//! A line-for-line port of `mutationDiff` and `bisect` in
//! `packages/harness-runtime/lib/session-mutation-text.js`. The JavaScript is
//! the reference: every place where Rust would otherwise behave differently
//! from JavaScript is marked `JS:`. The result is the same edit script, as
//! flat (kind, byte length) pairs instead of `{ kind, text }` records.
#![forbid(unsafe_code)]

/// Pair kinds, in the order of JavaScript's `equal`, `delete` and `insert`.
pub const EQUAL: u32 = 0;
pub const DELETE: u32 = 1;
pub const INSERT: u32 = 2;

/// One comparison unit. JS: `units()` picks per side: an ASCII text stays a
/// string (one unit per byte), any other valid UTF-8 text becomes an array of
/// code-point strings. Two units are `===` exactly when their code points are
/// equal, so a byte (always below 0x80 on an ASCII side) compared with a code
/// point matches only on ASCII.
trait Unit: Copy {
    fn key(self) -> u32;
    fn bytes(self) -> u32;
}

impl Unit for u8 {
    #[inline(always)]
    fn key(self) -> u32 {
        u32::from(self)
    }
    #[inline(always)]
    fn bytes(self) -> u32 {
        1
    }
}

impl Unit for u32 {
    #[inline(always)]
    fn key(self) -> u32 {
        self
    }
    #[inline(always)]
    fn bytes(self) -> u32 {
        if self < 0x80 {
            1
        } else if self < 0x800 {
            2
        } else if self < 0x10000 {
            3
        } else {
            4
        }
    }
}

/// Flat (kind, byte length) pairs.
struct Out {
    pairs: Vec<u32>,
}

impl Out {
    /// JS `push`: skip empty text, merge with the previous change of the same
    /// kind, including across recursive calls.
    fn push<T: Unit>(&mut self, kind: u32, units: &[T]) {
        let bytes: u32 = units.iter().map(|unit| unit.bytes()).sum();
        if bytes == 0 {
            return;
        }
        let len = self.pairs.len();
        if len >= 2 && self.pairs[len - 2] == kind {
            self.pairs[len - 1] += bytes;
            return;
        }
        self.pairs.push(kind);
        self.pairs.push(bytes);
    }
}

/// JS reads an out-of-range index as `undefined`, and `undefined === undefined`.
/// The loop guards bound the index above; this keeps the result identical if a
/// negative index were ever reached.
#[inline(always)]
fn at<T: Unit>(units: &[T], index: i64) -> Option<u32> {
    if index < 0 {
        None
    } else {
        units.get(index as usize).map(|unit| unit.key())
    }
}

/// JS `slice(start, end)`: negative positions count from the end, positions
/// past the end clamp, and an empty range is empty. Rust slicing would panic.
fn js_slice<T>(units: &[T], start: i64, end: Option<i64>) -> &[T] {
    let len = units.len() as i64;
    let clamp = |value: i64| {
        if value < 0 {
            (len + value).max(0)
        } else {
            value.min(len)
        }
    };
    let from = clamp(start);
    let to = end.map_or(len, clamp);
    if to <= from {
        &units[0..0]
    } else {
        &units[from as usize..to as usize]
    }
}

/// JS: `const alphabet = new Set(a); [...new Set(b)].some((char) => alphabet.has(char))`.
fn shares_alphabet<A: Unit, B: Unit>(a: &[A], b: &[B]) -> bool {
    let highest = a.iter().map(|unit| unit.key()).max().unwrap_or(0) as usize;
    let mut seen = vec![0u64; highest / 64 + 1];
    for unit in a {
        let key = unit.key() as usize;
        seen[key / 64] |= 1u64 << (key % 64);
    }
    b.iter().any(|unit| {
        let key = unit.key() as usize;
        key <= highest && seen[key / 64] & (1u64 << (key % 64)) != 0
    })
}

/// JS `bisect`. `work` is the budget shared by the whole walk.
fn bisect<A: Unit, B: Unit>(a: &[A], b: &[B], work: &mut i64) -> Option<(i64, i64)> {
    if !shares_alphabet(a, b) {
        return None;
    }
    let n = a.len() as i64;
    let m = b.len() as i64;
    // JS: Math.ceil((a.length + b.length) / 2) on a non-negative sum.
    let max = (n + m + 1) / 2;
    let offset = max + 1;
    let size = (2 * max + 3) as usize;
    // JS: Int32Array; a stored value is truncated to 32 bits the same way.
    let mut forward = vec![-1i32; size];
    let mut reverse = vec![-1i32; size];
    forward[(offset + 1) as usize] = 0;
    reverse[(offset + 1) as usize] = 0;
    let delta = n - m;
    // JS: `delta % 2 !== 0`; `%` keeps the dividend's sign in both languages.
    let odd = delta % 2 != 0;
    let (mut f_start, mut f_end, mut r_start, mut r_end) = (0i64, 0i64, 0i64, 0i64);
    for d in 0..=max {
        let mut k = -d + f_start;
        while k <= d - f_end {
            let p = (offset + k) as usize;
            let mut x: i64 = if k == -d || (k != d && forward[p - 1] < forward[p + 1]) {
                i64::from(forward[p + 1])
            } else {
                i64::from(forward[p - 1]) + 1
            };
            let mut y = x - k;
            let start = x;
            while x < n && y < m && at(a, x) == at(b, y) {
                x += 1;
                y += 1;
            }
            // JS: `(work.remaining -= 1 + x - start) <= 0`, one budget for the whole walk.
            *work -= 1 + x - start;
            if *work <= 0 {
                return None;
            }
            // JS: stored even when x > a.length; a later split can return it.
            forward[p] = x as i32;
            if x > n {
                f_end += 2;
            } else if y > m {
                f_start += 2;
            } else if odd {
                let q = offset + delta - k;
                if q >= 0
                    && (q as usize) < size
                    && reverse[q as usize] != -1
                    && x >= n - i64::from(reverse[q as usize])
                {
                    return Some((x, y));
                }
            }
            k += 2;
        }
        let mut k = -d + r_start;
        while k <= d - r_end {
            let p = (offset + k) as usize;
            let mut x: i64 = if k == -d || (k != d && reverse[p - 1] < reverse[p + 1]) {
                i64::from(reverse[p + 1])
            } else {
                i64::from(reverse[p - 1]) + 1
            };
            let mut y = x - k;
            let start = x;
            while x < n && y < m && at(a, n - x - 1) == at(b, m - y - 1) {
                x += 1;
                y += 1;
            }
            *work -= 1 + x - start;
            if *work <= 0 {
                return None;
            }
            reverse[p] = x as i32;
            if x > n {
                r_end += 2;
            } else if y > m {
                r_start += 2;
            } else if !odd {
                let q = offset + delta - k;
                if q >= 0
                    && (q as usize) < size
                    && forward[q as usize] != -1
                    && i64::from(forward[q as usize]) >= n - x
                {
                    let fx = i64::from(forward[q as usize]);
                    return Some((fx, fx - (delta - k)));
                }
            }
            k += 2;
        }
    }
    None
}

// JS `if (a === b) { push('equal', a); return; }` is left out: for equal
// inputs the prefix loop below pushes the same single equal change and every
// later push is empty, so the result is identical. (Two code-point arrays are
// never `===` in JavaScript, so there the shortcut only ever fires for ASCII.)
fn walk<A: Unit, B: Unit>(a: &[A], b: &[B], work: &mut i64, out: &mut Out) {
    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix].key() == b[prefix].key() {
        prefix += 1;
    }
    out.push(EQUAL, &a[..prefix]);
    let a = &a[prefix..];
    let b = &b[prefix..];
    let mut suffix = 0;
    while suffix < a.len()
        && suffix < b.len()
        && a[a.len() - suffix - 1].key() == b[b.len() - suffix - 1].key()
    {
        suffix += 1;
    }
    let tail = &a[a.len() - suffix..];
    let a = &a[..a.len() - suffix];
    let b = &b[..b.len() - suffix];
    if a.is_empty() {
        out.push(INSERT, b);
    } else if b.is_empty() {
        out.push(DELETE, a);
    } else {
        let split = if *work > 0 { bisect(a, b, work) } else { None };
        match split {
            Some((x, y))
                if !((x == 0 && y == 0) || (x == a.len() as i64 && y == b.len() as i64)) =>
            {
                // JS: walk(a.slice(0, x), b.slice(0, y)); walk(a.slice(x), b.slice(y));
                walk_halves(a, b, x, y, work, out);
            }
            _ => {
                out.push(DELETE, a);
                out.push(INSERT, b);
            }
        }
    }
    out.push(EQUAL, tail);
}

/// Code points of a text already known to be valid UTF-8.
fn code_points(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

/// `mutationDiff(before, after, { budget })` over the two byte strings, as
/// flat (kind, byte length) pairs. Includes `mutationDiff`'s own early exits:
/// equal texts are one equal change; a text holding a NUL byte or invalid
/// UTF-8 makes the result one deletion and one insertion.
pub fn mutation_diff(before: &[u8], after: &[u8], budget: i64) -> Vec<u32> {
    let mut out = Out { pairs: Vec::new() };
    if before == after {
        out.push(EQUAL, before);
        return out.pairs;
    }
    let text = |bytes: &[u8]| {
        if bytes.contains(&0) {
            None
        } else {
            core::str::from_utf8(bytes).ok().map(|_| ())
        }
    };
    if text(before).is_none() || text(after).is_none() {
        out.push(DELETE, before);
        out.push(INSERT, after);
        return out.pairs;
    }
    let mut work = budget;
    // Both are valid UTF-8 here: the checks above returned otherwise.
    let wide = |bytes: &[u8]| code_points(core::str::from_utf8(bytes).unwrap_or_default());
    match (before.is_ascii(), after.is_ascii()) {
        (true, true) => walk(before, after, &mut work, &mut out),
        (true, false) => walk(before, &wide(after)[..], &mut work, &mut out),
        (false, true) => walk(&wide(before)[..], after, &mut work, &mut out),
        (false, false) => walk(&wide(before)[..], &wide(after)[..], &mut work, &mut out),
    }
    out.pairs
}

/// The two recursive calls of `walk` for a split point `(x, y)`, on JS's
/// `a.slice(0, x), b.slice(0, y)` and `a.slice(x), b.slice(y)`: a split point
/// past the end of a text (a stored past-the-edge entry) clamps, never panics.
#[inline(always)]
fn walk_halves<A: Unit, B: Unit>(a: &[A], b: &[B], x: i64, y: i64, work: &mut i64, out: &mut Out) {
    walk(js_slice(a, 0, Some(x)), js_slice(b, 0, Some(y)), work, out);
    walk(js_slice(a, x, None), js_slice(b, y, None), work, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    // JS: [0,1,2,3,4].slice(start, end) for the out-of-range split points a
    // stored past-the-edge entry could produce.
    #[test]
    fn slice_clamps_like_javascript() {
        let units = [0u8, 1, 2, 3, 4];
        assert_eq!(js_slice(&units, 0, Some(7)), &units[..]);
        assert_eq!(js_slice(&units, 7, None), &units[0..0]);
        assert_eq!(js_slice(&units, 6, Some(2)), &units[0..0]);
        assert_eq!(js_slice(&units, 0, Some(-1)), &units[..4]);
        assert_eq!(js_slice(&units, -2, None), &units[3..]);
        assert_eq!(js_slice(&units, -9, Some(2)), &units[..2]);
        assert_eq!(js_slice(&units, 0, Some(-9)), &units[0..0]);
    }

    // `walk_halves` with split points past the end (and before the start) of
    // either text, against JS's `walk(a.slice(0, x), b.slice(0, y));
    // walk(a.slice(x), b.slice(y))`. No input is known to produce such a split
    // (exhaustive small searches find none); the clamp is the defence if one did.
    #[test]
    fn a_split_point_past_the_end_clamps_like_javascript() {
        let halves = |a: &[u8], b: &[u8], x: i64, y: i64| {
            let mut out = Out { pairs: Vec::new() };
            let mut work = 1_000;
            walk_halves(a, b, x, y, &mut work, &mut out);
            out.pairs
        };
        let a = b"abcde";
        let b = b"abc";
        // Both past the end: the first call sees both whole texts, the second nothing.
        assert_eq!(halves(a, b, 8, 3), vec![EQUAL, 3, DELETE, 2]);
        assert_eq!(halves(a, b, 7, 9), vec![EQUAL, 3, DELETE, 2]);
        // Past the end on one side only: JS walk('abcde', 'a') then walk('', 'bc').
        assert_eq!(halves(a, b, 6, 1), vec![EQUAL, 1, DELETE, 4, INSERT, 2]);
        // Negative positions count from the end: walk('abcd', '') then walk('e', 'abc').
        assert_eq!(halves(a, b, -1, -5), vec![DELETE, 5, INSERT, 3]);
    }

    #[test]
    fn out_of_range_reads_are_undefined() {
        let units = [7u8];
        assert_eq!(at(&units, -1), None);
        assert_eq!(at(&units, 1), None);
        assert_eq!(at(&units, -1), at(&[9u32][..], -3));
        assert_eq!(at(&units, 0), Some(7));
    }

    #[test]
    fn mixed_pair_matches_only_ascii() {
        // "ab" (an ASCII side) against "a\u{e9}": only "a" can match.
        let mut out = Out { pairs: Vec::new() };
        let mut work = 100;
        let wide = code_points("a\u{e9}");
        walk(&b"ab"[..], &wide[..], &mut work, &mut out);
        assert_eq!(out.pairs, vec![EQUAL, 1, DELETE, 1, INSERT, 2]);
    }

    #[test]
    fn early_exits_match_mutation_diff() {
        assert_eq!(mutation_diff(b"", b"", 10), Vec::<u32>::new());
        assert_eq!(mutation_diff(b"same", b"same", 0), vec![EQUAL, 4]);
        assert_eq!(
            mutation_diff(b"a\0b", b"ab", 10),
            vec![DELETE, 3, INSERT, 2]
        );
        assert_eq!(mutation_diff(b"", b"\xc0\x80", 10), vec![INSERT, 2]);
        assert_eq!(mutation_diff(b"\xed\xa0\x80", b"", 10), vec![DELETE, 3]);
    }

    #[test]
    fn an_exhausted_budget_replaces_the_middle() {
        assert_eq!(
            mutation_diff(b"xaby", b"xbay", 0),
            vec![EQUAL, 1, DELETE, 2, INSERT, 2, EQUAL, 1]
        );
        assert_eq!(
            mutation_diff(b"xaby", b"xbay", -3),
            vec![EQUAL, 1, DELETE, 2, INSERT, 2, EQUAL, 1]
        );
    }

    #[test]
    fn units_are_code_points_and_lengths_are_bytes() {
        // U+1F600 and U+1F601 share three leading bytes but are different units.
        let before = "a\u{1f600}b".as_bytes();
        let after = "a\u{1f601}b".as_bytes();
        assert_eq!(
            mutation_diff(before, after, 100),
            vec![EQUAL, 1, DELETE, 4, INSERT, 4, EQUAL, 1]
        );
    }
}

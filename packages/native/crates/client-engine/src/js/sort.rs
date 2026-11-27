//! `Array.prototype.sort` with a comparator, as the V8 of Electron's Node
//! (the product's renderer) does it: TimSort with V8's rules exactly, as
//! measured against that V8 call for call (`tests/sort-vectors.tsv`, made by
//! `tests/generate-sort-vectors.mjs` under Electron's Node): binary insertion
//! alone up to 15 elements; above that, natural runs (strictly descending ones
//! reversed) extended to balanced minimum lengths by binary insertion, merged
//! by powersort's policy, each merge with CPython listsort's galloping, so the comparator is called with the same arguments
//! in the same order and an inconsistent comparator (one that says a < b, b
//! < c and c < a, as message ids of mixed types do) gives V8's order. The
//! elements are first compacted: holes dropped, `undefined` taken out (it
//! sorts last without a call), the rest sorted, then written back followed by
//! the `undefined`s and the holes. A comparator's answer is `ToNumber`ed by
//! the caller; NaN counts as 0. A comparator that throws stops the sort and
//! the receiver keeps its order (the work array is V8's own copy).
//!
//! JavaScriptCore sorts otherwise (docs/TESTING.md, "Engine differences":
//! `sort-inconsistent-comparator`); for a consistent comparator every stable
//! sort gives one order.

use super::ops::Js;
use super::value::Value;

/// V8's `kMinGallopWins`.
const MIN_GALLOP: usize = 7;
/// Up to this length V8 sorts by binary insertion alone, from the second element on, with no run detection: what
/// Electron's Node does (measured: a sorted array of n <= 15 takes the binary insertion's calls, of 16 and more n - 1;
/// `tests/sort-vectors.tsv`). A later V8 lowered it to 7 (this repository's newer Node); the reference is the
/// renderer's V8, so the vectors are regenerated with Electron's Node when it changes.
const INSERTION_ONLY_UP_TO: usize = 15;

struct State<'c> {
    work: Vec<Value>,
    /// The pending runs: base, length, and the power of the boundary after it (powersort).
    runs: Vec<(usize, usize, u32)>,
    min_gallop: usize,
    compare: &'c mut dyn FnMut(&Value, &Value) -> Js<f64>,
}

impl State<'_> {
    fn order(&mut self, x: &Value, y: &Value) -> Js<f64> {
        let order = (self.compare)(x, y)?;
        Ok(if order.is_nan() { 0.0 } else { order })
    }
}

/// Sorts the elements of a dense list (holes already read as `undefined`) in place.
pub fn sort_by(items: &mut Vec<Value>, compare: &mut dyn FnMut(&Value, &Value) -> Js<f64>) -> Js<()> {
    if crate::plant::on("rv-sort-undefined-kept") {
        *items = tim_sort(std::mem::take(items), compare)?;
        return Ok(());
    }
    let undefined = items.iter().filter(|item| matches!(item, Value::Undefined)).count();
    let work: Vec<Value> = items.iter().filter(|item| !matches!(item, Value::Undefined)).cloned().collect();
    let mut sorted = tim_sort(work, compare)?;
    sorted.extend(std::iter::repeat_n(Value::Undefined, undefined));
    *items = sorted;
    Ok(())
}

/// Sorts an array's index members in place: present members sorted, then the `undefined`s, then the holes.
pub fn sort_elements(elements: &mut super::value::Elements, compare: &mut dyn FnMut(&Value, &Value) -> Js<f64>) -> Js<()> {
    let present: Vec<Value> = elements.present().map(|(_, value)| value.clone()).collect();
    let undefined = present.iter().filter(|item| matches!(item, Value::Undefined)).count();
    let work: Vec<Value> = present.into_iter().filter(|item| !matches!(item, Value::Undefined)).collect();
    let sorted = tim_sort(work, compare)?;
    let len = elements.len();
    let mut next = super::value::Elements::default();
    for value in sorted.into_iter().chain(std::iter::repeat_n(Value::Undefined, undefined)) {
        next.push(value);
    }
    next.push_holes(u64::from(len - next.len()));
    *elements = next;
    Ok(())
}

fn tim_sort(work: Vec<Value>, compare: &mut dyn FnMut(&Value, &Value) -> Js<f64>) -> Js<Vec<Value>> {
    let length = work.len();
    let mut state = State {
        work,
        runs: Vec::new(),
        min_gallop: MIN_GALLOP,
        compare,
    };
    if length < 2 {
        return Ok(state.work);
    }
    if length <= INSERTION_ONLY_UP_TO {
        binary_insertion_sort(&mut state, 0, 0, length)?;
        return Ok(state.work);
    }
    let mut remaining = length;
    let mut low = 0;
    let mut min_runs = MinRun::new(length);
    while remaining != 0 {
        let min_run = min_runs.next();
        let mut run = count_and_make_run(&mut state, low, low + remaining)?;
        if run < min_run {
            let forced = min_run.min(remaining);
            binary_insertion_sort(&mut state, low, low + run, low + forced)?;
            run = forced;
        }
        found_new_run(&mut state, run, length)?;
        state.runs.push((low, run, 0));
        low += run;
        remaining -= run;
    }
    merge_force_collapse(&mut state)?;
    Ok(state.work)
}

/// The shortest run of each step, as V8 computes it (Tim Peters' balanced rule, CPython's `minrun_next`): with `e`
/// the least shift that brings the length below 64, the k-th run's minimum is `(k * length) >> e` less the ones
/// before, so the forced runs differ by at most one (65 elements: 32, then 33). Measured against Electron's Node:
/// the classic rule (one minimum, 33 for 65) differs at 65 and 257 elements (`tests/sort-vectors.tsv`).
struct MinRun {
    shift: u32,
    mask: usize,
    current: usize,
    length: usize,
}

impl MinRun {
    fn new(length: usize) -> MinRun {
        let mut shift = 0;
        while (length >> shift) >= 64 {
            shift += 1;
        }
        MinRun {
            shift,
            mask: (1usize << shift) - 1,
            current: 0,
            length,
        }
    }

    fn next(&mut self) -> usize {
        self.current += self.length;
        let result = self.current >> self.shift;
        self.current &= self.mask;
        result
    }
}

fn binary_insertion_sort(state: &mut State<'_>, low: usize, start: usize, high: usize) -> Js<()> {
    let mut start = if low == start { start + 1 } else { start };
    while start < high {
        let (mut left, mut right) = (low, start);
        let pivot = state.work[start].clone();
        while left < right {
            let middle = left + ((right - left) >> 1);
            let other = state.work[middle].clone();
            let order = state.order(&pivot, &other)?;
            if order < 0.0 || (crate::plant::on("rv-sort-unstable-ties") && order == 0.0) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        let mut at = start;
        while at > left {
            state.work[at] = state.work[at - 1].clone();
            at -= 1;
        }
        state.work[left] = pivot;
        start += 1;
    }
    Ok(())
}

fn count_and_make_run(state: &mut State<'_>, low_arg: usize, high: usize) -> Js<usize> {
    let low = low_arg + 1;
    if low == high {
        return Ok(1);
    }
    let mut run = 2;
    let element_low = state.work[low].clone();
    let element_low_pre = state.work[low - 1].clone();
    let descending = state.order(&element_low, &element_low_pre)? < 0.0;
    let mut previous = element_low;
    for index in low + 1..high {
        let current = state.work[index].clone();
        let order = state.order(&current, &previous)?;
        if if descending { order >= 0.0 } else { order < 0.0 } {
            break;
        }
        previous = current;
        run += 1;
    }
    if descending {
        state.work[low_arg..low_arg + run].reverse();
    }
    Ok(run)
}

/// The power of the boundary between the top run (starting at `s1`, `n1` long) and the next one (`n2`), in a list
/// of `n`: the depth at which their midpoints part in a binary merge tree (powersort, CPython's `powerloop`).
fn power(s1: usize, n1: usize, n2: usize, n: usize) -> u32 {
    let mut result = 0;
    let mut a = 2 * s1 + n1;
    let mut b = a + n1 + n2;
    loop {
        result += 1;
        if a >= n {
            a -= n;
            b -= n;
        } else if b >= n {
            break;
        }
        a <<= 1;
        b <<= 1;
    }
    result
}

/// A new run of `n2` was found: merge the pending runs whose boundary is deeper than the new one's (powersort's merge
/// policy, which V8 follows: measured against Electron's Node, `tests/sort-vectors.tsv`), then record the new power.
fn found_new_run(state: &mut State<'_>, n2: usize, n: usize) -> Js<()> {
    let Some(&(s1, n1, _)) = state.runs.last() else { return Ok(()) };
    let power = power(s1, n1, n2, n);
    while state.runs.len() > 1 && state.runs[state.runs.len() - 2].2 > power {
        let at = state.runs.len() - 2;
        merge_at(state, at)?;
    }
    if let Some(top) = state.runs.last_mut() {
        top.2 = power;
    }
    Ok(())
}

fn merge_force_collapse(state: &mut State<'_>) -> Js<()> {
    while state.runs.len() > 1 {
        let mut n = state.runs.len() - 2;
        if n > 0 && state.runs[n - 1].1 < state.runs[n + 1].1 {
            n -= 1;
        }
        merge_at(state, n)?;
    }
    Ok(())
}

fn merge_at(state: &mut State<'_>, i: usize) -> Js<()> {
    let (mut base_a, mut length_a, _) = state.runs[i];
    let (base_b, mut length_b, _) = state.runs[i + 1];
    state.runs[i].1 = length_a + length_b;
    state.runs.remove(i + 1);
    let key_right = state.work[base_b].clone();
    let k = gallop_right(state, Side::Work, &key_right, base_a, length_a, 0)?;
    base_a += k;
    length_a -= k;
    if length_a == 0 {
        return Ok(());
    }
    let key_left = state.work[base_a + length_a - 1].clone();
    length_b = gallop_left(state, Side::Work, &key_left, base_b, length_b, length_b - 1)?;
    if length_b == 0 {
        return Ok(());
    }
    if length_a <= length_b {
        merge_low(state, base_a, length_a, base_b, length_b)
    } else {
        merge_high(state, base_a, length_a, base_b, length_b)
    }
}

/// Which array a gallop searches: the work array or the merge's temporary copy.
#[derive(Clone, Copy)]
enum Side {
    Work,
    Temp,
}

fn element(state: &State<'_>, temp: &[Value], side: Side, at: usize) -> Value {
    match side {
        Side::Work => state.work[at].clone(),
        Side::Temp => temp[at].clone(),
    }
}

fn gallop_left(state: &mut State<'_>, side: Side, key: &Value, base: usize, length: usize, hint: usize) -> Js<usize> {
    gallop_left_in(state, &[], side, key, base, length, hint)
}

fn gallop_right(state: &mut State<'_>, side: Side, key: &Value, base: usize, length: usize, hint: usize) -> Js<usize> {
    gallop_right_in(state, &[], side, key, base, length, hint)
}

/// V8's GallopLeft: the leftmost place in `[base, base + length)` for `key` (before equal elements).
fn gallop_left_in(state: &mut State<'_>, temp: &[Value], side: Side, key: &Value, base: usize, length: usize, hint: usize) -> Js<usize> {
    let (mut last, mut offset): (isize, isize) = (0, 1);
    let hint_i = hint as isize;
    let at = element(state, temp, side, base + hint);
    if state.order(&at, key)? < 0.0 {
        let max = (length - hint) as isize;
        while offset < max {
            let probe = element(state, temp, side, base + hint + offset as usize);
            if state.order(&probe, key)? >= 0.0 {
                break;
            }
            last = offset;
            offset = (offset << 1) + 1;
            if offset <= 0 {
                offset = max;
            }
        }
        offset = offset.min(max);
        last += hint_i;
        offset += hint_i;
    } else {
        let max = hint_i + 1;
        while offset < max {
            let probe = element(state, temp, side, base + (hint_i - offset) as usize);
            if state.order(&probe, key)? < 0.0 {
                break;
            }
            last = offset;
            offset = (offset << 1) + 1;
            if offset <= 0 {
                offset = max;
            }
        }
        offset = offset.min(max);
        let tmp = last;
        last = hint_i - offset;
        offset = hint_i - tmp;
    }
    last += 1;
    while last < offset {
        let middle = last + ((offset - last) >> 1);
        let probe = element(state, temp, side, base + middle as usize);
        if state.order(&probe, key)? < 0.0 {
            last = middle + 1;
        } else {
            offset = middle;
        }
    }
    Ok(offset as usize)
}

/// V8's GallopRight: the rightmost place in `[base, base + length)` for `key` (after equal elements).
fn gallop_right_in(state: &mut State<'_>, temp: &[Value], side: Side, key: &Value, base: usize, length: usize, hint: usize) -> Js<usize> {
    let (mut last, mut offset): (isize, isize) = (0, 1);
    let hint_i = hint as isize;
    let at = element(state, temp, side, base + hint);
    if state.order(key, &at)? < 0.0 {
        let max = hint_i + 1;
        while offset < max {
            let probe = element(state, temp, side, base + (hint_i - offset) as usize);
            if state.order(key, &probe)? >= 0.0 {
                break;
            }
            last = offset;
            offset = (offset << 1) + 1;
            if offset <= 0 {
                offset = max;
            }
        }
        offset = offset.min(max);
        let tmp = last;
        last = hint_i - offset;
        offset = hint_i - tmp;
    } else {
        let max = (length - hint) as isize;
        while offset < max {
            let probe = element(state, temp, side, base + hint + offset as usize);
            if state.order(key, &probe)? < 0.0 {
                break;
            }
            last = offset;
            offset = (offset << 1) + 1;
            if offset <= 0 {
                offset = max;
            }
        }
        offset = offset.min(max);
        last += hint_i;
        offset += hint_i;
    }
    last += 1;
    while last < offset {
        let middle = last + ((offset - last) >> 1);
        let probe = element(state, temp, side, base + middle as usize);
        if state.order(key, &probe)? < 0.0 {
            offset = middle;
        } else {
            last = middle + 1;
        }
    }
    Ok(offset as usize)
}

fn merge_low(state: &mut State<'_>, base_a: usize, length_a: usize, base_b: usize, length_b: usize) -> Js<()> {
    let (mut length_a, mut length_b) = (length_a, length_b);
    let temp: Vec<Value> = state.work[base_a..base_a + length_a].to_vec();
    let (mut dest, mut cursor_temp, mut cursor_b) = (base_a, 0usize, base_b);
    state.work[dest] = state.work[cursor_b].clone();
    dest += 1;
    cursor_b += 1;
    // Labels of V8's code: Succeed copies what is left of A; CopyB puts B's rest then A's last element.
    enum End {
        Succeed,
        CopyB,
    }
    let end = 'merge: {
        length_b -= 1;
        if length_b == 0 {
            break 'merge End::Succeed;
        }
        if length_a == 1 {
            break 'merge End::CopyB;
        }
        let mut min_gallop = state.min_gallop;
        loop {
            let (mut wins_a, mut wins_b) = (0usize, 0usize);
            loop {
                let b = state.work[cursor_b].clone();
                if state.order(&b, &temp[cursor_temp])? < 0.0 {
                    state.work[dest] = b;
                    dest += 1;
                    cursor_b += 1;
                    wins_b += 1;
                    length_b -= 1;
                    wins_a = 0;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                    if wins_b >= min_gallop {
                        break;
                    }
                } else {
                    state.work[dest] = temp[cursor_temp].clone();
                    dest += 1;
                    cursor_temp += 1;
                    wins_a += 1;
                    length_a -= 1;
                    wins_b = 0;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                    if wins_a >= min_gallop {
                        break;
                    }
                }
            }
            min_gallop += 1;
            let mut first = true;
            while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                first = false;
                min_gallop = min_gallop.saturating_sub(1).max(1);
                state.min_gallop = min_gallop;
                let key = state.work[cursor_b].clone();
                wins_a = gallop_right_in(state, &temp, Side::Temp, &key, cursor_temp, length_a, 0)?;
                if wins_a > 0 {
                    state.work[dest..dest + wins_a].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                    dest += wins_a;
                    cursor_temp += wins_a;
                    length_a -= wins_a;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                state.work[dest] = state.work[cursor_b].clone();
                dest += 1;
                cursor_b += 1;
                length_b -= 1;
                if length_b == 0 {
                    break 'merge End::Succeed;
                }
                let key = temp[cursor_temp].clone();
                wins_b = gallop_left_in(state, &temp, Side::Work, &key, cursor_b, length_b, 0)?;
                if wins_b > 0 {
                    for at in 0..wins_b {
                        state.work[dest + at] = state.work[cursor_b + at].clone();
                    }
                    dest += wins_b;
                    cursor_b += wins_b;
                    length_b -= wins_b;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                }
                state.work[dest] = temp[cursor_temp].clone();
                dest += 1;
                cursor_temp += 1;
                length_a -= 1;
                if length_a == 1 {
                    break 'merge End::CopyB;
                }
            }
            min_gallop += 1;
            state.min_gallop = min_gallop;
        }
    };
    match end {
        End::Succeed => {
            state.work[dest..dest + length_a].clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
        }
        End::CopyB => {
            for at in 0..length_b {
                state.work[dest + at] = state.work[cursor_b + at].clone();
            }
            state.work[dest + length_b] = temp[cursor_temp].clone();
        }
    }
    Ok(())
}

fn merge_high(state: &mut State<'_>, base_a: usize, length_a: usize, base_b: usize, length_b: usize) -> Js<()> {
    let (mut length_a, mut length_b) = (length_a as isize, length_b as isize);
    let temp: Vec<Value> = state.work[base_b..base_b + length_b as usize].to_vec();
    let base_a = base_a as isize;
    let mut dest = base_b as isize + length_b - 1;
    let mut cursor_temp = length_b - 1;
    let mut cursor_a = base_a + length_a - 1;
    let w = |at: isize| at as usize;
    state.work[w(dest)] = state.work[w(cursor_a)].clone();
    dest -= 1;
    cursor_a -= 1;
    enum End {
        Succeed,
        CopyA,
    }
    let end = 'merge: {
        length_a -= 1;
        if length_a == 0 {
            break 'merge End::Succeed;
        }
        if length_b == 1 {
            break 'merge End::CopyA;
        }
        let mut min_gallop = state.min_gallop;
        loop {
            let (mut wins_a, mut wins_b) = (0isize, 0isize);
            loop {
                let a = state.work[w(cursor_a)].clone();
                if state.order(&temp[w(cursor_temp)], &a)? < 0.0 {
                    state.work[w(dest)] = a;
                    dest -= 1;
                    cursor_a -= 1;
                    wins_a += 1;
                    length_a -= 1;
                    wins_b = 0;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                    if wins_a >= min_gallop as isize {
                        break;
                    }
                } else {
                    state.work[w(dest)] = temp[w(cursor_temp)].clone();
                    dest -= 1;
                    cursor_temp -= 1;
                    wins_b += 1;
                    length_b -= 1;
                    wins_a = 0;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    if wins_b >= min_gallop as isize {
                        break;
                    }
                }
            }
            min_gallop += 1;
            let mut first = true;
            while wins_a >= MIN_GALLOP as isize || wins_b >= MIN_GALLOP as isize || first {
                first = false;
                min_gallop = min_gallop.saturating_sub(1).max(1);
                state.min_gallop = min_gallop;
                let key = temp[w(cursor_temp)].clone();
                let k = gallop_right_in(state, &temp, Side::Work, &key, w(base_a), w(length_a), w(length_a - 1))? as isize;
                wins_a = length_a - k;
                if wins_a > 0 {
                    dest -= wins_a;
                    cursor_a -= wins_a;
                    // Copy(work, cursorA + 1, work, dest + 1, n): the ranges overlap, the destination to the right.
                    for at in (0..wins_a).rev() {
                        state.work[w(dest + 1 + at)] = state.work[w(cursor_a + 1 + at)].clone();
                    }
                    length_a -= wins_a;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                state.work[w(dest)] = temp[w(cursor_temp)].clone();
                dest -= 1;
                cursor_temp -= 1;
                length_b -= 1;
                if length_b == 1 {
                    break 'merge End::CopyA;
                }
                let key = state.work[w(cursor_a)].clone();
                let k = gallop_left_in(state, &temp, Side::Temp, &key, 0, w(length_b), w(length_b - 1))? as isize;
                wins_b = length_b - k;
                if wins_b > 0 {
                    dest -= wins_b;
                    cursor_temp -= wins_b;
                    for at in 0..wins_b {
                        state.work[w(dest + 1 + at)] = temp[w(cursor_temp + 1 + at)].clone();
                    }
                    length_b -= wins_b;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                }
                state.work[w(dest)] = state.work[w(cursor_a)].clone();
                dest -= 1;
                cursor_a -= 1;
                length_a -= 1;
                if length_a == 0 {
                    break 'merge End::Succeed;
                }
            }
            min_gallop += 1;
            state.min_gallop = min_gallop;
        }
    };
    match end {
        End::Succeed => {
            if length_b > 0 {
                let from = dest - (length_b - 1);
                for at in 0..length_b {
                    state.work[w(from + at)] = temp[w(at)].clone();
                }
            }
        }
        End::CopyA => {
            dest -= length_a;
            cursor_a -= length_a;
            for at in (0..length_a).rev() {
                state.work[w(dest + 1 + at)] = state.work[w(cursor_a + 1 + at)].clone();
            }
            state.work[w(dest)] = temp[w(cursor_temp)].clone();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(items: &[f64]) -> Vec<Value> {
        items.iter().map(|n| Value::Number(*n)).collect()
    }

    #[test]
    fn sorts_numbers_and_keeps_undefined_last() {
        let mut items = numbers(&[3.0, 1.0, 2.0]);
        items.insert(1, Value::Undefined);
        sort_by(&mut items, &mut |a, b| Ok(a.as_number().unwrap() - b.as_number().unwrap())).unwrap();
        assert_eq!(format!("{items:?}"), "[1, 2, 3, undefined]");
    }

    #[test]
    fn long_inputs_with_runs_and_gallops_come_out_sorted_and_stable() {
        // Pairs (key, original index); a stable sort keeps equal keys in index order.
        for length in [0usize, 1, 2, 5, 31, 32, 33, 64, 65, 100, 257, 1000, 4097] {
            let items: Vec<(f64, f64)> = (0..length).map(|at| ((((at * 7919) % 97) / 3) as f64, at as f64)).collect();
            let mut values: Vec<Value> = items
                .iter()
                .map(|(key, at)| Value::Object(crate::js::Obj::array(vec![Value::Number(*key), Value::Number(*at)])))
                .collect();
            let key = |value: &Value| crate::js::to_number(&crate::js::get_opt(value, "0"));
            let at = |value: &Value| crate::js::to_number(&crate::js::get_opt(value, "1"));
            sort_by(&mut values, &mut |a, b| Ok(key(a) - key(b))).unwrap();
            let mut wanted = items.clone();
            wanted.sort_by(|a, b| a.0.total_cmp(&b.0));
            let got: Vec<(f64, f64)> = values.iter().map(|value| (key(value), at(value))).collect();
            assert_eq!(got, wanted, "length {length}");
        }
    }
}

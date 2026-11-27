//! The ECMAScript regular expressions of the ported modules, matched by a
//! small backtracking engine with the specification's semantics for the
//! subset they use, in non-Unicode mode (no `u` flag): code units, `\b` over
//! `[A-Za-z0-9_]`, `\s` as WhiteSpace and LineTerminator, `\d`, classes with
//! ranges and negation, `^` and `$` without `m`, groups, alternation, greedy
//! `? * + {m} {m,} {m,n}`, and the `i` flag. Every pattern is ASCII, so
//! case-insensitive matching is ASCII case folding: Canonicalize never maps a
//! non-ASCII unit to an ASCII one without `u`. Each pattern is the JavaScript
//! source copied verbatim; anything outside the subset panics when compiled
//! (the unit tests compile every pattern).

use crate::text::is_js_whitespace;

#[derive(Debug)]
enum ClassItem {
    Range(u16, u16),
    Space,
    Digit,
}

#[derive(Debug)]
struct Class {
    items: Vec<ClassItem>,
    negated: bool,
}

#[derive(Debug)]
enum Node {
    Unit(u16),
    Class(Class),
    Start,
    End,
    WordBoundary,
    Group(Vec<Vec<Node>>, Option<usize>),
    Repeat(Box<Node>, u32, Option<u32>),
}

/// A compiled pattern.
#[derive(Debug)]
pub struct Regex {
    root: Vec<Vec<Node>>,
    ignore_case: bool,
    groups: usize,
}

/// Capture spans by group number (0 is the whole match).
pub type Captures = Vec<Option<(usize, usize)>>;

struct Parser<'a> {
    source: &'a [u8],
    at: usize,
    groups: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.source.get(self.at).copied()
    }

    fn next(&mut self) -> u8 {
        let byte = self.source[self.at];
        self.at += 1;
        byte
    }

    fn alternatives(&mut self) -> Vec<Vec<Node>> {
        let mut alternatives = vec![self.sequence()];
        while self.peek() == Some(b'|') {
            self.at += 1;
            alternatives.push(self.sequence());
        }
        alternatives
    }

    fn sequence(&mut self) -> Vec<Node> {
        let mut nodes = Vec::new();
        while let Some(byte) = self.peek() {
            if byte == b'|' || byte == b')' {
                break;
            }
            let atom = self.atom();
            nodes.push(self.quantified(atom));
        }
        nodes
    }

    fn atom(&mut self) -> Node {
        match self.next() {
            b'^' => Node::Start,
            b'$' => Node::End,
            b'(' => {
                let index = if self.source[self.at..].starts_with(b"?:") {
                    self.at += 2;
                    None
                } else {
                    self.groups += 1;
                    Some(self.groups)
                };
                let alternatives = self.alternatives();
                assert_eq!(self.next(), b')', "unclosed group");
                Node::Group(alternatives, index)
            }
            b'[' => self.class(),
            b'\\' => match self.next() {
                b'b' => Node::WordBoundary,
                b's' => Node::Class(Class {
                    items: vec![ClassItem::Space],
                    negated: false,
                }),
                b'd' => Node::Class(Class {
                    items: vec![ClassItem::Digit],
                    negated: false,
                }),
                byte if byte.is_ascii_alphanumeric() => panic!("unsupported escape \\{}", byte as char),
                byte => Node::Unit(u16::from(byte)),
            },
            b'.' | b'*' | b'+' | b'?' | b'{' | b'}' | b']' => panic!("unsupported pattern syntax at {}", self.at - 1),
            byte => Node::Unit(u16::from(byte)),
        }
    }

    fn class_unit(&mut self) -> ClassItem {
        match self.next() {
            b'\\' => match self.next() {
                b's' => ClassItem::Space,
                b'd' => ClassItem::Digit,
                b'u' => {
                    let hex = std::str::from_utf8(&self.source[self.at..self.at + 4]).expect("ASCII");
                    self.at += 4;
                    let unit = u16::from_str_radix(hex, 16).expect("four hex digits");
                    ClassItem::Range(unit, unit)
                }
                byte if byte.is_ascii_alphanumeric() => panic!("unsupported class escape \\{}", byte as char),
                byte => ClassItem::Range(u16::from(byte), u16::from(byte)),
            },
            byte => ClassItem::Range(u16::from(byte), u16::from(byte)),
        }
    }

    fn class(&mut self) -> Node {
        let negated = self.peek() == Some(b'^');
        if negated {
            self.at += 1;
        }
        let mut items = Vec::new();
        while self.peek() != Some(b']') {
            let first = self.class_unit();
            if self.peek() == Some(b'-') && self.source.get(self.at + 1) != Some(&b']') {
                self.at += 1;
                let last = self.class_unit();
                match (first, last) {
                    (ClassItem::Range(low, _), ClassItem::Range(high, _)) => {
                        assert!(low <= high, "range out of order");
                        items.push(ClassItem::Range(low, high));
                    }
                    _ => panic!("a class escape cannot bound a range"),
                }
            } else {
                items.push(first);
            }
        }
        self.at += 1;
        Node::Class(Class { items, negated })
    }

    fn number(&mut self) -> u32 {
        let start = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        std::str::from_utf8(&self.source[start..self.at]).expect("ASCII").parse().expect("a count")
    }

    fn quantified(&mut self, atom: Node) -> Node {
        let (min, max) = match self.peek() {
            Some(b'?') => (0, Some(1)),
            Some(b'*') => (0, None),
            Some(b'+') => (1, None),
            Some(b'{') => {
                self.at += 1;
                let min = self.number();
                let max = if self.peek() == Some(b',') {
                    self.at += 1;
                    if self.peek() == Some(b'}') { None } else { Some(self.number()) }
                } else {
                    Some(min)
                };
                assert_eq!(self.peek(), Some(b'}'), "unclosed count");
                (min, max)
            }
            _ => return atom,
        };
        self.at += 1;
        assert!(self.peek() != Some(b'?'), "lazy quantifiers are not supported");
        assert!(!matches!(atom, Node::Start | Node::End | Node::WordBoundary), "a quantified assertion");
        Node::Repeat(Box::new(atom), min, max)
    }
}

const fn is_word(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

impl Regex {
    /// Compiles a JavaScript pattern (the text between the slashes).
    pub fn new(source: &str, ignore_case: bool) -> Regex {
        assert!(source.is_ascii(), "patterns are ASCII");
        let mut parser = Parser {
            source: source.as_bytes(),
            at: 0,
            groups: 0,
        };
        let root = parser.alternatives();
        assert_eq!(parser.at, source.len(), "unbalanced `)` in {source}");
        Regex {
            root,
            ignore_case,
            groups: parser.groups,
        }
    }

    fn class_has(&self, class: &Class, unit: u16) -> bool {
        let raw = |unit: u16| {
            class.items.iter().any(|item| match item {
                ClassItem::Range(low, high) => (*low..=*high).contains(&unit),
                ClassItem::Space => is_js_whitespace(unit),
                ClassItem::Digit => (0x30..=0x39).contains(&unit),
            })
        };
        let member = raw(unit) || (self.ignore_case && u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphabetic()) && raw(unit ^ 0x20));
        member != class.negated
    }

    fn unit_matches(&self, node: &Node, unit: u16) -> Option<bool> {
        match node {
            Node::Unit(expected) => Some(
                *expected == unit
                    || (self.ignore_case
                        && u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphabetic())
                        && u8::try_from(*expected).is_ok_and(|byte| byte.is_ascii_alphabetic())
                        && (*expected ^ 0x20) == unit),
            ),
            Node::Class(class) => Some(self.class_has(class, unit)),
            _ => None,
        }
    }

    fn sequence(&self, nodes: &[Node], text: &[u16], at: usize, captures: &mut Captures, next: &mut dyn FnMut(usize, &mut Captures) -> bool) -> bool {
        let Some((first, rest)) = nodes.split_first() else {
            return next(at, captures);
        };
        self.node(first, text, at, captures, &mut |at, captures| self.sequence(rest, text, at, captures, next))
    }

    fn node(&self, node: &Node, text: &[u16], at: usize, captures: &mut Captures, next: &mut dyn FnMut(usize, &mut Captures) -> bool) -> bool {
        match node {
            Node::Unit(_) | Node::Class(_) => at < text.len() && self.unit_matches(node, text[at]) == Some(true) && next(at + 1, captures),
            Node::Start => at == 0 && next(at, captures),
            Node::End => at == text.len() && next(at, captures),
            Node::WordBoundary => {
                let before = at > 0 && is_word(text[at - 1]);
                let after = at < text.len() && is_word(text[at]);
                before != after && next(at, captures)
            }
            Node::Group(alternatives, index) => {
                for alternative in alternatives {
                    let saved = captures.clone();
                    let matched = self.sequence(alternative, text, at, captures, &mut |end, captures| match index {
                        Some(index) => {
                            let previous = captures[*index];
                            captures[*index] = Some((at, end));
                            if next(end, captures) {
                                return true;
                            }
                            captures[*index] = previous;
                            false
                        }
                        None => next(end, captures),
                    });
                    if matched {
                        return true;
                    }
                    *captures = saved;
                }
                false
            }
            Node::Repeat(inner, min, max) => {
                if matches!(**inner, Node::Unit(_) | Node::Class(_)) {
                    // One unit per iteration: count the run, then give back.
                    let limit = max.map_or(text.len() - at, |max| (max as usize).min(text.len() - at));
                    let run = text[at..at + limit]
                        .iter()
                        .take_while(|unit| self.unit_matches(inner, **unit) == Some(true))
                        .count();
                    if run < *min as usize {
                        return false;
                    }
                    (*min as usize..=run).rev().any(|count| next(at + count, captures))
                } else {
                    self.repeat(inner, *min, *max, 0, text, at, captures, next)
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn repeat(
        &self,
        inner: &Node,
        min: u32,
        max: Option<u32>,
        count: u32,
        text: &[u16],
        at: usize,
        captures: &mut Captures,
        next: &mut dyn FnMut(usize, &mut Captures) -> bool,
    ) -> bool {
        if max.is_none_or(|max| count < max) {
            let more = self.node(inner, text, at, captures, &mut |end, captures| {
                // RepeatMatcher: an empty iteration past the minimum fails.
                if end == at && count >= min {
                    return false;
                }
                self.repeat(inner, min, max, count + 1, text, end, captures, next)
            });
            if more {
                return true;
            }
        }
        count >= min && next(at, captures)
    }

    /// The captures of the leftmost match, as `exec` finds it.
    pub fn exec(&self, text: &[u16]) -> Option<Captures> {
        for start in 0..=text.len() {
            let mut captures: Captures = vec![None; self.groups + 1];
            let mut found = None;
            let matched = self.alternatives_at(text, start, &mut captures, &mut |end, _| {
                found = Some(end);
                true
            });
            if matched {
                captures[0] = Some((start, found.expect("a match end")));
                return Some(captures);
            }
        }
        None
    }

    fn alternatives_at(&self, text: &[u16], at: usize, captures: &mut Captures, next: &mut dyn FnMut(usize, &mut Captures) -> bool) -> bool {
        for alternative in &self.root {
            let saved = captures.clone();
            if self.sequence(alternative, text, at, captures, next) {
                return true;
            }
            *captures = saved;
        }
        false
    }

    /// `pattern.test(text)`.
    pub fn test(&self, text: &[u16]) -> bool {
        self.exec(text).is_some()
    }
}

/// A pattern compiled on first use: `pattern!(NAME, "source", ignore_case)`.
macro_rules! pattern {
    ($name:ident, $source:expr, $ignore_case:expr) => {
        pub fn $name() -> &'static $crate::regex::Regex {
            static CELL: std::sync::OnceLock<$crate::regex::Regex> = std::sync::OnceLock::new();
            CELL.get_or_init(|| $crate::regex::Regex::new($source, $ignore_case))
        }
    };
}
pub(crate) use pattern;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::units;

    fn test(source: &str, ignore_case: bool, text: &str) -> bool {
        Regex::new(source, ignore_case).test(&units(text))
    }

    #[test]
    fn subset_semantics() {
        assert!(test(r"\bnative_(?:web_[a-z_]+|permit_[a-z_]+)\b", false, "x native_web_ab."));
        assert!(!test(r"\bnative_(?:web_[a-z_]+|permit_[a-z_]+)\b", false, "native_web_abC"));
        assert!(test(r"^(?:[\\/]|[a-zA-Z]:)", false, "C:x"));
        assert!(test(r"^[a-f0-9]{64}$", false, &"a".repeat(64)));
        assert!(!test(r"^[a-f0-9]{64}$", false, &"a".repeat(65)));
        assert!(test(r"timeout(?:error)?\.?$", true, "TimeoutError."));
        assert!(test(r"^unknown\s*error$", true, "UNKNOWN\u{2028}error"));
        assert!(test(r"[^a-z0-9]", true, "\u{17f}"));
        assert!(!test(r"[^a-z0-9]", true, "Q"));
        let regex = Regex::new(r"^a (b([a-z]{0,3})\/c)(?: x)?$", false);
        let captures = regex.exec(&units("a bxy/c x")).expect("a match");
        assert_eq!(captures[1], Some((2, 7)));
        assert_eq!(captures[2], Some((3, 5)));
    }
}

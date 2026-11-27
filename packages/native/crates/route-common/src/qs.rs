//! `qs.parse(body, options)` (qs 6.15.0) with the options body-parser 2.2.2's
//! extended URL-encoded parser passes (`allowPrototypes: true`, `arrayLimit:
//! max(100, parameters)`, `depth: 32`, `strictDepth: true`, `parameterLimit:
//! 1000`, the request's charset), so that the group's `req.body?.text` is what
//! it is today: a string only when exactly that shape came out of qs's parse
//! and merge rules (a repeated key, a bracketed `[text]`, an empty value and
//! the overflow objects past the array limit all change it).
//!
//! It stops at the parsed object: qs's final `compact` only makes sparse arrays
//! dense, which never turns a value into a string or a string into anything
//! else, and nothing else of the object is read by the group.

use devryan_config_text::js;

use crate::props::Props;

/// A value qs builds: a string, an array (with holes), or an object (marked
/// with its highest index when qs's side channel marks it as an overflow).
#[derive(Clone, Debug, PartialEq)]
pub enum Q {
    Str(Vec<u16>),
    Arr(Vec<Option<Q>>),
    Obj(Props<Q>, Option<u64>),
}

/// What qs throws for these options: a key nested deeper than 32 brackets (`strictDepth`).
#[derive(Debug, PartialEq, Eq)]
pub struct DepthExceeded;

const PARAMETER_LIMIT: usize = 1000;
const DEPTH: usize = 32;

fn units(text: &str) -> Vec<u16> {
    js::units(text)
}

/// The value of `decodedRoot` as qs's array-index test reads it: `String(parseInt(x, 10)) === x`, non-negative.
fn canonical_index(text: &[u16]) -> Option<u64> {
    if text.is_empty() || !text.iter().all(|unit| (0x30..=0x39).contains(unit)) {
        return None;
    }
    let digits: String = text.iter().map(|unit| char::from(*unit as u8)).collect();
    let value: f64 = digits.parse().ok()?;
    (js::number_to_string(value) == digits).then_some(value as u64)
}

fn decode(text: &[u16], latin1: bool) -> Vec<u16> {
    let plus: Vec<u16> = text.iter().map(|unit| if *unit == u16::from(b'+') { 0x20 } else { *unit }).collect();
    if latin1 {
        let hex = |unit: u16| char::from_u32(u32::from(unit)).and_then(|ch| ch.to_digit(16));
        let mut out = Vec::with_capacity(plus.len());
        let mut at = 0;
        while at < plus.len() {
            if plus[at] == u16::from(b'%')
                && let (Some(high), Some(low)) = (plus.get(at + 1).and_then(|unit| hex(*unit)), plus.get(at + 2).and_then(|unit| hex(*unit)))
            {
                out.push((high * 16 + low) as u16);
                at += 3;
                continue;
            }
            out.push(plus[at]);
            at += 1;
        }
        return out;
    }
    js::decode_uri_component(&plus).unwrap_or(plus)
}

fn replace_brackets(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if text[at] == u16::from(b'%') && text.get(at + 1) == Some(&u16::from(b'5')) {
            match text.get(at + 2).copied() {
                Some(0x42 | 0x62) => {
                    out.push(u16::from(b'['));
                    at += 3;
                    continue;
                }
                Some(0x44 | 0x64) => {
                    out.push(u16::from(b']'));
                    at += 3;
                    continue;
                }
                _ => {}
            }
        }
        out.push(text[at]);
        at += 1;
    }
    out
}

/// The next match of `/\[[^[\]]*]/` at or after `from`: its start and end.
fn bracket_segment(key: &[u16], from: usize) -> Option<(usize, usize)> {
    let mut start = from;
    while start < key.len() {
        if key[start] == u16::from(b'[') {
            let mut end = start + 1;
            while end < key.len() && key[end] != u16::from(b'[') && key[end] != u16::from(b']') {
                end += 1;
            }
            if end < key.len() && key[end] == u16::from(b']') {
                return Some((start, end + 1));
            }
        }
        start += 1;
    }
    None
}

fn split_key(key: &[u16]) -> Result<Vec<Vec<u16>>, DepthExceeded> {
    let first = bracket_segment(key, 0);
    let parent = match first {
        Some((start, _)) => &key[..start],
        None => key,
    };
    let mut keys = Vec::new();
    if !parent.is_empty() {
        keys.push(parent.to_vec());
    }
    let mut from = 0;
    let mut count = 0;
    while let Some((start, end)) = bracket_segment(key, from) {
        if count >= DEPTH {
            return Err(DepthExceeded);
        }
        count += 1;
        keys.push(key[start..end].to_vec());
        from = end;
    }
    Ok(keys)
}

fn is_overflow(value: &Q) -> Option<u64> {
    match value {
        Q::Obj(_, overflow) => *overflow,
        _ => None,
    }
}

fn index_key(index: u64) -> Vec<u16> {
    units(&index.to_string())
}

fn array_to_object(items: Vec<Option<Q>>) -> Props<Q> {
    let mut props = Props::new();
    for (index, item) in items.into_iter().enumerate() {
        if let Some(item) = item {
            props.define(index_key(index as u64), item);
        }
    }
    props
}

/// `[].concat(a, b)` of qs's combine and merge: an array spreads (holes kept), anything else is one element.
fn concat(parts: Vec<Q>) -> Vec<Option<Q>> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            Q::Arr(items) => out.extend(items),
            other => out.push(Some(other)),
        }
    }
    out
}

fn combine(a: Q, b: Q, array_limit: usize) -> Q {
    let a = match a {
        Q::Obj(mut props, Some(max)) => {
            props.define(index_key(max + 1), b);
            return Q::Obj(props, Some(max + 1));
        }
        other => other,
    };
    let result = concat(vec![a, b]);
    if result.len() > array_limit {
        let last = result.len() as u64 - 1;
        return Q::Obj(array_to_object(result), Some(last));
    }
    Q::Arr(result)
}

fn is_object(value: &Q) -> bool {
    matches!(value, Q::Arr(_) | Q::Obj(..))
}

fn merge(target: Q, source: Option<Q>, array_limit: usize) -> Q {
    let Some(source) = source else { return target };
    if let Q::Str(text) = &source {
        if text.is_empty() {
            return target;
        }
        return match target {
            Q::Arr(mut items) => {
                let next = items.len();
                if next > array_limit {
                    items.push(Some(source));
                    Q::Obj(array_to_object(items), Some(next as u64))
                } else {
                    items.push(Some(source));
                    Q::Arr(items)
                }
            }
            Q::Obj(mut props, Some(max)) => {
                props.define(index_key(max + 1), source);
                Q::Obj(props, Some(max + 1))
            }
            // strictMerge (qs's default): an object and a primitive become a pair.
            object @ Q::Obj(_, None) => Q::Arr(vec![Some(object), Some(source)]),
            string @ Q::Str(_) => Q::Arr(vec![Some(string), Some(source)]),
        };
    }
    if let Q::Str(_) = target {
        if let Q::Obj(props, Some(max)) = source {
            let mut result = Props::new();
            result.define(units("0"), target);
            for (key, value) in props.into_entries() {
                let old: u64 = String::from_utf16_lossy(&key).parse().unwrap_or(0);
                result.define(index_key(old + 1), value);
            }
            return Q::Obj(result, Some(max + 1));
        }
        let combined = concat(vec![target, source]);
        if combined.len() > array_limit {
            let last = combined.len() as u64 - 1;
            return Q::Obj(array_to_object(combined), Some(last));
        }
        return Q::Arr(combined);
    }
    let (target, source) = match (target, source) {
        (Q::Arr(mut items), Q::Arr(more)) => {
            for (index, item) in more.into_iter().enumerate() {
                let Some(item) = item else { continue };
                match items.get_mut(index) {
                    Some(Some(existing)) => {
                        if is_object(existing) && is_object(&item) {
                            let taken = std::mem::replace(existing, Q::Str(Vec::new()));
                            *existing = merge(taken, Some(item), array_limit);
                        } else {
                            items.push(Some(item));
                        }
                    }
                    _ => {
                        if items.len() <= index {
                            items.resize(index + 1, None);
                        }
                        items[index] = Some(item);
                    }
                }
            }
            return Q::Arr(items);
        }
        pair => pair,
    };
    let (mut acc, mut acc_overflow) = match target {
        Q::Arr(items) => (array_to_object(items), None),
        Q::Obj(props, overflow) => (props, overflow),
        Q::Str(_) => unreachable!("handled above"),
    };
    let source_overflow = is_overflow(&source);
    let entries: Vec<(Vec<u16>, Q)> = match source {
        Q::Obj(props, _) => props.into_entries(),
        Q::Arr(items) => items
            .into_iter()
            .enumerate()
            .filter_map(|(index, item)| item.map(|item| (index_key(index as u64), item)))
            .collect(),
        Q::Str(_) => unreachable!("handled above"),
    };
    for (key, value) in entries {
        let next = match acc.remove_keep(&key) {
            Some(existing) => merge(existing, Some(value), array_limit),
            None => value,
        };
        acc.set_keep(key.clone(), next);
        if let (Some(max), None) = (source_overflow, acc_overflow) {
            acc_overflow = Some(max);
        }
        if let (Some(max), Some(number)) = (acc_overflow, canonical_index(&key))
            && number > max
        {
            acc_overflow = Some(number);
        }
    }
    Q::Obj(acc, acc_overflow)
}

trait KeepPlace {
    fn remove_keep(&mut self, key: &[u16]) -> Option<Q>;
    fn set_keep(&mut self, key: Vec<u16>, value: Q);
}

impl KeepPlace for Props<Q> {
    /// Takes the value out while keeping the key's place (a placeholder string stands in).
    fn remove_keep(&mut self, key: &[u16]) -> Option<Q> {
        self.get_mut(key).map(|slot| std::mem::replace(slot, Q::Str(Vec::new())))
    }

    fn set_keep(&mut self, key: Vec<u16>, value: Q) {
        self.define(key, value);
    }
}

fn parse_object(chain: Vec<Vec<u16>>, value: Q, array_limit: usize) -> Q {
    let mut leaf = value;
    for root in chain.into_iter().rev() {
        if root == units("[]") {
            leaf = if is_overflow(&leaf).is_some() {
                leaf
            } else {
                combine(Q::Arr(Vec::new()), leaf, array_limit)
            };
            continue;
        }
        let bracketed = root.len() >= 2 && root[0] == u16::from(b'[') && root[root.len() - 1] == u16::from(b']');
        let clean = if bracketed { root[1..root.len() - 1].to_vec() } else { root.clone() };
        let index = if bracketed { canonical_index(&clean) } else { None };
        leaf = match index {
            Some(index) if (index as usize) < array_limit => {
                let mut items = vec![None; index as usize + 1];
                items[index as usize] = Some(leaf);
                Q::Arr(items)
            }
            Some(index) => {
                let mut props = Props::new();
                props.define(index_key(index), leaf);
                Q::Obj(props, Some(index))
            }
            None => {
                let mut props = Props::new();
                if clean != units("__proto__") {
                    props.define(clean, leaf);
                }
                Q::Obj(props, None)
            }
        };
    }
    leaf
}

/// `qs.parse(text, options)` as body-parser calls it (text already decoded in `latin1` or UTF-8).
pub fn parse(text: &[u16], latin1: bool, array_limit: usize) -> Result<Q, DepthExceeded> {
    let clean = replace_brackets(text);
    let mut temp: Props<Q> = Props::new();
    let mut parts: Vec<&[u16]> = clean.split(|unit| *unit == u16::from(b'&')).collect();
    parts.truncate(PARAMETER_LIMIT);
    for part in parts {
        let bracket_equals = js::index_of(part, &units("]="), 0);
        let position = match bracket_equals {
            Some(at) => Some(at + 1),
            None => js::index_of(part, &units("="), 0),
        };
        let (key, value) = match position {
            None => (decode(part, latin1), Vec::new()),
            Some(at) => (decode(&part[..at], latin1), decode(&part[at + 1..], latin1)),
        };
        let value = Q::Str(value);
        match temp.remove_keep(&key) {
            Some(existing) => {
                let combined = combine(existing, value, array_limit);
                temp.set_keep(key, combined);
            }
            None => temp.define(key, value),
        }
    }
    let mut object = Q::Obj(Props::new(), None);
    for (key, value) in temp.into_entries() {
        if key.is_empty() {
            continue;
        }
        let chain = split_key(&key)?;
        let built = parse_object(chain, value, array_limit);
        object = merge(object, Some(built), array_limit);
    }
    Ok(object)
}

/// body-parser's parameter count: one more than the `&` in the text, or None past the limit (it answers 413).
pub fn parameter_count(text: &[u16]) -> Option<usize> {
    let count = text.iter().filter(|unit| **unit == u16::from(b'&')).count() + 1;
    (count <= PARAMETER_LIMIT + usize::from(crate::plant::named("rv-param-limit-1001"))).then_some(count)
}

/// `req.body?.text` when it is a string.
pub fn text_of(object: &Q) -> Option<Vec<u16>> {
    match object {
        Q::Obj(props, _) => match props.get(&units("text")) {
            Some(Q::Str(text)) => Some(text.clone()),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(body: &str) -> Option<String> {
        let units = units(body);
        let limit = parameter_count(&units).unwrap().max(100);
        parse(&units, false, limit)
            .ok()
            .as_ref()
            .and_then(text_of)
            .map(|text| String::from_utf16_lossy(&text))
    }

    #[test]
    fn shapes() {
        assert_eq!(text("text=from%20a+form").as_deref(), Some("from a form"));
        assert_eq!(text("text[nested]=value"), None);
        assert_eq!(text("text=a&text=b"), None);
        assert_eq!(text("[text]=x").as_deref(), Some("x"));
        assert_eq!(text("text=a&[text]=").as_deref(), Some("a"));
        assert_eq!(text("text=&[text]=b"), None);
        assert_eq!(text("text=a]=b"), None);
        assert_eq!(text("te%78t=%E2%9C%93").as_deref(), Some("✓"));
        assert_eq!(text("text=%ff").as_deref(), Some("%ff"));
        assert_eq!(text("text").as_deref(), Some(""));
        assert_eq!(text("text%5Bx%5D=1"), None);
        assert_eq!(text(&format!("x{}=1", "[a]".repeat(33))), None);
        assert!(parse(&units(&format!("x{}=1", "[a]".repeat(33))), false, 100).is_err());
        assert!(parse(&units(&format!("x{}=1", "[a]".repeat(32))), false, 100).is_ok());
    }

    #[test]
    fn latin1_decoding() {
        let body = units("text=%E9+%zz");
        let parsed = parse(&body, true, 100).unwrap();
        assert_eq!(String::from_utf16_lossy(&text_of(&parsed).unwrap()), "é %zz");
    }

    #[test]
    fn index_canonical() {
        assert_eq!(canonical_index(&units("0")), Some(0));
        assert_eq!(canonical_index(&units("01")), None);
        assert_eq!(canonical_index(&units("9007199254740992")), Some(9_007_199_254_740_992));
        assert_eq!(canonical_index(&units("9007199254740993")), None);
        assert_eq!(canonical_index(&units("-1")), None);
    }
}

//! JSON values as V8 parses and writes them, on bytes: `JSON.parse(text)` of
//! a body or a file and `JSON.stringify(value)` / `JSON.stringify(value, null,
//! 2)` of the result, byte for byte, without building UTF-16 text.
//!
//! - Strings are kept as WTF-8: UTF-8 where the JavaScript string is
//!   well-formed, a lone surrogate as its 3-byte encoding, adjacent surrogates
//!   (from escapes, or a raw unit next to an escape) merged into one character.
//! - Input bytes are read as Node's `buffer.toString('utf8')` reads them: an
//!   ill-formed sequence inside a string is U+FFFD per maximal subpart (outside
//!   a string every non-ASCII byte is a syntax error either way). Text another
//!   charset decoded comes in as WTF-8 ([`from_units`]), where a surrogate's
//!   encoding is a lone surrogate.
//! - Objects keep V8's order: canonical array-index keys (`0` to `2^32 - 2`)
//!   ascending, then the other keys where they were first defined; a repeated
//!   key keeps its first place and its last value; `__proto__` is an own key.
//! - Numbers are parsed correctly rounded and written as `Number.prototype.toString`
//!   writes them (`devryan_config_text::js`: the ledger core's number layout, the one
//!   implementation of the workspace); `-0` is `0`, and a number that overflows
//!   (`1e400`) is `null`.
//! - JSON.parse is iterative in V8, and so is JSON.stringify called with no
//!   replacer and no gap (V8's fast path: res.json writes any depth); with a
//!   gap (`JSON.stringify(value, null, 2)`) it recurses and throws a RangeError
//!   past V8's stack. [`Parsed::depth`] says how deep the value is; with a
//!   limit, a value deeper than it is validated but not built (the caller
//!   answers what the JavaScript answers when that stringify throws).
//!
//! Parse, stringify and drop all run with explicit stacks, so no input can
//! exhaust a thread's stack.

use crate::qs::Q;
use devryan_config_text::js;

/// The nesting (containers in a path from the root) beyond which V8's JSON.stringify with a gap runs out of stack
/// in the group's handler. Measured on this Node: in a plain script 5 623 containers stringify with a gap and 5 624
/// throw; in the session-folders handler under the JavaScript candidate adapter 5 408 stringify and 5 409 throw (the
/// handler's own frames take the rest), the same in two runs. With no replacer and no gap there is no limit. Not a
/// contract: it moves with V8's frames and stack size, and in the reference the answer past it is a page with a
/// stack, which the harness never judges.
pub const DEPTH_LIMIT: usize = 5_408;

/// Planted changes of these rules (test-only: a group candidate built with the `plants` feature sets them once,
/// from its `--plant`; otherwise every field is false and the limit is [`DEPTH_LIMIT`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct Variant {
    pub replacement_per_byte: bool,
    pub lone_surrogate_raw: bool,
    pub index_keys_in_place: bool,
    pub duplicate_last_place: bool,
    pub proto_dropped: bool,
    pub negative_zero_kept: bool,
    pub form_holes_kept: bool,
    pub depth_limit: Option<usize>,
}

static VARIANT: std::sync::OnceLock<Variant> = std::sync::OnceLock::new();
const PLAIN: Variant = Variant {
    replacement_per_byte: false,
    lone_surrogate_raw: false,
    index_keys_in_place: false,
    duplicate_last_place: false,
    proto_dropped: false,
    negative_zero_kept: false,
    form_holes_kept: false,
    depth_limit: None,
};

/// Sets the planted variant (once; refused without the `plants` feature).
pub fn plant_variant(variant: Variant) {
    if cfg!(feature = "plants") {
        let _ = VARIANT.set(variant);
    }
}

#[inline]
fn variant() -> &'static Variant {
    if cfg!(feature = "plants") { VARIANT.get().unwrap_or(&PLAIN) } else { &PLAIN }
}

/// The depth limit in force.
pub fn depth_limit() -> usize {
    variant().depth_limit.unwrap_or(DEPTH_LIMIT)
}

/// A JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum V {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u8>),
    Arr(Vec<V>),
    /// Boxed, so a value is 32 bytes: a body of empty arrays costs at most 16 times its size.
    Obj(Box<Obj>),
}

/// An object's own properties in V8's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Obj {
    indexed: Vec<(u32, V)>,
    named: Vec<(Vec<u8>, V)>,
    /// From 16 names on: each name's keyed hash to the last index with that hash, and per index the one before it
    /// with the same hash (no name is copied; the hash is keyed, so no body can make the names collide on purpose).
    positions: Option<Box<KeyTable>>,
    sorted: bool,
}

/// Names by their keyed hashes (from 16 names on, in an object and in the one pass): each hash to the last index
/// added with it, and per index the one before it with the same hash. No name is copied; the hash is keyed, so no
/// body can make names collide on purpose.
#[derive(Debug, Clone, Default)]
struct KeyTable {
    state: std::hash::RandomState,
    last: std::collections::HashMap<u64, usize>,
    previous: Vec<usize>,
}

impl PartialEq for KeyTable {
    fn eq(&self, _: &Self) -> bool {
        // Derived from the names it indexes: two objects with equal names are equal.
        true
    }
}

impl KeyTable {
    fn hash(&self, name: &[u8]) -> u64 {
        use std::hash::BuildHasher;
        self.state.hash_one(name)
    }

    fn add(&mut self, name: &[u8], at: usize) {
        let before = self.last.insert(self.hash(name), at).unwrap_or(usize::MAX);
        if self.previous.len() <= at {
            self.previous.resize(at + 1, usize::MAX);
        }
        self.previous[at] = before;
    }

    /// The index of `name` (`key_of` gives each index's name).
    fn find<'k>(&self, name: &[u8], key_of: impl Fn(usize) -> &'k [u8]) -> Option<usize> {
        let mut at = *self.last.get(&self.hash(name))?;
        while at != usize::MAX {
            if key_of(at) == name {
                return Some(at);
            }
            at = self.previous[at];
        }
        None
    }
}

/// The canonical array index of a key (`String(ToUint32(key)) === key`, below 2^32 - 1).
fn array_index(key: &[u8]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.iter().all(u8::is_ascii_digit) || (key.len() > 1 && key[0] == b'0' && !crate::plant::named("rv-index-key-01")) {
        return None;
    }
    let value: u64 = key.iter().fold(0u64, |sum, digit| sum * 10 + u64::from(digit - b'0'));
    (value < 4_294_967_295 || (crate::plant::named("rv-index-key-max") && value == 4_294_967_295)).then_some(value as u32)
}

impl Obj {
    pub fn new() -> Self {
        Obj::default()
    }

    /// `CreateDataProperty(object, key, value)`.
    pub fn define(&mut self, key: Vec<u8>, value: V) {
        let planted = variant();
        if planted.proto_dropped && key == b"__proto__" {
            return;
        }
        if let Some(index) = array_index(&key).filter(|_| !planted.index_keys_in_place) {
            self.indexed.push((index, value));
            self.sorted = false;
            return;
        }
        if self.positions.is_none() && self.named.len() >= 16 {
            let mut table = Box::<KeyTable>::default();
            for (at, (name, _)) in self.named.iter().enumerate() {
                table.add(name, at);
            }
            self.positions = Some(table);
        }
        let found = match &self.positions {
            Some(positions) => positions.find(&key, |at| self.named[at].0.as_slice()),
            None => self.named.iter().position(|(name, _)| *name == key),
        };
        match found {
            Some(at) if variant().duplicate_last_place => {
                self.named.remove(at);
                self.positions = None;
                self.named.push((key, value));
            }
            // The shared plant: a repeated key keeps its first value.
            Some(_) if crate::plant::on(crate::plant::Plant::DuplicateKeyFirstWins) => {}
            Some(at) => self.named[at].1 = value,
            None => {
                if let Some(positions) = &mut self.positions {
                    positions.add(&key, self.named.len());
                }
                self.named.push((key, value));
            }
        }
    }

    /// Sorts the indexed keys (the last value of a repeated index kept).
    fn settle(&mut self) {
        if self.sorted {
            return;
        }
        // A stable sort keeps definition order among equal indices: the last one is the value.
        self.indexed.sort_by_key(|(index, _)| *index);
        let mut kept: Vec<(u32, V)> = Vec::with_capacity(self.indexed.len());
        for (index, value) in self.indexed.drain(..) {
            match kept.last_mut() {
                Some((last, slot)) if *last == index => *slot = value,
                _ => kept.push((index, value)),
            }
        }
        self.indexed = kept;
        self.sorted = true;
    }

    pub fn is_empty(&self) -> bool {
        self.indexed.is_empty() && self.named.is_empty()
    }

    /// The properties in V8's order (index keys as their decimal text).
    pub fn entries(&mut self) -> Vec<(Vec<u8>, &V)> {
        self.settle();
        let mut out: Vec<(Vec<u8>, &V)> = self.indexed.iter().map(|(index, value)| (index.to_string().into_bytes(), value)).collect();
        out.extend(self.named.iter().map(|(name, value)| (name.clone(), value)));
        out
    }
}

impl V {
    /// An array or object with members (what dropping must take apart).
    fn has_members(&self) -> bool {
        match self {
            V::Arr(items) => !items.is_empty(),
            V::Obj(object) => !object.is_empty(),
            _ => false,
        }
    }

    /// Moves this container's members that have members of their own to `pending`; the others are dropped here.
    fn take_children(&mut self, pending: &mut Vec<V>) {
        let keep = |value: V, pending: &mut Vec<V>| {
            if value.has_members() {
                pending.push(value);
            }
        };
        match self {
            V::Arr(items) => items.drain(..).for_each(|item| keep(item, pending)),
            V::Obj(object) => {
                object.indexed.drain(..).for_each(|(_, item)| keep(item, pending));
                object.named.drain(..).for_each(|(_, item)| keep(item, pending));
                object.positions = None;
            }
            _ => {}
        }
    }
}

impl Drop for V {
    fn drop(&mut self) {
        // Members that are containers are moved to a list and taken apart one at a time, so a deep value never
        // recurses; a scalar member (or an empty container) is dropped where it stands, so a long array of numbers
        // costs no second list.
        if !self.has_members() {
            return;
        }
        let mut pending = Vec::new();
        self.take_children(&mut pending);
        while let Some(mut value) = pending.pop() {
            value.take_children(&mut pending);
        }
    }
}

/// JSON.parse threw (a SyntaxError).
#[derive(Debug, PartialEq, Eq)]
pub struct Thrown;

/// What JSON.parse made: the value (unless it is deeper than the limit asked for), its depth, and whether the
/// top-level value is an object.
#[derive(Debug)]
pub struct Parsed {
    pub value: Option<V>,
    pub depth: usize,
    pub object: bool,
}

// ------------------------------------------------------------------ strings (WTF-8)

/// Appends one code point (a surrogate as WTF-8), merging a low surrogate into a high one just before it.
fn push_code_point(out: &mut Vec<u8>, point: u32) {
    if (0xdc00..0xe000).contains(&point) {
        let len = out.len();
        if len >= 3 && out[len - 3] == 0xed && (0xa0..0xb0).contains(&out[len - 2]) {
            let high = 0xd000 | (u32::from(out[len - 2] & 0x3f) << 6) | u32::from(out[len - 1] & 0x3f);
            out.truncate(len - 3);
            let combined = 0x10000 + ((high - 0xd800) << 10) + (point - 0xdc00);
            push_code_point(out, combined);
            return;
        }
    }
    match point {
        0..=0x7f => out.push(point as u8),
        0x80..=0x7ff => out.extend_from_slice(&[0xc0 | (point >> 6) as u8, 0x80 | (point & 0x3f) as u8]),
        0x800..=0xffff => out.extend_from_slice(&[0xe0 | (point >> 12) as u8, 0x80 | ((point >> 6) & 0x3f) as u8, 0x80 | (point & 0x3f) as u8]),
        _ => out.extend_from_slice(&[
            0xf0 | (point >> 18) as u8,
            0x80 | ((point >> 12) & 0x3f) as u8,
            0x80 | ((point >> 6) & 0x3f) as u8,
            0x80 | (point & 0x3f) as u8,
        ]),
    }
}

/// One character of `bytes` at `at` as the WHATWG UTF-8 decoder (Node's) reads it: the code point and its length,
/// or U+FFFD and the length of the maximal subpart. With `wtf8`, a surrogate's 3-byte encoding is that surrogate.
fn decode_at(bytes: &[u8], at: usize, wtf8: bool) -> (u32, usize) {
    let first = bytes[at];
    let (point, length) = decode_maximal(bytes, at, wtf8, first);
    if point == 0xfffd && !wtf8 && variant().replacement_per_byte && length > 1 && bytes[at..at + length] != [0xef, 0xbf, 0xbd] {
        return (0xfffd, 1);
    }
    (point, length)
}

fn decode_maximal(bytes: &[u8], at: usize, wtf8: bool, first: u8) -> (u32, usize) {
    let (need, low, high, initial) = match first {
        0xc2..=0xdf => (1, 0x80, 0xbf, u32::from(first & 0x1f)),
        0xe0 => (2, 0xa0, 0xbf, u32::from(first & 0x0f)),
        0xed if !wtf8 => (2, 0x80, 0x9f, u32::from(first & 0x0f)),
        0xe1..=0xef => (2, 0x80, 0xbf, u32::from(first & 0x0f)),
        0xf0 => (3, 0x90, 0xbf, u32::from(first & 0x07)),
        0xf1..=0xf3 => (3, 0x80, 0xbf, u32::from(first & 0x07)),
        0xf4 => (3, 0x80, 0x8f, u32::from(first & 0x07)),
        _ => return (0xfffd, 1),
    };
    let mut point = initial;
    for index in 0..need {
        let Some(&byte) = bytes.get(at + 1 + index) else { return (0xfffd, 1 + index) };
        let (lo, hi) = if index == 0 { (low, high) } else { (0x80, 0xbf) };
        if !(lo..=hi).contains(&byte) {
            return (0xfffd, 1 + index);
        }
        point = (point << 6) | u32::from(byte & 0x3f);
    }
    (point, need + 1)
}

/// Text as WTF-8 (for a body another charset decoded into UTF-16 units).
pub fn wtf8_of_units(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len());
    for unit in units {
        push_code_point(&mut out, u32::from(*unit));
    }
    out
}

/// A UTF-16 text's WTF-8 bytes back as units.
pub fn units_of_wtf8(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        // An ASCII byte is its own unit (the decoder reads only sequences: the review's M4).
        let (point, length) = if bytes[at] < 0x80 {
            (u32::from(bytes[at]), 1)
        } else {
            decode_at(bytes, at, true)
        };
        if point >= 0x10000 {
            let shifted = point - 0x10000;
            out.push(0xd800 + (shifted >> 10) as u16);
            out.push(0xdc00 + (shifted & 0x3ff) as u16);
        } else {
            out.push(point as u16);
        }
        at += length;
    }
    out
}

// ------------------------------------------------------------------ parse

enum Frame {
    Arr(Vec<V>),
    Obj(Obj, Vec<u8>),
    /// A container deeper than the limit: validated, not built.
    Skip(bool),
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
    wtf8: bool,
}

impl<'a> Parser<'a> {
    fn space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn expect(&mut self, byte: u8) -> Result<(), Thrown> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(Thrown)
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), Thrown> {
        if self.bytes.get(self.at..self.at + word.len()) == Some(word) {
            self.at += word.len();
            Ok(())
        } else {
            Err(Thrown)
        }
    }

    fn hex4(&mut self) -> Result<u32, Thrown> {
        let digits = self.bytes.get(self.at..self.at + 4).ok_or(Thrown)?;
        let mut value = 0u32;
        for digit in digits {
            value = value * 16 + char::from(*digit).to_digit(16).ok_or(Thrown)?;
        }
        self.at += 4;
        Ok(value)
    }

    /// A string after its opening quote, into `out` (WTF-8).
    fn string(&mut self, out: &mut Vec<u8>) -> Result<(), Thrown> {
        loop {
            let start = self.at;
            self.at += plain_run(self.bytes.get(self.at..).unwrap_or_default());
            out.extend_from_slice(&self.bytes[start..self.at]);
            let byte = self.peek().ok_or(Thrown)?;
            match byte {
                b'"' => {
                    self.at += 1;
                    return Ok(());
                }
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek().ok_or(Thrown)?;
                    self.at += 1;
                    let point = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return Err(Thrown),
                    };
                    push_code_point(out, point);
                }
                0..=0x1f => return Err(Thrown),
                _ => {
                    let (point, length) = decode_at(self.bytes, self.at, self.wtf8);
                    let replaced = point == 0xfffd && self.bytes.get(self.at..self.at + length) != Some(&[0xef, 0xbf, 0xbd][..]);
                    if replaced || (0xd800..0xe000).contains(&point) {
                        push_code_point(out, point);
                    } else {
                        out.extend_from_slice(&self.bytes[self.at..self.at + length]);
                    }
                    self.at += length;
                }
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<f64, Thrown> {
        let text = self.number_text()?;
        js::decimal_to_f64(text).ok_or(Thrown)
    }

    /// A number's text, its grammar checked, not yet converted.
    fn number_text(&mut self) -> Result<&'a [u8], Thrown> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(Thrown),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(Thrown);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(Thrown);
            }
        }
        Ok(&self.bytes[start..self.at])
    }
}

/// JSON.parse of a text given as bytes: `wtf8` false for UTF-8 bytes read as Node reads them (a byte-order mark is
/// not removed: it is a syntax error, as U+FEFF is not JSON whitespace), true for WTF-8 made from UTF-16 units.
pub fn parse(bytes: &[u8], wtf8: bool) -> Result<Parsed, Thrown> {
    parse_limited(bytes, wtf8, None)
}

/// [`parse`], building no value deeper than `limit` (with [`depth_limit`] for a value a gap will stringify).
pub fn parse_limited(bytes: &[u8], wtf8: bool, limit: Option<usize>) -> Result<Parsed, Thrown> {
    let limit = limit.unwrap_or(usize::MAX);
    let mut parser = Parser { bytes, at: 0, wtf8 };
    let mut stack: Vec<Frame> = Vec::new();
    let mut depth = 0usize;
    let mut deepest = 0usize;
    parser.space();
    let object = parser.peek() == Some(b'{');
    loop {
        let skipping = matches!(stack.last(), Some(Frame::Skip(_))) || depth >= limit;
        // A value starts here.
        let mut value: Option<V> = match parser.peek().ok_or(Thrown)? {
            open @ (b'{' | b'[') => {
                parser.at += 1;
                depth += 1;
                deepest = deepest.max(depth);
                parser.space();
                let close = if open == b'{' { b'}' } else { b']' };
                if parser.peek() == Some(close) {
                    parser.at += 1;
                    depth -= 1;
                    if skipping {
                        None
                    } else if open == b'{' {
                        Some(V::Obj(Box::default()))
                    } else {
                        Some(V::Arr(Vec::new()))
                    }
                } else if open == b'{' {
                    parser.expect(b'"')?;
                    let mut key = Vec::new();
                    parser.string(&mut key)?;
                    parser.space();
                    parser.expect(b':')?;
                    parser.space();
                    stack.push(if skipping { Frame::Skip(true) } else { Frame::Obj(Obj::new(), key) });
                    continue;
                } else {
                    stack.push(if skipping { Frame::Skip(false) } else { Frame::Arr(Vec::new()) });
                    continue;
                }
            }
            b'"' => {
                parser.at += 1;
                let mut text = Vec::new();
                parser.string(&mut text)?;
                Some(V::Str(text))
            }
            b't' => {
                parser.literal(b"true")?;
                Some(V::Bool(true))
            }
            b'f' => {
                parser.literal(b"false")?;
                Some(V::Bool(false))
            }
            b'n' => {
                parser.literal(b"null")?;
                Some(V::Null)
            }
            _ => Some(V::Num(parser.number()?)),
        };
        // The value is complete: hand it to the containers it closes.
        loop {
            parser.space();
            let Some(frame) = stack.last_mut() else {
                if parser.at != bytes.len() {
                    return Err(Thrown);
                }
                return Ok(Parsed {
                    value: if deepest > limit { None } else { value },
                    depth: deepest,
                    object,
                });
            };
            match frame {
                Frame::Arr(items) => {
                    if let Some(item) = value.take() {
                        items.push(item);
                    }
                }
                Frame::Obj(object, key) => {
                    if let Some(item) = value.take() {
                        object.define(std::mem::take(key), item);
                    }
                }
                Frame::Skip(_) => {}
            }
            let is_object = matches!(frame, Frame::Obj(..) | Frame::Skip(true));
            match parser.peek() {
                Some(b',') => {
                    parser.at += 1;
                    parser.space();
                    if is_object {
                        parser.expect(b'"')?;
                        let mut key = Vec::new();
                        parser.string(&mut key)?;
                        parser.space();
                        parser.expect(b':')?;
                        parser.space();
                        if let Some(Frame::Obj(_, slot)) = stack.last_mut() {
                            *slot = key;
                        }
                    }
                    break;
                }
                Some(b'}') if is_object => {}
                Some(b']') if !is_object => {}
                _ => return Err(Thrown),
            }
            parser.at += 1;
            depth -= 1;
            value = match stack.pop() {
                Some(Frame::Arr(items)) => Some(V::Arr(items)),
                Some(Frame::Obj(mut object, _)) => {
                    object.settle();
                    Some(V::Obj(Box::new(object)))
                }
                _ => None,
            };
        }
    }
}

/// The depth of a value as JSON.stringify walks it (containers on its deepest path; a scalar is 0), without
/// recursion. [`Parsed::depth`] is the text's nesting, a superseded value's included; this is the value's.
pub fn depth_of(value: &V) -> usize {
    let mut deepest = 0;
    let mut pending = vec![(value, 1usize)];
    while let Some((value, depth)) = pending.pop() {
        match value {
            V::Arr(items) => {
                deepest = deepest.max(depth);
                pending.extend(items.iter().map(|item| (item, depth + 1)));
            }
            V::Obj(object) => {
                deepest = deepest.max(depth);
                pending.extend(object.indexed.iter().map(|(_, item)| (item, depth + 1)));
                pending.extend(object.named.iter().map(|(_, item)| (item, depth + 1)));
            }
            _ => {}
        }
    }
    deepest
}

/// JSON.parse of a UTF-16 text (a body another charset decoded).
pub fn from_units(units: &[u16], limit: Option<usize>) -> Result<Parsed, Thrown> {
    parse_limited(&wtf8_of_units(units), true, limit)
}

/// The object qs built (after its final `compact`, which drops the holes of its arrays).
pub fn from_form(form: &Q) -> V {
    match form {
        Q::Str(text) if crate::plant::named("rv-form-number-coerce") && !text.is_empty() && text.iter().all(|unit| (0x30..=0x39).contains(unit)) => {
            V::Num(String::from_utf16_lossy(text).parse().unwrap_or(0.0))
        }
        Q::Str(text) => V::Str(wtf8_of_units(text)),
        Q::Arr(items) if variant().form_holes_kept => V::Arr(items.iter().map(|item| item.as_ref().map_or(V::Null, from_form)).collect()),
        Q::Arr(items) => V::Arr(items.iter().flatten().map(from_form).collect()),
        Q::Obj(props, _) => {
            let mut object = Obj::new();
            for (key, value) in props.entries() {
                object.define(wtf8_of_units(&key), from_form(value));
            }
            object.settle();
            V::Obj(Box::new(object))
        }
    }
}

// ------------------------------------------------------------------ stringify

/// `JSON.stringify`'s quoting of a WTF-8 string.
pub fn push_string(out: &mut Vec<u8>, text: &[u8]) {
    if crate::plant::named("rv-escape-del") || crate::plant::named("rv-escape-2028") {
        return push_string_planted(out, text);
    }
    push_string_plain(out, text);
}

fn push_string_plain(out: &mut Vec<u8>, text: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let mut at = 0;
    while at < text.len() {
        let start = at;
        at += quoted_run(&text[at..]);
        out.extend_from_slice(&text[start..at]);
        let Some(&byte) = text.get(at) else { break };
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0xed if text.get(at + 1).is_some_and(|next| *next >= 0xa0) && !variant().lone_surrogate_raw => {
                // A lone surrogate: well-formed JSON.stringify writes it escaped, in lower case.
                let unit = 0xd000 | (u32::from(text[at + 1] & 0x3f) << 6) | u32::from(text.get(at + 2).copied().unwrap_or(0x80) & 0x3f);
                out.extend_from_slice(b"\\u");
                for shift in [12, 8, 4, 0] {
                    out.push(HEX[((unit >> shift) & 0xf) as usize]);
                }
                at += 3;
                continue;
            }
            0xed => {
                out.push(byte);
            }
            _ => {
                out.extend_from_slice(b"\\u00");
                out.push(HEX[usize::from(byte >> 4)]);
                out.push(HEX[usize::from(byte & 0xf)]);
            }
        }
        at += 1;
    }
    out.push(b'"');
}

/// [`push_string`] under the review's escape plants: DEL, or U+2028 and U+2029, escaped as well.
fn push_string_planted(out: &mut Vec<u8>, text: &[u8]) {
    let mut plain = Vec::new();
    let mut at = 0;
    out.push(b'"');
    while at < text.len() {
        let line =
            crate::plant::named("rv-escape-2028") && text[at] == 0xe2 && text.get(at + 1) == Some(&0x80) && matches!(text.get(at + 2), Some(0xa8 | 0xa9));
        if (crate::plant::named("rv-escape-del") && text[at] == 0x7f) || line {
            push_inner(out, &plain);
            plain.clear();
            out.extend_from_slice(if line {
                if text[at + 2] == 0xa8 { b"\\u2028" } else { b"\\u2029" }
            } else {
                b"\\u007f"
            });
            at += if line { 3 } else { 1 };
            continue;
        }
        plain.push(text[at]);
        at += 1;
    }
    push_inner(out, &plain);
    out.push(b'"');
}

/// [`push_string`] without its quotes.
fn push_inner(out: &mut Vec<u8>, text: &[u8]) {
    let mut quoted = Vec::new();
    push_string_plain(&mut quoted, text);
    out.extend_from_slice(&quoted[1..quoted.len() - 1]);
}

fn push_number(out: &mut Vec<u8>, number: f64) {
    if number == 0.0 && number.is_sign_negative() && variant().negative_zero_kept {
        out.extend_from_slice(b"-0");
    } else if number.is_finite() {
        js::push_number_utf8(out, number);
    } else {
        out.extend_from_slice(b"null");
    }
}

fn indent(out: &mut Vec<u8>, gap: usize, level: usize) {
    out.push(b'\n');
    out.resize(out.len() + gap * level, b' ');
}

/// `JSON.stringify(value)` (`gap` 0) or `JSON.stringify(value, null, gap)`. Stops once the output passes `stop`
/// bytes (the caller then only needs to know it is longer). The value's objects are settled (parse and
/// [`from_form`] settle every object they finish).
pub fn stringify(value: &V, gap: usize, stop: usize) -> Vec<u8> {
    enum Open<'a> {
        Arr(std::slice::Iter<'a, V>, bool),
        Obj(std::slice::Iter<'a, (u32, V)>, std::slice::Iter<'a, (Vec<u8>, V)>, bool),
    }
    let mut out = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    let mut next = Some(value);
    let mut number = String::new();
    loop {
        if let Some(value) = next.take() {
            match value {
                V::Null => out.extend_from_slice(b"null"),
                V::Bool(true) => out.extend_from_slice(b"true"),
                V::Bool(false) => out.extend_from_slice(b"false"),
                V::Num(value) => push_number(&mut out, *value),
                V::Str(text) => push_string(&mut out, text),
                V::Arr(items) if items.is_empty() => out.extend_from_slice(b"[]"),
                V::Arr(items) => {
                    out.push(b'[');
                    stack.push(Open::Arr(items.iter(), true));
                }
                V::Obj(object) if object.is_empty() => out.extend_from_slice(b"{}"),
                V::Obj(object) => {
                    debug_assert!(object.sorted || object.indexed.len() < 2, "an object stringified before it was settled");
                    out.push(b'{');
                    stack.push(Open::Obj(object.indexed.iter(), object.named.iter(), true));
                }
            }
        }
        if out.len() > stop {
            break;
        }
        let level = stack.len();
        let Some(top) = stack.last_mut() else { break };
        let (first, item, key): (&mut bool, Option<&V>, Option<&[u8]>) = match top {
            Open::Arr(items, first) => (first, items.next(), None),
            Open::Obj(indexed, named, first) => match indexed.next() {
                Some((index, value)) => {
                    number.clear();
                    number.push_str(&index.to_string());
                    (first, Some(value), Some(number.as_bytes()))
                }
                None => match named.next() {
                    Some((name, value)) => (first, Some(value), Some(name.as_slice())),
                    None => (first, None, None),
                },
            },
        };
        match item {
            Some(item) => {
                if !*first {
                    out.push(b',');
                }
                *first = false;
                if gap > 0 {
                    indent(&mut out, gap, level);
                }
                if let Some(key) = key {
                    push_string(&mut out, key);
                    out.extend_from_slice(if gap > 0 { b": " } else { b":" });
                }
                next = Some(item);
            }
            None => {
                let close = if matches!(top, Open::Arr(..)) { b']' } else { b'}' };
                stack.pop();
                if gap > 0 {
                    indent(&mut out, gap, level - 1);
                }
                out.push(close);
            }
        }
    }
    out
}

const _: () = assert!(std::mem::size_of::<V>() == 32);

// ------------------------------------------------------------------ the fast path: parse and write in one pass

/// What [`transcode`] wrote: the text JSON.stringify writes of the parsed value (cut off once it passed `stop`:
/// `over`), the value's depth, and whether it is an object.
#[derive(Debug)]
pub struct Transcoded {
    pub out: Vec<u8>,
    pub over: bool,
    pub depth: usize,
    pub object: bool,
}

/// `JSON.stringify(JSON.parse(bytes), null, gap)` (gap 0: no gap) of UTF-8 bytes in one pass. Each value is written
/// as it is read; an object whose members V8 orders otherwise (an array-index key after another key or out of
/// order, a repeated key: first place, last value) has its members' written bytes put in V8's order when it closes,
/// and a key with an escape or an ill-formed byte is decoded, compared and written as JSON.stringify writes it. A
/// string with escapes or ill-formed bytes, and a number not already written as JavaScript writes it, are decoded
/// and written again. `Err` where JSON.parse throws. Past `stop` bytes or `depth_limit` nothing more is written
/// (the whole text is still checked). When a repeated key's object was not written in full (past the stop), the
/// text is read a second time with each superseded value and each later spelling of the key left unwritten, so the
/// size written is the merged document's. `Ok(None)` (the caller parses and stringifies: [`parse`], [`stringify`])
/// only when a planted variant is switched on.
pub fn transcode(bytes: &[u8], gap: usize, stop: usize, depth_limit: usize) -> Result<Option<Transcoded>, Thrown> {
    if variant_planted() {
        return Ok(None);
    }
    transcode_text(bytes, false, gap, stop, depth_limit)
}

/// [`transcode`] of text given as UTF-8 bytes read as Node reads them (`wtf8` false) or as WTF-8 made from UTF-16
/// units (`wtf8` true: a body another charset decoded, [`wtf8_of_units`]), with no planted variant.
fn transcode_text(bytes: &[u8], wtf8: bool, gap: usize, stop: usize, depth_limit: usize) -> Result<Option<Transcoded>, Thrown> {
    let first = one_pass(bytes, wtf8, gap, stop, depth_limit, None)?;
    if !first.retry {
        return Ok(Some(first.done));
    }
    let second = one_pass(bytes, wtf8, gap, stop, depth_limit, Some(&first.plan))?;
    Ok(Some(second.done))
}

/// [`transcode`] of a UTF-16 text (a body another charset decoded); `Ok(None)` under a planted variant.
pub fn transcode_units(units: &[u16], gap: usize, stop: usize, depth_limit: usize) -> Result<Option<Transcoded>, Thrown> {
    if variant_planted() {
        return Ok(None);
    }
    transcode_text(&wtf8_of_units(units), true, gap, stop, depth_limit)
}

/// A planted variant of these rules is on (the one pass leaves the document to the tree).
fn variant_planted() -> bool {
    let planted = variant();
    planted.replacement_per_byte
        || planted.lone_surrogate_raw
        || planted.index_keys_in_place
        || planted.duplicate_last_place
        || planted.proto_dropped
        || planted.negative_zero_kept
        || crate::plant::on(crate::plant::Plant::DuplicateKeyFirstWins)
}

/// What one reading of the text gave: the result, whether a repeated key's object was cut short (so the merged
/// size needs a second reading), and the members that reading leaves unwritten (by object, in the order objects
/// open, and member): [`MUTE_VALUE`] for a value a later definition supersedes, [`MUTE_KEY`] for a later definition's key.
struct Pass {
    done: Transcoded,
    retry: bool,
    plan: std::collections::HashMap<(usize, usize), u8>,
}

const MUTE_VALUE: u8 = 1;
const MUTE_KEY: u8 = 2;

fn one_pass(
    bytes: &[u8],
    wtf8: bool,
    gap: usize,
    stop: usize,
    depth_limit: usize,
    plan: Option<&std::collections::HashMap<(usize, usize), u8>>,
) -> Result<Pass, Thrown> {
    let mut parser = Parser { bytes, at: 0, wtf8 };
    let mut out = Vec::with_capacity(bytes.len().min(stop.saturating_add(1)));
    let mut writing = true;
    // How many times writing has stopped: an object open across a stop was not written in full.
    let mut stops = 0usize;
    // Open values left unwritten by the plan (a superseded value and what it holds).
    let mut muted = 0usize;
    let mut stack: Vec<Open> = Vec::new();
    let mut objects = 0usize;
    let mut keys = KeyText::default();
    let mut found = std::collections::HashMap::new();
    let mut retry = false;
    // The depth of the value just read (containers on its deepest path; a superseded value does not count, as
    // JSON.stringify never sees it).
    let mut value_depth;
    let mut scratch = Vec::new();
    parser.space();
    let object = parser.peek() == Some(b'{');
    // Whether the text so far may still be written (not past the stop, not past the depth limit, not muted).
    macro_rules! emit {
        ($($body:tt)*) => {
            if writing && muted == 0 {
                $($body)*
                if out.len() > stop {
                    writing = false;
                    stops += 1;
                }
            }
        };
    }
    // Text read again after a rewind (bounded by the text's length; past it, a second reading decides).
    let mut reread = 0usize;
    // A member's key and colon (its comma before it, when it has one), unless the plan leaves them out; then
    // whether its value is left out.
    macro_rules! begin_member {
        ($comma:expr) => {{
            let level = stack.len();
            let key = member_key(&mut parser, &mut keys)?;
            let top = stack.last_mut().ok_or(Thrown)?;
            let flags = plan.and_then(|plan| plan.get(&(top.ordinal, top.members.len())).copied()).unwrap_or(0);
            if flags & MUTE_KEY == 0 {
                emit!(if $comma { out.push(b','); });
            }
            let start = out.len();
            if flags & MUTE_KEY == 0 {
                emit!(if gap > 0 { indent(&mut out, gap, level); } push_key(&mut out, &keys, bytes, key); out.extend_from_slice(if gap > 0 { b": " } else { b":" }););
            }
            let value_start = out.len();
            let whole = (writing && muted == 0 && flags & MUTE_VALUE == 0).then_some(stops);
            let top = stack.last_mut().ok_or(Thrown)?;
            if let Some((superseded, later)) = top.member(key, start, value_start, whole, bytes, &keys) {
                *found.entry((top.ordinal, superseded)).or_insert(0) |= MUTE_VALUE;
                *found.entry((top.ordinal, later)).or_insert(0) |= MUTE_KEY;
            }
            if flags & MUTE_VALUE != 0 {
                top.muted_value = true;
                muted += 1;
            }
            parser.space();
            parser.expect(b':')?;
            parser.space();
        }};
    }
    loop {
        // A value starts here.
        match parser.peek().ok_or(Thrown)? {
            open @ (b'{' | b'[') => {
                parser.at += 1;
                // Past the depth limit nothing more is written (inside a value the plan leaves out, nothing is anyway).
                if stack.len() + 1 > depth_limit && writing && muted == 0 {
                    writing = false;
                    stops += 1;
                }
                parser.space();
                let close = if open == b'{' { b'}' } else { b']' };
                if parser.peek() == Some(close) {
                    parser.at += 1;
                    value_depth = 1;
                    emit!(out.push(open); out.push(close););
                } else {
                    emit!(out.push(open););
                    let ordinal = objects;
                    if open == b'{' {
                        objects += 1;
                    }
                    stack.push(Open::new(open == b'{', ordinal, stops));
                    if open == b'{' {
                        begin_member!(false);
                    } else {
                        let level = stack.len();
                        emit!(if gap > 0 {
                            indent(&mut out, gap, level);
                        });
                    }
                    continue;
                }
            }
            b'"' => {
                parser.at += 1;
                let start = parser.at;
                value_depth = 0;
                match plain_string(&mut parser)? {
                    Some(end) => {
                        emit!(out.push(b'"'); out.extend_from_slice(&bytes[start..end]); out.push(b'"'););
                    }
                    None => {
                        // Escapes or ill-formed bytes: decoded, then written as JSON.stringify writes them.
                        parser.at = start;
                        scratch.clear();
                        parser.string(&mut scratch)?;
                        if crate::plant::named("rv-transcode-escape-raw") && !stack.is_empty() && bytes[start..parser.at].contains(&b'\\') {
                            let end = parser.at;
                            emit!(out.push(b'"'); out.extend_from_slice(&bytes[start..end]););
                        } else {
                            emit!(push_string(&mut out, &scratch););
                        }
                    }
                }
            }
            b't' => {
                parser.literal(b"true")?;
                value_depth = 0;
                emit!(out.extend_from_slice(b"true"););
            }
            b'f' => {
                parser.literal(b"false")?;
                value_depth = 0;
                emit!(out.extend_from_slice(b"false"););
            }
            b'n' => {
                parser.literal(b"null")?;
                value_depth = 0;
                emit!(out.extend_from_slice(b"null"););
            }
            _ => {
                value_depth = 0;
                // In an array, a run of numbers with nothing but commas between them is read here, item after item.
                let in_array = stack.last().is_some_and(|top| !top.object);
                let level = stack.len();
                loop {
                    let text = parser.number_text()?;
                    // An integer already written as JavaScript writes it is copied; any other number is converted.
                    if is_canonical_integer(text) || (crate::plant::named("rv-transcode-nested-number-raw") && !stack.is_empty()) {
                        emit!(out.extend_from_slice(text););
                    } else {
                        let number = js::decimal_to_f64(text).ok_or(Thrown)?;
                        emit!(push_number(&mut out, number););
                    }
                    if !in_array || bytes.get(parser.at) != Some(&b',') || !matches!(bytes.get(parser.at + 1), Some(b'0'..=b'9' | b'-')) {
                        break;
                    }
                    parser.at += 1;
                    emit!(out.push(b','); if gap > 0 { indent(&mut out, gap, level); });
                }
            }
        }
        // The value is complete: commas, keys and closes until the next value starts.
        loop {
            parser.space();
            let Some(top) = stack.last_mut() else {
                if parser.at != bytes.len() {
                    return Err(Thrown);
                }
                let over = out.len() > stop;
                return Ok(Pass {
                    done: Transcoded {
                        out,
                        over,
                        depth: value_depth,
                        object,
                    },
                    retry,
                    plan: found,
                });
            };
            // The member's value is complete: a value the plan left out is over.
            if top.muted_value {
                top.muted_value = false;
                muted -= 1;
            }
            match parser.peek() {
                Some(b',') => {
                    let comma = parser.at;
                    parser.at += 1;
                    parser.space();
                    let level = stack.len();
                    let top = stack.last_mut().ok_or(Thrown)?;
                    top.end_member(out.len(), value_depth, comma, objects);
                    if top.object {
                        // A repeated key whose superseded value passed the stop (or the depth limit) while it was
                        // written: that value's bytes are dropped and the text after it is read again, written
                        // (the merged document is then written whole in this reading).
                        let key_at = parser.at;
                        let arena = keys.all.len();
                        let key = member_key(&mut parser, &mut keys)?;
                        let name = keys.bytes(bytes, key);
                        if let Some(first) = top.earlier(name, bytes, &keys) {
                            let superseded = top.last[first];
                            let member = &top.members[superseded];
                            if let Some(at) = member.whole_at_value
                                && (!writing || stops != at)
                                && reread + (key_at - member.input_end) <= bytes.len()
                            {
                                reread += key_at - member.input_end;
                                out.truncate(member.value_start);
                                parser.at = member.input_end;
                                objects = member.objects_after;
                                value_depth = member.depth;
                                stops = at;
                                writing = true;
                                top.rewind_to(superseded, bytes, &keys);
                                continue;
                            }
                        }
                        parser.at = key_at;
                        keys.all.truncate(arena);
                        begin_member!(true);
                    } else {
                        emit!(out.push(b','); if gap > 0 { indent(&mut out, gap, level); });
                    }
                    break;
                }
                Some(close @ (b'}' | b']')) if (close == b'}') == top.object => {
                    parser.at += 1;
                    let mut done = stack.pop().ok_or(Thrown)?;
                    done.end_member(out.len(), value_depth, parser.at - 1, objects);
                    value_depth = 1 + done.child_depth();
                    if done.reorder {
                        if writing && muted == 0 && done.stops == stops {
                            done.put_in_order(&mut out, &mut scratch);
                        } else if done.repeated && plan.is_none() {
                            // Cut short with a repeated key: the merged size needs the second reading.
                            retry = true;
                        }
                        // Otherwise only the order differs (the size is the same and past the stop, or past the
                        // depth limit, or inside a value the plan leaves out).
                    }
                    let level = stack.len();
                    if level < depth_limit && out.len() <= stop {
                        writing = true;
                    }
                    emit!(if gap > 0 { indent(&mut out, gap, level); } out.push(close););
                }
                _ => return Err(Thrown),
            }
        }
    }
}

/// A key of the one pass: a plain key's bytes in the text, or a decoded key's bytes in [`KeyText`].
#[derive(Clone, Copy, Debug)]
enum KeyAt {
    Text(usize, usize),
    Decoded(usize, usize),
}

/// The decoded keys of one pass (keys with an escape or an ill-formed byte), one after another, and the buffer each
/// is decoded in first (so a key's leading low surrogate never merges with the key before it).
#[derive(Default)]
struct KeyText {
    all: Vec<u8>,
    one: Vec<u8>,
}

impl KeyText {
    fn bytes<'a>(&'a self, text: &'a [u8], key: KeyAt) -> &'a [u8] {
        match key {
            KeyAt::Text(start, end) => &text[start..end],
            KeyAt::Decoded(start, end) => &self.all[start..end],
        }
    }
}

/// Reads a member's key (at its opening quote): the key, its decoded bytes kept when it has an escape.
fn member_key(parser: &mut Parser, keys: &mut KeyText) -> Result<KeyAt, Thrown> {
    parser.expect(b'"')?;
    let start = parser.at;
    if let Some(end) = plain_string(parser)? {
        return Ok(KeyAt::Text(start, end));
    }
    parser.at = start;
    keys.one.clear();
    parser.string(&mut keys.one)?;
    let from = keys.all.len();
    keys.all.extend_from_slice(&keys.one);
    Ok(KeyAt::Decoded(from, keys.all.len()))
}

/// A key as JSON.stringify writes it.
fn push_key(out: &mut Vec<u8>, keys: &KeyText, text: &[u8], key: KeyAt) {
    match key {
        KeyAt::Text(start, end) => {
            out.push(b'"');
            out.extend_from_slice(&text[start..end]);
            out.push(b'"');
        }
        KeyAt::Decoded(..) => push_string(out, keys.bytes(text, key)),
    }
}

/// One member of an object the one pass writes: where its bytes are in the output (from its indentation, after
/// the comma before it; its value from `value_start`), its key, its array index, and the member that first
/// defined its key.
struct Member {
    start: usize,
    value_start: usize,
    end: usize,
    key: KeyAt,
    index: Option<u32>,
    first: usize,
    /// The depth of its value.
    depth: usize,
    /// The writer's stop count when its value began, if its value was being written then.
    whole_at_value: Option<usize>,
    /// Where its value ends in the text, and how many objects had opened by then.
    input_end: usize,
    objects_after: usize,
}

/// An open container of the one pass.
struct Open {
    object: bool,
    members: Vec<Member>,
    /// For each member that first defined its key, the member whose value is the key's last (V8's last value).
    last: Vec<usize>,
    /// From 16 members on: the first definitions by their keys' keyed hashes.
    by_hash: Option<KeyTable>,
    named_seen: bool,
    last_index: Option<u32>,
    /// V8 orders the members otherwise than they were written.
    reorder: bool,
    /// A key is defined twice.
    repeated: bool,
    /// The writer's stop count when the container opened.
    stops: usize,
    /// This object's place among the objects of the text, in the order they open.
    ordinal: usize,
    /// The member's value is being read unwritten (the second reading's plan).
    muted_value: bool,
    /// The deepest member value so far (an array's items; an object's, superseded ones included).
    deepest_child: usize,
}

impl Open {
    fn new(object: bool, ordinal: usize, stops: usize) -> Open {
        Open {
            ordinal,
            muted_value: false,
            deepest_child: 0,
            object,
            members: Vec::new(),
            last: Vec::new(),
            by_hash: None,
            named_seen: false,
            last_index: None,
            reorder: false,
            repeated: false,
            stops,
        }
    }

    /// A member begins: its key, found among the earlier ones (bytes compared, decoded keys as decoded). For a
    /// repeated key: the member whose value it supersedes, and itself.
    /// The member that first defined `name`, if one did.
    fn earlier(&self, name: &[u8], text: &[u8], keys: &KeyText) -> Option<usize> {
        match &self.by_hash {
            None => self
                .members
                .iter()
                .enumerate()
                .find(|(id, member)| member.first == *id && keys.bytes(text, member.key) == name)
                .map(|(id, _)| id),
            Some(table) => table.find(name, |id| keys.bytes(text, self.members[id].key)),
        }
    }

    fn member(&mut self, key: KeyAt, start: usize, value_start: usize, whole_at_value: Option<usize>, text: &[u8], keys: &KeyText) -> Option<(usize, usize)> {
        let name = keys.bytes(text, key);
        let at = self.members.len();
        let earlier = self.earlier(name, text, keys);
        let index = array_index(name);
        self.members.push(Member {
            start,
            value_start,
            end: value_start,
            key,
            index,
            first: earlier.unwrap_or(at),
            depth: 0,
            whole_at_value,
            input_end: 0,
            objects_after: 0,
        });
        self.last.push(at);
        if let Some(first) = earlier {
            let superseded = self.last[first];
            self.last[first] = at;
            self.repeated = true;
            self.reorder = true;
            return Some((superseded, at));
        }
        match &mut self.by_hash {
            Some(table) => table.add(name, at),
            None if self.members.len() >= 16 => {
                let mut table = KeyTable::default();
                for (id, member) in self.members.iter().enumerate().filter(|(id, member)| member.first == *id) {
                    table.add(keys.bytes(text, member.key), id);
                }
                self.by_hash = Some(table);
            }
            None => {}
        }
        match index {
            Some(index) => {
                if self.named_seen || self.last_index.is_some_and(|last| last > index) {
                    self.reorder = true;
                }
                self.last_index = Some(index);
            }
            None => self.named_seen = true,
        }
        None
    }

    /// The value of the member (or item) just read is complete: where its bytes end, its depth, where it ends in
    /// the text and how many objects had opened by then.
    fn end_member(&mut self, end: usize, depth: usize, input_end: usize, objects_after: usize) {
        self.deepest_child = self.deepest_child.max(depth);
        if let Some(member) = self.members.last_mut() {
            member.end = end;
            member.depth = depth;
            member.input_end = input_end;
            member.objects_after = objects_after;
        }
    }

    /// Back to the end of member `kept`'s value, its bytes dropped (a later definition supersedes it): the members
    /// after it are forgotten (they are read again), and what was derived from them is derived again.
    fn rewind_to(&mut self, kept: usize, text: &[u8], keys: &KeyText) {
        self.members.truncate(kept + 1);
        let member = &mut self.members[kept];
        member.end = member.value_start;
        member.whole_at_value = None;
        self.last = (0..=kept).collect();
        self.repeated = false;
        self.reorder = false;
        self.named_seen = false;
        self.last_index = None;
        self.deepest_child = 0;
        let mut table = (self.members.len() >= 16).then(KeyTable::default);
        for at in 0..=kept {
            let member = &self.members[at];
            self.deepest_child = self.deepest_child.max(member.depth);
            if member.first != at {
                self.last[member.first] = at;
                self.repeated = true;
                self.reorder = true;
                continue;
            }
            if let Some(table) = &mut table {
                table.add(keys.bytes(text, member.key), at);
            }
            match member.index {
                Some(index) => {
                    if self.named_seen || self.last_index.is_some_and(|last| last > index) {
                        self.reorder = true;
                    }
                    self.last_index = Some(index);
                }
                None => self.named_seen = true,
            }
        }
        self.by_hash = table;
    }

    /// The deepest member value of the container as V8 keeps it: with a repeated key, its last value's.
    fn child_depth(&self) -> usize {
        if !self.repeated {
            return self.deepest_child;
        }
        (0..self.members.len())
            .filter(|at| self.members[*at].first == *at)
            .map(|at| self.members[self.last[at]].depth)
            .max()
            .unwrap_or(0)
    }

    /// Puts the members' written bytes in V8's order: array indices ascending, then the other keys where they were
    /// first defined, each with its key's last value.
    fn put_in_order(&self, out: &mut Vec<u8>, scratch: &mut Vec<u8>) {
        let Some(base) = self.members.first().map(|member| member.start) else {
            return;
        };
        scratch.clear();
        scratch.extend_from_slice(&out[base..]);
        out.truncate(base);
        let firsts = self.members.iter().enumerate().filter(|(at, member)| member.first == *at);
        let mut indexed: Vec<(u32, usize)> = firsts.clone().filter_map(|(at, member)| member.index.map(|index| (index, at))).collect();
        indexed.sort_unstable();
        let order = indexed
            .into_iter()
            .map(|(_, at)| at)
            .chain(firsts.filter(|(_, member)| member.index.is_none()).map(|(at, _)| at));
        for (place, at) in order.enumerate() {
            if place > 0 {
                out.push(b',');
            }
            let first = &self.members[at];
            let last = &self.members[self.last[at]];
            out.extend_from_slice(&scratch[first.start - base..first.value_start - base]);
            out.extend_from_slice(&scratch[last.value_start - base..last.end - base]);
        }
    }
}

/// A string after its opening quote: `Some(end)` (the closing quote consumed) when it has no escape and its bytes
/// are well-formed UTF-8, so JSON.stringify writes it as it stands; `None` (nothing consumed that matters: the
/// caller starts again at the string's start) otherwise. `Err` for a raw control character or a missing quote.
fn plain_string(parser: &mut Parser) -> Result<Option<usize>, Thrown> {
    let bytes = parser.bytes;
    let start = parser.at;
    let mut at = start;
    loop {
        at += plain_run(bytes.get(at..).unwrap_or_default());
        let byte = *bytes.get(at).ok_or(Thrown)?;
        match byte {
            b'"' => {
                parser.at = at + 1;
                return Ok(Some(at));
            }
            b'\\' => return Ok(None),
            0..=0x1f => return Err(Thrown),
            0x20..=0x7f => at += 1,
            _ => {
                let (point, length) = decode_at(bytes, at, parser.wtf8);
                // An ill-formed sequence (U+FFFD in its place), or in WTF-8 a lone surrogate (written escaped).
                if (point == 0xfffd && bytes.get(at..at + length) != Some(&[0xef, 0xbf, 0xbd][..])) || (0xd800..0xe000).contains(&point) {
                    return Ok(None);
                }
                at += length;
            }
        }
    }
}

/// The length of the leading run of bytes a string may hold as they stand: printable ASCII other than `"` and `\\`.
/// Eight bytes at a time: a word's first byte below 0x20, equal to `"` or `\\`, or above 0x7f is found exactly by the
/// usual borrow tricks (a borrow can flag a byte after a flagged one, never before it).
fn plain_run(bytes: &[u8]) -> usize {
    const ONES: u64 = 0x0101_0101_0101_0101;
    const HIGH: u64 = 0x8080_8080_8080_8080;
    let zero_in = |word: u64| word.wrapping_sub(ONES) & !word & HIGH;
    let mut at = 0;
    while let Some(chunk) = bytes.get(at..at + 8) {
        let mut word = [0u8; 8];
        word.copy_from_slice(chunk);
        let word = u64::from_le_bytes(word);
        let special = (word.wrapping_sub(0x20 * ONES) & !word & HIGH)
            | zero_in(word ^ (u64::from(b'"') * ONES))
            | zero_in(word ^ (u64::from(b'\\') * ONES))
            | (word & HIGH);
        if special != 0 {
            return at + (special.trailing_zeros() / 8) as usize;
        }
        at += 8;
    }
    at + bytes[at..]
        .iter()
        .position(|byte| !(0x20..0x80).contains(byte) || *byte == b'"' || *byte == b'\\')
        .unwrap_or(bytes.len() - at)
}

/// The length of the leading run of WTF-8 bytes JSON.stringify writes as they stand: anything but a control byte,
/// `"`, `\\` and 0xED (the lead byte of a surrogate's encoding, which may be lone). Eight bytes at a time, with
/// [`plain_run`]'s tricks: a byte at or above 0x80 is never flagged by the control-byte term (its high bit is set).
fn quoted_run(bytes: &[u8]) -> usize {
    const ONES: u64 = 0x0101_0101_0101_0101;
    const HIGH: u64 = 0x8080_8080_8080_8080;
    let zero_in = |word: u64| word.wrapping_sub(ONES) & !word & HIGH;
    let mut at = 0;
    while let Some(chunk) = bytes.get(at..at + 8) {
        let mut word = [0u8; 8];
        word.copy_from_slice(chunk);
        let word = u64::from_le_bytes(word);
        let special = (word.wrapping_sub(0x20 * ONES) & !word & HIGH)
            | zero_in(word ^ (u64::from(b'"') * ONES))
            | zero_in(word ^ (u64::from(b'\\') * ONES))
            | zero_in(word ^ (0xed * ONES));
        if special != 0 {
            return at + (special.trailing_zeros() / 8) as usize;
        }
        at += 8;
    }
    at + bytes[at..]
        .iter()
        .position(|byte| *byte < 0x20 || *byte == b'"' || *byte == b'\\' || *byte == 0xed)
        .unwrap_or(bytes.len() - at)
}

/// An integer JavaScript writes as it stands: `-?(0|[1-9][0-9]{0,14})`, never `-0`.
fn is_canonical_integer(text: &[u8]) -> bool {
    let digits = text.strip_prefix(b"-").unwrap_or(text);
    !digits.is_empty()
        && (digits.len() <= 15 || crate::plant::named("rv-canonical-integer-any-length"))
        && digits.iter().all(u8::is_ascii_digit)
        && (digits[0] != b'0' || digits.len() == 1)
        && text != b"-0"
}

#[cfg(test)]
mod transcode_tests {
    use super::*;

    fn slow(text: &[u8], gap: usize) -> Option<Vec<u8>> {
        parse(text, false)
            .ok()
            .and_then(|parsed| parsed.value)
            .map(|value| stringify(&value, gap, usize::MAX))
    }

    #[test]
    fn the_fast_path_writes_what_the_tree_writes() {
        let cases: &[&[u8]] = &[
            br#"{"version":1,"foldersMap":{"/p":[{"id":"f","n":null,"t":true,"x":[1,-2,0,1.5,1e2,-0,12345678901234567]}]},"e":{},"a":[]}"#,
            b" [ \"a\\u0041\\n\", \"\\ud800\", \"x\xff\", \"\xf0\x9f\x98\x80\", 0.1 , [[[]]] ] ",
            b"\"top\"",
            b"-0",
            b"{\"a\":{\"b\":{\"c\":[1,{\"d\":2}]}}}",
        ];
        for text in cases {
            for gap in [0, 2] {
                let fast = transcode(text, gap, usize::MAX, usize::MAX)
                    .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(text)))
                    .unwrap();
                assert_eq!(Some(fast.out), slow(text, gap), "{}", String::from_utf8_lossy(text));
            }
        }
        // Members V8 orders otherwise, repeated keys, escaped keys (two lone surrogates in two keys stay two keys).
        for text in [
            &br#"{"1":1}"#[..],
            br#"{"a":1,"a":2}"#,
            b"{\"\\u0061\":1,\"a\":[2,{\"2\":0,\"1\":1,\"x\":{\"y\":1,\"y\":[]}}],\"0\":3}",
            b"{\"\\ud800\":1,\"\\udc00\":2,\"\\u0031\":3,\"1\":4,\"01\":5,\"4294967295\":6,\"4294967294\":7}",
            b"[{\"b\":1,\"a\":2,\"b\":3},{\"9\":9,\"10\":10,\"8\":8}]",
        ] {
            for gap in [0, 2] {
                let fast = transcode(text, gap, usize::MAX, usize::MAX).unwrap().unwrap();
                assert_eq!(Some(fast.out), slow(text, gap), "{}", String::from_utf8_lossy(text));
            }
        }
        // A repeated key in an object written past the stop: read again with the superseded value unwritten.
        for (text, stop) in [
            (&br#"{"a":[1,2,3,4,5,6,7,8],"a":1}"#[..], 10),
            (br#"{"a":[1,2,3,4,5,6,7,8],"b":[3],"a":{"c":[9,9,9,9]},"a":1}"#, 12),
            (br#"[{"x":[1,2,3,4,5,6],"x":2},{"y":1,"y":[1,2,3,4,5,6,7,8,9]}]"#, 20),
        ] {
            for gap in [0, 2] {
                let merged = slow(text, gap).unwrap();
                let fast = transcode(text, gap, stop, usize::MAX).unwrap().unwrap();
                assert_eq!(fast.over, merged.len() > stop, "{}", String::from_utf8_lossy(text));
                if !fast.over {
                    assert_eq!(fast.out, merged);
                }
            }
        }
        // A superseded value counts for nothing: not its depth (JSON.stringify never walks it), not its size (its bytes,
        // past the stop, are dropped when the next member redefines its key, and writing goes on in the same reading).
        let deep = format!("{{\"a\":{}1{},\"a\":1}}", "[".repeat(6000), "]".repeat(6000));
        let merged = transcode(deep.as_bytes(), 2, usize::MAX, DEPTH_LIMIT).unwrap().unwrap();
        assert_eq!((merged.depth, merged.out.as_slice()), (1, &b"{\n  \"a\": 1\n}"[..]));
        let long = format!("{{\"a\":[{}],\"a\":[2]}}", vec!["1"; 1000].join(","));
        let merged = transcode(long.as_bytes(), 2, 100, usize::MAX).unwrap().unwrap();
        assert_eq!((merged.over, merged.out.as_slice()), (false, &b"{\n  \"a\": [\n    2\n  ]\n}"[..]));
        // Members after the superseded value are read again (written now), objects in them keep their places, and
        // past the re-reading budget the second reading decides: the same document every way.
        let big = vec!["1"; 300].join(",");
        let cases = [
            format!("{{\"a\":[{big}],\"b\":[2,{{\"9\":0,\"8\":1}}],\"c\":{{\"d\":1,\"d\":2}},\"a\":1}}"),
            format!("{{\"k1\":[{big}],\"k2\":[{big}],\"k3\":[{big}],\"k1\":{{\"x\":[{big}]}},\"k2\":1,\"k3\":2,\"k1\":3}}"),
            format!("[{{\"a\":[{big}],\"a\":0}},{{\"b\":[{big}],\"c\":[{big}],\"b\":1,\"c\":2}}]"),
        ];
        for text in &cases {
            for (gap, stop) in [(0, 40), (2, 40), (2, 900), (0, usize::MAX)] {
                let merged = slow(text.as_bytes(), gap).unwrap();
                let fast = transcode(text.as_bytes(), gap, stop, usize::MAX).unwrap().unwrap();
                assert_eq!(fast.over, merged.len() > stop, "{text} {gap} {stop}");
                if !fast.over {
                    assert_eq!(fast.out, merged, "{text} {gap} {stop}");
                }
            }
        }
        // UTF-16 text (another charset's body) in one pass: a lone surrogate unit stays one, escaped when written.
        let units: Vec<u16> = "{\"b\":\"x\u{1f600}\",\"1\":[\""
            .encode_utf16()
            .chain([0xd800, 0x41])
            .chain("\"]}".encode_utf16())
            .collect();
        for gap in [0, 2] {
            let tree = stringify(from_units(&units, None).unwrap().value.as_ref().unwrap(), gap, usize::MAX);
            assert_eq!(transcode_units(&units, gap, usize::MAX, usize::MAX).unwrap().unwrap().out, tree);
        }
        // Only the order differs past the stop: the size is known (over).
        assert!(transcode(br#"{"a":[1,2,3,4,5,6,7,8],"1":1}"#, 2, 10, usize::MAX).unwrap().unwrap().over);
        for text in [&b"[1,]"[..], b"{\"a\" 1}", b"\xef\xbb\xbf{}", b"[\"\x01\"]", b"{}x", b"[01]"] {
            assert!(transcode(text, 0, usize::MAX, usize::MAX).is_err(), "{}", String::from_utf8_lossy(text));
        }
        let deep = format!("{}0{}", "{\"a\":".repeat(50), "}".repeat(50));
        let limited = transcode(deep.as_bytes(), 2, usize::MAX, 10).unwrap().unwrap();
        assert_eq!((limited.depth, limited.object), (50, true));
        let cut = transcode(deep.as_bytes(), 2, 100, usize::MAX).unwrap().unwrap();
        assert!(cut.over && cut.out.len() < 200);
    }
}

//! `JSON.parse` and `JSON.stringify` as V8 computes them, byte for byte,
//! up to a fixed nesting depth.
//!
//! The specification is research file 28, section 4.3; the tests compare
//! every rule with Node itself (`tests/generate-json.mjs`). Both directions
//! are iterative.
//!
//! **Depth: a deliberate difference from V8.** V8 parses any depth, and its
//! `JSON.stringify` recurses and throws a `RangeError` at a depth that
//! depends on the value's shape, the thread and the version (measured
//! 2026-11-12: from 2,688 levels of `{"0":…}` on Node 26's main thread to
//! 400,000 levels of `[{"a":…}]`; 3,634 on Electron's Node 24 main thread,
//! 14,524 on its worker thread). That cannot be reproduced, so both
//! directions here refuse more than `MAX_DEPTH` nested containers: `parse`
//! with `ParseErrorKind::TooDeep`, `stringify` with `TooDeep`. Callers fail
//! closed (the native ledger falls back). The deepest record of the
//! aged-profile corpus has depth 5, so the bound is about 100 times what the
//! ledger stores and about 5 times below the smallest V8 limit observed.

use super::number::write_number;
use super::string::JsStr;
use super::value::{JsObject, Key, Value};

/// The most containers `parse` and `stringify` nest (`[]` is depth 1).
pub const MAX_DEPTH: usize = 512;

/// Why a text is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseErrorKind {
    /// `JSON.parse` throws a `SyntaxError`.
    Syntax,
    /// Nesting deeper than `MAX_DEPTH` (V8 would accept it).
    TooDeep,
}

/// A refused text. `position` is the code-unit offset where parsing stopped;
/// it is not V8's message position and nothing should depend on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub position: usize,
    pub kind: ParseErrorKind,
}

/// `stringify` met a value nested deeper than `MAX_DEPTH`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TooDeep;

const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;

fn is_whitespace(unit: u16) -> bool {
    // JSON's whitespace only: no NBSP, no BOM, no U+2028.
    matches!(unit, 0x20 | 0x09 | 0x0a | 0x0d)
}

enum Frame {
    Array(Vec<Value>),
    /// An object and the key whose value is being parsed.
    Object(JsObject, JsStr),
}

struct Parser<'a> {
    text: &'a [u16],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.text.get(self.at).copied()
    }

    fn error<T>(&self) -> Result<T, ParseError> {
        Err(ParseError {
            position: self.at,
            kind: ParseErrorKind::Syntax,
        })
    }

    /// Refuses a container that would be nested deeper than `MAX_DEPTH`.
    fn deeper(&self, stack: &[Frame]) -> Result<(), ParseError> {
        if stack.len() >= MAX_DEPTH {
            return Err(ParseError {
                position: self.at,
                kind: ParseErrorKind::TooDeep,
            });
        }
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(is_whitespace) {
            self.at += 1;
        }
    }

    fn expect(&mut self, unit: u8) -> Result<(), ParseError> {
        if self.peek() == Some(u16::from(unit)) {
            self.at += 1;
            Ok(())
        } else {
            self.error()
        }
    }

    fn literal(&mut self, word: &[u8], value: Value) -> Result<Value, ParseError> {
        for &byte in word {
            self.expect(byte)?;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<JsStr, ParseError> {
        self.expect(b'"')?;
        let mut units = Vec::new();
        loop {
            let start = self.at;
            while let Some(unit) = self.peek() {
                if unit == QUOTE || unit == BACKSLASH || unit < 0x20 {
                    break;
                }
                self.at += 1;
            }
            units.extend_from_slice(&self.text[start..self.at]);
            match self.peek() {
                Some(QUOTE) => {
                    self.at += 1;
                    return Ok(JsStr::from_units(units));
                }
                Some(BACKSLASH) => {
                    self.at += 1;
                    let escaped = match self.peek() {
                        Some(0x22) => 0x22,
                        Some(0x5c) => 0x5c,
                        Some(0x2f) => 0x2f,
                        Some(0x62) => 0x08,
                        Some(0x66) => 0x0c,
                        Some(0x6e) => 0x0a,
                        Some(0x72) => 0x0d,
                        Some(0x74) => 0x09,
                        Some(0x75) => {
                            let mut code = 0u16;
                            for offset in 1..=4 {
                                let digit = self
                                    .text
                                    .get(self.at + offset)
                                    .and_then(|unit| char::from_u32(u32::from(*unit)))
                                    .and_then(|character| character.to_digit(16));
                                match digit {
                                    Some(digit) => code = code * 16 + digit as u16,
                                    None => {
                                        self.at += offset;
                                        return self.error();
                                    }
                                }
                            }
                            self.at += 4;
                            code
                        }
                        _ => return self.error(),
                    };
                    self.at += 1;
                    units.push(escaped);
                }
                // A raw control character, or the end of the text.
                _ => return self.error(),
            }
        }
    }

    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.at;
        let digit = |unit: Option<u16>| unit.is_some_and(|unit| (0x30..=0x39).contains(&unit));
        if self.peek() == Some(u16::from(b'-')) {
            self.at += 1;
        }
        match self.peek() {
            Some(0x30) => self.at += 1,
            Some(0x31..=0x39) => {
                while digit(self.peek()) {
                    self.at += 1;
                }
            }
            _ => return self.error(),
        }
        if self.peek() == Some(u16::from(b'.')) {
            self.at += 1;
            if !digit(self.peek()) {
                return self.error();
            }
            while digit(self.peek()) {
                self.at += 1;
            }
        }
        if matches!(self.peek(), Some(0x45 | 0x65)) {
            self.at += 1;
            if matches!(self.peek(), Some(0x2b | 0x2d)) {
                self.at += 1;
            }
            if !digit(self.peek()) {
                return self.error();
            }
            while digit(self.peek()) {
                self.at += 1;
            }
        }
        // The grammar above admits only ASCII; Rust's parse is correctly
        // rounded, as V8's is, and saturates to infinity or zero.
        let text: String = self.text[start..self.at]
            .iter()
            .map(|unit| *unit as u8 as char)
            .collect();
        Ok(Value::Number(
            text.parse()
                .expect("the JSON number grammar is a Rust float"),
        ))
    }

    /// A scalar, or the opening of a container (pushed onto `stack`).
    fn value_start(&mut self, stack: &mut Vec<Frame>) -> Result<Option<Value>, ParseError> {
        self.skip_whitespace();
        let value = match self.peek() {
            Some(0x7b) => {
                self.deeper(stack)?;
                self.at += 1;
                self.skip_whitespace();
                if self.peek() == Some(0x7d) {
                    self.at += 1;
                    Value::Object(JsObject::new())
                } else {
                    let key = self.key()?;
                    stack.push(Frame::Object(JsObject::new(), key));
                    return Ok(None);
                }
            }
            Some(0x5b) => {
                self.deeper(stack)?;
                self.at += 1;
                self.skip_whitespace();
                if self.peek() == Some(0x5d) {
                    self.at += 1;
                    Value::Array(Vec::new())
                } else {
                    stack.push(Frame::Array(Vec::new()));
                    return Ok(None);
                }
            }
            Some(QUOTE) => Value::String(self.string()?),
            Some(0x74) => self.literal(b"true", Value::Bool(true))?,
            Some(0x66) => self.literal(b"false", Value::Bool(false))?,
            Some(0x6e) => self.literal(b"null", Value::Null)?,
            Some(0x2d | 0x30..=0x39) => self.number()?,
            _ => return self.error(),
        };
        Ok(Some(value))
    }

    /// `"key"` then `:`, with whitespace around.
    fn key(&mut self) -> Result<JsStr, ParseError> {
        self.skip_whitespace();
        if self.peek() != Some(QUOTE) {
            return self.error();
        }
        let key = self.string()?;
        self.skip_whitespace();
        self.expect(b':')?;
        Ok(key)
    }
}

/// `JSON.parse(text)` without a reviver, for texts nested at most
/// `MAX_DEPTH` deep. Duplicate keys keep their first position and take the
/// last value; `"__proto__"` is an ordinary property.
pub fn parse(text: &[u16]) -> Result<Value, ParseError> {
    let mut parser = Parser { text, at: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    loop {
        let Some(mut value) = parser.value_start(&mut stack)? else {
            continue;
        };
        // Hand the finished value to its container, closing containers as
        // they end, until one expects another element.
        loop {
            match stack.last_mut() {
                None => {
                    parser.skip_whitespace();
                    if parser.at != text.len() {
                        return parser.error();
                    }
                    return Ok(value);
                }
                Some(Frame::Array(items)) => {
                    items.push(value);
                    parser.skip_whitespace();
                    match parser.peek() {
                        Some(0x2c) => {
                            parser.at += 1;
                            break;
                        }
                        Some(0x5d) => {
                            parser.at += 1;
                            let Some(Frame::Array(items)) = stack.pop() else {
                                unreachable!()
                            };
                            value = Value::Array(items);
                        }
                        _ => return parser.error(),
                    }
                }
                Some(Frame::Object(object, key)) => {
                    object.insert(std::mem::take(key), value);
                    parser.skip_whitespace();
                    match parser.peek() {
                        Some(0x2c) => {
                            parser.at += 1;
                            *key = parser.key()?;
                            break;
                        }
                        Some(0x7d) => {
                            parser.at += 1;
                            let Some(Frame::Object(object, _)) = stack.pop() else {
                                unreachable!()
                            };
                            value = Value::Object(object);
                        }
                        _ => return parser.error(),
                    }
                }
            }
        }
    }
}

/// `JSON.parse(buffer.toString('utf8'))`: a record's bytes as Node reads them.
pub fn parse_utf8(bytes: &[u8]) -> Result<Value, ParseError> {
    parse(JsStr::from_utf8_lossy(bytes).units())
}

/// Appends a string as `JSON.stringify` quotes it (well-formed stringify,
/// ES2019): `"` and `\` escaped, `\b \f \n \r \t`, other units below 0x20
/// as `\u00xx`, lone surrogates as `\udxxx` (lowercase hex), everything else
/// literal (U+2028, U+2029, `/` and DEL included), as UTF-8.
pub fn write_json_string(out: &mut Vec<u8>, units: &[u16]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        match unit {
            0x22 => out.extend_from_slice(b"\\\""),
            0x5c => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0a => out.extend_from_slice(b"\\n"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x00..=0x1f => {
                out.extend_from_slice(b"\\u00");
                out.push(HEX[usize::from(unit >> 4)]);
                out.push(HEX[usize::from(unit & 0xf)]);
            }
            0x20..=0x7f => out.push(unit as u8),
            0xd800..=0xdbff
                if units
                    .get(index)
                    .is_some_and(|low| (0xdc00..=0xdfff).contains(low)) =>
            {
                let low = units[index];
                index += 1;
                let code = 0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                let character = char::from_u32(code).expect("a surrogate pair is a scalar value");
                out.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
            }
            0xd800..=0xdfff => {
                out.extend_from_slice(b"\\u");
                for shift in [12, 8, 4, 0] {
                    out.push(HEX[usize::from((unit >> shift) & 0xf)]);
                }
            }
            _ => {
                let character = char::from_u32(u32::from(unit))
                    .expect("a non-surrogate unit is a scalar value");
                out.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
            }
        }
    }
    out.push(b'"');
}

enum Cursor<'a> {
    Array(&'a [Value], usize),
    /// The object's entries in enumeration order, and whether one was written.
    Object(Box<dyn Iterator<Item = (Key<'a>, &'a Value)> + 'a>, bool),
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// `JSON.stringify`, refusing more than `MAX_DEPTH` levels.
    Json,
    /// `Debug`: no bound, `undefined`, `NaN` and the infinities spelled out.
    Debug,
}

/// Writes a scalar, or opens a container and returns its cursor.
fn write_start<'a>(out: &mut Vec<u8>, value: &'a Value, mode: Mode) -> Option<Cursor<'a>> {
    match value {
        Value::Undefined if mode == Mode::Debug => out.extend_from_slice(b"undefined"),
        Value::Undefined | Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(number) if !number.is_finite() && mode == Mode::Json => {
            out.extend_from_slice(b"null")
        }
        Value::Number(number) => {
            let mut text = String::new();
            write_number(&mut text, *number);
            out.extend_from_slice(text.as_bytes());
        }
        Value::String(text) => write_json_string(out, text.units()),
        Value::Array(items) => {
            out.push(b'[');
            return Some(Cursor::Array(items, 0));
        }
        Value::Object(object) => {
            out.push(b'{');
            return Some(Cursor::Object(Box::new(object.entries()), false));
        }
    }
    None
}

fn write_value(value: &Value, mode: Mode) -> Result<Vec<u8>, TooDeep> {
    let mut out = Vec::new();
    let mut stack: Vec<Cursor<'_>> = write_start(&mut out, value, mode).into_iter().collect();
    while let Some(cursor) = stack.last_mut() {
        let next = match cursor {
            Cursor::Array(items, index) => {
                if *index == items.len() {
                    out.push(b']');
                    stack.pop();
                    continue;
                }
                if *index > 0 {
                    out.push(b',');
                }
                *index += 1;
                // `undefined` in an array is written as null (write_start does).
                &items[*index - 1]
            }
            Cursor::Object(entries, wrote) => {
                // `undefined` properties are omitted (but shown by Debug).
                let entry = entries
                    .find(|(_, value)| mode == Mode::Debug || !matches!(value, Value::Undefined));
                let Some((key, value)) = entry else {
                    out.push(b'}');
                    stack.pop();
                    continue;
                };
                if *wrote {
                    out.push(b',');
                }
                *wrote = true;
                match key {
                    Key::Index(index) => {
                        out.push(b'"');
                        out.extend_from_slice(index.to_string().as_bytes());
                        out.push(b'"');
                    }
                    Key::Named(key) => write_json_string(&mut out, key.units()),
                }
                out.push(b':');
                value
            }
        };
        if let Some(cursor) = write_start(&mut out, next, mode) {
            if mode == Mode::Json && stack.len() >= MAX_DEPTH {
                return Err(TooDeep);
            }
            stack.push(cursor);
        }
    }
    Ok(out)
}

/// `JSON.stringify(value)` as UTF-8 bytes (`Buffer.from(JSON.stringify(value))`;
/// the text is always well-formed, so the conversion loses nothing).
/// `Ok(None)` where `JSON.stringify` returns `undefined`; `Err(TooDeep)` for
/// a value nested deeper than `MAX_DEPTH`.
pub fn stringify_utf8(value: &Value) -> Result<Option<Vec<u8>>, TooDeep> {
    if matches!(value, Value::Undefined) {
        return Ok(None);
    }
    write_value(value, Mode::Json).map(Some)
}

/// `JSON.stringify(value)` as a JavaScript string.
pub fn stringify(value: &Value) -> Result<Option<JsStr>, TooDeep> {
    Ok(stringify_utf8(value)?
        .map(|bytes| JsStr::from(std::str::from_utf8(&bytes).expect("stringify writes UTF-8"))))
}

/// The text `Value`'s `Debug` prints.
pub(super) fn debug_text(value: &Value) -> Vec<u8> {
    write_value(value, Mode::Debug).expect("Debug has no depth bound")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(text: &str) -> Result<String, ParseError> {
        let value = parse(&text.encode_utf16().collect::<Vec<_>>())?;
        Ok(String::from_utf8(stringify_utf8(&value).unwrap().unwrap()).unwrap())
    }

    #[test]
    fn duplicate_keys_index_keys_and_proto() {
        assert_eq!(
            round(r#"{"b":1,"4294967295":2,"4294967294":3,"1":4,"01":5,"-0":6,"0":7,"__proto__":8,"b":9,"10":10,"9":11}"#),
            Ok(r#"{"0":7,"1":4,"9":11,"10":10,"4294967294":3,"b":9,"4294967295":2,"01":5,"-0":6,"__proto__":8}"#.to_string())
        );
    }

    #[test]
    fn values_and_escapes() {
        assert_eq!(
            round(r#" [1E5 , -0, 1e400, 1e-400, "\/\u00e9\uD800", true, null, {}] "#),
            Ok("[100000,0,null,0,\"/é\\ud800\",true,null,{}]".to_string())
        );
        assert_eq!(
            round("\"\u{7f}\u{2028}\\u0000\\u001f\\b\\f\\n\\r\\t\\u000b\""),
            Ok("\"\u{7f}\u{2028}\\u0000\\u001f\\b\\f\\n\\r\\t\\u000b\"".to_string())
        );
    }

    #[test]
    fn malformed_text_is_refused() {
        for text in [
            "",
            " ",
            "01",
            "1.",
            ".5",
            "+1",
            "-",
            "1e",
            "1e+",
            "0x1",
            "[1,]",
            "{\"a\":1,}",
            "\"\\x\"",
            "\"\\u12\"",
            " \u{a0} 1",
            "\u{feff}1",
            "\"\t\"",
            "1 2",
            "nul",
            "[]x",
            "{\"a\" 1}",
            "{1:2}",
            "[",
            "{",
            "\"",
            "\"\\u00e9",
            "\"\\\u{ff55}0000\"",
        ] {
            assert!(round(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn undefined_is_omitted_or_null() {
        let mut object = JsObject::new();
        object.set("a", Value::Undefined);
        object.set(
            "b",
            Value::Array(vec![Value::Undefined, Value::Number(f64::NAN)]),
        );
        object.set("c", Value::Undefined);
        assert_eq!(
            stringify_utf8(&Value::Object(object)).unwrap().unwrap(),
            br#"{"b":[null,null]}"#.to_vec()
        );
        assert_eq!(stringify_utf8(&Value::Undefined), Ok(None));
    }

    fn nested(depth: usize) -> String {
        // Alternating arrays and objects with index keys, the shape V8
        // stringifies least deep.
        let (mut open, mut close) = (String::new(), String::new());
        for level in 0..depth {
            if level % 2 == 0 {
                open.push('[');
                close.push(']');
            } else {
                open.push_str("{\"0\":");
                close.push('}');
            }
        }
        let close: String = close.chars().rev().collect();
        format!("{open}1{close}")
    }

    #[test]
    fn the_depth_bound_holds_on_both_sides() {
        let at_bound = nested(MAX_DEPTH);
        assert_eq!(round(&at_bound), Ok(at_bound.clone()));
        for depth in [MAX_DEPTH + 1, MAX_DEPTH + 2, 10_000, 1_000_000] {
            assert_eq!(
                round(&nested(depth)).map_err(|error| error.kind),
                Err(ParseErrorKind::TooDeep),
                "{depth}"
            );
        }
        // Built in Rust past the bound: stringify refuses, nothing aborts.
        let mut value = Value::Number(1.0);
        for _ in 0..MAX_DEPTH {
            value = Value::Array(vec![value]);
        }
        assert!(stringify_utf8(&value).is_ok());
        let value = Value::Array(vec![value]);
        assert_eq!(stringify_utf8(&value), Err(TooDeep));
        assert_eq!(stringify(&value), Err(TooDeep));
    }

    #[test]
    fn a_million_levels_are_refused_on_a_64_kib_stack() {
        let worker = std::thread::Builder::new().stack_size(64 * 1024).spawn(|| {
            let text: Vec<u16> = nested(1_000_000).encode_utf16().collect();
            assert_eq!(
                parse(&text).map_err(|error| error.kind),
                Err(ParseErrorKind::TooDeep)
            );
            let mut value = Value::Null;
            for _ in 0..1_000_000 {
                value = Value::Array(vec![value]);
            }
            assert_eq!(stringify_utf8(&value), Err(TooDeep));
        });
        worker.expect("spawn").join().expect("no stack overflow");
    }
}

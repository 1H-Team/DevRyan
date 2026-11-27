//! `JSON.parse(text)` without a reviver, as V8 runs it: the strict JSON
//! grammar over a JavaScript string (UTF-16 units; escapes may make lone
//! surrogates), every object key defined as an own property (`"__proto__"`
//! included, which JSON.parse never treats as the prototype), a repeated key
//! keeping its first place with the last value, and V8's property order
//! (array-index keys ascending, then insertion order). It runs with an
//! explicit stack, as V8's parser does, so nesting depth is bounded only by
//! memory.
//!
//! The error is only "it throws": the group never answers a parse error's text
//! (a body the parser refuses is answered by the edge; a data file that does
//! not parse is read as empty).

use devryan_config_text::value::{Graph, Val};

/// `JSON.parse` threw (a SyntaxError).
#[derive(Debug, PartialEq, Eq)]
pub struct Thrown;

/// The length of the leading run of string units that need no decoding (not `"`, `\` or a control character).
fn plain_run(units: &[u16]) -> usize {
    let plain = |unit: u16| unit >= 0x20 && unit != 0x22 && unit != 0x5c;
    let mut length = 0;
    for chunk in units.as_chunks::<16>().0 {
        if !chunk.iter().fold(true, |all, unit| all & plain(*unit)) {
            break;
        }
        length += 16;
    }
    length + units[length..].iter().position(|unit| !plain(*unit)).unwrap_or(units.len() - length)
}

/// What the group's handlers read of a JSON request body: `JSON.parse(text)?.text` when it is a string.
/// `text_of_utf8(bytes)` gives the same answer as decoding `bytes` as UTF-8 (`buffer.toString('utf8')`, a
/// byte-order mark already removed by the caller) and running [`parse`], without building the value: the
/// JSON grammar is checked on the bytes (every structural character is ASCII, and a byte the decoding would
/// replace is never one), and only the top-level object's `text` members are decoded (the last one wins,
/// whatever its type, as JSON.parse keeps a repeated key's last value). `Ok(None)`: an array, or no string `text`.
pub fn text_of_utf8(bytes: &[u8]) -> Result<Option<Vec<u16>>, Thrown> {
    let mut parser = Bytes { bytes, at: 0 };
    // Container kinds, innermost last; `b'{'` frames expect a key after a comma.
    let mut stack: Vec<u8> = Vec::new();
    let mut text: Option<Vec<u16>> = None;
    let mut root_object = false;
    // Whether the value about to be read is the top-level object's `text` member, and whether one was read.
    let mut is_text = false;
    let mut seen_text = false;
    parser.space();
    loop {
        match parser.peek().ok_or(Thrown)? {
            b'{' => {
                parser.at += 1;
                if is_text {
                    text = None;
                }
                if stack.is_empty() {
                    root_object = true;
                }
                stack.push(b'{');
                parser.space();
                if parser.peek() == Some(b'}') {
                    parser.at += 1;
                    stack.pop();
                } else {
                    is_text = parser.key(stack.len() == 1)?;
                    continue;
                }
            }
            b'[' => {
                parser.at += 1;
                if is_text {
                    text = None;
                }
                stack.push(b'[');
                parser.space();
                if parser.peek() == Some(b']') {
                    parser.at += 1;
                    stack.pop();
                } else {
                    is_text = false;
                    continue;
                }
            }
            b'"' => {
                let value = parser.string(is_text)?;
                // The duplicate-key plant keeps a repeated key's first value.
                if is_text && !(seen_text && crate::plant::on(crate::plant::Plant::DuplicateKeyFirstWins)) {
                    text = value;
                }
            }
            b't' => {
                parser.literal(b"true")?;
                if is_text {
                    text = None;
                }
            }
            b'f' => {
                parser.literal(b"false")?;
                if is_text {
                    text = None;
                }
            }
            b'n' => {
                parser.literal(b"null")?;
                if is_text {
                    text = None;
                }
            }
            _ => {
                parser.number()?;
                if is_text {
                    text = None;
                }
            }
        }
        // A value is complete: close every container it completes, or go on to the next member.
        loop {
            parser.space();
            let Some(&kind) = stack.last() else {
                return if parser.at == bytes.len() {
                    Ok(if root_object { text } else { None })
                } else {
                    Err(Thrown)
                };
            };
            match parser.peek() {
                Some(b',') => {
                    parser.at += 1;
                    parser.space();
                    seen_text |= is_text && stack.len() == 1;
                    is_text = if kind == b'{' { parser.key(stack.len() == 1)? } else { false };
                    break;
                }
                Some(b'}') if kind == b'{' => {
                    parser.at += 1;
                    stack.pop();
                }
                Some(b']') if kind == b'[' => {
                    parser.at += 1;
                    stack.pop();
                }
                _ => return Err(Thrown),
            }
        }
    }
}

struct Bytes<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Bytes<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
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

    /// A member's key and its colon; true when it is the top-level object's `text`.
    fn key(&mut self, top: bool) -> Result<bool, Thrown> {
        if self.peek() != Some(b'"') {
            return Err(Thrown);
        }
        let key = self.string(top)?;
        self.space();
        if self.peek() != Some(b':') {
            return Err(Thrown);
        }
        self.at += 1;
        self.space();
        Ok(top && key.as_deref() == Some(&[0x74, 0x65, 0x78, 0x74][..]))
    }

    /// A string at `"`: checked, and decoded to units when `keep`.
    fn string(&mut self, keep: bool) -> Result<Option<Vec<u16>>, Thrown> {
        self.at += 1;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let rest = &self.bytes[self.at..];
            let plain = crate::text::byte_run(rest, |byte| byte >= 0x20 && byte != b'"' && byte != b'\\');
            if keep {
                crate::text::push_utf8_units(&mut out, &rest[..plain]);
            }
            self.at += plain;
            match self.peek().ok_or(Thrown)? {
                b'"' => {
                    self.at += 1;
                    return Ok(keep.then_some(out));
                }
                b'\\' => {
                    self.at += 1;
                    let unit = match self.peek().ok_or(Thrown)? {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => {
                            let digits = self.bytes.get(self.at + 1..self.at + 5).ok_or(Thrown)?;
                            let mut value = 0u16;
                            for digit in digits {
                                value = value * 16 + char::from(*digit).to_digit(16).ok_or(Thrown)? as u16;
                            }
                            self.at += 4;
                            value
                        }
                        _ => return Err(Thrown),
                    };
                    self.at += 1;
                    if keep {
                        out.push(unit);
                    }
                }
                _ => return Err(Thrown),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<(), Thrown> {
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
        Ok(())
    }
}

enum Frame {
    Array(usize),
    Object(usize, Vec<u16>),
}

struct Parser<'a> {
    text: &'a [u16],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.text.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn expect(&mut self, unit: u8) -> Result<(), Thrown> {
        if self.peek() == Some(u16::from(unit)) {
            self.at += 1;
            Ok(())
        } else {
            Err(Thrown)
        }
    }

    fn literal(&mut self, word: &str) -> Result<(), Thrown> {
        for byte in word.bytes() {
            self.expect(byte)?;
        }
        Ok(())
    }

    fn string(&mut self) -> Result<Vec<u16>, Thrown> {
        self.expect(b'"')?;
        let mut out = Vec::new();
        loop {
            // A run of units that stand for themselves.
            let rest = &self.text[self.at..];
            let plain = plain_run(rest);
            out.extend_from_slice(&rest[..plain]);
            self.at += plain;
            let unit = self.peek().ok_or(Thrown)?;
            self.at += 1;
            match unit {
                0x22 => return Ok(out),
                0x5c => {
                    let escape = self.peek().ok_or(Thrown)?;
                    self.at += 1;
                    out.push(match escape {
                        0x22 => 0x22,
                        0x5c => 0x5c,
                        0x2f => 0x2f,
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let mut value = 0u16;
                            for _ in 0..4 {
                                let digit = self
                                    .peek()
                                    .and_then(|unit| char::from_u32(u32::from(unit)))
                                    .and_then(|ch| ch.to_digit(16))
                                    .ok_or(Thrown)?;
                                self.at += 1;
                                value = value * 16 + digit as u16;
                            }
                            value
                        }
                        _ => return Err(Thrown),
                    });
                }
                0x00..=0x1f => return Err(Thrown),
                other => out.push(other),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|unit| (0x30..=0x39).contains(&unit)) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<f64, Thrown> {
        let start = self.at;
        if self.peek() == Some(0x2d) {
            self.at += 1;
        }
        match self.peek() {
            Some(0x30) => self.at += 1,
            Some(0x31..=0x39) => {
                self.digits();
            }
            _ => return Err(Thrown),
        }
        if self.peek() == Some(0x2e) {
            self.at += 1;
            if self.digits() == 0 {
                return Err(Thrown);
            }
        }
        if matches!(self.peek(), Some(0x45 | 0x65)) {
            self.at += 1;
            if matches!(self.peek(), Some(0x2b | 0x2d)) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(Thrown);
            }
        }
        let text: Vec<u8> = self.text[start..self.at].iter().map(|unit| *unit as u8).collect();
        devryan_config_text::js::decimal_to_f64(&text).ok_or(Thrown)
    }
}

/// `JSON.parse(text)`: the value and the graph its arrays and objects live in.
pub fn parse(text: &[u16]) -> Result<(Graph, Val), Thrown> {
    let mut graph = Graph::new();
    let mut parser = Parser { text, at: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    parser.space();
    loop {
        // A value starts here.
        let mut value = match parser.peek().ok_or(Thrown)? {
            0x7b => {
                parser.at += 1;
                parser.space();
                let id = graph.object();
                if parser.peek() == Some(0x7d) {
                    parser.at += 1;
                    Val::Ref(id)
                } else {
                    let key = parser.string()?;
                    parser.space();
                    parser.expect(b':')?;
                    parser.space();
                    stack.push(Frame::Object(id, key));
                    continue;
                }
            }
            0x5b => {
                parser.at += 1;
                parser.space();
                let id = graph.array();
                if parser.peek() == Some(0x5d) {
                    parser.at += 1;
                    Val::Ref(id)
                } else {
                    stack.push(Frame::Array(id));
                    continue;
                }
            }
            0x22 => Val::String(parser.string()?),
            0x74 => {
                parser.literal("true")?;
                Val::Bool(true)
            }
            0x66 => {
                parser.literal("false")?;
                Val::Bool(false)
            }
            0x6e => {
                parser.literal("null")?;
                Val::Null
            }
            _ => Val::Number(parser.number()?),
        };
        // The value is complete: hand it to its container, closing every container it completes.
        loop {
            match stack.last_mut() {
                None => {
                    parser.space();
                    return if parser.at == text.len() { Ok((graph, value)) } else { Err(Thrown) };
                }
                Some(Frame::Array(id)) => {
                    let id = *id;
                    graph.push(id, value);
                    parser.space();
                    match parser.peek() {
                        Some(0x2c) => {
                            parser.at += 1;
                            parser.space();
                            break;
                        }
                        Some(0x5d) => {
                            parser.at += 1;
                            stack.pop();
                            value = Val::Ref(id);
                        }
                        _ => return Err(Thrown),
                    }
                }
                Some(Frame::Object(id, key)) => {
                    let id = *id;
                    let key = std::mem::take(key);
                    let repeated = crate::plant::on(crate::plant::Plant::DuplicateKeyFirstWins)
                        && matches!(graph.node(id), devryan_config_text::value::Node::Object(object) if object.get(&key).is_some());
                    if !repeated {
                        graph.define(id, key, value);
                    }
                    parser.space();
                    match parser.peek() {
                        Some(0x2c) => {
                            parser.at += 1;
                            parser.space();
                            let next = parser.string()?;
                            parser.space();
                            parser.expect(b':')?;
                            parser.space();
                            if let Some(Frame::Object(_, key)) = stack.last_mut() {
                                *key = next;
                            }
                            break;
                        }
                        Some(0x7d) => {
                            parser.at += 1;
                            stack.pop();
                            value = Val::Ref(id);
                        }
                        _ => return Err(Thrown),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devryan_config_text::js::units;

    fn described(text: &str) -> Result<String, Thrown> {
        parse(&units(text)).map(|(graph, value)| graph.describe(&value))
    }

    #[test]
    fn values() {
        assert_eq!(
            described(" {\"b\":1,\"a\":[true,false,null,\"x\"],\"2\":{},\"1\":-0.5e2} ").unwrap(),
            "{\"1\":#-50,\"2\":{},\"b\":#1,\"a\":[t,f,n,\"x\"]}"
        );
        assert_eq!(described("{\"a\":\"1\",\"b\":2,\"a\":\"3\"}").unwrap(), "{\"a\":\"3\",\"b\":#2}");
        assert_eq!(described("{\"__proto__\":{\"x\":1}}").unwrap(), "{\"__proto__\":{\"x\":#1}}");
        assert_eq!(described("\"\\ud800\\u00e9\\/\"").unwrap(), "\"\\ud800é/\"");
        assert_eq!(described("9007199254740993").unwrap(), "#9007199254740992");
    }

    #[test]
    fn refusals() {
        for text in [
            "",
            " ",
            "{",
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            ".5",
            "+1",
            "1e",
            "\"\t\"",
            "'a'",
            "tru",
            "nul",
            "[1] x",
            "{\"a\" 1}",
            "\u{feff}{}",
            "\"\\x\"",
        ] {
            assert_eq!(described(text), Err(Thrown), "{text:?}");
        }
    }

    #[test]
    fn deep_nesting_without_recursion() {
        let depth = 200_000;
        let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(parse(&units(&text)).is_ok());
    }
}

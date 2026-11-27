//! JSON as the harness writes it (`JSON.stringify`, `protocolLine`), read and
//! written with strings as UTF-16 code units, so a lone surrogate (`\ud800`)
//! survives a round trip (engine.mjs ENGINE_ACCIDENTS: lone surrogates in
//! JSON text). Members keep the order they were written in.

use devryan_client_engine::js::{Str, number, push_json_string, s};

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(Str),
    Array(Vec<Json>),
    Object(Vec<(Str, Json)>),
}

impl Json {
    pub fn str(text: &str) -> Json {
        Json::String(s(text))
    }

    pub fn object(members: Vec<(&str, Json)>) -> Json {
        Json::Object(members.into_iter().map(|(key, value)| (s(key), value)).collect())
    }

    /// The member `key` of an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(members) => members
                .iter()
                .find(|(name, _)| name.iter().copied().eq(key.encode_utf16()))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&Str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_string(&self) -> Option<String> {
        self.as_str().map(|text| String::from_utf16_lossy(text))
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn is_true(&self) -> bool {
        matches!(self, Json::Bool(true))
    }

    /// The string member `key` as Rust text.
    pub fn text(&self, key: &str) -> Option<String> {
        self.get(key).and_then(Json::as_string)
    }

    /// The member `key` as an integer.
    pub fn integer(&self, key: &str) -> Option<i64> {
        self.get(key)
            .and_then(Json::as_f64)
            .filter(|number| number.fract() == 0.0 && number.abs() < 9.0e15)
            .map(|number| number as i64)
    }

    /// Whether this is a tagged codec node of `tag` (`{"$dr": tag, ...}`).
    pub fn is_tag(&self, tag: &str) -> bool {
        self.get("$dr")
            .is_some_and(|value| value.as_str().is_some_and(|name| name.iter().copied().eq(tag.encode_utf16())))
    }
}

#[derive(Debug)]
pub struct ParseError(pub String);

/// Parses one JSON text (a line without its newline).
pub fn parse(bytes: &[u8]) -> Result<Json, ParseError> {
    let mut parser = Parser { bytes, at: 0, depth: 0 };
    parser.space();
    let value = parser.value()?;
    parser.space();
    if parser.at != bytes.len() {
        return Err(parser.fail("text after the value"));
    }
    Ok(value)
}

const MAX_DEPTH: usize = 4096;

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
    depth: usize,
}

impl Parser<'_> {
    fn fail(&self, what: &str) -> ParseError {
        ParseError(format!("{what} at byte {}", self.at))
    }

    fn space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> Result<(), ParseError> {
        if self.bytes.get(self.at) == Some(&byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(self.fail(&format!("expected {:?}", char::from(byte))))
        }
    }

    fn value(&mut self) -> Result<Json, ParseError> {
        match self.bytes.get(self.at) {
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'"') => Ok(Json::String(self.string()?.into())),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.fail("expected a value")),
        }
    }

    fn nested(&mut self, read: fn(&mut Self) -> Result<Json, ParseError>) -> Result<Json, ParseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.fail("nested too deep"));
        }
        let value = read(self);
        self.depth -= 1;
        value
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, ParseError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.fail("expected a value"))
        }
    }

    fn number(&mut self) -> Result<Json, ParseError> {
        let start = self.at;
        if self.bytes.get(self.at) == Some(&b'-') {
            self.at += 1;
        }
        let digits = |parser: &mut Self| {
            let from = parser.at;
            while parser.bytes.get(parser.at).is_some_and(u8::is_ascii_digit) {
                parser.at += 1;
            }
            parser.at - from
        };
        let integer_start = self.at;
        let integer = digits(self);
        if integer == 0 || (integer > 1 && self.bytes[integer_start] == b'0') {
            return Err(self.fail("a malformed number"));
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if digits(self) == 0 {
                return Err(self.fail("a malformed number"));
            }
        }
        if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if digits(self) == 0 {
                return Err(self.fail("a malformed number"));
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| self.fail("a malformed number"))?;
        // Rust's parse rounds correctly, as JSON.parse does.
        text.parse::<f64>().map(Json::Number).map_err(|_| self.fail("a malformed number"))
    }

    fn string(&mut self) -> Result<Vec<u16>, ParseError> {
        self.eat(b'"')?;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let Some(&byte) = self.bytes.get(self.at) else {
                return Err(self.fail("an unterminated string"));
            };
            match byte {
                b'"' => {
                    self.at += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.at += 1;
                    let Some(&escape) = self.bytes.get(self.at) else {
                        return Err(self.fail("an unterminated escape"));
                    };
                    self.at += 1;
                    match escape {
                        b'"' => out.push(0x22),
                        b'\\' => out.push(0x5c),
                        b'/' => out.push(0x2f),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0c),
                        b'n' => out.push(0x0a),
                        b'r' => out.push(0x0d),
                        b't' => out.push(0x09),
                        b'u' => {
                            let hex = self.bytes.get(self.at..self.at + 4).ok_or_else(|| self.fail("a short \\u escape"))?;
                            let text = std::str::from_utf8(hex).map_err(|_| self.fail("a malformed \\u escape"))?;
                            let unit = u16::from_str_radix(text, 16).map_err(|_| self.fail("a malformed \\u escape"))?;
                            self.at += 4;
                            out.push(unit);
                        }
                        _ => return Err(self.fail("an unknown escape")),
                    }
                }
                0x00..=0x1f => return Err(self.fail("a control character in a string")),
                _ => {
                    // A run of plain characters, decoded as UTF-8 at once and appended as UTF-16 units.
                    let from = self.at;
                    while self.bytes.get(self.at).is_some_and(|byte| !matches!(byte, b'"' | b'\\' | 0x00..=0x1f)) {
                        self.at += 1;
                    }
                    let text = std::str::from_utf8(&self.bytes[from..self.at]).map_err(|_| self.fail("malformed UTF-8"))?;
                    out.extend(text.encode_utf16());
                }
            }
        }
    }

    fn array(&mut self) -> Result<Json, ParseError> {
        self.eat(b'[')?;
        let mut items = Vec::new();
        self.space();
        if self.bytes.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.space();
            items.push(self.value()?);
            self.space();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.fail("expected , or ]")),
            }
        }
    }

    fn object(&mut self) -> Result<Json, ParseError> {
        self.eat(b'{')?;
        let mut members: Vec<(Str, Json)> = Vec::new();
        self.space();
        if self.bytes.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Json::Object(members));
        }
        loop {
            self.space();
            let key: Str = self.string()?.into();
            self.space();
            self.eat(b':')?;
            self.space();
            let value = self.value()?;
            // A repeated key keeps its first place and its last value, as JSON.parse.
            match members.iter_mut().find(|(name, _)| *name == key) {
                Some(slot) => slot.1 = value,
                None => members.push((key, value)),
            }
            self.space();
            match self.bytes.get(self.at) {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Json::Object(members));
                }
                _ => return Err(self.fail("expected , or }")),
            }
        }
    }
}

/// Writes `value` as `JSON.stringify` does, then as `protocolLine` does
/// (U+2028 and U+2029 as escapes), as UTF-8.
pub fn write(value: &Json, out: &mut Vec<u8>) {
    let mut units: Vec<u16> = Vec::new();
    write_units(value, &mut units);
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('\u{2028}') if !devryan_client_engine::plant::on("rv-json-raw-line-separators") => out.extend_from_slice(b"\\u2028"),
            Ok('\u{2029}') if !devryan_client_engine::plant::on("rv-json-raw-line-separators") => out.extend_from_slice(b"\\u2029"),
            Ok(character) => {
                let mut buffer = [0u8; 4];
                out.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
            }
            // push_json_string escapes every lone surrogate, so none reaches here.
            Err(_) => out.extend_from_slice("\u{fffd}".as_bytes()),
        }
    }
}

fn write_units(value: &Json, out: &mut Vec<u16>) {
    let ascii = |out: &mut Vec<u16>, text: &str| out.extend(text.encode_utf16());
    match value {
        Json::Null => ascii(out, "null"),
        Json::Bool(value) => ascii(out, if *value { "true" } else { "false" }),
        Json::Number(value) => ascii(out, &if value.is_finite() { number::to_string(*value) } else { "null".to_owned() }),
        Json::String(text) => push_json_string(out, text),
        Json::Array(items) => {
            out.push(u16::from(b'['));
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(u16::from(b','));
                }
                write_units(item, out);
            }
            out.push(u16::from(b']'));
        }
        Json::Object(members) => {
            out.push(u16::from(b'{'));
            for (index, (key, item)) in members.iter().enumerate() {
                if index > 0 {
                    out.push(u16::from(b','));
                }
                push_json_string(out, key);
                out.push(u16::from(b':'));
                write_units(item, out);
            }
            out.push(u16::from(b'}'));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(text: &str) -> String {
        let mut out = Vec::new();
        write(&parse(text.as_bytes()).unwrap(), &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn lone_surrogates_and_line_separators_survive() {
        assert_eq!(round_trip(r#"["\ud800","\udc00x","😀","\u2028"]"#), r#"["\ud800","\udc00x","😀","\u2028"]"#);
        assert_eq!(round_trip("[\"\u{2029}\"]"), r#"["\u2029"]"#);
        let parsed = parse(r#""😀""#.as_bytes()).unwrap();
        assert_eq!(parsed, Json::String(vec![0xd83d, 0xde00].into()));
    }

    #[test]
    fn numbers_keep_the_javascript_layout() {
        assert_eq!(round_trip("[1e21,1.5e-7,0.000001,100,-0]"), "[1e+21,1.5e-7,0.000001,100,0]");
        assert!(parse(b"01").is_err() && parse(b"1.").is_err() && parse(b"-").is_err() && parse(b"[1,]").is_err());
    }

    #[test]
    fn members_keep_their_order_and_a_repeated_key_its_first_place() {
        assert_eq!(round_trip(r#"{"b":1,"a":2,"b":3}"#), r#"{"b":3,"a":2}"#);
        assert_eq!(round_trip(r#"{"x":"\"\\\/\b\f\n\r\t\u0001"}"#), r#"{"x":"\"\\/\b\f\n\r\t\u0001"}"#);
    }
}

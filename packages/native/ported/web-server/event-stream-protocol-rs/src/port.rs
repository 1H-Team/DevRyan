//! The Rust port of `event-stream/protocol.js` (3 of 7; the gap-control payloads are recognized
//! by a module `WeakSet` (identity), and the senders call socket methods). `JSON.parse` and
//! `JSON.stringify` are written out (JS-exact: lone surrogates, `1e400`, duplicate keys,
//! index keys first). Lines split at `\n` only.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !js_space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !js_space(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

/// JSON text, parsed as `JSON.parse` does; `None` where it throws (from `decoders-rs`).
struct Json<'a> {
    text: &'a [u16],
    at: usize,
}

impl Json<'_> {
    fn space(&mut self) {
        while self.text.get(self.at).is_some_and(|&u| matches!(u, 0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn eat(&mut self, unit: u8) -> Option<()> {
        (self.text.get(self.at) == Some(&u16::from(unit))).then(|| self.at += 1)
    }

    fn word(&mut self, word: &str, value: Value) -> Option<Value> {
        word.bytes().try_for_each(|b| self.eat(b))?;
        Some(value)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.text.get(self.at).is_some_and(|&u| (0x30..=0x39).contains(&u)) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        let _ = self.eat(b'-');
        if self.eat(b'0').is_none() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'.').is_some() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'e').or_else(|| self.eat(b'E')).is_some() {
            let _ = self.eat(b'+').or_else(|| self.eat(b'-'));
            if self.digits() == 0 {
                return None;
            }
        }
        let text = String::from_utf16(&self.text[start..self.at]).ok()?;
        Some(js::number(text.parse::<f64>().ok()?))
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            let unit = *self.text.get(self.at)?;
            self.at += 1;
            match unit {
                0x22 => return Some(out),
                0x00..=0x1f => return None,
                0x5c => {
                    let escape = *self.text.get(self.at)?;
                    self.at += 1;
                    out.push(match escape {
                        0x22 | 0x5c | 0x2f => escape,
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let hex = String::from_utf16(self.text.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            u16::from_str_radix(&hex, 16).ok()?
                        }
                        _ => return None,
                    });
                }
                _ => out.push(unit),
            }
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.space();
        let value = match *self.text.get(self.at)? {
            0x7b => {
                self.at += 1;
                let mut map = Map::new();
                self.space();
                if self.eat(b'}').is_none() {
                    loop {
                        self.space();
                        let key = String::from_utf16_lossy(&self.string()?);
                        self.space();
                        self.eat(b':')?;
                        let item = self.value()?;
                        map.insert(key, item);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b'}')?;
                            break;
                        }
                    }
                }
                Value::Object(js_order(map))
            }
            0x5b => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.eat(b']').is_none() {
                    loop {
                        items.push(self.value()?);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b']')?;
                            break;
                        }
                    }
                }
                Value::Array(items)
            }
            0x22 => js::utf16_string(&self.string()?),
            0x74 => self.word("true", Value::Bool(true))?,
            0x66 => self.word("false", Value::Bool(false))?,
            0x6e => self.word("null", Value::Null)?,
            _ => self.number()?,
        };
        self.space();
        Some(value)
    }
}

fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// An object's keys in JS order: array indexes ascending, then insertion order.
fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest = Map::new();
    for (key, value) in map {
        match index_key(&key) {
            Some(n) => indexed.push((n, key, value)),
            None => {
                rest.insert(key, value);
            }
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

fn quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn single<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get(key))
}

/// `JSON.stringify(value)`; `None` for `undefined`.
fn stringify(value: &Value) -> Result<Option<String>, String> {
    if js::is_undefined(value) {
        return Ok(None);
    }
    if let Some(units) = js::string_units(value) {
        return Ok(Some(quote(&units)));
    }
    if let Some(n) = js::as_number(value) {
        return Ok(Some(if n.is_finite() { js::number_to_string(n) } else { "null".into() }));
    }
    if single(value, "$bigint").is_some() {
        return Err("Do not know how to serialize a BigInt".into()); // recorded-literal: V8 TypeError text
    }
    Ok(Some(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(stringify(item)?.unwrap_or_else(|| "null".into()));
            }
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            if let Some(date) = single(value, "$date") {
                return Ok(Some(match date.as_str() {
                    Some("Invalid") | None => "null".into(),
                    Some(iso) => quote(&iso.encode_utf16().collect::<Vec<_>>()),
                }));
            }
            if single(value, "$map").is_some() || single(value, "$set").is_some() {
                return Ok(Some("{}".into()));
            }
            let pairs: Vec<(String, Value)> = match single(value, "$bytes").and_then(Value::as_array) {
                Some(bytes) => bytes.iter().enumerate().map(|(i, b)| (i.to_string(), b.clone())).collect(),
                None => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            };
            let mut parts = Vec::new();
            for (k, v) in pairs {
                if let Some(text) = stringify(&v)? {
                    parts.push(format!("{}:{text}", quote(&k.encode_utf16().collect::<Vec<_>>())));
                }
            }
            format!("{{{}}}", parts.join(","))
        }
        _ => return Ok(None),
    }))
}

fn is_typeof_object(value: &Value) -> bool {
    (value.is_object() || value.is_array()) && js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value)
}

fn field(value: &Value, key: &str) -> Value {
    match value {
        Value::Object(o) if is_typeof_object(value) && !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))) => {
            o.get(key).cloned().unwrap_or_else(js::undefined)
        }
        _ => js::undefined(),
    }
}

fn non_empty(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// Port of `parseSseEventEnvelope` (`event-stream/protocol.js:20`).
pub fn parse_sse_event_envelope(block: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&block).filter(|u| !u.is_empty()) else {
        return Ok(Value::Null);
    };
    let nl = u16::from(b'\n');
    let lines: Vec<&[u16]> = units.split(|u| *u == nl).collect();
    let starts = |line: &[u16], p: &str| line.starts_with(&p.encode_utf16().collect::<Vec<_>>());
    let event_id = lines
        .iter()
        .find(|l| starts(l, "id:"))
        .map(|l| trim(&l[3..]).to_vec())
        .filter(|t| !t.is_empty());
    let data: Vec<Vec<u16>> = lines
        .iter()
        .filter(|l| starts(l, "data:"))
        .map(|l| {
            let rest = &l[5..];
            if rest.first().is_some_and(|c| js_space(*c)) {
                rest[1..].to_vec()
            } else {
                rest.to_vec()
            }
        })
        .collect();
    if data.is_empty() {
        return Ok(Value::Null);
    }
    let joined = data.join(&[nl][..]);
    let text = trim(&joined).to_vec();
    if text.is_empty() {
        return Ok(Value::Null);
    }
    let mut parser = Json { text: &text, at: 0 };
    let Some(parsed) = parser.value().filter(|_| parser.at == text.len()) else {
        return Ok(Value::Null);
    };
    let event_id = event_id.map_or(Value::Null, |u| js::utf16_string(&u));
    let payload = field(&parsed, "payload");
    if truthy(&parsed) && is_typeof_object(&parsed) && (is_typeof_object(&payload) || payload.is_null()) && !payload.is_null() {
        let directory = field(&parsed, "directory");
        return Ok(json!({ "eventId": event_id, "directory": if non_empty(&directory) { directory } else { Value::Null }, "payload": payload }));
    }
    let own = field(&parsed, "directory");
    let nested = field(&field(&parsed, "properties"), "directory");
    let directory = if non_empty(&own) {
        own
    } else if non_empty(&nested) {
        nested
    } else {
        Value::Null
    };
    Ok(json!({ "eventId": event_id, "directory": directory, "payload": parsed }))
}

/// Port of `toUpstreamV2SseEvent` (`event-stream/protocol.js:74`).
pub fn to_upstream_v2_sse_event(parsed: Value) -> Result<Value, String> {
    if !truthy(&parsed) || !is_typeof_object(&parsed) {
        return Ok(Value::Null);
    }
    match field(&parsed, "kind").as_str() {
        Some("comment") => return Ok(json!({ "keepalive": true })),
        Some("event") => {}
        _ => return Ok(Value::Null),
    }
    let envelope = field(&parsed, "envelope");
    if !truthy(&envelope) || !is_typeof_object(&envelope) {
        return Ok(Value::Null);
    }
    let pick = |k: &str| {
        let v = field(&parsed, k);
        if non_empty(&v) { v } else { Value::Null }
    };
    Ok(json!({ "eventId": null, "upstreamEventId": pick("eventId"), "directory": pick("directory"), "payload": envelope }))
}

/// Port of `serializeMessageStreamWsEvent` (`event-stream/protocol.js:152`): a gap-control payload is
/// recognized by identity and cannot arrive here.
pub fn serialize_message_stream_ws_event(payload: Value, options: Value) -> Result<Value, String> {
    if options.is_null() {
        return Err("Cannot read properties of null (reading 'eventId')".into()); // recorded-literal: V8 TypeError text
    }
    let opt = |k: &str| if js::is_undefined(&options) { js::undefined() } else { field(&options, k) };
    let event_id = Some(opt("eventId")).filter(non_empty);
    let directory = Some(opt("directory")).filter(non_empty);
    let quoted = |v: &Value| quote(&js::string_units(v).unwrap_or_default());
    let tail = format!(
        "{}{}",
        event_id.as_ref().map_or(String::new(), |e| format!(",\"eventId\":{}", quoted(e))),
        directory.as_ref().map_or(String::new(), |d| format!(",\"directory\":{}", quoted(d)))
    );
    let Some(json) = stringify(&payload)? else {
        return Ok(Value::String(format!("{{\"type\":\"event\"{tail}}}")));
    };
    let units: Vec<u16> = json.encode_utf16().collect();
    let legacy: Vec<u16> = "{\"type\":\"openchamber:".encode_utf16().collect();
    let devryan: Vec<u16> = "{\"type\":\"devryan:".encode_utf16().collect();
    let (from, to) = if opt("dialect").as_str() == Some("devryan") {
        (legacy, devryan)
    } else {
        (devryan, legacy)
    };
    let body = match units.strip_prefix(from.as_slice()) {
        Some(rest) => [to.as_slice(), rest].concat(),
        None => units,
    };
    let mut out: Vec<u16> = "{\"type\":\"event\",\"payload\":".encode_utf16().collect();
    out.extend(body);
    out.extend(tail.encode_utf16());
    out.push(u16::from(b'}'));
    Ok(js::utf16_string(&out))
}

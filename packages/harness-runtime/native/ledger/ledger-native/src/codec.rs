//! The line codec of the stdio protocol (research file 28, section 2): one
//! JSON text per line, with the `$dr` tags of the dual-run codec for what
//! JSON cannot carry. It decodes as `decodeLine` and encodes as `encodeLine`
//! do, byte for byte:
//!
//! - `{"$dr":"undefined"}`, `{"$dr":"number","value":"NaN"|"Infinity"|"-Infinity"|"-0"}`,
//!   `{"$dr":"bytes","base64":...}`, `{"$dr":"escape","value":{...}}` (an
//!   object that has a `$dr` key);
//! - `bigint`, `date`, `map` and `set` decode to `W::Unsupported`: the
//!   native ledger refuses them (`mutation_wire_type`);
//! - an unknown tag, a malformed tag or text that is not JSON is a corrupt
//!   stream (`Corrupt`), where the JavaScript process throws and exits.
//!
//! Encoding reproduces the JavaScript's own quirks: a `__proto__` key is
//! dropped (the encoder assigns properties, and that assignment sets the
//! prototype), an `Error` encodes as its assigned fields, a stream as `{}`,
//! and a function cannot be encoded (`TypeError`).
#![forbid(unsafe_code)]

use std::rc::Rc;

use ledger_core::base64;
use ledger_core::js::{JsObject, JsStr, Value, parse, stringify_utf8};

use crate::value::{JsError, Obj, W, own_entries, to_number};

/// The longest line either side accepts (research file 28, section 2).
pub const MAX_LINE_BYTES: usize = 256 * 1024 * 1024;

/// Why a line cannot be read: the stream is corrupt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Corrupt(pub String);

const TAG: &str = "$dr";

/// One line (without its newline) as a value.
pub fn decode_line(line: &[u8]) -> Result<W, Corrupt> {
    let text = JsStr::from_utf8_lossy(line);
    let value = parse(text.units())
        .map_err(|error| Corrupt(format!("not JSON ({:?} at {})", error.kind, error.position)))?;
    from_json(&value)
}

/// A parsed JSON value with its tags decoded.
pub fn from_json(value: &Value) -> Result<W, Corrupt> {
    Ok(match value {
        Value::Undefined => W::Undefined,
        Value::Null => W::Null,
        Value::Bool(value) => W::Bool(*value),
        Value::Number(value) => W::Number(*value),
        Value::String(text) => W::String(text.clone()),
        Value::Array(items) => W::Array(items.iter().map(from_json).collect::<Result<_, _>>()?),
        Value::Object(object) => match object.get_str(TAG) {
            None => W::Object(object_from_json(object)?),
            Some(Value::String(tag)) => decode_tag(&tag.to_string_lossy(), object)?,
            Some(_) => return Err(Corrupt("a $dr tag that is not a string".into())),
        },
    })
}

fn object_from_json(object: &JsObject) -> Result<Obj, Corrupt> {
    let mut out = Obj::new();
    for (key, value) in object.iter() {
        out.set(key, from_json(value)?);
    }
    Ok(out)
}

fn decode_tag(tag: &str, object: &JsObject) -> Result<W, Corrupt> {
    Ok(match tag {
        "undefined" => W::Undefined,
        // `item.value === '-0' ? -0 : Number(item.value)`, on the raw value.
        "number" => match object.get_str("value") {
            Some(Value::String(text)) if *text == "-0" => W::Number(-0.0),
            Some(raw) => W::Number(to_number(&raw_value(raw))),
            None => W::Number(f64::NAN),
        },
        "bytes" => match object.get_str("base64") {
            Some(Value::String(text)) => W::Bytes(Rc::new(base64::decode(text.units()))),
            // `Buffer.from(array, 'base64')` ignores the encoding.
            Some(Value::Array(items)) => W::Bytes(Rc::new(
                items
                    .iter()
                    .map(|item| to_uint8(to_number(&raw_value(item))))
                    .collect(),
            )),
            _ => return Err(Corrupt("a bytes tag without a base64 string".into())),
        },
        // `Object.entries(item.value)`, each value decoded.
        "escape" => match object.get_str("value") {
            None | Some(Value::Null | Value::Undefined) => {
                return Err(Corrupt("an escape tag without a value".into()));
            }
            Some(Value::Object(inner)) => W::Object(object_from_json(inner)?),
            // Array elements still pass through the decoder.
            Some(Value::Array(items)) => {
                let mut decoded = Obj::new();
                for (index, item) in items.iter().enumerate() {
                    decoded.set(JsStr::from(index.to_string()), from_json(item)?);
                }
                W::Object(decoded)
            }
            // A string's code units; a number or boolean has no entries.
            Some(raw) => {
                let mut out = Obj::new();
                for (key, item) in own_entries(&raw_value(raw)) {
                    out.set(key, item);
                }
                W::Object(out)
            }
        },
        "bigint" => W::Unsupported("bigint"),
        "date" => W::Unsupported("date"),
        "map" => W::Unsupported("map"),
        "set" => W::Unsupported("set"),
        other => return Err(Corrupt(format!("unknown tag {other}"))),
    })
}

/// A raw JSON value as a value, tags not interpreted (for `Number(raw)`).
fn raw_value(value: &Value) -> W {
    match value {
        Value::Undefined => W::Undefined,
        Value::Null => W::Null,
        Value::Bool(value) => W::Bool(*value),
        Value::Number(value) => W::Number(*value),
        Value::String(text) => W::String(text.clone()),
        Value::Array(items) => W::Array(items.iter().map(raw_value).collect()),
        Value::Object(object) => {
            let mut out = Obj::new();
            for (key, item) in object.iter() {
                out.set(key, raw_value(item));
            }
            W::Object(out)
        }
    }
}

/// ECMAScript `ToUint8`.
fn to_uint8(value: f64) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    (value.trunc().rem_euclid(256.0)) as u8
}

/// The `TypeError` the JavaScript encoder throws for a function.
pub fn function_error() -> W {
    W::Error(Rc::new(JsError::new(
        "TypeError",
        "ledger-dual-run codec: cannot encode a function",
    )))
}

/// One message as one line, newline included.
pub fn encode_line(message: &W) -> Result<Vec<u8>, W> {
    let value = to_json(message)?;
    let mut bytes = stringify_utf8(&value)
        .map_err(|_| {
            W::Error(Rc::new(JsError::new(
                "RangeError",
                "Maximum call stack size exceeded",
            )))
        })?
        .expect("an encoded message is never undefined");
    bytes.push(b'\n');
    Ok(bytes)
}

fn tagged(tag: &str, rest: Vec<(&str, Value)>) -> Value {
    let mut object = JsObject::new();
    object.set(TAG, Value::string(tag));
    for (key, value) in rest {
        object.set(key, value);
    }
    Value::Object(object)
}

/// A value with its tags encoded, as `encodeValue` builds it.
pub fn to_json(value: &W) -> Result<Value, W> {
    Ok(match value {
        W::Undefined => tagged("undefined", vec![]),
        W::Null => Value::Null,
        W::Bool(value) => Value::Bool(*value),
        W::Number(value) => {
            if value.is_nan() {
                tagged("number", vec![("value", Value::string("NaN"))])
            } else if value.is_infinite() {
                let text = if *value > 0.0 {
                    "Infinity"
                } else {
                    "-Infinity"
                };
                tagged("number", vec![("value", Value::string(text))])
            } else if *value == 0.0 && value.is_sign_negative() {
                tagged("number", vec![("value", Value::string("-0"))])
            } else {
                Value::Number(*value)
            }
        }
        W::String(text) => Value::String(text.clone()),
        W::Bytes(bytes) => tagged(
            "bytes",
            vec![("base64", Value::string(&base64::encode(bytes)))],
        ),
        W::Array(items) => Value::Array(items.iter().map(to_json).collect::<Result<_, _>>()?),
        W::Object(object) => {
            encode_entries(object.iter().map(|(key, value)| (key.clone(), value)))?
        }
        W::Error(error) => encode_entries(
            error
                .fields
                .iter()
                .map(|(field, value)| (JsStr::from(*field), value)),
        )?,
        // An async generator object has no own enumerable properties.
        W::Stream(_) => Value::Object(JsObject::new()),
        W::Function(_) => return Err(function_error()),
        W::Unsupported(kind) => {
            return Err(W::Error(Rc::new(JsError::new(
                "TypeError",
                &format!("ledger-dual-run codec: cannot encode a {kind}"),
            ))));
        }
    })
}

fn encode_entries<'a>(entries: impl Iterator<Item = (JsStr, &'a W)>) -> Result<Value, W> {
    let mut out = JsObject::new();
    let mut escape = false;
    for (key, value) in entries {
        let encoded = to_json(value)?;
        if key == "__proto__" {
            continue;
        }
        if key == TAG {
            escape = true;
        }
        out.insert(key, encoded);
    }
    Ok(if escape {
        tagged("escape", vec![("value", Value::Object(out))])
    } else {
        Value::Object(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(line: &str) -> String {
        let value = decode_line(line.as_bytes()).expect("decodes");
        let bytes = encode_line(&value).expect("encodes");
        String::from_utf8(bytes).unwrap().trim_end().to_string()
    }

    #[test]
    fn tags_round_trip() {
        for line in [
            r#"{"a":{"$dr":"undefined"},"b":[{"$dr":"number","value":"NaN"},{"$dr":"number","value":"-0"},{"$dr":"number","value":"-Infinity"}]}"#,
            r#"{"$dr":"bytes","base64":"AAEC"}"#,
            r#"{"$dr":"escape","value":{"$dr":"x","y":1}}"#,
            r#""\ud800""#,
        ] {
            assert_eq!(round(line), line);
        }
        assert_eq!(round(r#"{"2":1,"1":2,"b":3}"#), r#"{"1":2,"2":1,"b":3}"#);
    }

    #[test]
    fn quirks_of_the_javascript_encoder() {
        assert_eq!(round(r#"{"__proto__":{"a":1},"b":2}"#), r#"{"b":2}"#);
        assert_eq!(round(r#"{"$dr":"number","value":"12"}"#), "12");
        assert_eq!(
            round(r#"{"$dr":"escape","value":"ab"}"#),
            r#"{"0":"a","1":"b"}"#
        );
        assert_eq!(
            round(r#"{"$dr":"bytes","base64":[1,257,-1]}"#),
            r#"{"$dr":"bytes","base64":"AQH/"}"#
        );
    }

    #[test]
    fn random_bytes_never_panic() {
        // Seeded: lines of random bytes, and valid lines with bytes flipped;
        // each decodes or is refused, and what decodes encodes.
        let mut state: u32 = 0x2468_ace0;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        let valid: [&[u8]; 4] = [
            br#"{"type":"call","id":1,"input":[{"$dr":"bytes","base64":"AA=="},{"$dr":"undefined"}]}"#,
            br#"{"$dr":"escape","value":{"$dr":1,"a":[{"$dr":"number","value":"-0"}]}}"#,
            br#"["\ud800",1e308,-0,{"2":1,"1":2}]"#,
            br#"{"__devryanError":true,"errors":[{"cause":{"x":null}}]}"#,
        ];
        for round in 0..20_000 {
            let line: Vec<u8> = if round % 2 == 0 {
                (0..(next() % 48)).map(|_| (next() % 256) as u8).collect()
            } else {
                let mut line = valid[(next() % 4) as usize].to_vec();
                for _ in 0..(1 + next() % 3) {
                    let at = (next() as usize) % line.len();
                    line[at] = (next() % 256) as u8;
                }
                line
            };
            if let Ok(value) = decode_line(&line) {
                let _ = encode_line(&value);
                let decoded = crate::wire::decode_wire_value(&value, None);
                let _ = crate::wire::encode_wire_value(&decoded, None, None);
            }
        }
    }

    #[test]
    fn corrupt_lines_are_refused() {
        for line in [
            "",
            "{",
            r#"{"$dr":"nope"}"#,
            r#"{"$dr":null}"#,
            r#"{"$dr":"bytes"}"#,
            r#"{"$dr":"escape"}"#,
        ] {
            assert!(decode_line(line.as_bytes()).is_err(), "{line}");
        }
        assert!(matches!(
            decode_line(br#"{"$dr":"map","entries":[]}"#),
            Ok(W::Unsupported("map"))
        ));
    }
}

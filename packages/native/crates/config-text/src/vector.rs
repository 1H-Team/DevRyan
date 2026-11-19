//! The vector interchange format (`tests/config-text-format.mjs` is its
//! JavaScript half): each operation as one row of fields, and its result as
//! one text, so a tracked vector file, the cargo tests and the test-only
//! probe all compare the same bytes. Not a product interface.
//!
//! Fields are base64 of WTF-8 (UTF-8 that also carries lone surrogates), so
//! any JavaScript string survives. Results are JavaScript strings too.

use crate::value::{Graph, Val};
use crate::{front_matter, js, jsonc, yaml};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = ALPHABET
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or_else(|| format!("bad base64 byte {byte}"))? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

/// WTF-8 bytes of a JavaScript string.
pub fn wtf8_encode(text: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        let mut code = u32::from(text[index]);
        if (0xd800..=0xdbff).contains(&code)
            && let Some(low) = text.get(index + 1).filter(|low| (0xdc00..=0xdfff).contains(*low))
        {
            code = 0x10000 + ((code - 0xd800) << 10) + (u32::from(*low) - 0xdc00);
            index += 1;
        }
        index += 1;
        if code < 0x80 {
            out.push(code as u8);
        } else if code < 0x800 {
            out.extend([0xc0 | (code >> 6) as u8, 0x80 | (code & 63) as u8]);
        } else if code < 0x10000 {
            out.extend([0xe0 | (code >> 12) as u8, 0x80 | ((code >> 6) & 63) as u8, 0x80 | (code & 63) as u8]);
        } else {
            out.extend([
                0xf0 | (code >> 18) as u8,
                0x80 | ((code >> 12) & 63) as u8,
                0x80 | ((code >> 6) & 63) as u8,
                0x80 | (code & 63) as u8,
            ]);
        }
    }
    out
}

/// The JavaScript string of WTF-8 bytes.
pub fn wtf8_decode(bytes: &[u8]) -> Result<Vec<u16>, String> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index];
        let (count, initial) = match first {
            0x00..=0x7f => (0, u32::from(first)),
            0xc0..=0xdf => (1, u32::from(first & 0x1f)),
            0xe0..=0xef => (2, u32::from(first & 0x0f)),
            0xf0..=0xf7 => (3, u32::from(first & 0x07)),
            _ => return Err(format!("bad WTF-8 byte at {index}")),
        };
        let mut code = initial;
        for offset in 1..=count {
            let next = *bytes.get(index + offset).ok_or("truncated WTF-8")?;
            code = (code << 6) | u32::from(next & 0x3f);
        }
        index += count + 1;
        if code >= 0x10000 {
            let value = code - 0x10000;
            out.push(0xd800 + (value >> 10) as u16);
            out.push(0xdc00 + (value & 0x3ff) as u16);
        } else {
            out.push(code as u16);
        }
    }
    Ok(out)
}

/// A field: base64 of WTF-8.
pub fn field(text: &str) -> Result<Vec<u16>, String> {
    wtf8_decode(&base64_decode(text)?)
}

pub fn encode_field(text: &[u16]) -> String {
    base64_encode(&wtf8_encode(text))
}

fn json(text: &[u16]) -> String {
    js::lossy_json(text)
}

/// A JSON array of strings, as the vector rows write paths.
fn string_list(text: &[u16]) -> Result<Vec<Vec<u16>>, String> {
    let mut graph = Graph::new();
    // JSON arrays of strings are descriptions too.
    let value = graph.from_description_units(text)?;
    let Val::Ref(id) = value else {
        return Err("a path must be an array".to_owned());
    };
    let crate::value::Node::Array(items) = graph.node(id) else {
        return Err("a path must be an array".to_owned());
    };
    items
        .iter()
        .map(|item| match item {
            Val::String(text) => Ok(text.clone()),
            _ => Err("a path holds strings".to_owned()),
        })
        .collect()
}

fn list_of_lists(text: &[u16]) -> Result<Vec<Vec<Vec<u16>>>, String> {
    let mut graph = Graph::new();
    let value = graph.from_description_units(text)?;
    let Val::Ref(id) = value else {
        return Err("key paths must be an array".to_owned());
    };
    let crate::value::Node::Array(items) = graph.node(id).clone() else {
        return Err("key paths must be an array".to_owned());
    };
    let mut out = Vec::new();
    for item in items {
        let Val::Ref(inner) = item else {
            return Err("a key path must be an array".to_owned());
        };
        let crate::value::Node::Array(segments) = graph.node(inner) else {
            return Err("a key path must be an array".to_owned());
        };
        let mut path = Vec::new();
        for segment in segments {
            let Val::String(text) = segment else {
                return Err("a key path holds strings".to_owned());
            };
            path.push(text.clone());
        }
        out.push(path);
    }
    Ok(out)
}

/// An edit's failure: `!` and what JavaScript throws, or `refused`.
fn edit_error(error: jsonc::ModifyError) -> Vec<u16> {
    match error {
        jsonc::ModifyError::Thrown(message) => js::units(&format!("!{message}")),
        jsonc::ModifyError::Refused(_) => js::units("refused"),
    }
}

fn edit_result(result: Result<Vec<u16>, jsonc::ModifyError>) -> Vec<u16> {
    match result {
        Ok(text) => js::concat(&[&[0x3d], &text]),
        Err(error) => edit_error(error),
    }
}

/// Runs one operation and returns its result text.
pub fn run(op: &str, args: &[Vec<u16>]) -> Result<Vec<u16>, String> {
    let arg = |index: usize| args.get(index).ok_or_else(|| format!("{op} needs argument {}", index + 1));
    Ok(match op {
        "jsonc-parse" => match jsonc::parse(arg(0)?) {
            Err(_) => js::units("deep"),
            Ok(parsed) => {
                let errors: Vec<String> = parsed.errors.iter().map(|e| format!("{}@{}:{}", e.error, e.offset, e.length)).collect();
                js::units(&format!("{}\n{}", parsed.graph.describe(&parsed.value), errors.join(",")))
            }
        },
        "jsonc-strip" => jsonc::strip_comments(arg(0)?),
        "jsonc-modify" => {
            let path = string_list(arg(1)?)?;
            let mut graph = Graph::new();
            let description = arg(2)?;
            let value = if description.is_empty() {
                Val::Undefined
            } else {
                graph.from_description_units(description)?
            };
            let eol = arg(3)?.clone();
            match jsonc::modify(arg(0)?, &path, &graph, &value, &eol) {
                Ok(edits) => {
                    let rows: Vec<String> = edits
                        .iter()
                        .map(|edit| format!("{}:{}:{}", edit.offset, edit.length, json(&edit.content)))
                        .collect();
                    js::units(&rows.join("\n"))
                }
                Err(error) => edit_error(error),
            }
        }
        "jsonc-remove" => edit_result(jsonc::remove_key_paths(arg(0)?, &list_of_lists(arg(1)?)?)),
        "jsonc-set" => {
            let path = string_list(arg(1)?)?;
            let mut graph = Graph::new();
            let value = graph.from_description_units(arg(2)?)?;
            edit_result(jsonc::set_key_path(arg(0)?, &path, &graph, &value))
        }
        "jsonc-provision" => {
            // user-profile-provisioning: set `plugin`, then remove key paths, on one text.
            let source = arg(0)?;
            let mut graph = Graph::new();
            let value = graph.from_description_units(arg(1)?)?;
            let paths = list_of_lists(arg(2)?)?;
            let result = jsonc::set_key_path(source, &[js::units("plugin")], &graph, &value).and_then(|text| jsonc::remove_key_paths(&text, &paths));
            edit_result(result)
        }
        "yaml-parse" => {
            let mut lines: Vec<String> = Vec::new();
            match yaml::parse(arg(0)?) {
                yaml::Parsed::Refused(_) => lines.push("unsupported".to_owned()),
                yaml::Parsed::Value { graph, value, warnings } => {
                    lines.extend(warnings.iter().map(|w| format!("warn\t{}\t{}", w.code, json(&w.message))));
                    lines.push(format!("value\t{}", graph.describe(&value)));
                }
                yaml::Parsed::Thrown { name, code, message, warnings } => {
                    lines.extend(warnings.iter().map(|w| format!("warn\t{}\t{}", w.code, json(&w.message))));
                    lines.push(format!("throw\t{name}\t{}\t{}", code.unwrap_or("-"), json(&message)));
                }
            }
            js::units(&lines.join("\n"))
        }
        "yaml-stringify" => {
            let mut graph = Graph::new();
            let value = graph.from_description_units(arg(0)?)?;
            match yaml::stringify(&graph, &value) {
                Ok(None) => js::units("undefined"),
                Ok(Some(text)) => js::units(&json(&text)),
                Err(_) => js::units("unsupported"),
            }
        }
        "front-split" => match front_matter::split(arg(0)?) {
            None => js::units("none"),
            Some((yaml, body)) => js::units(&format!("{}\n{}", json(&yaml), json(&body))),
        },
        "front-skill" => match front_matter::split_skill(arg(0)?) {
            None => js::units("none"),
            Some(yaml) => js::units(&json(&yaml)),
        },
        "trim" => js::trim(arg(0)?).to_vec(),
        "utf8-decode" => {
            // The argument's units are bytes (0 to 255): what readFileSync(file, 'utf8') gives for them.
            let bytes: Vec<u8> = arg(0)?.iter().map(|unit| *unit as u8).collect();
            js::from_utf8(&bytes)
        }
        "utf8-encode" => js::to_utf8(arg(0)?).iter().map(|byte| u16::from(*byte)).collect(),
        other => return Err(format!("unknown operation {other}")),
    })
}

//! The Rust port of `opencode/runtime-host/claude-agent-protocol.js`: the controller/host frame
//! validators. `JSON.stringify` is written out for the size bound (UTF-8 bytes; its output escapes
//! lone surrogates, so every unit is well formed). Base64 chunks are checked as Node checks them:
//! the canonical pattern, then a decode and re-encode that must give the same text. A `Map`,
//! `Set`, `Date` or typed array is an object with no own string keys (a typed array lists its
//! indexes), as `Object.keys` sees it.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

const CHUNK_BYTES: usize = 16384;
const INVALID: &str = "claude_agent_invalid";
#[rustfmt::skip]
const ERRORS: [&str; 8] = ["claude_agent_invalid", "claude_agent_missing", "claude_agent_argument_refused", "claude_agent_directory_invalid", "claude_agent_launch_failed", "claude_agent_limit", "claude_agent_closed", "claude_agent_session_failed"];

fn fail<T>() -> Result<T, String> {
    Err(INVALID.into())
}

fn check(ok: bool) -> Result<(), String> {
    if ok { Ok(()) } else { fail() }
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

/// `Object.keys(value)` of an object, or `None` when `value` is not a non-array object.
fn object_keys(value: &Value) -> Option<Vec<String>> {
    let o = value.as_object()?;
    match o.keys().next().filter(|k| o.len() == 1 && k.starts_with('$')).map(String::as_str) {
        Some("$utf16" | "$num" | "$undefined" | "$function" | "$bigint") => None,
        Some("$bytes") => Some((0..value["$bytes"].as_array().map_or(0, Vec::len)).map(|i| i.to_string()).collect()),
        Some(_) => Some(Vec::new()),
        None => Some(o.keys().cloned().collect()),
    }
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), String> {
    check(object_keys(value).is_some_and(|k| k.iter().all(|k| allowed.contains(&k.as_str()))))
}

fn byte_length(value: &Value) -> Result<usize, String> {
    Ok(stringify(value)?.map_or(0, |t| t.len()))
}

fn ascii(value: &Value) -> Option<String> {
    js::string_units(value).and_then(|u| String::from_utf16(&u).ok())
}

fn id(value: &Value) -> Result<(), String> {
    check(ascii(value).is_some_and(|s| (32..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')))
}

fn text(value: &Value, max: usize) -> Result<(), String> {
    check(js::string_units(value).is_some_and(|u| u.len() <= max && !u.contains(&0)))
}

fn base64_value(b: u8) -> Option<u32> {
    match b {
        b'A'..=b'Z' => Some(u32::from(b - b'A')),
        b'a'..=b'z' => Some(u32::from(b - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(b - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn chunk(value: &Value) -> Result<(), String> {
    let Some(s) = ascii(value).filter(|s| !s.is_empty() && s.len() <= 21848 && s.len() % 4 == 0) else {
        return fail();
    };
    let bytes = s.as_bytes();
    let padding = bytes.iter().rev().take_while(|b| **b == b'=').count();
    let body = &bytes[..bytes.len() - padding];
    let Some(values) = body.iter().map(|b| base64_value(*b)).collect::<Option<Vec<u32>>>() else {
        return fail();
    };
    // The pattern allows `==` or `=` padding of the last quantum only; the re-encode is the same
    // text only when the bits a short quantum drops are zero.
    let last = values.last().copied().unwrap_or(0);
    let canonical = match padding {
        0 => true,
        1 => last & 0b11 == 0,
        2 => last & 0b1111 == 0,
        _ => false,
    };
    check(canonical && values.len() * 6 / 8 <= CHUNK_BYTES)
}

fn claude_session(value: &Value) -> Result<(), String> {
    let Some(s) = ascii(value) else { return fail() };
    let groups: Vec<&str> = s.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    check(
        groups.len() == 5
            && groups
                .iter()
                .zip(lengths)
                .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit())),
    )
}

fn safe_int(value: &Value) -> Option<f64> {
    js::as_number(value).filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

fn same(value: Value) -> Value {
    js::as_number(&value).map_or(value, js::number)
}

/// Port of `parseClaudeAgentRequest` (`claude-agent-protocol.js:30`).
pub fn parse_claude_agent_request(value: Value) -> Result<Value, String> {
    if byte_length(&value)? > 60 * 1024 {
        return fail();
    }
    let action = field(&value, "action");
    let action = action.as_str().unwrap_or_default();
    let fields: &[&str] = match action {
        "spawn" => &["args", "cwd", "env"],
        "stdin" => &["chunk"],
        "kill" => &["signal"],
        "session" => &["operation", "sessionID", "messageID"],
        _ => &[],
    };
    keys(&value, &[&["protocol", "type", "action", "id"][..], fields].concat())?;
    check(
        js::as_number(&field(&value, "protocol")) == Some(1.0)
            && field(&value, "type").as_str() == Some("claude-agent")
            && ["spawn", "stdin", "end", "kill", "session"].contains(&action),
    )?;
    id(&field(&value, "id"))?;
    match action {
        "spawn" => {
            let Value::Array(args) = field(&value, "args") else { return fail() };
            check(args.len() <= 128)?;
            args.iter().try_for_each(|a| text(a, 16384))?;
            let cwd = field(&value, "cwd");
            text(&cwd, 8192)?;
            check(js::string_units(&cwd).is_some_and(|u| u.first() == Some(&0x2f) && !u.iter().any(|c| *c <= 0x1f)))?;
            let env = field(&value, "env");
            let names = object_keys(&env).ok_or_else(|| INVALID.to_string())?;
            check(names.len() <= 256)?;
            for name in &names {
                let mut chars = name.bytes();
                let first = chars.next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_');
                check(first && name.len() <= 128 && name.is_ascii() && chars.all(|b| b.is_ascii_alphanumeric() || b == b'_'))?;
                text(plain(&env).map_or(&Value::Null, |o| &o[name]), 16384)?;
            }
        }
        "stdin" => chunk(&field(&value, "chunk"))?,
        "kill" => check(matches!(field(&value, "signal").as_str(), Some("SIGTERM" | "SIGKILL" | "SIGINT")))?,
        "session" => {
            let operation = field(&value, "operation");
            check(matches!(operation.as_str(), Some("exists" | "fork" | "remove")))?;
            claude_session(&field(&value, "sessionID"))?;
            if operation.as_str() == Some("fork") {
                claude_session(&field(&value, "messageID"))?;
            } else {
                check(js::is_undefined(&field(&value, "messageID")))?;
            }
        }
        _ => {}
    }
    Ok(same(value))
}

/// Port of `parseClaudeAgentReply` (`claude-agent-protocol.js:61`).
pub fn parse_claude_agent_reply(value: Value) -> Result<Value, String> {
    if byte_length(&value)? > 8 * 1024 * 1024 {
        return fail();
    }
    let action = field(&value, "action");
    let action = action.as_str().unwrap_or_default();
    let fields: &[&str] = match action {
        "stdout" => &["chunk"],
        "exit" => &["code", "signal", "error"],
        "result" => &["result"],
        "error" => &["error"],
        _ => &[],
    };
    keys(&value, &[&["protocol", "type", "action", "id"][..], fields].concat())?;
    check(
        js::as_number(&field(&value, "protocol")) == Some(1.0)
            && field(&value, "type").as_str() == Some("claude-agent-reply")
            && ["started", "stdout", "exit", "result", "error"].contains(&action),
    )?;
    id(&field(&value, "id"))?;
    let known = |v: &Value| v.as_str().is_some_and(|e| ERRORS.contains(&e));
    match action {
        "stdout" => chunk(&field(&value, "chunk"))?,
        "exit" => {
            let (code, signal, error) = (field(&value, "code"), field(&value, "signal"), field(&value, "error"));
            check(code.is_null() || safe_int(&code).is_some_and(|c| (0.0..=255.0).contains(&c)))?;
            let signal_ok = |s: &str| {
                s.strip_prefix("SIG")
                    .is_some_and(|r| (1..=16).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
            };
            check(signal.is_null() || ascii(&signal).is_some_and(|s| signal_ok(&s)))?;
            check(js::is_undefined(&error) || known(&error))?;
        }
        "error" => check(known(&field(&value, "error")))?,
        "result" => {
            let result = field(&value, "result");
            if result.is_boolean() || result.is_null() {
                return Ok(value);
            }
            keys(&result, &["sessionID", "messages"])?;
            claude_session(&field(&result, "sessionID"))?;
            let Value::Array(messages) = field(&result, "messages") else { return fail() };
            check(messages.len() <= 100_000)?;
            for pair in &messages {
                let Value::Array(pair) = pair else { return fail() };
                check(pair.len() == 2)?;
                pair.iter().try_for_each(claude_session)?;
            }
        }
        _ => {}
    }
    Ok(same(value))
}

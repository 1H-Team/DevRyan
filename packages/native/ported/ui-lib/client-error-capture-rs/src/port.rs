//! The Rust port of `client-error-capture.ts`: `shouldIgnoreClientError` and
//! `fingerprintError` (FNV-1a over UTF-16 code units, `Math.imul`, base 36). The report queue,
//! its timers, `fetch` and the `window` readers stay in TS. The fingerprint joins its parts with
//! NUL characters, as the source's template does.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const BENIGN: &str = "ResizeObserver loop completed with undelivered notifications";

/// JS `String(value)` as UTF-16 code units (`element` for an array member: `null`/`undefined`
/// print empty).
fn js_string(value: &Value, element: bool) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    let single = |key: &str| value.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(key));
    let text = match value {
        _ if js::is_undefined(value) => {
            if element {
                String::new()
            } else {
                "undefined".into()
            }
        }
        Value::Null => {
            if element {
                String::new()
            } else {
                "null".into()
            }
        }
        Value::Bool(flag) => flag.to_string(),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(|v| String::from_utf16_lossy(&js_string(v, true))).collect();
            parts.join(",")
        }
        _ if single("$map") => "[object Map]".into(),
        _ if single("$set") => "[object Set]".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    };
    text.encode_utf16().collect()
}

/// JS `\s`.
fn sp(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

fn trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|u| !sp(*u)).unwrap_or(units.len());
    let end = units.iter().rposition(|u| !sp(*u)).map_or(start, |i| i + 1);
    &units[start..end]
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

/// Port of `shouldIgnoreClientError` (`client-error-capture.ts:36`).
pub fn should_ignore_client_error(message: Value, source: Value) -> Result<bool, String> {
    if source.as_str() != Some("window_error") {
        return Ok(false);
    }
    let Some(units) = js::string_units(&message) else { return Ok(false) };
    let text = String::from_utf16_lossy(trim(&units));
    let body = text.strip_suffix('.').unwrap_or(&text);
    Ok(body.len() == BENIGN.len() && body.eq_ignore_ascii_case(BENIGN) && text.is_ascii())
}

/// Port of `fingerprintError` (`client-error-capture.ts:59`).
pub fn fingerprint_error(name: Value, message: Value, stack: Value) -> Result<String, String> {
    let frames: Vec<u16> = if truthy(&stack) {
        let Some(units) = js::string_units(&stack) else {
            return Err("(stack || \"\").split is not a function".into()); // recorded-literal: V8 TypeError text
        };
        let lines: Vec<&[u16]> = units.split(|u| *u == u16::from(b'\n')).skip(1).take(3).collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if i > 0 {
                out.push(u16::from(b'|'));
            }
            out.extend_from_slice(trim(line));
        }
        out
    } else {
        Vec::new()
    };
    let mut text = js_string(&name, false);
    text.push(0);
    text.extend(js_string(&message, false));
    text.push(0);
    text.extend(frames);
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let mut digits = Vec::new();
    let mut n = hash;
    loop {
        digits.push(char::from_digit(n % 36, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    Ok(digits.into_iter().rev().collect())
}

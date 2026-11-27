//! The Rust port of `lib/upstream-stall.js` of `@devryan/shared-runtime`. `JSON.parse` is
//! serde_json after the same two rewrites as `provider-error-details-rs` (surrogate escapes, numbers
//! beyond f64), so an envelope JS reads is read here too.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// `Upstream stalled: no data for <n>ms` with `n` of 1 to 13 digits and no leading zero.
fn stall_message(t: &str) -> bool {
    t.strip_prefix("Upstream stalled: no data for ")
        .and_then(|r| r.strip_suffix("ms"))
        .is_some_and(|n| (1..=13).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()) && !n.starts_with('0'))
}

/// The JSON text with surrogate escapes replaced and numbers beyond f64 written as `0`.
fn tolerant(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let (mut out, mut i, mut in_string) = (String::with_capacity(text.len()), 0, false);
    while i < chars.len() {
        let c = chars[i];
        if in_string && c == '\\' && chars.get(i + 1) == Some(&'u') {
            let hex: String = chars.iter().skip(i + 2).take(4).collect();
            let surrogate = hex.len() == 4 && u16::from_str_radix(&hex, 16).is_ok_and(|v| (0xd800..=0xdfff).contains(&v)) && !hex.starts_with('+');
            out.push_str(if surrogate { "\\ufffd" } else { "\\u" });
            out.push_str(if surrogate { "" } else { &hex });
            i += 2 + hex.chars().count();
        } else if in_string && c == '\\' {
            out.extend(chars.get(i..i + 2).unwrap_or(&chars[i..]));
            i += 2;
        } else if c == '"' {
            in_string = !in_string;
            out.push(c);
            i += 1;
        } else if !in_string && (c == '-' || c.is_ascii_digit()) {
            let run: String = chars[i..]
                .iter()
                .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
                .collect();
            i += run.len();
            out.push_str(if run.parse::<f64>().is_ok_and(f64::is_infinite) { "0" } else { &run });
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn parse(text: String) -> Option<Value> {
    let read = move || {
        let text = tolerant(&text);
        let mut reader = serde_json::Deserializer::from_str(&text);
        reader.disable_recursion_limit();
        let value = <Value as serde::Deserialize>::deserialize(&mut reader).ok()?;
        reader.end().ok().map(|()| value)
    };
    std::thread::Builder::new().stack_size(64 << 20).spawn(read).ok()?.join().ok().flatten()
}

/// Port of `isUpstreamStallText` (`upstream-stall.js:10`).
pub fn is_upstream_stall_text(value: Value) -> Result<Value, String> {
    Ok(Value::Bool(
        value.as_str().and_then(|t| t.strip_prefix("upstream_timeout: ")).is_some_and(stall_message),
    ))
}

/// Port of `isUpstreamStallEnvelope` (`upstream-stall.js:13`).
pub fn is_upstream_stall_envelope(value: Value) -> Result<Value, String> {
    let Some(units) = js::string_units(&value).filter(|u| u.len() <= 4096) else {
        return Ok(Value::Bool(false));
    };
    let parsed = parse(String::from_utf16_lossy(&units));
    let ok = parsed.as_ref().and_then(Value::as_object).is_some_and(|o| {
        o.get("type").and_then(Value::as_str) == Some("upstream_timeout") && o.get("message").and_then(Value::as_str).is_some_and(stall_message)
    });
    Ok(Value::Bool(ok))
}

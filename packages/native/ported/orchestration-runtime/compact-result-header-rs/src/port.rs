//! The Rust port of `compact-result-header.js` of `@devryan/orchestration-runtime`:
//! `readManagedResultReport`, its two regexes matched by hand on UTF-16 lines.
//! `createCompactResultHeader` stays in JS (it rests on modules `scheduler-policy` already ports).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

// ---- the unit ----

fn ws(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// `/^ {0,3}(`{3,}|~{3,})/`: (match length, fence).
fn delimiter(line: &[u16]) -> Option<(usize, Vec<u16>)> {
    let spaces = line.iter().take_while(|c| **c == 32).count();
    let c = *line.get(spaces)?;
    if spaces > 3 || (c != 96 && c != 126) {
        return None;
    }
    let run = line[spaces..].iter().take_while(|x| **x == c).count();
    (run >= 3).then(|| (spaces + run, line[spaces..spaces + run].to_vec()))
}

fn starts(line: &[u16], lit: &str) -> bool {
    line.starts_with(&lit.encode_utf16().collect::<Vec<_>>())
}

/// Port of `readManagedResultReport` (`compact-result-header.js:8`).
pub fn read_managed_result_report(preview: serde_json::Value) -> Result<serde_json::Value, String> {
    let Some(text) = js::string_units(&preview) else {
        if preview.is_null() || js::is_undefined(&preview) {
            let kind = if preview.is_null() { "null" } else { "undefined" };
            return Err(format!("TypeError: Cannot read properties of {kind} (reading 'trimEnd')"));
        }
        return Err("TypeError: preview.trimEnd is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let end = text.iter().rposition(|c| !ws(*c)).map_or(0, |i| i + 1);
    let mut lines: Vec<&[u16]> = Vec::new();
    let mut start = 0;
    for (i, c) in text[..end].iter().enumerate() {
        if *c == 10 {
            lines.push(&text[start..if i > start && text[i - 1] == 13 { i - 1 } else { i }]);
            start = i + 1;
        }
    }
    lines.push(&text[start..end]);
    let mut markers: Vec<(usize, Option<&str>)> = Vec::new();
    let mut fence: Option<Vec<u16>> = None;
    let mut routing = Value::Null;
    for (index, line) in lines.iter().enumerate() {
        if let Some((len, run)) = delimiter(line) {
            match &fence {
                None => fence = Some(run),
                Some(open) if run[0] == open[0] && run.len() >= open.len() && line[len..].iter().all(|c| ws(*c)) => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if starts(line, "**Status:**") {
            let status = ["complete", "blocked"]
                .into_iter()
                .find(|s| line[..] == format!("**Status:** {s}").encode_utf16().collect::<Vec<_>>()[..]);
            markers.push((index, status));
        }
        if index + 2 == lines.len() && starts(line, "**Routing:** ") && line.len() <= 256 {
            routing = js::utf16_string(&line[13..]);
        }
    }
    let terminal = match markers.as_slice() {
        [] => "missing",
        [(index, Some(status))] if *index + 1 == lines.len() && fence.is_none() => status,
        _ => "ambiguous",
    };
    Ok(json!({ "source": "retained-child-preview", "authoritative": false, "terminalMarker": terminal, "routing": routing }))
}

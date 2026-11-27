//! The Rust port of `opencode/runtime-host/native-managed-job-input.js` (`nativeManagedJobInput`;
//! the completion `Symbol` and the phase list stay JS constants). Every accepted value is plain
//! JSON data, so `structuredClone` of it is the value as given.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::js;

const INVALID: &str = "native_managed_job_scope_invalid";
const FIELDS: [&str; 9] = [
    "taskId",
    "leaseToken",
    "rootSessionId",
    "directory",
    "sessionID",
    "providerId",
    "modelId",
    "agent",
    "variant",
];
const SEGMENT_FIELDS: [&str; 3] = ["messageID", "jobID", "notificationID"];

fn fail<T>() -> Result<T, String> {
    Err(INVALID.into())
}

/// A non-null, non-array object's own entries (a `Map`, `Set`, `Date`: none; a typed array: its indexes).
fn record(value: &Value) -> Option<Map<String, Value>> {
    let o = value.as_object()?;
    match o.keys().next().filter(|k| o.len() == 1 && k.starts_with('$')).map(String::as_str) {
        Some("$utf16" | "$num" | "$undefined" | "$function" | "$bigint") => None,
        Some("$bytes") => Some(
            value["$bytes"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(i, b)| (i.to_string(), b.clone()))
                .collect(),
        ),
        Some(_) => Some(Map::new()),
        None => Some(o.clone()),
    }
}

fn get<'a>(o: &'a Map<String, Value>, key: &str) -> &'a Value {
    o.get(key).unwrap_or(&Value::Null)
}

fn text(value: &Value) -> Option<Vec<u16>> {
    js::string_units(value).filter(|u| (1..=512).contains(&u.len()) && !u.contains(&0))
}

fn prefixed(value: &Value, prefix: &str) -> bool {
    js::string_units(value).and_then(|u| String::from_utf16(&u).ok()).is_some_and(|s| {
        s.strip_prefix(prefix)
            .is_some_and(|r| (1..=128).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    })
}

fn segment(item: &Map<String, Value>, session_id: &Value) -> Result<(), String> {
    let ok = SEGMENT_FIELDS.iter().all(|k| text(get(item, k)).is_some())
        && prefixed(get(item, "messageID"), "msg")
        && prefixed(get(item, "notificationID"), "msg")
        && text(get(item, "messageID")) != text(get(item, "notificationID"))
        && text(get(item, "jobID")) != js::string_units(session_id);
    if ok { Ok(()) } else { fail() }
}

/// Port of `nativeManagedJobInput` (`native-managed-job-input.js:10`).
pub fn native_managed_job_input(value: Value, phase: Value) -> Result<Value, String> {
    let phase = phase
        .as_str()
        .filter(|p| ["prepare", "activate", "cancelSegment", "cancelTask", "acknowledge"].contains(p))
        .unwrap_or_default();
    let Some(o) = record(&value).filter(|_| !phase.is_empty()) else {
        return fail();
    };
    let mut allowed: Vec<&str> = FIELDS.to_vec();
    allowed.extend(if phase == "cancelTask" { &["segments"][..] } else { &SEGMENT_FIELDS[..] });
    if phase == "acknowledge" {
        allowed.push("envelopeID");
    }
    let directory = js::string_units(get(&o, "directory"));
    let variant = get(&o, "variant");
    let variant = if o.contains_key("variant") { variant.clone() } else { js::undefined() };
    let session = get(&o, "sessionID");
    let ok = o.keys().all(|k| allowed.contains(&k.as_str()))
        && FIELDS
            .iter()
            .filter(|k| !matches!(**k, "variant" | "directory"))
            .all(|k| text(get(&o, k)).is_some())
        && directory.is_some_and(|d| d.first() == Some(&0x2f) && !d.contains(&0))
        && (variant.is_null() || text(&variant).is_some())
        && get(&o, "providerId").as_str() != Some("cursor-acp")
        && prefixed(session, "ses")
        && prefixed(get(&o, "rootSessionId"), "ses")
        && js::string_units(session) != js::string_units(get(&o, "rootSessionId"));
    if !ok {
        return fail();
    }
    if phase == "cancelTask" {
        let Value::Array(segments) = get(&o, "segments") else { return fail() };
        let mut jobs = HashSet::new();
        for item in segments {
            let Some(item) = record(item).filter(|i| i.keys().all(|k| SEGMENT_FIELDS.contains(&k.as_str()))) else {
                return fail();
            };
            segment(&item, session)?;
            jobs.insert(text(get(&item, "jobID")));
        }
        if jobs.len() != segments.len() {
            return fail();
        }
    } else {
        segment(&o, session)?;
    }
    if phase == "acknowledge" && text(get(&o, "envelopeID")).is_none() {
        return fail();
    }
    Ok(value)
}

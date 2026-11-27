//! The Rust port of `startup-diagnostics.js` of `@devryan/shared-runtime`. Its four regexes are
//! ASCII character classes, matched by hand. `JSON.stringify(_, null, 2)` is serde_json's pretty
//! printer (the same two-space layout); `-0` prints as `0`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const STAGES: [&str; 6] = ["manifest", "inventory", "payload", "signature", "reviewed_asset", "launcher"];
const REASONS: [(&str, &str); 10] = [
    ("manifest_missing", "A required runtime manifest is missing."),
    ("manifest_invalid", "The runtime manifest is invalid or incompatible."),
    ("unsupported_platform", "The runtime was built for a different platform or architecture."),
    ("digest_mismatch", "A runtime file does not match its verified contents."),
    ("payload_missing", "A required runtime file is missing."),
    ("payload_invalid", "A runtime file has an invalid location or file type."),
    ("mode_mismatch", "A runtime file has incorrect permissions."),
    ("signature_failure", "A runtime code signature could not be verified."),
    ("reviewed_asset_mismatch", "A bundled runtime component does not match its approved version."),
    ("launcher_rejected", "The runtime execution launcher could not be verified."),
];
const PURPOSES: [&str; 4] = ["current", "bundle-source", "bundle-rollback", "update-candidate"];

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `typeof v === "object" && v !== null` for a received value (markers are primitives).
fn object(v: &Value) -> bool {
    v.is_array()
        || v.as_object()
            .is_some_and(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16"].iter().any(|k| o.contains_key(*k))))
}

/// `v?.key`.
fn opt(v: &Value, key: &str) -> Value {
    v.as_object()
        .filter(|_| object(v))
        .and_then(|o| o.get(key))
        .cloned()
        .unwrap_or_else(js::undefined)
}

fn text(v: &Value) -> Option<&str> {
    v.as_str()
}

fn one_of(v: &Value, set: &[&str]) -> bool {
    text(v).is_some_and(|t| set.contains(&t))
}

fn class(c: char, extra: &str) -> bool {
    c.is_ascii_alphanumeric() || extra.contains(c)
}

/// `/^(?:native-bundle\.json|DevRyan-[A-Za-z0-9._-]{1,128})$/`.
fn artifact_name(t: &str) -> bool {
    t == "native-bundle.json"
        || t.strip_prefix("DevRyan-")
            .is_some_and(|r| (1..=128).contains(&r.len()) && r.chars().all(|c| class(c, "._-")))
}

/// `/^[A-Za-z0-9._-]{1,64}$/`.
fn label(v: &Value) -> bool {
    text(v).is_some_and(|t| (1..=64).contains(&t.len()) && t.chars().all(|c| class(c, "._-")))
}

/// `/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,159}$/` and no empty or `..` segment.
fn record_key(t: &str) -> bool {
    let mut chars = t.chars();
    chars.next().is_some_and(|c| class(c, "_-")) && t.len() <= 160 && chars.all(|c| class(c, "._/-")) && !t.split('/').any(|p| p.is_empty() || p == "..")
}

fn parse(value: &Value) -> Option<Value> {
    if !object(value)
        || !one_of(&opt(value, "stage"), &STAGES)
        || !REASONS.iter().any(|(r, _)| text(&opt(value, "reason")) == Some(r))
        || !one_of(&opt(value, "purpose"), &PURPOSES)
    {
        return None;
    }
    let mut out = Map::new();
    for key in ["stage", "reason", "purpose"] {
        out.insert(key.into(), opt(value, key));
    }
    let artifact = opt(value, "artifact");
    if text(&artifact).is_some_and(artifact_name) {
        out.insert("artifact".into(), artifact);
    }
    Some(Value::Object(out))
}

fn artifact(error: &Value) -> Option<Value> {
    parse(&opt(error, "diagnostic")).or_else(|| parse(&opt(&opt(error, "cause"), "diagnostic")))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        _ if js::is_undefined(v) => false,
        _ => js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()) && js::string_units(v).is_none_or(|u| !u.is_empty()),
    }
}

fn detail(error: &Value) -> Option<Value> {
    let own = opt(error, "detail");
    let detail = if nullish(&own) { opt(&opt(error, "cause"), "detail") } else { own };
    if !truthy(&detail) || !object(&detail) || !label(&opt(&detail, "ledger")) {
        return None;
    }
    let ledger = opt(&detail, "ledger");
    let key = opt(&detail, "key");
    if text(&key).is_some_and(record_key) {
        return Some(json!({ "ledger": ledger, "key": key }));
    }
    let Value::Array(leases) = opt(&detail, "leases") else { return None };
    let rows: Vec<Value> = leases
        .iter()
        .take(8)
        .filter(|row| truthy(row) && ["token", "state", "kind"].iter().all(|k| label(&opt(row, k))))
        .map(|row| json!({ "token": opt(row, "token"), "state": opt(row, "state"), "kind": opt(row, "kind"), "cleanupPending": opt(row, "cleanupPending") == Value::Bool(true) }))
        .collect();
    Some(json!({ "ledger": ledger, "leases": rows }))
}

/// Port of `parseArtifactDiagnostic` (`startup-diagnostics.js:7`).
pub fn parse_artifact_diagnostic(value: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(parse(&value).unwrap_or_else(js::undefined))
}

/// Port of `artifactDiagnostic` (`startup-diagnostics.js:15`).
pub fn artifact_diagnostic(error: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(artifact(&error).unwrap_or_else(js::undefined))
}

/// Port of `startupFailureDetail` (`startup-diagnostics.js:20`).
pub fn startup_failure_detail(error: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(detail(&error).unwrap_or_else(js::undefined))
}

/// Port of `startupDiagnosticSummary` (`startup-diagnostics.js:31`).
pub fn startup_diagnostic_summary(error: serde_json::Value) -> Result<String, String> {
    let code = opt(&error, "code");
    let code_ok = text(&code).is_some_and(|c| {
        ["native_", "opencode_", "bundle_", "runtime_"].iter().any(|p| {
            c.strip_prefix(p)
                .is_some_and(|r| (1..=100).contains(&r.len()) && r.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'))
        })
    });
    let mut out = Map::new();
    out.insert("code".into(), if code_ok { code } else { Value::String("opencode_startup_failed".into()) });
    let attempt = opt(&error, "attempt");
    if let Some(n) = attempt.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && *n >= 0.0) {
        out.insert("attempt".into(), Value::from(n as i64));
    } else if attempt.get("$num").and_then(Value::as_str) == Some("-0") {
        out.insert("attempt".into(), Value::from(0));
    }
    if let Some(d) = artifact(&error) {
        out.insert("diagnostic".into(), d);
    }
    if let Some(d) = detail(&error) {
        out.insert("detail".into(), d);
    }
    serde_json::to_string_pretty(&Value::Object(out)).map_err(|e| e.to_string())
}

/// Port of `describeReferenceFailure` (`startup-diagnostics.js:52`).
pub fn describe_reference_failure(error: serde_json::Value) -> Result<String, String> {
    let record = detail(&error)
        .filter(|d| truthy(&opt(d, "key")))
        .map(|d| {
            format!(
                " Record: {}/{}.",
                text(&opt(&d, "ledger")).unwrap_or_default(),
                text(&opt(&d, "key")).unwrap_or_default()
            )
        })
        .unwrap_or_default();
    Ok(format!(
        "DevRyan found a saved record that refers to a deleted session or message, so it did not start.{record} Install the latest DevRyan update. Your existing data has not been reset."
    ))
}

/// Port of `describeArtifactFailure` (`startup-diagnostics.js:57`).
pub fn describe_artifact_failure(value: serde_json::Value) -> Result<String, String> {
    let Some(d) = parse(&value) else {
        return Ok("The runtime files could not be verified. Your existing data has not been reset.".into());
    };
    let explanation = REASONS.iter().find(|(r, _)| text(&opt(&d, "reason")) == Some(r)).map_or("", |(_, e)| e);
    let file = text(&opt(&d, "artifact")).map(|a| format!(" File: {a}.")).unwrap_or_default();
    Ok(format!("{explanation}{file} Your existing data has not been reset."))
}

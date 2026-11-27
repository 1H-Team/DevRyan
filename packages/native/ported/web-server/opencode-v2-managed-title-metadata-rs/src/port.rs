//! The Rust port of `opencode/v2/managed-title-metadata.js`: exactly the 25 keys, each checked;
//! `path.resolve(dir) === dir` holds for `/` or an absolute path with no empty, `.` or `..` segment.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const KEYS: [&str; 25] = [
    "v",
    "taskId",
    "rootSessionId",
    "parentSessionId",
    "childSessionId",
    "directory",
    "dispatchCallId",
    "dispatchGroupId",
    "attempt",
    "sequence",
    "agent",
    "providerId",
    "modelId",
    "variant",
    "readOnly",
    "anchorID",
    "objectiveID",
    "cancellationGeneration",
    "generation",
    "admissionRevision",
    "controllerInstanceID",
    "configurationDigest",
    "sourceMessageID",
    "fingerprint",
    "textSha256",
];

fn int_at_least(v: &Value, min: f64) -> bool {
    (v.is_number() || v.get("$num").is_some()) && js::as_number(v).is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && n >= min)
}

fn word(v: &Value, prefix: &str, len: usize, hex: bool) -> bool {
    v.as_str().and_then(|s| s.strip_prefix(prefix)).is_some_and(|r| {
        (1..=len).contains(&r.len())
            && (hex && r.len() == 64 && r.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !hex && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    })
}

/// Port of `isCanonicalManagedTitleMetadata` (`opencode/v2/managed-title-metadata.js:11`).
pub fn is_canonical_managed_title_metadata(value: Value) -> Result<Value, String> {
    let Some(map) = value.as_object().filter(|o| o.len() == KEYS.len() && KEYS.iter().all(|k| o.contains_key(*k))) else {
        return Ok(Value::Bool(false));
    };
    let f = |k: &str| map[k].clone();
    let text = |k: &str| js::string_units(&f(k)).is_some_and(|u| !u.is_empty() && u.len() <= 256 && !u.iter().any(|c| *c <= 0x1f || *c == 0x7f));
    let dir = f("directory");
    let dir_ok = dir.as_str().is_some_and(|d| {
        d.encode_utf16().count() <= 4096 && !d.contains('\0') && (d == "/" || d.starts_with('/') && d[1..].split('/').all(|s| !matches!(s, "" | "." | "..")))
    });
    Ok(Value::Bool(
        f("v").is_number()
            && js::as_number(&f("v")) == Some(1.0)
            && word(&f("taskId"), "dvr_task_", 128, false)
            && ["rootSessionId", "parentSessionId", "childSessionId"]
                .iter()
                .all(|k| word(&f(k), "ses", 128, false))
            && ["dispatchGroupId", "anchorID", "objectiveID", "sourceMessageID"]
                .iter()
                .all(|k| word(&f(k), "msg_", 128, false))
            && dir_ok
            && ["dispatchCallId", "controllerInstanceID", "agent", "providerId", "modelId", "variant"]
                .iter()
                .all(|k| text(k))
            && ["attempt", "sequence"].iter().all(|k| int_at_least(&f(k), 1.0))
            && ["generation", "admissionRevision", "cancellationGeneration"]
                .iter()
                .all(|k| int_at_least(&f(k), 0.0))
            && f("readOnly").is_boolean()
            && ["configurationDigest", "fingerprint", "textSha256"].iter().all(|k| word(&f(k), "", 64, true)),
    ))
}

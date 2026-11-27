//! The Rust port of `opencode/runtime-host/native-credential-mutation-owner.js`: the two binding
//! validators (`credentialMutationFingerprint` is SHA-256 and the owner a factory over the
//! caller's queues; both stay in JS). `isCatalogProviderIntegration` is
//! `native-provider-integrations.js`'s. `RegExp#test` on `sessionID` reads its `String()`, so an
//! array spelling a session id passes that test, as in JS; `===` between two objects is false.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

#[rustfmt::skip]
const MUTATION_FIELDS: [&str; 13] = ["directory", "controllerInstanceID", "integrationID", "operation", "credentialID", "expectedFingerprint", "requestedFingerprint", "valueType", "methodID", "kind", "server", "configurationDigest", "acquisitionID"];
#[rustfmt::skip]
const RESOLUTION_FIELDS: [&str; 12] = ["kind", "integrationID", "methodID", "controllerInstanceID", "directory", "acquisitionID", "configurationDigest", "sessionID", "permit", "credentialID", "expectedFingerprint", "valueType"];

/// A non-null, non-array object's own entries (a `Map`, `Set` or `Date` has none).
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

struct Fields(Map<String, Value>);

impl Fields {
    fn get(&self, key: &str) -> Value {
        self.0.get(key).cloned().unwrap_or_else(js::undefined)
    }
    fn str(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(js::string_units).and_then(|u| String::from_utf16(&u).ok())
    }
    fn is(&self, key: &str, text: &str) -> bool {
        self.0.get(key).and_then(Value::as_str) == Some(text)
    }
    fn absent(&self, key: &str) -> bool {
        js::is_undefined(&self.get(key))
    }
    fn id(&self, key: &str) -> bool {
        self.str(key)
            .is_some_and(|s| (1..=256).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    }
    fn digest(&self, key: &str) -> bool {
        self.str(key)
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    }
    fn one_of(&self, key: &str, values: &[&str]) -> bool {
        values.iter().any(|v| self.is(key, v))
    }
    /// An absolute directory of at most 4096 units without control characters.
    fn directory(&self) -> bool {
        self.0
            .get("directory")
            .and_then(js::string_units)
            .is_some_and(|d| d.first() == Some(&0x2f) && d.len() <= 4096 && !d.iter().any(|c| *c <= 0x1f))
    }
}

fn fields(value: &Value, allowed: &[&str]) -> Option<Fields> {
    record(value).filter(|o| o.keys().all(|k| allowed.contains(&k.as_str()))).map(Fields)
}

fn catalog(value: &Value) -> bool {
    let Some(text) = value.as_str() else { return false };
    let id = !text.is_empty() && text.len() <= 256 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let mcp = text
        .strip_prefix("mcp_")
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    id && !["openai", "cursor-acp", "claude-agent", "anthropic"].contains(&text) && !mcp
}

/// Port of `parseCredentialMutationBinding` (`native-credential-mutation-owner.js:15`).
pub fn parse_credential_mutation_binding(value: Value) -> Result<Value, String> {
    let Some(f) = fields(&value, &MUTATION_FIELDS) else {
        return Err("native_credential_mutation_binding_invalid".into());
    };
    let (oauth, kind) = (f.is("valueType", "oauth"), f.get("kind"));
    let kind = kind.as_str().unwrap_or_default();
    let server =
        f.0.get("server")
            .and_then(js::string_units)
            .is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.iter().any(|c| *c <= 0x1f));
    let ok = f.directory()
        && f.id("controllerInstanceID")
        && f.id("integrationID")
        && f.digest("requestedFingerprint")
        && f.one_of("operation", &["create", "update", "activate", "remove"])
        && f.one_of("valueType", &["key", "oauth"])
        && ["openai", "mcp", "cursor", "provider"].contains(&kind)
        && !(kind == "cursor" && !f.is("valueType", "key"))
        && !(kind == "provider" && (!catalog(&f.get("integrationID")) || oauth && f.is("integrationID", "xai") && !f.is("methodID", "device")))
        && (if oauth { f.id("methodID") } else { f.absent("methodID") })
        && (f.absent("credentialID") || f.id("credentialID"))
        && (f.absent("expectedFingerprint") || f.digest("expectedFingerprint"))
        && (if f.is("operation", "create") {
            f.absent("credentialID") && f.absent("expectedFingerprint")
        } else {
            f.id("credentialID") && f.digest("expectedFingerprint")
        })
        && (if kind == "mcp" {
            server && f.digest("configurationDigest") && f.id("acquisitionID")
        } else {
            !(kind != "provider" && !f.is("integrationID", if kind == "cursor" { "cursor-acp" } else { "openai" }))
                && f.absent("server")
                && f.absent("configurationDigest")
                && f.absent("acquisitionID")
        });
    if ok {
        Ok(Value::Object(f.0))
    } else {
        Err("native_credential_mutation_binding_invalid".into())
    }
}

/// `String(value)` for the session pattern (only text or an array can spell a session id).
fn text(value: &Value) -> Option<String> {
    if let Some(u) = js::string_units(value) {
        return Some(String::from_utf16_lossy(&u));
    }
    value
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .map(|v| if v.is_null() || js::is_undefined(v) { Some(String::new()) } else { text(v) })
                .collect::<Option<Vec<_>>>()
        })
        .map(|p| p.join(","))
}

/// `a === b` for values that crossed the bindings (objects are never the same reference).
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), _, _) => x == y,
        (None, None, Some(x), Some(y)) => x == y,
        (None, None, None, None) => (js::is_undefined(a) && js::is_undefined(b)) || (!a.is_object() && !a.is_array() && a == b),
        _ => false,
    }
}

/// Port of `parseCredentialResolutionBinding` (`native-credential-mutation-owner.js:38`).
pub fn parse_credential_resolution_binding(value: Value) -> Result<Value, String> {
    let invalid = || Err("native_credential_resolution_binding_invalid".into());
    let Some(f) = fields(&value, &RESOLUTION_FIELDS) else { return invalid() };
    let openai = f.is("kind", "openai") && f.is("integrationID", "openai");
    let provider = f.is("kind", "provider");
    let method = if f.is("valueType", "key") {
        f.absent("methodID")
    } else {
        provider && f.id("methodID") && (!f.is("integrationID", "xai") || f.is("methodID", "device"))
            || openai && f.one_of("methodID", &["chatgpt-token-sharing", "chatgpt-browser"])
    };
    let session = f.get("sessionID");
    let session_text = if session.is_null() || js::is_undefined(&session) {
        Some(String::new())
    } else {
        text(&session)
    };
    let session_ok = session_text.is_some_and(|s| {
        s.strip_prefix("ses")
            .is_some_and(|r| (1..=128).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    });
    let permit = fields(&f.get("permit"), &["token", "sessionID", "revision"]);
    let permit_ok = permit.as_ref().is_some_and(|p| {
        let revision = js::as_number(&p.get("revision")).filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n));
        p.digest("token") && strict_equal(&p.get("sessionID"), &session) && revision.is_some()
    });
    let ok = (provider && catalog(&f.get("integrationID")) || openai && f.is("valueType", "oauth"))
        && f.one_of("valueType", &["key", "oauth"])
        && method
        && f.id("controllerInstanceID")
        && f.id("acquisitionID")
        && f.id("credentialID")
        && session_ok
        && f.directory()
        && f.digest("configurationDigest")
        && f.digest("expectedFingerprint")
        && permit_ok;
    let (true, Some(p)) = (ok, permit) else { return invalid() };
    let mut out = f.0;
    out.insert("permit".into(), Value::Object(p.0));
    Ok(Value::Object(out))
}

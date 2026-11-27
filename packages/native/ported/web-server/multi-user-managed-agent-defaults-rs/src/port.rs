//! The Rust port of `multi-user/managed-agent-defaults.js` (all 6 exports). Refusals are product
//! `Error`s whose messages must match (`statusCode`/`code` do not cross the bindings); checks run in
//! the source's order. A `Map` passes `isRecord` with no own keys.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

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

fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied()).map(|c| c.map_or(3, char::len_utf8)).sum()
}

fn space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
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

fn is_record(value: &Value) -> bool {
    truthy(value) && value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none()
}

fn marker(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.len() == 1 && o.keys().all(|k| k.starts_with('$')))
}

fn field(value: &Value, key: &str) -> Value {
    if nullish(value) || marker(value) {
        return js::undefined();
    }
    value.as_object().and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn coalesce(a: Value, b: Value) -> Value {
    if nullish(&a) { b } else { a }
}

/// `clean(value)`.
fn clean(value: &Value) -> String {
    value.as_str().map(|s| s.trim_matches(space).to_string()).unwrap_or_default()
}

fn bad(label: &str) -> String {
    format!("{label} is invalid")
}

fn identifier(value: &Value, label: &str, max: usize, allow_slash: bool) -> Result<String, String> {
    let n = clean(value);
    if n.is_empty() || n.encode_utf16().count() > max || !n.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(bad(label));
    }
    let b = n.as_bytes();
    let extra: &[u8] = if allow_slash { b"._:/@+-" } else { b"._:+-" };
    if !b[0].is_ascii_alphanumeric() || !b[1..].iter().all(|c| c.is_ascii_alphanumeric() || extra.contains(c)) {
        return Err(bad(label));
    }
    Ok(n)
}

fn find_agent(agents: &Value, name: &Value) -> Value {
    let wanted = clean(name).to_lowercase();
    if wanted.is_empty() {
        return Value::Null;
    }
    let Value::Array(list) = agents else { return Value::Null };
    list.iter()
        .find(|a| clean(&field(a, "name")).to_lowercase() == wanted)
        .filter(|a| truthy(a))
        .cloned()
        .unwrap_or(Value::Null)
}

fn execution(providers: (Value, Value), models: (Value, Value), variant: &Value) -> Option<Value> {
    let p = clean(&coalesce(providers.0, providers.1));
    let m = clean(&coalesce(models.0, models.1));
    if p.is_empty() || m.is_empty() {
        return None;
    }
    let v = clean(variant);
    Some(json!({ "providerId": p, "modelId": m, "variant": if v.is_empty() { Value::Null } else { Value::String(v) } }))
}

fn host_execution(agent: &Value) -> Option<Value> {
    let model = field(agent, "model");
    execution(
        (field(&model, "providerID"), field(&model, "providerId")),
        (field(&model, "modelID"), field(&model, "modelId")),
        &field(agent, "variant"),
    )
}

fn single_model(agent: &Value) -> bool {
    if !truthy(agent) || host_execution(agent).is_none() {
        return false;
    }
    if field(agent, "councillors").as_array().is_some_and(|c| !c.is_empty()) || field(agent, "modelRefs").as_array().is_some_and(|m| m.len() > 1) {
        return false;
    }
    clean(&field(agent, "name")).to_lowercase() != "council"
}

fn personal(settings: &Value, name: &Value) -> Option<Value> {
    let selections = field(settings, "agentModelSelections");
    let wanted = clean(name).to_lowercase();
    let entries: Vec<(String, Value)> = if is_record(&selections) && !marker(&selections) {
        selections
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let (_, entry) = entries.into_iter().find(|(k, _)| k.trim_matches(space).to_lowercase() == wanted)?;
    if !is_record(&entry) {
        return None;
    }
    execution(
        (field(&entry, "providerId"), js::undefined()),
        (field(&entry, "modelId"), js::undefined()),
        &field(&entry, "variant"),
    )
}

fn with(base: Value, pairs: &[(&str, Value)]) -> Value {
    let mut map: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    for (k, v) in pairs {
        map.insert((*k).to_string(), v.clone());
    }
    Value::Object(map)
}

fn destructure(arg: &Value, first: &str) -> Result<(), String> {
    if nullish(arg) {
        let kind = if arg.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property '{first}' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    Ok(())
}

/// Port of `findManagedAgent` (`multi-user/managed-agent-defaults.js:32`).
pub fn find_managed_agent(agents: Value, agent_name: Value) -> Result<Value, String> {
    Ok(find_agent(&agents, &agent_name))
}

/// Port of `backupExecutionFromManagedAgent` (`multi-user/managed-agent-defaults.js:52`).
pub fn backup_execution_from_managed_agent(agent: Value) -> Result<Value, String> {
    let backup = field(&agent, "backupModel");
    if !is_record(&backup) {
        return Ok(Value::Null);
    }
    Ok(execution(
        (field(&backup, "providerID"), field(&backup, "providerId")),
        (field(&backup, "modelID"), field(&backup, "modelId")),
        &field(&backup, "variant"),
    )
    .unwrap_or(Value::Null))
}

/// Port of `isSingleModelManagedAgent` (`multi-user/managed-agent-defaults.js:65`).
pub fn is_single_model_managed_agent(agent: Value) -> Result<bool, String> {
    Ok(single_model(&agent))
}

/// Port of `getPersonalAgentDefault` (`multi-user/managed-agent-defaults.js:72`).
pub fn get_personal_agent_default(settings_overrides: Value, agent_name: Value) -> Result<Value, String> {
    Ok(personal(&settings_overrides, &agent_name).unwrap_or(Value::Null))
}

/// Port of `validatePersonalAgentDefault` (`multi-user/managed-agent-defaults.js:88`).
pub fn validate_personal_agent_default(arg0: Value) -> Result<Value, String> {
    destructure(&arg0, "agentName")?;
    let (name, payload, agents) = (field(&arg0, "agentName"), field(&arg0, "payload"), field(&arg0, "agents"));
    let requested = clean(&name);
    if requested.is_empty() || requested.encode_utf16().count() > 80 || requested.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '/') {
        return Err("Agent name is invalid".into());
    }
    let size = if is_record(&payload) {
        stringify(&payload)?.map_or(0, |j| utf8_len(&j.encode_utf16().collect::<Vec<_>>()))
    } else {
        0
    };
    if !is_record(&payload) || size > 1_024 {
        return Err("Agent default payload is invalid".into());
    }
    let keys: Vec<String> = if marker(&payload) {
        Vec::new()
    } else {
        payload.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
    };
    if let Some(unknown) = keys.iter().find(|k| !["providerId", "modelId", "variant"].contains(&k.as_str())) {
        return Err(format!("Unknown agent default field: {unknown}"));
    }
    let agent = find_agent(&agents, &Value::String(requested));
    if agent.is_null() {
        return Err("Agent not found".into());
    }
    if !single_model(&agent) {
        return Err("This agent is managed by the host and cannot have a personal model default".into());
    }
    let provider = identifier(&field(&payload, "providerId"), "Provider ID", 80, false)?;
    let model = identifier(&field(&payload, "modelId"), "Model ID", 180, true)?;
    let mut selection = json!({ "providerId": provider, "modelId": model });
    if keys.iter().any(|k| k == "variant") {
        selection["variant"] = json!(identifier(&field(&payload, "variant"), "Thinking value", 80, false)?);
    }
    Ok(json!({ "agentName": clean(&field(&agent, "name")), "selection": selection }))
}

/// Port of `resolveManagedAgentExecution` (`multi-user/managed-agent-defaults.js:124`).
pub fn resolve_managed_agent_execution(arg0: Value) -> Result<Value, String> {
    destructure(&arg0, "agents")?;
    let agent = find_agent(&field(&arg0, "agents"), &field(&arg0, "agentName"));
    let Some(host) = host_execution(&agent).filter(|_| !agent.is_null()) else {
        return Ok(Value::Null);
    };
    let name = Value::String(clean(&field(&agent, "name")));
    if !single_model(&agent) {
        return Ok(with(host, &[("agentName", name), ("source", json!("host-managed"))]));
    }
    Ok(match personal(&field(&arg0, "settingsOverrides"), &field(&agent, "name")) {
        Some(p) => with(p, &[("agentName", name), ("source", json!("personal"))]),
        None => with(host, &[("agentName", name), ("source", json!("inherited"))]),
    })
}

//! The Rust port of `opencode/v2/projection/catalog.js` (all 21 exports) over any JS value.
//! Objects built by assignment keep JS key order (index keys first). Assigning to `__proto__`
//! sets no own key; the permission config keeps that prototype, and reading an
//! `Object.prototype` member name (`constructor`, `toString`, ...) finds the inherited function,
//! as in JS. `/i` in these patterns is ASCII-only (non-Unicode mode). A `Map`, `Set` or `Date`
//! is a record without own entries. `Date#toISOString` is written out for the release date.

#![forbid(unsafe_code)]

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::js;

type Obj = Map<String, Value>;

const MARKERS: [&str; 5] = ["$utf16", "$num", "$undefined", "$function", "$bigint"];
const PROTO: &str = "__proto__"; // recorded-literal: the JS engine's prototype accessor name
// The members of the JS engine's `Object.prototype`.
#[rustfmt::skip]
const OBJECT_PROTOTYPE: [&str; 11] = ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString"]; // recorded-literal: engine-defined names

fn marker(value: &Value) -> Option<&str> {
    value
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn is_record(value: &Value) -> bool {
    value.is_object() && !marker(value).is_some_and(|m| MARKERS.contains(&m))
}

fn plain(value: &Value) -> Option<&Obj> {
    value.as_object().filter(|_| marker(value).is_none())
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn defined(value: &Value) -> Option<Value> {
    (!js::is_undefined(value)).then(|| value.clone())
}

fn non_empty(value: &Value) -> bool {
    js::string_units(value).is_some_and(|u| !u.is_empty())
}

fn is_string(value: &Value) -> bool {
    js::string_units(value).is_some()
}

fn finite(value: &Value) -> Option<Value> {
    js::as_number(value).filter(|n| n.is_finite()).map(js::number)
}

fn safe_int(value: &Value) -> Option<Value> {
    js::as_number(value)
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .map(js::number)
}

fn or(value: Option<Value>, fallback: impl Into<Value>) -> Value {
    value.unwrap_or_else(|| fallback.into())
}

fn string_or(value: Value, fallback: impl Into<Value>) -> Value {
    if is_string(&value) { value } else { fallback.into() }
}

fn non_empty_or(value: Value, fallback: impl Into<Value>) -> Value {
    if non_empty(&value) { value } else { fallback.into() }
}

fn record_or_empty(value: Value) -> Value {
    if is_record(&value) { value } else { json!({}) }
}

fn list_of(value: &Value) -> Vec<Value> {
    value.as_array().into_iter().flatten().filter(|v| is_record(v)).cloned().collect()
}

/// `Object.entries(value)` of a record (a typed array lists its indexes).
fn entries(value: &Value) -> Vec<(String, Value)> {
    match marker(value) {
        Some("$bytes") => value["$bytes"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, b)| (i.to_string(), b.clone()))
            .collect(),
        Some(_) => Vec::new(),
        None => value.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.clone())).collect(),
    }
}

fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// An object's keys in JS order: array indexes ascending, then insertion order.
fn ordered(map: Obj) -> Value {
    let (mut indexed, rest): (Vec<_>, Vec<_>) = map.into_iter().partition(|(k, _)| index_key(k).is_some());
    indexed.sort_by_key(|(k, _)| index_key(k));
    Value::Object(indexed.into_iter().chain(rest).collect())
}

/// `object[key] = value`: an assignment to `__proto__` defines no own key.
fn assign(object: &mut Obj, key: String, value: Value) {
    if key != PROTO {
        object.insert(key, value);
    }
}

fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^(?:key|.*api[-_]?key|.*token|.*secret|.*password|.*authorization|cookie|credentials?)$/i`.
fn secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if matches!(lower.as_str(), "key" | "cookie" | "credential" | "credentials") {
        return true;
    }
    ["apikey", "api-key", "api_key", "token", "secret", "password", "authorization"]
        .iter()
        .any(|s| lower.strip_suffix(s).is_some_and(|prefix| !prefix.chars().any(line_terminator)))
}

fn redact(value: &Value) -> Value {
    if !is_record(value) {
        return json!({});
    }
    let Some(object) = plain(value) else { return value.clone() };
    let mut changed = false;
    let mut result = Obj::new();
    for (key, entry) in object {
        if secret(key) {
            changed = true;
            continue;
        }
        let kept = if is_record(entry) { redact(entry) } else { entry.clone() };
        changed |= &kept != entry;
        result.insert(key.clone(), kept);
    }
    if changed { Value::Object(result) } else { value.clone() }
}

/// Port of `redactCredentials` (`catalog.js:51`).
pub fn redact_credentials(value: Value) -> Result<Value, String> {
    Ok(redact(&value))
}

#[rustfmt::skip]
const PACKAGES: [(&str, &str); 19] = [("amazon-bedrock", "@ai-sdk/amazon-bedrock"), ("amazon-bedrock/mantle", "@ai-sdk/amazon-bedrock/mantle"), ("alibaba/chat", "@ai-sdk/alibaba"), ("anthropic", "@ai-sdk/anthropic"), ("azure/responses", "@ai-sdk/azure"), ("azure/chat", "@ai-sdk/azure"), ("cerebras", "@ai-sdk/cerebras"), ("deepinfra", "@ai-sdk/deepinfra"), ("google", "@ai-sdk/google"), ("google-vertex", "@ai-sdk/google-vertex"), ("google-vertex/messages", "@ai-sdk/google-vertex/anthropic"), ("groq", "@ai-sdk/groq"), ("mistral", "@ai-sdk/mistral"), ("openai", "@ai-sdk/openai"), ("openai-compatible", "@ai-sdk/openai-compatible"), ("togetherai", "@ai-sdk/togetherai"), ("xai", "@ai-sdk/xai"), ("openrouter", "@openrouter/ai-sdk-provider"), ("cloudflare-ai-gateway", "ai-gateway-provider")];

fn provider_package(pkg: &Value) -> Value {
    if !non_empty(pkg) {
        return "".into();
    }
    // Lossy text: a lone surrogate never equals or completes an ASCII table entry.
    let text = String::from_utf16_lossy(&js::string_units(pkg).unwrap_or_default());
    let Some(name) = text.strip_prefix("@opencode/ai/providers/") else {
        return pkg.clone();
    };
    if let Some((_, v1)) = PACKAGES.iter().find(|(v2, _)| *v2 == name) {
        return (*v1).into();
    }
    let suffix = [
        ("/chat", "@ai-sdk/openai-compatible"),
        ("/messages", "@ai-sdk/anthropic"),
        ("/responses", "@ai-sdk/openai"),
    ]
    .into_iter()
    .find(|(s, _)| text.ends_with(s));
    suffix.map_or("@ai-sdk/openai-compatible", |(_, v1)| v1).into()
}

/// Port of `toV1ProviderPackage` (`catalog.js:113`).
pub fn to_v1_provider_package(pkg: Value) -> Result<Value, String> {
    Ok(provider_package(&pkg))
}

fn v1_tool_name(name: Value) -> Value {
    match name.as_str() {
        Some("shell") => "bash".into(),
        Some("subagent") => "task".into(),
        Some("patch") => "apply_patch".into(),
        _ => name,
    }
}

fn ruleset(rules: &Value) -> Vec<Value> {
    let valid = |r: &Value| ["action", "resource", "effect"].iter().all(|k| is_string(&field(r, k)));
    list_of(rules)
        .into_iter()
        .filter(valid)
        .map(|r| json!({ "permission": v1_tool_name(field(&r, "action")), "pattern": field(&r, "resource"), "action": field(&r, "effect") }))
        .collect()
}

/// Port of `toV1PermissionRuleset` (`catalog.js:132`).
pub fn to_v1_permission_ruleset(rules: Value) -> Result<Value, String> {
    Ok(Value::Array(ruleset(&rules)))
}

/// `toV1PermissionConfig`: `config[permission]` reads through the config's prototype.
fn permission_config(rules: &Value) -> Value {
    let (mut own, mut proto): (Obj, Option<Obj>) = (Obj::new(), None);
    for rule in ruleset(rules) {
        let (permission, pattern, action) = (
            rule["permission"].as_str().unwrap_or_default().to_string(),
            rule["pattern"].as_str().unwrap_or_default().to_string(),
            rule["action"].clone(),
        );
        let current = match (own.get(&permission), proto.as_ref().and_then(|p| p.get(&permission))) {
            (Some(v), _) | (None, Some(v)) => Some(v.clone()),
            _ if permission == PROTO => Some(Value::Object(proto.clone().unwrap_or_default())),
            _ if OBJECT_PROTOTYPE.contains(&permission.as_str()) => Some(json!({})),
            _ => None,
        };
        if current.is_none() && pattern == "*" {
            own.insert(permission, action);
            continue;
        }
        let mut patterns = match current {
            Some(Value::String(s)) => Obj::from_iter([("*".into(), Value::String(s))]),
            Some(Value::Object(o)) => o,
            _ => Obj::new(),
        };
        assign(&mut patterns, pattern, action);
        let Value::Object(patterns) = ordered(patterns) else { continue };
        if permission == PROTO {
            proto = Some(patterns);
        } else {
            own.insert(permission, Value::Object(patterns));
        }
    }
    ordered(own)
}

fn agent_of(agent: &Value) -> Option<Value> {
    let id = field(agent, "id");
    if !is_record(agent) || !non_empty(&id) {
        return None;
    }
    let request = field(agent, "request");
    let body = field(&request, "body");
    let mut out = Obj::from_iter([
        ("name".into(), id),
        ("mode".into(), string_or(field(agent, "mode"), "primary")),
        ("hidden".into(), (field(agent, "hidden") == Value::Bool(true)).into()),
        ("permission".into(), Value::Array(ruleset(&field(agent, "permissions")))),
        ("options".into(), redact(&field(&request, "settings"))),
    ]);
    for (from, to) in [("description", "description"), ("color", "color")] {
        Some(field(agent, from)).filter(is_string).map(|v| out.insert(to.into(), v));
    }
    safe_int(&field(agent, "steps")).map(|v| out.insert("steps".into(), v));
    Some(field(agent, "system")).filter(is_string).map(|v| out.insert("prompt".into(), v));
    let body = if is_record(&request) && is_record(&body) { body } else { json!({}) };
    finite(&field(&body, "temperature")).map(|v| out.insert("temperature".into(), v));
    finite(&field(&body, "top_p")).map(|v| out.insert("topP".into(), v));
    let model = field(agent, "model");
    let (model_id, provider_id, variant) = (field(&model, "id"), field(&model, "providerID"), field(&model, "variant"));
    if is_record(&model) && non_empty(&model_id) && non_empty(&provider_id) {
        out.insert("model".into(), json!({ "modelID": model_id, "providerID": provider_id }));
        Some(variant).filter(non_empty).map(|v| out.insert("variant".into(), v));
    }
    Some(Value::Object(out))
}

/// Port of `toV1Agent` (`catalog.js:168`).
pub fn to_v1_agent(agent: Value) -> Result<Value, String> {
    Ok(agent_of(&agent).unwrap_or(Value::Null))
}

/// Port of `toV1Agents` (`catalog.js:198`).
pub fn to_v1_agents(agents: Value) -> Result<Value, String> {
    Ok(list_of(&agents).iter().filter_map(agent_of).collect())
}

fn modalities(list: &Value) -> Value {
    let present = |m: &str| list.as_array().is_some_and(|l| l.iter().any(|v| v.as_str() == Some(m)));
    Value::Object(
        ["text", "audio", "image", "video", "pdf"]
            .iter()
            .map(|m| ((*m).into(), present(m).into()))
            .collect(),
    )
}

fn cost_entry(cost: &Value) -> Value {
    let cache = record_or_empty(field(cost, "cache"));
    let n = |v: &Value, k: &str| or(finite(&field(v, k)), 0);
    json!({ "input": n(cost, "input"), "output": n(cost, "output"), "cache": { "read": n(&cache, "read"), "write": n(&cache, "write") } })
}

fn cost_of(costs: &Value) -> Value {
    let list = list_of(costs);
    let base = list
        .iter()
        .find(|e| !is_record(&field(e, "tier")))
        .map_or_else(|| json!({ "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } }), cost_entry);
    let tiers: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            safe_int(&field(&field(e, "tier"), "size"))
                .filter(|_| is_record(&field(e, "tier")))
                .map(|size| (e, size))
        })
        .map(|(e, size)| {
            let mut entry = cost_entry(e);
            entry["tier"] = json!({ "type": "context", "size": size });
            entry
        })
        .collect();
    if tiers.is_empty() {
        base
    } else {
        let mut out = base;
        out["tiers"] = Value::Array(tiers);
        out
    }
}

/// `new Date(ms).toISOString().slice(0, 10)` for a positive time value.
fn release_date(time: &Value) -> Value {
    let Some(ms) = js::as_number(&field(time, "released")).filter(|n| n.is_finite() && *n > 0.0 && is_record(time)) else {
        return "".into();
    };
    if ms > 8.64e15 {
        return "".into();
    }
    let days = (ms.trunc() / 86_400_000.0).floor() as i64;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + i64::from(month <= 2);
    let iso = if year <= 9999 {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("+{year:06}-{month:02}-{day:02}")
    };
    iso.chars().take(10).collect::<String>().into()
}

fn variants_of(variants: &Value) -> Value {
    let list = list_of(variants).into_iter().filter(|v| non_empty(&field(v, "id")));
    ordered(
        list.map(|v| (field(&v, "id").as_str().unwrap_or_default().to_string(), redact(&field(&v, "settings"))))
            .collect(),
    )
}

/// `a !== b` across the bindings, where two objects are never the same reference.
fn strict_equal(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), _, _) => x == y,
        (None, None, Some(x), Some(y)) => x == y,
        (None, None, None, None) => (js::is_undefined(a) && js::is_undefined(b)) || (!a.is_object() && !a.is_array() && a == b),
        _ => false,
    }
}

fn own_settings(settings: &Value, provider_settings: Option<&Value>) -> Value {
    let own = redact(settings);
    let Some(provider) = provider_settings else { return own };
    let all = entries(&own);
    let kept: Vec<(String, Value)> = all
        .iter()
        .filter(|(k, v)| plain(provider).is_none_or(|p| p.get(k).is_none_or(|pv| !strict_equal(pv, v))))
        .cloned()
        .collect();
    if kept.len() == all.len() { own } else { ordered(kept.into_iter().collect()) }
}

fn model_of(model: &Value, provider: &Value) -> Option<Value> {
    let (id, provider_id) = (field(model, "id"), field(model, "providerID"));
    if !is_record(model) || !non_empty(&id) || !non_empty(&provider_id) {
        return None;
    }
    let provider_settings = Some(field(provider, "settings")).filter(|s| is_record(provider) && is_record(s));
    let settings = record_or_empty(field(model, "settings"));
    let capabilities = record_or_empty(field(model, "capabilities"));
    let compatibility = record_or_empty(field(model, "compatibility"));
    let input = modalities(&field(&capabilities, "input"));
    let variants = variants_of(&field(model, "variants"));
    let reasoning_field = Some(field(&compatibility, "reasoningField")).filter(non_empty);
    let base_url = [
        field(&settings, "baseURL"),
        provider_settings.as_ref().map_or_else(js::undefined, |p| field(p, "baseURL")),
    ]
    .into_iter()
    .find(non_empty)
    .unwrap_or_else(|| "".into());
    let limit = record_or_empty(field(model, "limit"));
    let package = field(model, "package");
    let package = if package.is_null() || js::is_undefined(&package) {
        field(provider, "package")
    } else {
        package
    };
    let reasoning =
        variants.as_object().is_some_and(|v| !v.is_empty()) || reasoning_field.is_some() || field(&compatibility, "requireReasoning") == Value::Bool(true);
    let attachment = input.as_object().is_some_and(|i| i.iter().any(|(m, p)| m != "text" && p == &Value::Bool(true)));
    let mut limits = Obj::from_iter([("context".into(), or(safe_int(&field(&limit, "context")), 0))]);
    safe_int(&field(&limit, "input")).map(|v| limits.insert("input".into(), v));
    limits.insert("output".into(), or(safe_int(&field(&limit, "output")), 0));
    let mut out = Obj::from_iter([
        ("id".into(), id.clone()),
        ("providerID".into(), provider_id),
        (
            "api".into(),
            json!({ "id": non_empty_or(field(model, "modelID"), id.clone()), "url": base_url, "npm": provider_package(&package) }),
        ),
        ("name".into(), non_empty_or(field(model, "name"), id)),
        (
            "capabilities".into(),
            json!({
                "temperature": true, "reasoning": reasoning, "attachment": attachment,
                "toolcall": field(&capabilities, "tools") != Value::Bool(false), "input": input,
                "output": modalities(&field(&capabilities, "output")),
                "interleaved": reasoning_field.map_or(Value::Bool(false), |f| json!({ "field": f })),
            }),
        ),
        ("cost".into(), cost_of(&field(model, "cost"))),
        ("limit".into(), Value::Object(limits)),
        ("status".into(), string_or(field(model, "status"), "active")),
        ("options".into(), own_settings(&settings, provider_settings.as_ref())),
        ("headers".into(), redact(&field(model, "headers"))),
        ("release_date".into(), release_date(&field(model, "time"))),
        ("variants".into(), variants),
    ]);
    Some(field(model, "family")).filter(non_empty).map(|f| out.insert("family".into(), f));
    Some(Value::Object(out))
}

/// Port of `toV1Model` (`catalog.js:265`).
pub fn to_v1_model(model: Value, provider: Value) -> Result<Value, String> {
    Ok(model_of(&model, &provider).unwrap_or(Value::Null))
}

fn read_member(value: &Value, key: &str) -> Result<Value, String> {
    if value.is_null() || js::is_undefined(value) {
        let shown = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

fn provider_of(provider: &Value, models: &[Value], options: &Value) -> Result<Option<Value>, String> {
    let id = field(provider, "id");
    if !is_record(provider) || !non_empty(&id) {
        return Ok(None);
    }
    let mut v1_models = Obj::new();
    for model in models.iter().filter(|m| is_record(m)) {
        if js::string_units(&field(model, "providerID")) != js::string_units(&id) {
            continue;
        }
        let enabled_only = if js::is_undefined(options) {
            js::undefined()
        } else {
            read_member(options, "enabledOnly")?
        };
        if enabled_only == Value::Bool(true) && field(model, "enabled") == Value::Bool(false) {
            continue;
        }
        if let Some(projected) = model_of(model, provider) {
            assign(&mut v1_models, projected["id"].as_str().unwrap_or_default().to_string(), projected);
        }
    }
    let integration = field(provider, "integrationID");
    let mut out = Obj::from_iter([
        ("id".into(), id.clone()),
        ("name".into(), non_empty_or(field(provider, "name"), id)),
        ("source".into(), (if non_empty(&integration) { "api" } else { "config" }).into()),
        ("env".into(), json!([])),
        ("options".into(), redact(&field(provider, "settings"))),
        ("models".into(), ordered(v1_models)),
    ]);
    if non_empty(&integration) {
        out.insert("integrationID".into(), integration);
    }
    Ok(Some(Value::Object(out)))
}

/// Port of `toV1Provider` (`catalog.js:336`).
pub fn to_v1_provider(provider: Value, models: Value, options: Value) -> Result<Value, String> {
    Ok(provider_of(&provider, models.as_array().map_or(&[][..], Vec::as_slice), &options)?.unwrap_or(Value::Null))
}

fn group(models: &Value) -> HashMap<String, Vec<Value>> {
    let mut by_provider: HashMap<String, Vec<Value>> = HashMap::new();
    for model in list_of(models)
        .into_iter()
        .filter(|m| non_empty(&field(m, "providerID")) && non_empty(&field(m, "id")))
    {
        by_provider
            .entry(field(&model, "providerID").as_str().unwrap_or_default().to_string())
            .or_default()
            .push(model);
    }
    by_provider
}

fn default_map(ids: &[Value], by_provider: &HashMap<String, Vec<Value>>, default_model: &Value) -> Value {
    let mut defaults = Obj::new();
    for id in ids.iter().filter_map(Value::as_str) {
        if let Some(first) = by_provider.get(id).into_iter().flatten().find(|m| field(m, "enabled") != Value::Bool(false)) {
            assign(&mut defaults, id.into(), field(first, "id"));
        }
    }
    let (provider_id, model_id) = (field(default_model, "providerID"), field(default_model, "id"));
    if let Some(p) = provider_id
        .as_str()
        .filter(|p| is_record(default_model) && !p.is_empty() && non_empty(&model_id) && defaults.contains_key(*p))
    {
        defaults.insert(p.into(), model_id);
    }
    ordered(defaults)
}

fn catalog(arg: &Value) -> Result<(Value, Value, Value), String> {
    let read = |k: &str| read_member(arg, k);
    Ok((read("providers")?, read("models")?, read("defaultModel")?))
}

fn config_providers(providers: &Value, models: &Value, default_model: &Value) -> Result<Value, String> {
    let by_provider = group(models);
    let mut projected = Vec::new();
    for provider in list_of(providers) {
        if field(&provider, "activation").as_str() == Some("disabled") {
            continue;
        }
        let models = field(&provider, "id").as_str().and_then(|id| by_provider.get(id)).cloned().unwrap_or_default();
        if let Some(entry) =
            provider_of(&provider, &models, &json!({ "enabledOnly": true }))?.filter(|e| e["models"].as_object().is_some_and(|m| !m.is_empty()))
        {
            projected.push(entry);
        }
    }
    let ids: Vec<Value> = projected.iter().map(|p| p["id"].clone()).collect();
    Ok(json!({ "providers": projected, "default": default_map(&ids, &by_provider, default_model) }))
}

/// Port of `toV1ConfigProviders` (`catalog.js:391`).
pub fn to_v1_config_providers(arg0: Value) -> Result<Value, String> {
    let (providers, models, default_model) = catalog(&arg0)?;
    config_providers(&providers, &models, &default_model)
}

/// Port of `toV1ProviderList` (`catalog.js:411`).
pub fn to_v1_provider_list(arg0: Value) -> Result<Value, String> {
    let (providers, models, default_model) = catalog(&arg0)?;
    let by_provider = group(&models);
    let mut all = Vec::new();
    for provider in list_of(&providers) {
        let models = field(&provider, "id").as_str().and_then(|id| by_provider.get(id)).cloned().unwrap_or_default();
        all.extend(provider_of(&provider, &models, &js::undefined())?);
    }
    let connected: Vec<Value> = config_providers(&providers, &models, &default_model)?["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| p["id"].clone())
        .collect();
    Ok(json!({ "all": all, "default": default_map(&connected, &by_provider, &default_model), "connected": connected }))
}

/// Port of `toV1Commands` (`catalog.js:433`).
pub fn to_v1_commands(commands: Value, options: Value) -> Result<Value, String> {
    let config = if js::is_undefined(&options) {
        js::undefined()
    } else {
        read_member(&options, "config")?
    };
    let configured = Some(field(&config, "command"))
        .filter(|c| is_record(&config) && is_record(c))
        .unwrap_or_else(|| json!({}));
    let project = |command: Value| {
        let name = field(&command, "name");
        let definition = record_or_empty(name.as_str().map_or_else(js::undefined, |n| field(&configured, n)));
        let mut out = Obj::from_iter([
            ("name".into(), name),
            ("source".into(), "command".into()),
            ("template".into(), string_or(field(&definition, "template"), "")),
            ("hints".into(), json!([])),
        ]);
        let own = field(&command, "description");
        Some(if is_string(&own) { own } else { field(&definition, "description") })
            .filter(is_string)
            .map(|d| out.insert("description".into(), d));
        for key in ["agent", "model"] {
            Some(field(&definition, key)).filter(non_empty).map(|v| out.insert(key.into(), v));
        }
        Some(field(&definition, "subtask"))
            .filter(Value::is_boolean)
            .map(|v| out.insert("subtask".into(), v));
        Value::Object(out)
    };
    Ok(list_of(&commands).into_iter().filter(|c| non_empty(&field(c, "name"))).map(project).collect())
}

/// Port of `toV1Skills` (`catalog.js:463`).
pub fn to_v1_skills(skills: Value) -> Result<Value, String> {
    let project = |skill: Value| {
        let (id, name) = (field(&skill, "id"), field(&skill, "name"));
        let mut out = Obj::from_iter([
            ("name".into(), non_empty_or(name.clone(), id.clone())),
            ("location".into(), string_or(field(&skill, "path"), "")),
            ("content".into(), string_or(field(&skill, "content"), "")),
            ("id".into(), non_empty_or(id, name)),
        ]);
        Some(field(&skill, "description"))
            .filter(is_string)
            .map(|d| out.insert("description".into(), d));
        Some(field(&skill, "autoinvoke"))
            .filter(Value::is_boolean)
            .map(|d| out.insert("autoinvoke".into(), d));
        Value::Object(out)
    };
    Ok(list_of(&skills)
        .into_iter()
        .filter(|s| non_empty(&field(s, "id")) || non_empty(&field(s, "name")))
        .map(project)
        .collect())
}

/// Port of `toV1McpStatus` (`catalog.js:487`).
pub fn to_v1_mcp_status(servers: Value) -> Result<Value, String> {
    let mut statuses = Obj::new();
    for server in list_of(&servers) {
        let (name, status) = (field(&server, "name"), field(&server, "status"));
        let (state, error) = (field(&status, "status"), field(&status, "error"));
        if !non_empty(&name) || !is_record(&status) || !non_empty(&state) {
            continue;
        }
        let entry = if is_string(&error) {
            json!({ "status": state, "error": error })
        } else {
            json!({ "status": state })
        };
        assign(&mut statuses, name.as_str().unwrap_or_default().into(), entry);
    }
    Ok(ordered(statuses))
}

fn concatenated(path: &[String]) -> bool {
    let patterns: [&[&str]; 3] = [&["permissions"], &["plugins"], &["agents", "*", "permissions"]];
    patterns
        .iter()
        .any(|p| p.len() == path.len() && p.iter().zip(path).all(|(k, s)| *k == "*" || k == s))
}

fn deep_merge(base: &Value, overlay: &Value, path: &[String]) -> Value {
    let mut merged: Obj = entries(base).into_iter().collect();
    for (key, value) in entries(overlay) {
        if js::is_undefined(&value) {
            continue;
        }
        let child: Vec<String> = path.iter().cloned().chain([key.clone()]).collect();
        let current = merged.get(&key).cloned().unwrap_or_else(js::undefined);
        let next = match (&value, &current) {
            (Value::Array(v), Value::Array(c)) if concatenated(&child) => Value::Array(c.iter().chain(v).cloned().collect()),
            _ if is_record(&value) && is_record(&current) => deep_merge(&current, &value, &child),
            _ => value,
        };
        assign(&mut merged, key, next);
    }
    ordered(merged)
}

fn merge_entries(entries: &Value) -> Value {
    let documents = list_of(entries)
        .into_iter()
        .filter(|e| field(e, "type").as_str() == Some("document") && is_record(&field(e, "info")));
    documents.fold(json!({}), |merged, e| deep_merge(&merged, &field(&e, "info"), &[]))
}

/// Port of `mergeV2ConfigEntries` (`catalog.js:537`).
pub fn merge_v2_config_entries(entries: Value) -> Result<Value, String> {
    Ok(merge_entries(&entries))
}

/// Port of `configDirectories` (`catalog.js:551`).
pub fn config_directories(entries: Value) -> Result<Value, String> {
    Ok(list_of(&entries)
        .iter()
        .filter(|e| field(e, "type").as_str() == Some("directory") && non_empty(&field(e, "path")))
        .map(|e| field(e, "path"))
        .collect())
}

fn selection_of(selection: &Value) -> Option<(Value, Option<Value>)> {
    if let Some(units) = js::string_units(selection) {
        let hash = units.iter().position(|u| *u == u16::from(b'#'));
        let (model, variant) = hash.map_or((&units[..], &[][..]), |h| (&units[..h], &units[h + 1..]));
        if model.iter().position(|u| *u == u16::from(b'/')).is_none_or(|p| p == 0) {
            return None;
        }
        return Some((js::utf16_string(model), (!variant.is_empty()).then(|| js::utf16_string(variant))));
    }
    let (provider, model, variant) = (field(selection, "providerID"), field(selection, "model"), field(selection, "variant"));
    if !is_record(selection) || !non_empty(&provider) || !non_empty(&model) {
        return None;
    }
    let joined = [
        js::string_units(&provider).unwrap_or_default(),
        vec![u16::from(b'/')],
        js::string_units(&model).unwrap_or_default(),
    ]
    .concat();
    Some((js::utf16_string(&joined), Some(variant).filter(non_empty)))
}

/// Port of `toV1ModelSelection` (`catalog.js:561`).
pub fn to_v1_model_selection(selection: Value) -> Result<Value, String> {
    Ok(selection_of(&selection).map_or(Value::Null, |(model, variant)| match variant {
        Some(v) => json!({ "model": model, "variant": v }),
        None => json!({ "model": model }),
    }))
}

fn put_selection(out: &mut Obj, selection: &Value) {
    if let Some((model, variant)) = selection_of(selection) {
        out.insert("model".into(), model);
        variant.map(|v| out.insert("variant".into(), v));
    }
}

fn config_agent(agent: &Value) -> Value {
    let mut out = Obj::new();
    put_selection(&mut out, &field(agent, "model"));
    Some(field(agent, "system")).filter(is_string).map(|v| out.insert("prompt".into(), v));
    for key in ["description", "mode", "hidden", "color", "steps"] {
        defined(&field(agent, key)).map(|v| out.insert(key.into(), v));
    }
    if field(agent, "disabled") == Value::Bool(true) {
        out.insert("disable".into(), true.into());
    }
    if field(agent, "permissions").is_array() {
        out.insert("permission".into(), permission_config(&field(agent, "permissions")));
    }
    let request = field(agent, "request");
    let body = Some(field(&request, "body"))
        .filter(|b| is_record(&request) && is_record(b))
        .unwrap_or_else(|| json!({}));
    finite(&field(&body, "temperature")).map(|v| out.insert("temperature".into(), v));
    finite(&field(&body, "top_p")).map(|v| out.insert("top_p".into(), v));
    Value::Object(out)
}

fn config_command(command: &Value) -> Value {
    let mut out = Obj::new();
    for key in ["template", "description"] {
        Some(field(command, key)).filter(is_string).map(|v| out.insert(key.into(), v));
    }
    Some(field(command, "agent")).filter(non_empty).map(|v| out.insert("agent".into(), v));
    put_selection(&mut out, &field(command, "model"));
    let subagent = field(command, "subagent");
    let subtask = if subagent.is_null() || js::is_undefined(&subagent) {
        field(command, "subtask")
    } else {
        subagent
    };
    Some(subtask).filter(Value::is_boolean).map(|v| out.insert("subtask".into(), v));
    Value::Object(out)
}

fn config_provider_model(model: &Value) -> Value {
    let mut out = Obj::new();
    for key in ["name", "family", "limit"] {
        defined(&field(model, key)).map(|v| out.insert(key.into(), v));
    }
    Some(field(model, "modelID")).filter(non_empty).map(|v| out.insert("id".into(), v));
    for (from, to) in [("settings", "options"), ("headers", "headers")] {
        Some(field(model, from)).filter(is_record).map(|v| out.insert(to.into(), redact(&v)));
    }
    if field(model, "variants").is_array() {
        out.insert("variants".into(), variants_of(&field(model, "variants")));
    }
    Value::Object(out)
}

fn records_map(value: &Value, project: impl Fn(&Value) -> Value) -> Value {
    ordered(
        entries(value)
            .into_iter()
            .filter(|(_, v)| is_record(v))
            .map(|(k, v)| (k, project(&v)))
            .collect(),
    )
}

fn config_provider(provider: &Value) -> Value {
    let mut out = Obj::new();
    Some(field(provider, "name")).filter(is_string).map(|v| out.insert("name".into(), v));
    let package = field(provider, "package");
    if non_empty(&package) {
        out.insert("npm".into(), provider_package(&package));
    }
    Some(field(provider, "env")).filter(Value::is_array).map(|v| out.insert("env".into(), v));
    let (options, headers) = (redact(&field(provider, "settings")), redact(&field(provider, "headers")));
    if !entries(&headers).is_empty() {
        let mut merged: Obj = entries(&options).into_iter().collect();
        merged.insert("headers".into(), headers);
        out.insert("options".into(), ordered(merged));
    } else if is_record(&field(provider, "settings")) {
        out.insert("options".into(), options);
    }
    let models = field(provider, "models");
    if is_record(&models) {
        out.insert("models".into(), records_map(&models, config_provider_model));
    }
    Value::Object(out)
}

fn mcp_timeout(timeout: &Value) -> Option<Value> {
    finite(&field(timeout, "execution")).filter(|_| is_record(timeout))
}

fn config_mcp(mcp: &Value) -> Value {
    let servers = record_or_empty(field(mcp, "servers"));
    let global = mcp_timeout(&field(mcp, "timeout"));
    let mut projected = Obj::new();
    for (name, server) in entries(&servers) {
        let kind = field(&server, "type");
        let local = kind.as_str() == Some("local");
        if !is_record(&server) || !(local || kind.as_str() == Some("remote")) {
            continue;
        }
        let mut entry = Obj::from_iter([
            ("type".into(), kind),
            ("enabled".into(), (field(&server, "disabled") != Value::Bool(true)).into()),
        ]);
        if local {
            Some(field(&server, "command"))
                .filter(Value::is_array)
                .map(|v| entry.insert("command".into(), v));
            Some(field(&server, "environment"))
                .filter(is_record)
                .map(|v| entry.insert("environment".into(), redact(&v)));
        } else {
            Some(field(&server, "url")).filter(is_string).map(|v| entry.insert("url".into(), v));
            Some(field(&server, "headers"))
                .filter(is_record)
                .map(|v| entry.insert("headers".into(), redact(&v)));
            let oauth = field(&server, "oauth");
            if oauth == Value::Bool(false) {
                entry.insert("oauth".into(), false.into());
            }
            if is_record(&oauth) {
                let picked = [("client_id", "clientId"), ("scope", "scope"), ("redirect_uri", "redirectUri")]
                    .iter()
                    .filter_map(|(from, to)| Some(field(&oauth, from)).filter(non_empty).map(|v| ((*to).into(), v)));
                entry.insert("oauth".into(), Value::Object(picked.collect()));
            }
        }
        mcp_timeout(&field(&server, "timeout"))
            .or_else(|| global.clone())
            .map(|t| entry.insert("timeout".into(), t));
        projected.insert(name, Value::Object(entry));
    }
    ordered(projected)
}

fn plugins_of(plugins: &[Value]) -> Value {
    let plugin = |p: &Value| -> Option<Value> {
        if is_string(p) {
            return Some(p.clone());
        }
        let package = field(p, "package");
        if !is_record(p) || !non_empty(&package) {
            return None;
        }
        Some(if is_record(&field(p, "options")) {
            json!([package, field(p, "options")])
        } else {
            package
        })
    };
    plugins.iter().filter_map(plugin).collect()
}

fn skill_sources(skills: &[Value]) -> Value {
    let url = |s: &Value| {
        let text = String::from_utf16_lossy(&js::string_units(s).unwrap_or_default()).to_ascii_lowercase();
        text.starts_with("http://") || text.starts_with("https://")
    };
    let (urls, paths): (Vec<Value>, Vec<Value>) = skills.iter().filter(|s| is_string(s)).cloned().partition(url);
    let mut out = Obj::new();
    for (key, list) in [("paths", paths), ("urls", urls)] {
        if !list.is_empty() {
            out.insert(key.into(), Value::Array(list));
        }
    }
    Value::Object(out)
}

/// Port of `toV1Config` (`catalog.js:713`).
pub fn to_v1_config(entries: Value) -> Result<Value, String> {
    let info = merge_entries(&entries);
    let mut config = Obj::new();
    for key in [
        "$schema",
        "shell",
        "default_agent",
        "share",
        "username",
        "enterprise",
        "instructions",
        "formatter",
        "lsp",
        "tool_output",
        "compaction",
        "references",
        "watcher",
    ] {
        defined(&field(&info, key)).map(|v| config.insert(key.into(), v));
    }
    selection_of(&field(&info, "model")).map(|(m, _)| config.insert("model".into(), m));
    Some(field(&info, "snapshots"))
        .filter(Value::is_boolean)
        .map(|v| config.insert("snapshot".into(), v));
    let update = match field(&info, "update").as_str() {
        Some("disable") => Some(false.into()),
        Some("auto") => Some(true.into()),
        Some("notify") => Some("notify".into()),
        _ => None,
    };
    update.map(|v| config.insert("autoupdate".into(), v));
    if field(&info, "permissions").is_array() {
        config.insert("permission".into(), permission_config(&field(&info, "permissions")));
    }
    if let Value::Array(plugins) = field(&info, "plugins") {
        config.insert("plugin".into(), plugins_of(&plugins));
    }
    if let Value::Array(skills) = field(&info, "skills") {
        config.insert("skills".into(), skill_sources(&skills));
    }
    let agents = field(&info, "agents");
    if is_record(&agents) {
        config.insert("agent".into(), records_map(&agents, config_agent));
        let title = field(&agents, "title");
        if let Some((model, _)) = Some(title).filter(is_record).and_then(|t| selection_of(&field(&t, "model"))) {
            config.insert("small_model".into(), model);
        }
    }
    for (from, to, project) in [
        ("commands", "command", config_command as fn(&Value) -> Value),
        ("providers", "provider", config_provider),
    ] {
        let value = field(&info, from);
        if is_record(&value) {
            config.insert(to.into(), records_map(&value, project));
        }
    }
    Some(field(&info, "mcp")).filter(is_record).map(|m| config.insert("mcp".into(), config_mcp(&m)));
    Ok(Value::Object(config))
}

/// Port of `toV1Path` (`catalog.js:765`).
pub fn to_v1_path(location: Value, paths: Value) -> Result<Value, String> {
    let directory = field(&location, "directory");
    if !is_record(&location) || !non_empty(&directory) {
        return Ok(Value::Null);
    }
    let project = record_or_empty(field(&location, "project"));
    let path = |k: &str| -> Result<Value, String> {
        Ok(if js::is_undefined(&paths) {
            "".into()
        } else {
            non_empty_or(read_member(&paths, k)?, "")
        })
    };
    Ok(
        json!({ "home": path("home")?, "state": path("state")?, "config": path("config")?, "worktree": non_empty_or(field(&project, "directory"), directory.clone()), "directory": directory }),
    )
}

fn project_of(project: &Value) -> Option<Value> {
    let (id, canonical) = (field(project, "id"), field(project, "canonical"));
    if !is_record(project) || !non_empty(&id) || !non_empty(&canonical) {
        return None;
    }
    let time = record_or_empty(field(project, "time"));
    let sandboxes: Vec<Value> = field(project, "sandboxes")
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| is_string(s))
        .cloned()
        .collect();
    let mut out = Obj::from_iter([
        ("id".into(), id),
        ("worktree".into(), canonical),
        (
            "time".into(),
            json!({ "created": or(finite(&field(&time, "created")), 0), "updated": or(finite(&field(&time, "updated")), 0) }),
        ),
        ("sandboxes".into(), Value::Array(sandboxes)),
    ]);
    for key in ["vcs", "name", "icon", "commands"] {
        defined(&field(project, key)).map(|v| out.insert(key.into(), v));
    }
    Some(Value::Object(out))
}

/// Port of `toV1Project` (`catalog.js:783`).
pub fn to_v1_project(project: Value) -> Result<Value, String> {
    Ok(project_of(&project).unwrap_or(Value::Null))
}

/// Port of `toV1Projects` (`catalog.js:806`).
pub fn to_v1_projects(projects: Value) -> Result<Value, String> {
    Ok(list_of(&projects).iter().filter_map(project_of).collect())
}

/// Port of `toV1CurrentProject` (`catalog.js:815`).
pub fn to_v1_current_project(location: Value, projects: Value) -> Result<Value, String> {
    let project = field(&location, "project");
    let id = field(&project, "id");
    if !is_record(&location) || !is_record(&project) || !non_empty(&id) {
        return Ok(Value::Null);
    }
    let listed = list_of(&projects)
        .into_iter()
        .find(|p| js::string_units(&field(p, "id")) == js::string_units(&id));
    let fallback = || json!({ "id": id, "canonical": field(&project, "canonical"), "time": { "created": 0, "updated": 0 }, "sandboxes": [] });
    Ok(project_of(&listed.unwrap_or_else(fallback)).unwrap_or(Value::Null))
}

/// Port of `toV1VcsInfo` (`catalog.js:828`).
pub fn to_v1_vcs_info(vcs: Value) -> Result<Value, String> {
    let branch = Some(field(&vcs, "branch"))
        .filter(|b| is_record(&vcs) && is_record(b))
        .unwrap_or_else(|| json!({}));
    let mut out = Obj::new();
    for (from, to) in [("current", "branch"), ("default", "default_branch")] {
        Some(field(&branch, from)).filter(non_empty).map(|v| out.insert(to.into(), v));
    }
    Ok(Value::Object(out))
}

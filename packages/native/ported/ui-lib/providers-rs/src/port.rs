//! The Rust port of `providers/` (26 of 40 exports), over any JS value: reads, `.find`,
//! `.some`, `.trim()` fail where V8 does, `===` is strict (a missing id matches a missing id).
//! Kept in TS: `sorting.ts` (`Intl.Collator`, `localeCompare`), `getOrderedThinkingVariants`
//! (sorts unranked variants with `localeCompare`) and the nine exports built on it (variant
//! control/display/selection, chat thinking state, Cursor ACP variant state/selection), and the
//! two `filter*ProviderModels` (callback parameter).

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::js;

const CURSOR_ACP: &str = "cursor-acp";
const FAST_SUFFIX: &str = "-fast";

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// A plain JS object (not an array, nor a marker for a string, number, `undefined`, `Map` or `Set`).
fn is_plain(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        !(o.len() == 1
            && ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$function"]
                .iter()
                .any(|k| o.contains_key(*k)))
    })
}

/// `value.key` of a non-nullish value: own properties of plain objects, else `undefined`.
fn field(value: &Value, key: &str) -> Value {
    if !is_plain(value) {
        return js::undefined();
    }
    value.get(key).cloned().unwrap_or_else(js::undefined)
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

/// `value?.key`.
fn opt(value: &Value, key: &str) -> Value {
    if nullish(value) { js::undefined() } else { field(value, key) }
}

/// Whether `key` is a JS array index (canonical decimal below 2^32 - 1).
fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// `Object.entries(value)` of a non-nullish value, in JS order (array-index keys first).
fn entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::String(text) => text.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), js::utf16_string(&[u]))).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::Object(map) if is_plain(value) => {
            let mut indexes: Vec<(u32, &String)> = map.keys().filter_map(|k| index_key(k).map(|n| (n, k))).collect();
            indexes.sort_unstable();
            let mut keys: Vec<&String> = indexes.into_iter().map(|(_, k)| k).collect();
            keys.extend(map.keys().filter(|k| index_key(k).is_none()));
            keys.into_iter().map(|k| (k.clone(), map[k].clone())).collect()
        }
        _ => Vec::new(),
    }
}

/// JS `===` between values received from JS (objects are never the same reference).
fn strict_eq(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b)) {
        (Some(x), Some(y)) => return x == y,
        (Some(_), None) | (None, Some(_)) => return false,
        _ => {}
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) | (Value::String(_), Value::String(_)) => a == b,
        _ if js::is_undefined(a) && js::is_undefined(b) => true,
        _ => match (js::string_units(a), js::string_units(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn undef() -> Value {
    js::undefined()
}

/// `typeof value === 'string'`.
fn string(value: &Value) -> Option<String> {
    js::string_units(value).map(|u| String::from_utf16_lossy(&u))
}

/// `value.trim()` on a value that must be a string (`name` names it in the TypeError).
fn trim_of(value: &Value, name: &str) -> Result<String, String> {
    match string(value) {
        Some(s) => Ok(s.trim_matches(js_space).to_string()),
        None if nullish(value) => Err(format!(
            "Cannot read properties of {} (reading 'trim')",
            if value.is_null() { "null" } else { "undefined" }
        )), // recorded-literal: V8 TypeError text
        None => Err(format!("{name}.trim is not a function")), // recorded-literal: V8 TypeError text
    }
}

/// `normalizeVariantKey(variant)`.
fn variant_key(value: &Value) -> Result<String, String> {
    Ok(trim_of(value, "variant")?.to_lowercase())
}

/// `value.length`.
fn length(value: &Value) -> Result<Value, String> {
    if let Some(units) = js::string_units(value) {
        return Ok(js::number(units.len() as f64));
    }
    match value {
        Value::Array(items) => Ok(js::number(items.len() as f64)),
        _ => get(value, "length"),
    }
}

/// `list.find(...)` / `.some(...)` over an array (`what` is the expression V8 names).
fn items<'a>(list: &'a Value, what: &str, method: &str) -> Result<&'a [Value], String> {
    match list {
        Value::Array(items) => Ok(items),
        _ => {
            get(list, method)?;
            Err(format!("{what}.{method} is not a function")) // recorded-literal: V8 TypeError text
        }
    }
}

fn find_in(list: &Value, what: &str, mut pred: impl FnMut(&Value) -> Result<bool, String>) -> Result<Value, String> {
    for item in items(list, what, "find")? {
        if pred(item)? {
            return Ok(item.clone());
        }
    }
    Ok(undef())
}

fn ends_fast(units: &[u16]) -> bool {
    units.ends_with(&FAST_SUFFIX.encode_utf16().collect::<Vec<_>>())
}

/// `modelId.endsWith('-fast') ? modelId.slice(0, -5) : modelId`.
fn base_id(model_id: &Value) -> Result<Value, String> {
    let Some(units) = js::string_units(model_id) else {
        get(model_id, "endsWith")?;
        return Err("modelId.endsWith is not a function".into()); // recorded-literal: V8 TypeError text
    };
    Ok(if ends_fast(&units) {
        js::utf16_string(&units[..units.len() - FAST_SUFFIX.len()])
    } else {
        model_id.clone()
    })
}

/// `modelId?.endsWith('-fast')`.
fn opt_ends_fast(model_id: &Value) -> Result<bool, String> {
    if nullish(model_id) {
        return Ok(false);
    }
    match js::string_units(model_id) {
        Some(units) => Ok(ends_fast(&units)),
        None => Err("modelId?.endsWith is not a function".into()), // recorded-literal: V8 TypeError text
    }
}

/// `findProviderModel` / `findCursorAcpModel`.
fn find_model(provider: &Value, model_id: &Value) -> Result<Value, String> {
    if !truthy(provider) || !truthy(model_id) {
        return Ok(undef());
    }
    let models = field(provider, "models");
    if !models.is_array() {
        return Ok(undef());
    }
    find_in(&models, "provider.models", |m| Ok(strict_eq(&get(m, "id")?, model_id)))
}

/// `provider?.models?.find(pred)`.
fn find_opt_models(provider: &Value, what: &str, pred: impl FnMut(&Value) -> Result<bool, String>) -> Result<Value, String> {
    let models = opt(provider, "models");
    if nullish(&models) {
        return Ok(undef());
    }
    find_in(&models, what, pred)
}

fn is_typeof_object(value: &Value) -> bool {
    value.is_array()
        || (value.is_object()
            && js::string_units(value).is_none()
            && js::as_number(value).is_none()
            && !js::is_undefined(value)
            && value.get("$function").is_none())
}

/// `isProviderModelAvailable`.
fn available(model: &Value) -> bool {
    !truthy(model) || !is_typeof_object(model) || field(model, "available") != Value::Bool(false)
}

fn unavailable_message(model: &Value) -> Option<&'static str> {
    if available(model) {
        return None;
    }
    Some(match field(model, "unavailableReason").as_str() {
        Some("account_models_unavailable") => "ChatGPT account models could not be loaded. Retry before choosing a model.",
        Some("plan_usage_disabled") => {
            "You are signed in, but ChatGPT plan usage is disabled. Authorize plan usage or explicitly choose API-key authentication in Providers."
        }
        Some("reauthorization_required") => "Reconnect with Sign in with ChatGPT in Providers to use ChatGPT plan usage.",
        Some("auth_type_unsupported") if field(model, "requiredAuthType").as_str() == Some("api") => {
            "This model is unavailable with Sign in with ChatGPT. Connect OpenAI with an API key to use it."
        }
        _ => "This model is unavailable for the connected provider.",
    })
}

/// `resolveThinkingVariant`.
fn thinking_variant(variant: &Value, variants: &Value, context: &Value) -> Result<Value, String> {
    if strict_eq(&length(variants)?, &js::number(0.0)) {
        return Ok(undef());
    }
    let trimmed = string(variant).map(|s| s.trim_matches(js_space).to_string()).unwrap_or_default();
    if trimmed.to_lowercase() == "none"
        && variant_key(&{
            let id = opt(context, "providerId");
            if nullish(&id) { text("") } else { id }
        })? == "openai"
    {
        for wanted in ["low", "medium"] {
            let found = find_in(variants, "variants", |e| Ok(variant_key(e)? == wanted))?;
            if !nullish(&found) {
                return Ok(found);
            }
        }
        return Ok(match variants {
            Value::Array(items) => items.first().cloned().unwrap_or_else(undef),
            _ => undef(),
        });
    }
    if !trimmed.is_empty() {
        let want = text(&trimmed);
        let exact = find_in(variants, "variants", |e| Ok(strict_eq(e, &want)))?;
        if truthy(&exact) {
            return Ok(exact);
        }
        let lower = trimmed.to_lowercase();
        let normalized = find_in(variants, "variants", |e| Ok(variant_key(e)? == lower))?;
        if truthy(&normalized) {
            return Ok(normalized);
        }
    }
    Ok(undef())
}

/// `parseCursorAcpVariantKey`.
fn parse_cursor(variant: &Value) -> Option<Value> {
    let lowered = string(variant).map(|s| s.trim_matches(js_space).to_lowercase()).unwrap_or_default();
    if lowered.is_empty() {
        return None;
    }
    let tokens: Vec<&str> = lowered.split(|c: char| c == '-' || c == '_' || js_space(c)).filter(|t| !t.is_empty()).collect();
    let mut thinking = false;
    let mut effort_tokens = Vec::new();
    for token in tokens {
        if token == "thinking" {
            thinking = true;
        } else if token != "fast" {
            effort_tokens.push(token);
        }
    }
    let effort = match effort_tokens.as_slice() {
        ["extra", "high"] => Some("extra-high"),
        [one] => match *one {
            "low" | "medium" | "high" | "max" | "ultra" | "minimal" | "none" => Some(*one),
            "xhigh" => Some("extra-high"),
            "min" => Some("minimal"),
            _ => None,
        },
        _ => None,
    };
    if !thinking && effort.is_none() {
        return None;
    }
    let canonical = match (thinking, effort) {
        (true, Some(e)) => format!("thinking-{e}"),
        (true, None) => "thinking".to_string(),
        (false, e) => e.unwrap_or_default().to_string(),
    };
    Some(json!({ "effort": effort.map_or_else(undef, text), "thinking": thinking, "canonical": canonical }))
}

fn normalize_id(value: &Value) -> String {
    string(value).map(|s| s.trim_matches(js_space).to_string()).unwrap_or_default()
}

fn hidden_refs(provider_id: &Value, model: &Value) -> Result<(Value, Vec<(String, String)>), String> {
    if !truthy(model) {
        return Ok((Value::Null, Vec::new()));
    }
    let model_id = normalize_id(&field(model, "id"));
    if model_id.is_empty() {
        return Ok((Value::Null, Vec::new()));
    }
    let requested = normalize_id(provider_id);
    let own = normalize_id(&field(model, "providerID"));
    let model_provider = if own.is_empty() { normalize_id(&field(model, "providerId")) } else { own };
    let execution = if model_provider.is_empty() {
        requested.clone()
    } else {
        model_provider.clone()
    };
    let canonical = if requested.is_empty() { execution.clone() } else { requested.clone() };
    let mut aliases = Vec::new();
    let mut seen = HashSet::new();
    for p in [&canonical, &requested, &execution, &model_provider] {
        if !p.is_empty() && seen.insert(format!("{p}/{model_id}")) {
            aliases.push((p.clone(), model_id.clone()));
        }
    }
    let canonical = if canonical.is_empty() {
        Value::Null
    } else {
        json!({ "providerID": canonical, "modelID": model_id })
    };
    Ok((canonical, aliases))
}

fn is_hidden(hidden: &Value, provider_id: &str, model_id: &str) -> Result<bool, String> {
    if provider_id.is_empty() || model_id.is_empty() {
        return Ok(false);
    }
    for h in items(hidden, "hiddenModels", "some")? {
        if get(h, "providerID")?.as_str() == Some(provider_id) && field(h, "modelID").as_str() == Some(model_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Port of `resolveChatThinkingLevel` (`providers/chatThinking.ts:7`).
pub fn resolve_chat_thinking_level(value: Value, levels: Value, model_default: Value) -> Result<Value, String> {
    for candidate in [&value, &model_default] {
        let found = thinking_variant(candidate, &levels, &undef())?;
        if !nullish(&found) {
            return Ok(found);
        }
    }
    let medium = find_in(&levels, "levels", |l| match string(l) {
        Some(s) => Ok(s.to_lowercase() == "medium"),
        None => {
            get(l, "toLowerCase")?;
            Err("level.toLowerCase is not a function".into()) // recorded-literal: V8 TypeError text
        }
    })?;
    if !nullish(&medium) {
        return Ok(medium);
    }
    let Value::Array(list) = &levels else { return Ok(undef()) };
    let index = (list.len() as f64 - 1.0) / 2.0;
    Ok(if index < 0.0 {
        undef()
    } else {
        list.get(index.floor() as usize).cloned().unwrap_or_else(undef)
    })
}

/// Port of `isCursorAcpProvider` (`providers/cursorAcp.ts:13`).
pub fn is_cursor_acp_provider(provider: Value) -> Result<Value, String> {
    Ok(Value::Bool(opt(&provider, "id").as_str() == Some(CURSOR_ACP)))
}

/// Port of `getCursorAcpBaseModelId` (`providers/cursorAcp.ts:17`).
pub fn get_cursor_acp_base_model_id(model_id: Value) -> Result<Value, String> {
    base_id(&model_id)
}

/// Port of `getCursorAcpFastModelId` (`providers/cursorAcp.ts:23`).
pub fn get_cursor_acp_fast_model_id(model_id: Value) -> Result<Value, String> {
    let mut units = js::string_units(&base_id(&model_id)?).unwrap_or_default();
    units.extend(FAST_SUFFIX.encode_utf16());
    Ok(js::utf16_string(&units))
}

/// Port of `findCursorAcpModel` (`providers/cursorAcp.ts:27`).
pub fn find_cursor_acp_model(provider: Value, model_id: Value) -> Result<Value, String> {
    find_model(&provider, &model_id)
}

/// Port of `shouldHideCursorAcpFastModel` (`providers/cursorAcp.ts:37`).
pub fn should_hide_cursor_acp_fast_model(provider: Value, model_id: Value) -> Result<Value, String> {
    if opt(&provider, "id").as_str() != Some(CURSOR_ACP) || !opt_ends_fast(&model_id)? {
        return Ok(Value::Bool(false));
    }
    Ok(Value::Bool(truthy(&find_model(&provider, &base_id(&model_id)?)?)))
}

/// Port of `parseCursorAcpVariantKey` (`providers/cursorThinking.ts:53`).
pub fn parse_cursor_acp_variant_key(variant: Value) -> Result<Value, String> {
    Ok(parse_cursor(&variant).unwrap_or(Value::Null))
}

/// Port of `normalizeCursorAcpVariantKey` (`providers/cursorThinking.ts:81`).
pub fn normalize_cursor_acp_variant_key(variant: Value) -> Result<Value, String> {
    Ok(parse_cursor(&variant).map_or_else(undef, |p| p["canonical"].clone()))
}

fn anthropic(provider_id: &Value) -> Result<bool, String> {
    let id = if nullish(provider_id) { text("") } else { provider_id.clone() };
    let lower = trim_of(&id, "(providerId ?? '')")?.to_lowercase();
    Ok(["anthropic", "claude", "anthropic-oauth", "opencode-with-claude"].contains(&lower.as_str()))
}

/// Port of `isAnthropicOAuthProviderId` (`providers/display.ts:13`).
pub fn is_anthropic_o_auth_provider_id(provider_id: Value) -> Result<Value, String> {
    Ok(Value::Bool(anthropic(&provider_id)?))
}

/// Port of `getProviderDisplayName` (`providers/display.ts:17`).
pub fn get_provider_display_name(provider: Value) -> Result<Value, String> {
    let id = get(&provider, "id")?;
    if id.as_str() == Some("openai") {
        return Ok(text("ChatGPT"));
    }
    if anthropic(&id)? || id.as_str() == Some("claude-agent") {
        return Ok(text("Claude"));
    }
    let name = field(&provider, "name");
    if id.as_str() == Some(CURSOR_ACP) {
        return Ok(if name.as_str() == Some("Cursor ACP") || !truthy(&name) {
            text("Cursor")
        } else {
            name
        });
    }
    if id.as_str() == Some("opencode") {
        return Ok(text("OpenCode Zen"));
    }
    Ok(if truthy(&name) {
        name
    } else if truthy(&id) {
        id
    } else {
        text("")
    })
}

/// Port of `shouldPreserveProviderLogoColor` (`providers/logoPresentation.ts:9`).
pub fn should_preserve_provider_logo_color(provider_id: Value) -> Result<bool, String> {
    let id = if nullish(&provider_id) { text("") } else { provider_id };
    let Some(raw) = string(&id) else {
        return Err("(providerId ?? \"\").toLowerCase is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let lowered = raw.to_lowercase();
    let normalized = lowered.trim_matches(js_space);
    let normalized = normalized.strip_prefix("models.").unwrap_or(normalized);
    let normalized = normalized.strip_prefix("provider.").unwrap_or(normalized);
    let primary = normalized.split(['/', ':']).next().filter(|p| !p.is_empty()).unwrap_or(normalized);
    let set = ["anthropic", "anthropic-oauth", "claude", "claude-agent", "opencode-with-claude"];
    Ok(set.contains(&normalized) || set.contains(&primary))
}

/// Port of `isProviderModelAvailable` (`providers/modelAvailability.ts:13`).
pub fn is_provider_model_available(model: Value) -> Result<bool, String> {
    Ok(available(&model))
}

/// Port of `resolveAvailableProviderModel` (`providers/modelAvailability.ts:22`).
pub fn resolve_available_provider_model(providers: Value, preferred_provider_id: Value, preferred_model_id: Value) -> Result<Value, String> {
    let pick = |p: &Value, m: &Value| json!({ "providerId": field(p, "id"), "modelId": field(m, "id") });
    let what = "preferredProvider?.models";
    let provider = find_in(&providers, "providers", |p| Ok(strict_eq(&get(p, "id")?, &preferred_provider_id)))?;
    let model = find_opt_models(&provider, what, |m| Ok(strict_eq(&get(m, "id")?, &preferred_model_id) && available(m)))?;
    if truthy(&provider) && truthy(&model) {
        return Ok(pick(&provider, &model));
    }
    let fallback = find_opt_models(&provider, what, |m| Ok(available(m)))?;
    if truthy(&provider) && truthy(&fallback) {
        return Ok(pick(&provider, &fallback));
    }
    for p in items(&providers, "providers", "find")? {
        let models = get(p, "models")?;
        if nullish(&models) {
            continue;
        }
        let model = find_in(&models, "provider.models", |m| Ok(available(m)))?;
        if truthy(&model) {
            return Ok(pick(p, &model));
        }
    }
    Ok(Value::Null)
}

/// Port of `getProviderModelUnavailability` (`providers/modelAvailability.ts:50`).
pub fn get_provider_model_unavailability(model: Value) -> Result<Value, String> {
    let Some(message) = unavailable_message(&model) else { return Ok(undef()) };
    let retryable = field(&model, "unavailableReason").as_str() == Some("account_models_unavailable");
    Ok(json!({ "message": message, "retryable": retryable }))
}

/// Port of `getProviderModelUnavailableMessage` (`providers/modelAvailability.ts:59`).
pub fn get_provider_model_unavailable_message(model: Value) -> Result<Value, String> {
    Ok(unavailable_message(&model).map_or_else(undef, text))
}

/// Port of `getModelDisplayName` (`providers/modelIdentity.ts:14`).
pub fn get_model_display_name(model: Value) -> Result<Value, String> {
    let name = get(&model, "name")?;
    if js::string_units(&name).is_some_and(|u| !u.is_empty()) {
        return Ok(name);
    }
    let id = field(&model, "id");
    Ok(if js::string_units(&id).is_some() { id } else { text("") })
}

/// Port of `getExecutionProviderId` (`providers/modelIdentity.ts:22`).
pub fn get_execution_provider_id(provider_id: Value, model: Value) -> Result<Value, String> {
    let upper = get(&model, "providerID")?;
    let own = if js::string_units(&upper).is_some() {
        upper
    } else {
        let lower = field(&model, "providerId");
        if js::string_units(&lower).is_some() { lower } else { text("") }
    };
    Ok(if truthy(&own) { own } else { provider_id })
}

/// Port of `getHiddenModelRefsForProviderModel` (`providers/modelVisibility.ts:52`).
pub fn get_hidden_model_refs_for_provider_model(provider_id: Value, model: Value) -> Result<Value, String> {
    let (canonical, aliases) = hidden_refs(&provider_id, &model)?;
    let aliases: Vec<Value> = aliases.into_iter().map(|(p, m)| json!({ "providerID": p, "modelID": m })).collect();
    Ok(json!({ "canonical": canonical, "aliases": aliases }))
}

/// Port of `isHiddenModelRef` (`providers/modelVisibility.ts:83`).
pub fn is_hidden_model_ref(hidden_models: Value, provider_id: Value, model_id: Value) -> Result<bool, String> {
    is_hidden(&hidden_models, &normalize_id(&provider_id), &normalize_id(&model_id))
}

/// Port of `isHiddenProviderModelRef` (`providers/modelVisibility.ts:100`).
pub fn is_hidden_provider_model_ref(hidden_models: Value, provider_id: Value, model: Value) -> Result<bool, String> {
    for (p, m) in hidden_refs(&provider_id, &model)?.1 {
        if is_hidden(&hidden_models, &p, &m)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Port of `getModelDefaultThinkingLevel` (`providers/variantControls.ts:18`).
pub fn get_model_default_thinking_level(provider: Value, model_id: Value) -> Result<Value, String> {
    let model = find_opt_models(&provider, "provider?.models", |e| Ok(strict_eq(&get(e, "id")?, &model_id)))?;
    let value = opt(&model, "defaultThinkingLevel");
    let trimmed = string(&value).map(|s| s.trim_matches(js_space).to_string()).unwrap_or_default();
    Ok(if trimmed.is_empty() { undef() } else { text(&trimmed) })
}

/// Port of `resolveThinkingVariant` (`providers/variantControls.ts:103`).
pub fn resolve_thinking_variant(variant: Value, variants: Value, context: Value) -> Result<Value, String> {
    thinking_variant(&variant, &variants, &context)
}

/// Port of `getFastModelBaseId` (`providers/variantControls.ts:134`).
pub fn get_fast_model_base_id(model_id: Value) -> Result<Value, String> {
    base_id(&model_id)
}

/// Port of `findProviderModel` (`providers/variantControls.ts:170`).
pub fn find_provider_model(provider: Value, model_id: Value) -> Result<Value, String> {
    find_model(&provider, &model_id)
}

/// Port of `shouldHidePairedFastModel` (`providers/variantControls.ts:180`).
pub fn should_hide_paired_fast_model(provider: Value, model_id: Value) -> Result<bool, String> {
    if !truthy(&provider) || !opt_ends_fast(&model_id)? {
        return Ok(false);
    }
    Ok(truthy(&find_model(&provider, &base_id(&model_id)?)?))
}

/// `findVariantKey(variants, variant)`.
fn variant_key_in(variants: &Value, variant: Option<&str>) -> Result<Option<String>, String> {
    let wanted = variant.map(|v| v.trim_matches(js_space).to_lowercase()).unwrap_or_default();
    if !truthy(variants) || wanted.is_empty() {
        return Ok(None);
    }
    let keys: Vec<String> = entries(variants).into_iter().map(|(k, _)| k).collect();
    if let Some(exact) = keys.iter().find(|k| Some(k.as_str()) == variant) {
        return Ok(Some(exact.clone()));
    }
    Ok(keys.into_iter().find(|k| k.trim_matches(js_space).to_lowercase() == wanted))
}

/// Port of `resolveProviderModelVariant` (`providers/variantControls.ts:236`).
pub fn resolve_provider_model_variant(provider: Value, model_id: Value, variant: Value) -> Result<Value, String> {
    let cleaned = string(&variant).map(|v| v.trim_matches(js_space).to_string()).filter(|v| !v.is_empty());
    let fallback = || cleaned.clone().map_or_else(undef, |c| text(&c));
    if !truthy(&provider) || !truthy(&model_id) {
        return Ok(fallback());
    }
    let model = find_model(&provider, &model_id)?;
    if !truthy(&model) {
        return Ok(fallback());
    }
    Ok(variant_key_in(&field(&model, "variants"), cleaned.as_deref())?.map_or_else(fallback, |k| text(&k)))
}

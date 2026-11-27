//! The Rust port of `responseStyle.ts`, over any JS value. The instruction cache is module
//! state, kept per thread. `String(preset)` is the JS conversion (`['concise']` reads as
//! `concise`); `shouldAttachResponseStyleReminder` returns the `||`/`&&` operand, not a boolean.

#![forbid(unsafe_code)]

use std::cell::RefCell;

use serde_json::Value;

use crate::js;

const LEVELS: [&str; 4] = ["provider", "actions", "concise", "detailed"];
const LEGACY_CONCISE_PRESETS: [&str; 3] = ["concise", "noFiller", "matchEnergy"];
const LEGACY_DETAILED_PRESETS: [&str; 4] = ["detailed", "mentor", "pushback", "warmPeer"];

thread_local! {
    /// `cachedResponseStyleInstruction`, `cachedResponseStyleLevel`, `responseStyleInstructionLoaded`.
    static CACHE: RefCell<(Option<&'static str>, &'static str, bool)> = const { RefCell::new((None, "provider", false)) };
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

/// JS truthiness of a value received from JS.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
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

/// `String(value)` for an array element joined by `Array.prototype.join`.
fn join_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => String::new(),
        _ if js::is_undefined(value) => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(join_text).collect::<Option<Vec<_>>>()?.join(","),
        Value::Number(_) | Value::Object(_) => js::number_to_string(js::as_number(value)?),
    })
}

/// JS `String(value)`.
fn js_string(value: &Value) -> String {
    if js::is_undefined(value) {
        return "undefined".into();
    }
    match value {
        Value::Null => "null".into(),
        Value::Array(_) => join_text(value).unwrap_or_default(),
        Value::Object(_) if js::as_number(value).is_none() => match js::string_units(value) {
            Some(units) => String::from_utf16_lossy(&units),
            None => "[object Object]".into(),
        },
        _ => join_text(value).unwrap_or_default(),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key)).filter(|v| !js::is_undefined(v))
}

fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(field(value, key))
}

fn destructure<'a>(arg: &'a Value, first: &str) -> Result<&'a Value, String> {
    if nullish(arg) {
        let kind = if arg.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property '{first}' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    Ok(arg)
}

/// `for...of` over a value.
fn iterate(value: &Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(map) if map.len() == 1 && map.get("$set").is_some_and(Value::is_array) => Ok(map["$set"].as_array().cloned().unwrap_or_default()),
        _ => Err(format!("{name} is not iterable")), // recorded-literal: V8 TypeError text
    }
}

fn level_of(enabled: Option<&Value>, preset: Option<&Value>) -> &'static str {
    if enabled != Some(&Value::Bool(true)) {
        return "provider";
    }
    if preset.and_then(Value::as_str) == Some("actions") {
        return "actions";
    }
    let text = js_string(preset.unwrap_or(&js::undefined()));
    if LEGACY_DETAILED_PRESETS.contains(&text.as_str()) {
        "detailed"
    } else if LEGACY_CONCISE_PRESETS.contains(&text.as_str()) {
        "concise"
    } else {
        "provider"
    }
}

fn resolve(settings: &Value) -> &'static str {
    let settings = Some(settings).filter(|s| !nullish(s));
    level_of(
        settings.and_then(|s| field(s, "responseStyleEnabled")),
        settings.and_then(|s| field(s, "responseStylePreset")),
    )
}

fn instructions(preset: &str) -> Option<&'static str> {
    match preset {
        "actions" => Some(
            "Show only a short action or status summary for each major step. Do not add a separate rationale. Write every visible summary as a complete, punctuated sentence.",
        ),
        "concise" => Some(
            "For each major step, include one concise user-facing sentence that explains why it is the right next action. Do not expose private chain-of-thought. Write every visible summary as a complete, punctuated sentence.",
        ),
        "detailed" => Some(
            "For each major step, provide a short user-facing paragraph summarizing the evidence, rationale, and relevant tradeoffs before taking action. Do not expose private chain-of-thought. Write every visible summary as complete, punctuated prose.",
        ),
        _ => None,
    }
}

fn or_undefined(text: Option<&str>) -> Value {
    text.map_or_else(js::undefined, |t| Value::String(t.into()))
}

/// `/<system-reminder\s+data-devryan-response-style="(actions|concise|detailed)">/.exec(text)?.[1]`.
fn marker(text: &str) -> Option<&'static str> {
    const OPEN: &str = "<system-reminder";
    const ATTR: &str = "data-devryan-response-style=\"";
    text.match_indices(OPEN).find_map(|(at, _)| {
        let rest = &text[at + OPEN.len()..];
        let after = rest.trim_start_matches(js_space);
        if after.len() == rest.len() {
            return None;
        }
        let value = after.strip_prefix(ATTR)?;
        ["actions", "concise", "detailed"]
            .into_iter()
            .find(|level| value.strip_prefix(level).is_some_and(|r| r.starts_with("\">")))
    })
}

fn level_from_parts(parts: &Value) -> Result<&'static str, String> {
    for part in iterate(parts, "parts")? {
        let kind = get(&part, "type")?;
        if kind.and_then(Value::as_str) != Some("text") || field(&part, "synthetic") != Some(&Value::Bool(true)) {
            continue;
        }
        if let Some(level) = field(&part, "text").and_then(Value::as_str).and_then(marker) {
            return Ok(level);
        }
    }
    Ok("provider")
}

/// Port of `isResponseStyleLevel` (`responseStyle.ts:11`).
pub fn is_response_style_level(value: Value) -> Result<bool, String> {
    Ok(value.as_str().is_some_and(|v| LEVELS.contains(&v)))
}

/// Port of `isResponseStylePreset` (`responseStyle.ts:15`).
pub fn is_response_style_preset(value: Value) -> Result<bool, String> {
    Ok(value.as_str().is_some_and(|v| LEVELS[1..].contains(&v)))
}

/// Port of `resolveResponseStyleLevel` (`responseStyle.ts:19`).
pub fn resolve_response_style_level(settings: Value) -> Result<Value, String> {
    Ok(Value::String(resolve(&settings).into()))
}

/// Port of `getResponseStylePresetInstructions` (`responseStyle.ts:35`): `undefined` for
/// anything but the three presets.
pub fn get_response_style_preset_instructions(preset: Value) -> Result<Value, String> {
    Ok(or_undefined(preset.as_str().and_then(instructions)))
}

/// Port of `buildResponseStyleInstruction` (`responseStyle.ts:46`).
pub fn build_response_style_instruction(arg0: Value) -> Result<Option<String>, String> {
    let arg = destructure(&arg0, "enabled")?;
    let level = level_of(field(arg, "enabled"), field(arg, "preset"));
    Ok(instructions(level).map(str::to_string))
}

/// Port of `wrapResponseStyleReminder` (`responseStyle.ts:58`).
pub fn wrap_response_style_reminder(level: Value, instruction: String) -> Result<String, String> {
    let trimmed = instruction.trim_matches(js_space);
    if level.as_str() == Some("provider") || trimmed.is_empty() {
        return Ok(String::new());
    }
    let level = js_string(&level);
    Ok(format!(
        "<system-reminder data-devryan-response-style=\"{level}\">\n{trimmed}\n</system-reminder>"
    ))
}

/// Port of `readResponseStyleLevelFromParts` (`responseStyle.ts:66`).
pub fn read_response_style_level_from_parts(parts: Value) -> Result<Value, String> {
    Ok(Value::String(level_from_parts(&parts)?.into()))
}

/// Port of `readSessionResponseStyleLevel` (`responseStyle.ts:78`).
pub fn read_session_response_style_level(messages: Value) -> Result<Value, String> {
    for message in iterate(&messages, "messages")? {
        let parts = get(&message, "parts")?.cloned().unwrap_or_else(js::undefined);
        let level = level_from_parts(&parts)?;
        if level != "provider" {
            return Ok(Value::String(level.into()));
        }
    }
    Ok(Value::String("provider".into()))
}

/// Port of `shouldAttachResponseStyleReminder` (`responseStyle.ts:88`).
pub fn should_attach_response_style_reminder(arg0: Value) -> Result<Value, String> {
    let arg = destructure(&arg0, "isNewSessionDraft")?;
    let value = |key: &str| field(arg, key).cloned().unwrap_or_else(js::undefined);
    let draft = value("isNewSessionDraft");
    if truthy(&draft) {
        return Ok(draft);
    }
    let existing = value("hasExistingSession");
    if !truthy(&existing) {
        return Ok(existing);
    }
    Ok(Value::Bool(!truthy(&value("existingSessionHasUserMessages"))))
}

/// Port of `cacheResponseStyleInstructionFromSettings` (`responseStyle.ts:108`).
pub fn cache_response_style_instruction_from_settings(settings: Value) -> Result<Option<String>, String> {
    let level = resolve(&settings);
    let instruction = instructions(level);
    CACHE.with(|c| *c.borrow_mut() = (instruction, level, true));
    Ok(instruction.map(str::to_string))
}

/// Port of `getCachedResponseStyleInstruction` (`responseStyle.ts:118`).
pub fn get_cached_response_style_instruction() -> Result<Option<String>, String> {
    Ok(CACHE.with(|c| c.borrow().0.map(str::to_string)))
}

/// Port of `getCachedResponseStyleLevel` (`responseStyle.ts:120`).
pub fn get_cached_response_style_level() -> Result<Value, String> {
    Ok(Value::String(CACHE.with(|c| c.borrow().1).into()))
}

/// Port of `isResponseStyleInstructionLoaded` (`responseStyle.ts:122`).
pub fn is_response_style_instruction_loaded() -> Result<bool, String> {
    Ok(CACHE.with(|c| c.borrow().2))
}

/// Port of `clearResponseStyleInstructionCacheForTests` (`responseStyle.ts:124`).
pub fn clear_response_style_instruction_cache_for_tests() -> Result<(), String> {
    CACHE.with(|c| *c.borrow_mut() = (None, "provider", false));
    Ok(())
}

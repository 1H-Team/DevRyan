//! The Rust port of `agentSelection.ts`, over any JS value (property reads, `?.trim()` and
//! `.find()` fail as V8 does). The three exports that sort with `localeCompare` (ICU
//! collation) stay in TS.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
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

/// `value[key]` (`undefined` when absent), failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(value.as_object().and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined))
}

/// `name?.trim().toLowerCase() ?? ""`.
fn normalize(name: &Value) -> Result<String, String> {
    if nullish(name) {
        return Ok(String::new());
    }
    match name {
        Value::String(text) => Ok(text.trim_matches(js_space).to_lowercase()),
        _ => Err("name?.trim is not a function".into()), // recorded-literal: V8 TypeError text
    }
}

fn builder(name: &Value) -> Result<bool, String> {
    Ok(matches!(normalize(name)?.as_str(), "build" | "builder"))
}

fn hidden(agent: &Value) -> Result<bool, String> {
    if get(agent, "hidden")? == Value::Bool(true) {
        return Ok(true);
    }
    let options = get(agent, "options")?;
    Ok(!nullish(&options) && get(&options, "hidden")? == Value::Bool(true))
}

fn selectable(agent: &Value) -> Result<bool, String> {
    let mode = get(agent, "mode")?;
    if !matches!(mode.as_str(), Some("primary" | "all")) {
        return Ok(false);
    }
    if normalize(&get(agent, "name")?)? == "plan" {
        return Ok(false);
    }
    Ok(!hidden(agent)?)
}

/// `agents.find(predicate)`.
fn find(agents: &Value, mut predicate: impl FnMut(&Value) -> Result<bool, String>) -> Result<Option<Value>, String> {
    let Value::Array(items) = agents else {
        get(agents, "find")?;
        return Err("agents.find is not a function".into()); // recorded-literal: V8 TypeError text
    };
    for item in items {
        if predicate(item)? {
            return Ok(Some(item.clone()));
        }
    }
    Ok(None)
}

fn find_by_name(agents: &Value, agent_name: &Value) -> Result<Option<Value>, String> {
    if !truthy(agent_name) {
        return Ok(None);
    }
    let wanted = normalize(agent_name)?;
    if matches!(wanted.as_str(), "build" | "builder") {
        let exact = find(agents, |a| Ok(normalize(&get(a, "name")?)? == "builder" && selectable(a)?))?;
        if exact.is_some() {
            return Ok(exact);
        }
        return find(agents, |a| Ok(builder(&get(a, "name")?)? && selectable(a)?));
    }
    find(agents, |a| Ok(normalize(&get(a, "name")?)? == wanted && selectable(a)?))
}

/// Port of `normalizeAgentName` (`agentSelection.ts:15`).
pub fn normalize_agent_name(name: Value) -> Result<Value, String> {
    Ok(Value::String(normalize(&name)?))
}

/// Port of `isPrimaryAgentMode` (`agentSelection.ts:17`).
pub fn is_primary_agent_mode(mode: Value) -> Result<Value, String> {
    Ok(Value::Bool(matches!(mode.as_str(), Some("primary" | "all"))))
}

/// Port of `isHiddenBuiltinAgentOption` (`agentSelection.ts:19`).
pub fn is_hidden_builtin_agent_option(name: Value) -> Result<Value, String> {
    Ok(Value::Bool(normalize(&name)? == "plan"))
}

/// Port of `isBuilderAgentName` (`agentSelection.ts:23`).
pub fn is_builder_agent_name(name: Value) -> Result<Value, String> {
    Ok(Value::Bool(builder(&name)?))
}

/// Port of `isAgentHidden` (`agentSelection.ts:38`).
pub fn is_agent_hidden(agent: Value) -> Result<Value, String> {
    Ok(Value::Bool(hidden(&agent)?))
}

/// Port of `isSelectablePrimaryAgentOption` (`agentSelection.ts:42`).
pub fn is_selectable_primary_agent_option(agent: Value) -> Result<Value, String> {
    Ok(Value::Bool(selectable(&agent)?))
}

/// Port of `findSelectableAgentByName` (`agentSelection.ts:82`).
pub fn find_selectable_agent_by_name(agents: Value, agent_name: Value) -> Result<Value, String> {
    Ok(find_by_name(&agents, &agent_name)?.unwrap_or_else(js::undefined))
}

/// Port of `resolveDefaultAgentName` (`agentSelection.ts:99`).
pub fn resolve_default_agent_name(saved_agent: Value, selectable_agents: Value) -> Result<Value, String> {
    if let Some(saved) = find_by_name(&selectable_agents, &saved_agent)?.filter(truthy) {
        return get(&saved, "name");
    }
    for wanted in ["orchestrator", "builder"] {
        let found = find(&selectable_agents, |a| Ok(normalize(&get(a, "name")?)? == wanted))?;
        if let Some(found) = found.filter(|f| !nullish(f)) {
            let name = get(&found, "name")?;
            if !nullish(&name) {
                return Ok(name);
            }
        }
    }
    let first = match &selectable_agents {
        Value::Array(items) => items.first().cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    };
    if !nullish(&first) {
        let name = get(&first, "name")?;
        if !nullish(&name) {
            return Ok(name);
        }
    }
    Ok(Value::String(String::new()))
}

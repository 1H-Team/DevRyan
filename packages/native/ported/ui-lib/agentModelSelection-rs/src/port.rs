//! The Rust port of `agentModelSelection.ts`. Object keys follow JS order (array-index keys
//! first, ascending), on the way in and out.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

/// JS `String.prototype.trim` white space and line terminators, as UTF-16 code units.
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `typeof value === 'string' ? value.trim() : None`, in UTF-16 code units.
fn trimmed(value: Option<&Value>) -> Option<Vec<u16>> {
    let units = js::string_units(value?)?;
    let start = units.iter().position(|&u| !js_space(u)).unwrap_or(units.len());
    let end = units.iter().rposition(|&u| !js_space(u)).map_or(start, |i| i + 1);
    Some(units[start..end].to_vec())
}

/// Whether `key` is a JS array index (canonical decimal below 2^32 - 1).
fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// The keys of `map` in JS property order.
fn js_order(map: &Map<String, Value>) -> Vec<&String> {
    let mut indexes: Vec<(u32, &String)> = map.keys().filter_map(|k| index_key(k).map(|n| (n, k))).collect();
    indexes.sort_unstable();
    let mut keys: Vec<&String> = indexes.into_iter().map(|(_, k)| k).collect();
    keys.extend(map.keys().filter(|k| index_key(k).is_none()));
    keys
}

fn is_object(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|o| js::string_units(value).is_none() && js::as_number(value).is_none() && !js::is_undefined(value) && !o.contains_key("$set"))
}

/// Port of `parseAgentModelSelections` (`agentModelSelection.ts:7`).
pub fn parse_agent_model_selections(value: Value) -> Result<Option<Value>, String> {
    let Some(input) = value.as_object().filter(|_| is_object(&value)) else {
        return Ok(None);
    };
    let mut selections = Map::new();
    for key in js_order(input) {
        let name = key.trim_matches(|c: char| u32::from(c) < 0x10000 && js_space(c as u16));
        let entry = &input[key];
        let field = |k: &str| entry.as_object().and_then(|o| o.get(k));
        let (Some(provider_id), Some(model_id)) = (trimmed(field("providerId")), trimmed(field("modelId"))) else {
            continue;
        };
        if name.is_empty() || provider_id.is_empty() || model_id.is_empty() {
            continue;
        }
        let mut selection = Map::new();
        selection.insert("providerId".into(), js::utf16_string(&provider_id));
        selection.insert("modelId".into(), js::utf16_string(&model_id));
        if let Some(variant) = trimmed(field("variant")).filter(|v| !v.is_empty()) {
            selection.insert("variant".into(), js::utf16_string(&variant));
        }
        selections.insert(name.to_string(), Value::Object(selection));
    }
    let ordered = js_order(&selections).into_iter().map(|k| (k.clone(), selections[k].clone())).collect();
    Ok(Some(Value::Object(ordered)))
}

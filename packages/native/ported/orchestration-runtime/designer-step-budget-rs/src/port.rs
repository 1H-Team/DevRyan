//! The Rust port of `designer-step-budget.js` of `@devryan/orchestration-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

// ---- JS values over JSON ----

/// `typeof v === "number"` (a one-key `$num` object is the bridge's NaN, Infinity or -0).
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key("$num")))
        .then(|| js::as_number(v))
        .flatten()
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(v) => false,
        _ => num(v).map_or_else(|| js::string_units(v).is_none_or(|u| !u.is_empty()), |n| n != 0.0 && !n.is_nan()),
    }
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    v.as_object().is_some_and(|o| plain(v).is_some() || (o.len() == 1 && o.contains_key("$set")))
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// JS `String(v)`.
fn to_text(v: &Value) -> String {
    match (num(v), js::string_units(v), v) {
        (Some(n), ..) => js::number_to_string(n),
        (_, Some(u), _) => String::from_utf16_lossy(&u),
        (_, _, Value::Array(items)) => items
            .iter()
            .map(|i| if i.is_null() || js::is_undefined(i) { String::new() } else { to_text(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        (_, _, Value::Object(_)) => "[object Object]".into(),
        _ => v.to_string(),
    }
}

/// `Object.keys(v)` of a value that is not nullish.
fn keys(v: &Value) -> Vec<String> {
    let n = js::string_units(v).map(|u| u.len()).or_else(|| v.as_array().map(Vec::len));
    match n {
        Some(n) => (0..n).map(|i| i.to_string()).collect(),
        None => plain(v).map(|o| o.keys().cloned().collect()).unwrap_or_default(),
    }
}

// ---- the unit ----

const WARNING: usize = 180;
const EMERGENCY: usize = 260;

/// `/^[A-Za-z0-9_:-]{1,256}$/` on a string.
fn identifier(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|t| (1..=256).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '-')))
}

fn finite_non_negative(v: &Value) -> bool {
    num(v).is_some_and(|n| n.is_finite() && n >= 0.0)
}

fn only_keys(v: &Value, allowed: &[&str]) -> bool {
    keys(v).iter().all(|k| allowed.contains(&k.as_str()))
}

fn distinct(values: &[Value]) -> bool {
    values.iter().enumerate().all(|(i, v)| !values[..i].iter().any(|w| eq(v, w)))
}

fn rows<'a>(v: &'a Value, max: usize, allowed: &[&str], ok: impl Fn(&Value) -> bool) -> Option<&'a Vec<Value>> {
    v.as_array()
        .filter(|r| r.len() <= max && r.iter().all(|p| truthy(p) && only_keys(p, allowed) && ok(p)))
}

fn invalid(value: &Value) -> bool {
    let top = [
        "acceptedPrompts",
        "userMessageID",
        "assistantMessageIDs",
        "warningClaimedAt",
        "maintenanceParents",
        "retiredPromptThrough",
    ];
    if !record(value) || !only_keys(value, &top) {
        return true;
    }
    let prompts = prop(value, "acceptedPrompts");
    let ok_prompt = |p: &Value| identifier(&prop(p, "userMessageID")) && finite_non_negative(&prop(p, "createdAt"));
    let Some(prompts) = rows(&prompts, 32, &["userMessageID", "createdAt"], ok_prompt) else {
        return true;
    };
    let ids: Vec<Value> = prompts.iter().map(|p| prop(p, "userMessageID")).collect();
    let known = |id: &Value| ids.iter().any(|x| eq(x, id));
    let retired = prop(value, "retiredPromptThrough");
    let parents = prop(value, "maintenanceParents");
    let ok_parent = |p: &Value| identifier(&prop(p, "parentID")) && known(&prop(p, "userMessageID"));
    let parents_ok = js::is_undefined(&parents)
        || rows(&parents, 32, &["parentID", "userMessageID"], ok_parent).is_some_and(|r| distinct(&r.iter().map(|p| prop(p, "parentID")).collect::<Vec<_>>()));
    let user = prop(value, "userMessageID");
    let assistants = prop(value, "assistantMessageIDs");
    let Some(assistants) = assistants
        .as_array()
        .filter(|a| a.len() <= EMERGENCY && a.iter().all(identifier) && distinct(a))
    else {
        return true;
    };
    let claimed = prop(value, "warningClaimedAt");
    !distinct(&ids)
        || (!js::is_undefined(&retired) && !finite_non_negative(&retired))
        || !parents_ok
        || (!user.is_null() && !known(&user))
        || (user.is_null() && !assistants.is_empty())
        || (!claimed.is_null() && (!finite_non_negative(&claimed) || assistants.len() < WARNING))
}

/// Port of `validatePrimaryStepBudget` (`designer-step-budget.js:5`).
pub fn validate_primary_step_budget(value: serde_json::Value) -> Result<serde_json::Value, String> {
    if !js::is_undefined(&value) && invalid(&value) {
        return Err("TypeError: Invalid managed primary step budget".into());
    }
    Ok(js::undefined())
}

/// Port of `designerStepBudgetNotice` (`designer-step-budget.js:29`).
pub fn designer_step_budget_notice(attempt: serde_json::Value, used_steps: serde_json::Value) -> Result<serde_json::Value, String> {
    let message = format!(
        "Designer has used {} primary steps for this accepted prompt. Finish the assigned work and run its exact required checks; avoid further broad discovery. The native prompt cap is 240 steps and the emergency stop is {EMERGENCY}. Report remaining blockers honestly.",
        to_text(&used_steps)
    );
    Ok(json!({ "code": "designer_step_budget_warning", "attempt": attempt, "usedSteps": used_steps, "limit": EMERGENCY, "message": message }))
}

//! The Rust port of `session-tool-effects.js` of `@devryan/harness-runtime`. `descriptors[tool]`
//! also reads inherited `Object.prototype` members (`toString`, `constructor`, ...): their
//! `kind` and `id` are `undefined`, as in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

// ---- JS values over JSON ----

/// A one-key object `{ tag: ... }`: how the bridge marks numbers, strings, `undefined` and `Set`s.
fn marked(v: &Value, tag: &str) -> bool {
    v.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(tag))
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    (v.is_number() || marked(v, "$num")).then(|| js::as_number(v)).flatten()
}

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn truthy(v: &Value) -> bool {
    let falsy = num(v).is_some_and(|n| n == 0.0 || n.is_nan()) || js::string_units(v).is_some_and(|u| u.is_empty());
    !(falsy || matches!(v, Value::Null | Value::Bool(false)) || js::is_undefined(v))
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
    match (num(v), text(v), v) {
        (Some(n), ..) => js::number_to_string(n),
        (_, Some(t), _) => t,
        (_, _, Value::Array(items)) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { to_text(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        (_, _, Value::Object(_)) => "[object Object]".into(),
        _ => v.to_string(),
    }
}

/// `JSON.stringify(a) === JSON.stringify(b)` for two arrays: the same encoding, key order included.
fn same_json(a: &Value, b: &Value) -> bool {
    let skip = |v: &Value| js::is_undefined(v);
    let leaf = |v: &Value| match num(v) {
        Some(n) if !n.is_finite() => Value::Null,
        Some(n) => js::number(n + 0.0),
        None if skip(v) => Value::Null,
        None => v.clone(),
    };
    let obj = |v: &Value| if marked(v, "$set") { Some(Map::new()) } else { plain(v).cloned() };
    match (obj(a), obj(b), a, b) {
        (Some(x), Some(y), ..) => {
            let (x, y): (Vec<_>, Vec<_>) = (x.iter().filter(|e| !skip(e.1)).collect(), y.iter().filter(|e| !skip(e.1)).collect());
            x.len() == y.len() && x.iter().zip(&y).all(|(p, q)| p.0 == q.0 && same_json(p.1, q.1))
        }
        (_, _, Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_json(p, q)),
        (None, None, ..) if !a.is_array() && !b.is_array() => leaf(a) == leaf(b),
        _ => false,
    }
}

// ---- the unit ----

/// `tool:kind:id` for each reviewed tool.
const DESCRIPTORS: &str = "read:native:opencode.tool.read glob:native:opencode.tool.glob grep:native:opencode.tool.grep \
    skill:native:opencode.tool.skill question:native:opencode.tool.question webfetch:plugin:devryan.slim \
    devryan_document:plugin:devryan.document-reader devryan_plan_read:plugin:devryan.managed-task devryan_task:plugin:devryan.managed-task \
    council_session:plugin:devryan.council todoread:plugin:devryan.harness-context todowrite:plugin:devryan.harness-context";
/// Members every object inherits from `Object.prototype`.
const INHERITED: &str = "constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf __proto__ \
    __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__";

/// Port of `reviewedToolEffect` (`session-tool-effects.js:22`).
pub fn reviewed_tool_effect(arg0: Value) -> Result<Value, String> {
    if nullish(&arg0) {
        return Err(format!(
            "TypeError: Cannot destructure property 'tool' of '{0}' as it is {0}.",
            if arg0.is_null() { "null" } else { "undefined" }
        )
        .replace("of 'null'", "of 'object null'"));
    }
    let (tool, origin, reviewed) = (prop(&arg0, "tool"), prop(&arg0, "origin"), prop(&arg0, "reviewedOrigin"));
    let name = to_text(&tool);
    let found = DESCRIPTORS.split_whitespace().map(|d| d.split(':').collect::<Vec<_>>()).find(|d| d[0] == name);
    let expected = match found {
        Some(d) => (json!(d[1]), json!(d[2])),
        None if INHERITED.split_whitespace().any(|m| m == name) => (js::undefined(), js::undefined()),
        None => return Ok(Value::Null),
    };
    let matches = |o: &Value| eq(&prop(o, "kind"), &expected.0) && eq(&prop(o, "id"), &expected.1);
    let digest = prop(&origin, "manifestDigest");
    let caps = (prop(&origin, "capabilities"), prop(&reviewed, "capabilities"));
    let ok = truthy(&origin)
        && truthy(&reviewed)
        && matches(&origin)
        && matches(&reviewed)
        && digest
            .as_str()
            .is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        && eq(&digest, &prop(&reviewed, "manifestDigest"))
        && caps.0.is_array()
        && caps.1.is_array()
        && same_json(&caps.0, &caps.1);
    if !ok {
        return Ok(Value::Null);
    }
    Ok(json!({ "version": 1, "tool": tool, "kind": prop(&origin, "kind"), "id": prop(&origin, "id"), "manifestDigest": digest, "effect": "read-only" }))
}

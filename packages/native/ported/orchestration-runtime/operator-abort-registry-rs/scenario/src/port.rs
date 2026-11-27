//! The Rust port of the test wrapper `scenario-js/operator-abort-registry-scenario.js`: step
//! sequences on one `createManagedOperatorAbortRegistry` registry of `operator-abort-registry.js`,
//! with the clock the steps set. The registry's `Map` is kept in insertion order.

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
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(v) => false,
        _ => num(v).map_or_else(|| js::string_units(v).is_none_or(|u| !u.is_empty()), |n| n != 0.0 && !n.is_nan()),
    }
}

/// `typeof v === "object" && v !== null && !Array.isArray(v)`, as `isRecord` reads it.
fn record(v: &Value) -> bool {
    plain(v).is_some() || marked(v, "$set")
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

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> Result<Value, String> {
    if nullish(v) {
        let kind = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("TypeError: Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(prop(v, key))
}

/// `a === b` (objects are never the same here).
fn eq(a: &Value, b: &Value) -> bool {
    match (num(a), num(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), ..) => x == y,
        (_, _, Some(x), Some(y)) => x == y,
        _ => matches!((a, b), (Value::Bool(x), Value::Bool(y)) if x == y) || (a.is_null() && b.is_null()) || (js::is_undefined(a) && js::is_undefined(b)),
    }
}

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

/// JS `Number(v)` for what these units pass (numbers, `undefined`, `null`, booleans, strings).
fn to_number(v: &Value) -> f64 {
    match (num(v), v) {
        (Some(n), _) => n,
        (_, Value::Null) => 0.0,
        (_, Value::Bool(b)) => f64::from(u8::from(*b)),
        (_, Value::String(s)) if s.trim().is_empty() => 0.0,
        (_, Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `...step.args`.
fn spread_args(args: &Value) -> Result<Vec<Value>, String> {
    if let Some(u) = js::string_units(args) {
        return Ok(char::decode_utf16(u.iter().copied())
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match args {
        Value::Array(items) => Ok(items.clone()),
        _ if marked(args, "$set") => Ok(args.get("$set").and_then(Value::as_array).cloned().unwrap_or_default()),
        _ if nullish(args) => Err(format!(
            "TypeError: step.args is not iterable (cannot read property {})",
            if args.is_null() { "null" } else { "undefined" }
        )),
        _ => Err("TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function".into()), // recorded-literal: the V8 TypeError text
    }
}

fn or_empty(v: Value) -> Value {
    if record(&v) { v } else { Value::Object(Map::new()) }
}

/// The argument of a method whose parameter is `({ ... } = {})`.
fn defaulted(arg: Value, first: &str) -> Result<Value, String> {
    if arg.is_null() {
        return Err(format!(
            "TypeError: Cannot destructure property '{first}' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."
        ));
    }
    Ok(if js::is_undefined(&arg) { Value::Object(Map::new()) } else { arg })
}

struct Registry {
    max: f64,
    clock: Value,
    map: Vec<(String, Value)>,
}

impl Registry {
    fn find(&self, key: &str) -> Option<usize> {
        self.map.iter().position(|(k, _)| k == key)
    }

    fn delete(&mut self, key: &str) -> bool {
        self.find(key).map(|i| self.map.remove(i)).is_some()
    }

    fn record(&mut self, arg: Value) -> Result<Value, String> {
        let arg = defaulted(arg, "sessionId")?;
        let key = trimmed(&prop(&arg, "sessionId"));
        if key.is_empty() {
            return Ok(Value::Null);
        }
        let mut entry = Map::new();
        entry.insert("sessionId".into(), Value::String(key.clone()));
        for field in ["taskId", "requestId"] {
            let v = prop(&arg, field);
            if js::string_units(&v).is_some() {
                entry.insert(field.into(), v);
            }
        }
        let state = prop(&arg, "state");
        if state.as_str().is_some_and(|s| s == "pending" || s == "accepted") {
            entry.insert("state".into(), state);
        }
        let at = prop(&arg, "requestedAt");
        entry.insert(
            "requestedAt".into(),
            num(&at).filter(|n| n.is_finite()).map_or_else(|| self.clock.clone(), js::number),
        );
        let entry = Value::Object(entry);
        self.delete(&key);
        self.map.push((key, entry.clone()));
        while self.map.len() as f64 > self.max {
            self.map.remove(0);
        }
        Ok(entry)
    }

    fn withdraw(&mut self, arg: Value) -> Result<bool, String> {
        let arg = defaulted(arg, "sessionId")?;
        let key = trimmed(&prop(&arg, "sessionId"));
        let Some(i) = self.find(&key) else { return Ok(false) };
        let entry = &self.map[i].1;
        let at = prop(&arg, "requestedAt");
        let request = prop(&arg, "requestId");
        if (num(&at).is_some_and(f64::is_finite) && !eq(&prop(entry, "requestedAt"), &at))
            || (!js::is_undefined(&request) && !eq(&prop(entry, "requestId"), &request))
        {
            return Ok(false);
        }
        Ok(self.delete(&key))
    }

    fn accept(&mut self, arg: Value) -> Result<bool, String> {
        if nullish(&arg) {
            let (shown, kind) = if arg.is_null() { ("object null", "null") } else { ("undefined", "undefined") };
            return Err(format!("TypeError: Cannot destructure property 'sessionId' of '{shown}' as it is {kind}."));
        }
        let Some(i) = self.find(&trimmed(&prop(&arg, "sessionId"))) else {
            return Ok(false);
        };
        let entry = &mut self.map[i].1;
        if !eq(&prop(entry, "requestedAt"), &prop(&arg, "requestedAt")) || !eq(&prop(entry, "requestId"), &prop(&arg, "requestId")) {
            return Ok(false);
        }
        if let Value::Object(map) = entry {
            map.insert("state".into(), json!("accepted"));
        }
        Ok(true)
    }

    fn read(&self, arg: Value) -> Result<Value, String> {
        let arg = defaulted(arg, "sessionId")?;
        let after = prop(&arg, "after");
        let after = if js::is_undefined(&after) { 0.0 } else { to_number(&after) };
        let Some(i) = self.find(&trimmed(&prop(&arg, "sessionId"))) else {
            return Ok(Value::Null);
        };
        let entry = &self.map[i].1;
        let (task, own) = (prop(&arg, "taskId"), prop(entry, "taskId"));
        if to_number(&prop(entry, "requestedAt")) < after || (truthy(&task) && truthy(&own) && !eq(&own, &task)) {
            return Ok(Value::Null);
        }
        Ok(entry.clone())
    }

    fn observe(&mut self, payload: &Value) -> bool {
        if !record(payload) || !eq(&prop(payload, "type"), &json!("session.deleted")) {
            return false;
        }
        let properties = or_empty(prop(payload, "properties"));
        let info = or_empty(prop(&properties, "info"));
        let key = [prop(&info, "id"), prop(&properties, "sessionID"), prop(&properties, "sessionId")]
            .iter()
            .map(trimmed)
            .find(|t| !t.is_empty())
            .unwrap_or_default();
        !key.is_empty() && self.delete(&key)
    }
}

/// Port of `runOperatorAbortRegistry` (`operator-abort-registry-scenario.js:10`).
pub fn run_operator_abort_registry(options: serde_json::Value, steps: serde_json::Value) -> Result<serde_json::Value, String> {
    let max = prop(&if nullish(&options) { Value::Object(Map::new()) } else { options }, "maximumSessions");
    let max = if js::is_undefined(&max) { 5_000.0 } else { num(&max).unwrap_or(f64::NAN) };
    if !(max.fract() == 0.0 && max.abs() <= 9_007_199_254_740_991.0 && max >= 1.0) {
        return Err("RangeError: maximumSessions must be a positive safe integer".into());
    }
    let Value::Array(steps) = steps else {
        get(&steps, "map")?;
        return Err("TypeError: steps.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut registry = Registry {
        max,
        clock: js::number(0.0),
        map: Vec::new(),
    };
    let mut out = Vec::new();
    for step in &steps {
        registry.clock = get(step, "at")?;
        let op = prop(step, "op");
        if eq(&op, &json!("size")) {
            out.push(js::number(registry.map.len() as f64));
            continue;
        }
        let args = spread_args(&prop(step, "args"))?;
        let arg = args.first().cloned().unwrap_or_else(js::undefined);
        out.push(match op.as_str() {
            Some("record") => registry.record(arg)?,
            Some("withdraw") => Value::Bool(registry.withdraw(arg)?),
            Some("accept") => Value::Bool(registry.accept(arg)?),
            Some("read") => registry.read(arg)?,
            Some("observe") => Value::Bool(registry.observe(&arg)),
            Some("clear") => {
                registry.map.clear();
                js::undefined()
            }
            _ => return Err("TypeError: registry[step.op] is not a function".into()), // recorded-literal: the V8 TypeError text
        });
    }
    Ok(Value::Array(out))
}

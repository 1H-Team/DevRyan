//! The Rust port of the test wrapper `scenario-js/host-stall-clock-scenario.js`: step sequences on
//! one `createHostStallClock` clock of `host-stall-clock.js`, with the time the steps set. The
//! kill switch is read from this process's environment, as the original reads `process.env`.
//! `Math.max`/`Math.min` keep JS's NaN and signed-zero rules.

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

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
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

/// JS `String(v)`.
fn to_text(v: &Value) -> String {
    match (num(v), js::string_units(v).map(|u| String::from_utf16_lossy(&u)), v) {
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

// ---- the unit ----

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_positive() { a } else { b }
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else {
        a.min(b)
    }
}

/// JS `a + b`: concatenation when either side is a string.
fn add(a: &Value, b: &Value) -> Value {
    match (js::string_units(a), js::string_units(b)) {
        (None, None) => js::number(to_number(a) + to_number(b)),
        _ => Value::String(to_text(a) + &to_text(b)),
    }
}

struct Clock {
    now: Value,
    last: Value,
    tick_ms: Value,
    stall_ms: f64,
    running: bool,
    stalls: Vec<(f64, f64, Value)>,
    count: f64,
    total: f64,
    longest: f64,
    observed: Vec<Value>,
}

impl Clock {
    fn tick(&mut self) {
        let at = to_number(&self.now);
        let late = at - to_number(&self.last) - to_number(&self.tick_ms);
        if late >= self.stall_ms {
            let from = add(&self.last, &self.tick_ms);
            let stall = (to_number(&from), at, from);
            self.stalls.push(stall.clone());
            self.count += 1.0;
            self.total += late;
            self.longest = js_max(self.longest, late);
            while self.stalls.len() > 512 || self.stalls.first().is_some_and(|s| at - s.1 > 1_800_000.0) {
                self.stalls.remove(0);
            }
            self.observed.push(json!({ "from": stall.2, "to": self.now, "ms": js::number(late) }));
        }
        self.last = self.now.clone();
    }

    fn stalled_between(&self, from: f64, to: f64) -> f64 {
        if std::env::var("DEVRYAN_STALL_AWARE_DEADLINES").is_ok_and(|v| v == "0") || to.partial_cmp(&from) != Some(std::cmp::Ordering::Greater) {
            return 0.0;
        }
        let mut ms = self.stalls.iter().fold(0.0, |ms, s| ms + js_max(0.0, js_min(to, s.1) - js_max(from, s.0)));
        let now = to_number(&self.now);
        if now - to_number(&self.last) - to_number(&self.tick_ms) >= self.stall_ms {
            ms += js_max(0.0, js_min(to, now) - js_max(from, to_number(&add(&self.last, &self.tick_ms))));
        }
        js_min(ms, to - from)
    }

    fn active_since(&self, since: f64, at: f64) -> f64 {
        js_max(0.0, at - since - self.stalled_between(since, at))
    }
}

/// Port of `runHostStallClock` (`host-stall-clock-scenario.js:11`).
pub fn run_host_stall_clock(options: Value, steps: Value) -> Result<Value, String> {
    let start = get(&options, "start")?;
    let setting = |key: &str, default: f64| {
        let v = prop(&options, key);
        if js::is_undefined(&v) { js::number(default) } else { v }
    };
    let (tick_ms, stall_ms) = (setting("tickMs", 250.0), to_number(&setting("stallMs", 1_000.0)));
    let mut clock = Clock {
        now: start.clone(),
        last: start,
        tick_ms,
        stall_ms,
        running: false,
        stalls: vec![],
        count: 0.0,
        total: 0.0,
        longest: 0.0,
        observed: vec![],
    };
    let Value::Array(steps) = steps else {
        get(&steps, "map")?;
        return Err("TypeError: steps.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut results = Vec::new();
    for step in &steps {
        clock.now = get(step, "at")?;
        let now = to_number(&clock.now);
        let op = prop(step, "op");
        let args = if matches!(op.as_str(), Some("stalledMsBetween" | "activeMsSince" | "expired")) {
            spread_args(&prop(step, "args"))?
        } else {
            vec![]
        };
        let arg = |i: usize, default: f64| args.get(i).filter(|v| !js::is_undefined(v)).map_or(default, to_number);
        let result = match op.as_str() {
            Some("tick") => {
                clock.tick();
                js::undefined()
            }
            Some("stalledMsBetween") => js::number(clock.stalled_between(arg(0, f64::NAN), arg(1, now))),
            Some("activeMsSince") => js::number(clock.active_since(arg(0, f64::NAN), arg(1, now))),
            Some("expired") => {
                let (since, limit, cap, at) = (arg(0, f64::NAN), arg(1, f64::NAN), arg(2, f64::INFINITY), arg(3, now));
                Value::Bool(at - since >= cap || clock.active_since(since, at) >= limit)
            }
            Some("start") => {
                if !clock.running {
                    clock.last = clock.now.clone();
                    clock.running = true;
                }
                js::undefined()
            }
            Some("stop") => {
                clock.running = false;
                js::undefined()
            }
            _ => json!({ "stalls": js::number(clock.count), "stalledMs": js::number(clock.total), "longestStallMs": js::number(clock.longest) }),
        };
        results.push(result);
    }
    Ok(json!({ "results": results, "stalls": clock.observed }))
}

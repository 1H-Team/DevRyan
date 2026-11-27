//! The Rust port of `duration.ts`. `formatElapsedDuration`'s `now = Date.now()` default reads the
//! pinned clock (`record --pin-clock`); `end ?? now` treats `null` as missing but `end !== undefined`
//! still marks it final.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

mod pinned;

fn unavailable() -> Value {
    json!({ "available": false, "label": "Unavailable", "milliseconds": null })
}

/// JS `x.toFixed(1)` for `0 <= x < 60`: exact decimal rounding, exact halves (`x * 4` odd) up.
fn to_fixed_1(x: f64) -> String {
    let quarters = x * 4.0;
    if quarters.fract() == 0.0 && quarters % 2.0 == 1.0 {
        return format!("{:.1}", x + 0.05);
    }
    format!("{:.1}", x + 0.0)
}

fn duration(milliseconds: f64, last: impl FnOnce() -> Result<bool, String>) -> Result<Value, String> {
    if !milliseconds.is_finite() || milliseconds < 0.0 {
        return Ok(unavailable());
    }
    let last = last()?;
    let normalized = if last && milliseconds > 0.0 && milliseconds < 100.0 {
        100.0
    } else {
        milliseconds
    };
    let ms = js::number(milliseconds);
    if normalized < 60_000.0 {
        return Ok(json!({ "available": true, "label": format!("{}s", to_fixed_1(normalized / 1_000.0)), "milliseconds": ms }));
    }
    let n = js::number_to_string;
    let total = (normalized / 1_000.0).floor();
    let label = if normalized < 3_600_000.0 {
        format!("{}m {}s", n((total / 60.0).floor()), n(total % 60.0))
    } else {
        format!(
            "{}h {}m {}s",
            n((total / 3_600.0).floor()),
            n(((total % 3_600.0) / 60.0).floor()),
            n(total % 60.0)
        )
    };
    Ok(json!({ "available": true, "label": label, "milliseconds": ms }))
}

/// Port of `formatDurationMilliseconds` (`duration.ts:11`).
pub fn format_duration_milliseconds(milliseconds: f64, options: Value) -> Result<Value, String> {
    duration(milliseconds, || {
        if options.is_null() {
            return Err("Cannot read properties of null (reading 'final')".into()); // recorded-literal: V8 TypeError text
        }
        Ok(options.as_object().and_then(|o| o.get("final")).is_some_and(|v| match v {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::String(text) => !text.is_empty(),
            _ if js::is_undefined(v) => false,
            _ => js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
        }))
    })
}

/// Port of `formatElapsedDuration` (`duration.ts:52`).
pub fn format_elapsed_duration(start: f64, end: Value, now: Value) -> Result<Value, String> {
    if !start.is_finite() {
        return Ok(unavailable());
    }
    let now = if js::is_undefined(&now) { js::number(pinned::now_ms()) } else { now };
    let missing = |v: &Value| v.is_null() || js::is_undefined(v);
    let effective = if missing(&end) { &now } else { &end };
    let effective = match effective {
        Value::Number(_) | Value::Object(_) => js::as_number(effective).filter(|n| n.is_finite()),
        _ => None,
    };
    match effective {
        Some(e) if e >= start => duration(e - start, || Ok(!js::is_undefined(&end))),
        _ => Ok(unavailable()),
    }
}

//! The Rust port of `formatBytes.ts`.
//!
//! Quirk kept: a value below 1 gives a negative unit index, so `0.5` prints `512.0 undefined`.

#![forbid(unsafe_code)]

const BYTE_UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];

/// JS `x.toFixed(1)` for `x > 0`: exact decimal rounding, exact halves (`x * 4` odd) up;
/// `String(x)` from `1e21`.
fn to_fixed_1(x: f64) -> String {
    if !x.is_finite() {
        return "Infinity".into();
    }
    if x >= 1e21 {
        let text = format!("{x:e}");
        return match text.split_once('e') {
            Some((digits, exp)) if !exp.starts_with('-') => format!("{digits}e+{exp}"),
            _ => text,
        };
    }
    let quarters = x * 4.0;
    if quarters.fract() == 0.0 && quarters % 2.0 == 1.0 {
        return format!("{:.1}", x + 0.05);
    }
    format!("{x:.1}")
}

/// Port of `formatBytes` (`formatBytes.ts:3`).
pub fn format_bytes(value: f64) -> Result<String, String> {
    if !value.is_finite() || value <= 0.0 {
        return Ok("0 B".into());
    }
    let unit_index = (value.ln() / 1024f64.ln()).floor().min(3.0);
    let scaled = value / 1024f64.powf(unit_index);
    if unit_index == 0.0 {
        return Ok(format!("{} B", scaled.floor()));
    }
    let unit = usize::try_from(unit_index as i64).ok().and_then(|i| BYTE_UNITS.get(i)).unwrap_or(&"undefined");
    Ok(format!("{} {unit}", to_fixed_1(scaled)))
}

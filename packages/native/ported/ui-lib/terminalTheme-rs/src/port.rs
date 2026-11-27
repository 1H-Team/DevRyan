//! The Rust port of `terminalTheme.ts`: `convertThemeToXterm`, over any JS value (reads fail on
//! `null`/`undefined` in the source's order). `getGhosttyTerminalOptions` carries the Ghostty
//! runtime object through and stays in TS. `selection + '50'` is JS string concatenation
//! (`undefined50`, `[object Object]50`).

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
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

/// `String(value)` for `value + '50'`.
fn concat_text(value: &Value) -> String {
    if js::is_undefined(value) {
        return "undefined".into();
    }
    match value {
        Value::Null => "null".into(),
        Value::Object(o) if o.len() == 1 && o.contains_key("$map") => "[object Map]".into(),
        Value::Object(o) if o.len() == 1 && o.contains_key("$set") => "[object Set]".into(),
        _ => join_text(value).unwrap_or_else(|| "[object Object]".into()),
    }
}

fn path(root: &Value, keys: &[&str]) -> Result<Value, String> {
    let mut current = root.clone();
    for key in keys {
        current = get(&current, key)?;
    }
    Ok(current)
}

/// Port of `convertThemeToXterm` (`terminalTheme.ts:30`).
pub fn convert_theme_to_xterm(theme: Value) -> Result<Value, String> {
    if nullish(&theme) {
        let kind = if theme.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'colors' of 'theme' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    let colors = field(&theme, "colors");
    let syntax = path(&colors, &["syntax", "base"])?;
    let c = |keys: &[&str]| path(&colors, keys);
    let s = |key: &str| get(&syntax, key);
    let selection = c(&["interactive", "selection"])?;
    let entries: Vec<(&str, Value)> = vec![
        ("background", c(&["surface", "background"])?),
        ("foreground", s("foreground")?),
        ("cursor", c(&["interactive", "cursor"])?),
        ("cursorAccent", c(&["surface", "background"])?),
        ("selectionBackground", selection.clone()),
        ("selectionForeground", c(&["interactive", "selectionForeground"])?),
        (
            "selectionInactiveBackground",
            match js::string_units(&selection) {
                Some(mut units) => {
                    units.extend("50".encode_utf16());
                    js::utf16_string(&units)
                }
                None => Value::String(format!("{}50", concat_text(&selection))),
            },
        ),
        ("black", c(&["surface", "muted"])?),
        ("red", c(&["status", "error"])?),
        ("green", c(&["status", "success"])?),
        ("yellow", c(&["status", "warning"])?),
        ("blue", s("function")?),
        ("magenta", s("keyword")?),
        ("cyan", s("type")?),
        ("white", s("foreground")?),
        ("brightBlack", s("comment")?),
        ("brightRed", c(&["status", "error"])?),
        ("brightGreen", c(&["status", "success"])?),
        ("brightYellow", c(&["status", "warning"])?),
        ("brightBlue", s("function")?),
        ("brightMagenta", s("keyword")?),
        ("brightCyan", s("type")?),
        ("brightWhite", c(&["surface", "elevatedForeground"])?),
    ];
    Ok(Value::Object(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Map<_, _>>()))
}

//! The Rust port of `jsonTreeUtils.ts`. `JSON.parse` is a JS-exact parser (lone-surrogate
//! escapes, `1e400`, duplicate keys, array-index keys first). Options spread over the defaults,
//! so `{ maxDepth: undefined }` disables the depth limit's children (every `<` with it is false);
//! the limits compare with JS `ToNumber`. The walkers read nodes as V8 does (`collapsedPaths.has`,
//! for-of over `children`).

#![forbid(unsafe_code)]

use std::cell::Cell;

use serde_json::{Map, Value, json};

use crate::js;

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

/// JS `Number(text)`.
fn string_number(text: &str) -> f64 {
    let t = text.trim_matches(js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
                .unwrap_or(f64::NAN);
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
    let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || exponent.is_empty() || !digits(exponent) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
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

/// JS `ToNumber(ToPrimitive(value))` (a plain object is NaN).
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::String(text) => string_number(text),
        Value::Array(_) => join_text(value).map_or(f64::NAN, |text| string_number(&text)),
        _ => js::as_number(value).unwrap_or(f64::NAN),
    }
}

fn kind(value: &Value) -> &'static str {
    if value.is_null() { "null" } else { "undefined" }
}

/// `value.key`, failing as V8 does on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Value, String> {
    if nullish(value) {
        return Err(format!("Cannot read properties of {} (reading '{key}')", kind(value))); // recorded-literal: V8 TypeError text
    }
    Ok(match value {
        Value::Object(o) if !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))) => o.get(key).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    })
}

/// `for (const x of value)`.
fn iterate(value: &Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(o) if o.len() == 1 && o.get("$set").is_some_and(Value::is_array) => Ok(o["$set"].as_array().cloned().unwrap_or_default()),
        _ => Err(format!("{name} is not iterable")), // recorded-literal: V8 TypeError text
    }
}

/// SameValueZero between values received from JS (objects are never the same reference).
fn same_value_zero(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (js::as_number(a), js::as_number(b)) {
        return x == y || (x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (js::string_units(a), js::string_units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Null, Value::Null) | (Value::Bool(_), Value::Bool(_)) => a == b,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

/// JSON text, parsed as `JSON.parse` does; `None` where it throws.
struct Json<'a> {
    text: &'a [u16],
    at: usize,
}

impl Json<'_> {
    fn space(&mut self) {
        while self.text.get(self.at).is_some_and(|&u| matches!(u, 0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }

    fn eat(&mut self, unit: u8) -> Option<()> {
        (self.text.get(self.at) == Some(&u16::from(unit))).then(|| self.at += 1)
    }

    fn word(&mut self, word: &str, value: Value) -> Option<Value> {
        word.bytes().try_for_each(|b| self.eat(b))?;
        Some(value)
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.text.get(self.at).is_some_and(|&u| (0x30..=0x39).contains(&u)) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        let _ = self.eat(b'-');
        if self.eat(b'0').is_none() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'.').is_some() && self.digits() == 0 {
            return None;
        }
        if self.eat(b'e').or_else(|| self.eat(b'E')).is_some() {
            let _ = self.eat(b'+').or_else(|| self.eat(b'-'));
            if self.digits() == 0 {
                return None;
            }
        }
        let text = String::from_utf16(&self.text[start..self.at]).ok()?;
        Some(js::number(text.parse::<f64>().ok()?))
    }

    fn string(&mut self) -> Option<Vec<u16>> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            let unit = *self.text.get(self.at)?;
            self.at += 1;
            match unit {
                0x22 => return Some(out),
                0x00..=0x1f => return None,
                0x5c => {
                    let escape = *self.text.get(self.at)?;
                    self.at += 1;
                    out.push(match escape {
                        0x22 | 0x5c | 0x2f => escape,
                        0x62 => 0x08,
                        0x66 => 0x0c,
                        0x6e => 0x0a,
                        0x72 => 0x0d,
                        0x74 => 0x09,
                        0x75 => {
                            let hex = String::from_utf16(self.text.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            u16::from_str_radix(&hex, 16).ok()?
                        }
                        _ => return None,
                    });
                }
                _ => out.push(unit),
            }
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.space();
        let value = match *self.text.get(self.at)? {
            0x7b => {
                self.at += 1;
                let mut map = Map::new();
                self.space();
                if self.eat(b'}').is_none() {
                    loop {
                        self.space();
                        let key = String::from_utf16_lossy(&self.string()?);
                        self.space();
                        self.eat(b':')?;
                        let item = self.value()?;
                        map.insert(key, item);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b'}')?;
                            break;
                        }
                    }
                }
                Value::Object(js_order(map))
            }
            0x5b => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.eat(b']').is_none() {
                    loop {
                        items.push(self.value()?);
                        self.space();
                        if self.eat(b',').is_none() {
                            self.eat(b']')?;
                            break;
                        }
                    }
                }
                Value::Array(items)
            }
            0x22 => js::utf16_string(&self.string()?),
            0x74 => self.word("true", Value::Bool(true))?,
            0x66 => self.word("false", Value::Bool(false))?,
            0x6e => self.word("null", Value::Null)?,
            _ => self.number()?,
        };
        self.space();
        Some(value)
    }
}

fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// An object's keys in JS order: array indexes ascending, then insertion order.
fn js_order(map: Map<String, Value>) -> Map<String, Value> {
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest = Map::new();
    for (key, value) in map {
        match index_key(&key) {
            Some(n) => indexed.push((n, key, value)),
            None => {
                rest.insert(key, value);
            }
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

const DEFAULTS: [(&str, f64); 3] = [("maxDepth", 50.0), ("maxNodes", 100_000.0), ("initiallyExpandedDepth", 2.0)];

thread_local! {
    static NODE_COUNT: Cell<f64> = const { Cell::new(0.0) };
}

fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Array(_) => "array",
        Value::Object(_) if js::string_units(value).is_some() => "string",
        Value::Object(_) if js::as_number(value).is_some() => "number",
        Value::Object(_) => "object",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
    }
}

fn node_path(segments: &[String]) -> String {
    let mut result = String::from("root");
    for segment in segments {
        if !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()) {
            result.push_str(&format!("[{segment}]"));
        } else {
            result.push('.');
            result.push_str(segment);
        }
    }
    result
}

fn build(value: &Value, key: &str, path: Vec<String>, depth: f64, max_depth: f64, max_nodes: f64) -> Option<Value> {
    if NODE_COUNT.get() >= max_nodes {
        return None;
    }
    NODE_COUNT.set(NODE_COUNT.get() + 1.0);
    let kind = type_of(value);
    let expandable = kind == "object" || kind == "array";
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_path(&path)));
    node.insert("key".into(), Value::String(key.into()));
    node.insert("value".into(), value.clone());
    node.insert("type".into(), Value::String(kind.into()));
    node.insert("depth".into(), js::number(depth));
    node.insert("path".into(), json!(path));
    node.insert("isExpandable".into(), Value::Bool(expandable));
    let entries: Vec<(String, Value)> = match value {
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::Object(o) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => Vec::new(),
    };
    if expandable {
        node.insert("childCount".into(), js::number(entries.len() as f64));
    }
    if expandable && depth < max_depth {
        let children: Vec<Value> = entries
            .into_iter()
            .filter_map(|(child_key, child)| {
                let mut child_path = path.clone();
                child_path.push(child_key.clone());
                build(&child, &child_key, child_path, depth + 1.0, max_depth, max_nodes)
            })
            .collect();
        node.insert("children".into(), Value::Array(children));
    }
    Some(Value::Object(node))
}

/// Port of `getNodePath` (`jsonTreeUtils.ts:48`).
pub fn get_node_path(path_segments: Vec<String>) -> Result<String, String> {
    Ok(node_path(&path_segments))
}

/// Port of `parseJsonToTree` (`jsonTreeUtils.ts:110`).
pub fn parse_json_to_tree(text: String, options: Value) -> Result<Value, String> {
    let mut opts: Map<String, Value> = DEFAULTS.iter().map(|(k, v)| ((*k).to_string(), js::number(*v))).collect();
    if let Value::Object(o) = &options
        && js::string_units(&options).is_none()
        && js::as_number(&options).is_none()
        && !js::is_undefined(&options)
    {
        for (k, v) in o {
            opts.insert(k.clone(), v.clone());
        }
    }
    let limit = |key: &str| to_number(&opts[key]);
    NODE_COUNT.set(0.0);
    let trimmed = text.trim_matches(js_space);
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    let units: Vec<u16> = trimmed.encode_utf16().collect();
    let mut parser = Json { text: &units, at: 0 };
    let parsed = match parser.value() {
        Some(parsed) if parser.at == units.len() => parsed,
        _ => return Ok(Value::Null),
    };
    Ok(build(&parsed, "root", Vec::new(), 0.0, limit("maxDepth"), limit("maxNodes")).unwrap_or(Value::Null))
}

/// Port of `flattenTree` (`jsonTreeUtils.ts:125`).
pub fn flatten_tree(root: Value, collapsed_paths: Value) -> Result<Vec<Value>, String> {
    fn walk(node: &Value, collapsed: &Value, out: &mut Vec<Value>) -> Result<(), String> {
        let id = get(node, "id")?;
        if nullish(collapsed) {
            return Err(format!("Cannot read properties of {} (reading 'has')", kind(collapsed))); // recorded-literal: V8 TypeError text
        }
        let Some(set) = collapsed
            .as_object()
            .filter(|o| o.len() == 1)
            .and_then(|o| o.get("$set"))
            .and_then(Value::as_array)
        else {
            return Err("collapsedPaths.has is not a function".into()); // recorded-literal: V8 TypeError text
        };
        let expanded = !set.iter().any(|v| same_value_zero(v, &id));
        out.push(json!({ "node": node, "isExpanded": expanded }));
        let children = get(node, "children")?;
        if truthy(&get(node, "isExpandable")?) && expanded && truthy(&children) {
            for child in iterate(&children, "node.children")? {
                walk(&child, collapsed, out)?;
            }
        }
        Ok(())
    }
    if !truthy(&root) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    walk(&root, &collapsed_paths, &mut out)?;
    Ok(out)
}

/// Port of `getAllExpandableIds` (`jsonTreeUtils.ts:142`).
pub fn get_all_expandable_ids(root: Value) -> Result<Vec<Value>, String> {
    fn walk(node: &Value, ids: &mut Vec<Value>) -> Result<(), String> {
        if truthy(&get(node, "isExpandable")?) {
            ids.push(get(node, "id")?);
            let children = get(node, "children")?;
            if truthy(&children) {
                for child in iterate(&children, "node.children")? {
                    walk(&child, ids)?;
                }
            }
        }
        Ok(())
    }
    let mut ids = Vec::new();
    if truthy(&root) {
        walk(&root, &mut ids)?;
    }
    Ok(ids)
}

/// Port of `getExpandableIdsAboveDepth` (`jsonTreeUtils.ts:159`).
pub fn get_expandable_ids_above_depth(root: Value, max_depth: f64) -> Result<Vec<Value>, String> {
    fn walk(node: &Value, max_depth: f64, ids: &mut Vec<Value>) -> Result<(), String> {
        if truthy(&get(node, "isExpandable")?) && to_number(&get(node, "depth")?) >= max_depth {
            ids.push(get(node, "id")?);
        }
        let children = get(node, "children")?;
        if truthy(&children) {
            for child in iterate(&children, "node.children")? {
                walk(&child, max_depth, ids)?;
            }
        }
        Ok(())
    }
    let mut ids = Vec::new();
    if truthy(&root) {
        walk(&root, max_depth, &mut ids)?;
    }
    Ok(ids)
}

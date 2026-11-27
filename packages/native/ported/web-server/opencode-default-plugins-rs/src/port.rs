//! The Rust port of `opencode/default-plugins.js`. Its managed-plugin lookups are
//! `managed-plugins.js`'s, ported as in `opencode-managed-plugins-rs` (the plugin table without
//! the fields this unit never reads). `findLast` reads `defaultPluginId` of every item it passes,
//! so a `null` item throws there, as in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

struct Plugin {
    id: &'static str,
    name: &'static str,
    package: Option<(&'static str, &'static str, &'static str)>,
    registration: &'static str,
    legacy_specs: &'static [&'static str],
    legacy_paths: Option<&'static [&'static str]>,
    delivery: &'static str,
    source: &'static str,
}

const PROFILE_PACKAGE: &str = "default-config/user-profile/package.json";

#[rustfmt::skip]
const PLUGINS: [Plugin; 5] = [
    Plugin { id: "@rama_nigg/open-cursor", name: "Open Cursor", package: Some(("@rama_nigg/open-cursor", "2.5.17", "dist/plugin-entry.js")), registration: "./plugins/devryan-open-cursor.mjs", legacy_specs: &["@rama_nigg/open-cursor", "@rama_nigg/open-cursor@latest"], legacy_paths: Some(&["./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js"]), delivery: "installed-local", source: PROFILE_PACKAGE },
    Plugin { id: "opencode-gpt-imagegen", name: "GPT Image Generation", package: Some(("opencode-gpt-imagegen", "0.1.12", "dist/index.js")), registration: "./node_modules/opencode-gpt-imagegen/dist/index.js", legacy_specs: &["opencode-gpt-imagegen", "opencode-gpt-imagegen@latest", "opencode-gpt-imagegen@0.1.10", "opencode-gpt-imagegen@0.1.12"], legacy_paths: None, delivery: "installed-local", source: PROFILE_PACKAGE },
    Plugin { id: "devryan-skill-context", name: "DevRyan Skill Context", package: None, registration: "./plugins/devryan-skill-context.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/devryan-skill-context.mjs" },
    Plugin { id: "devryan-document-reader", name: "DevRyan Document Reader", package: None, registration: "./plugins/devryan-document-reader.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/devryan-document-reader.mjs" },
    Plugin { id: "openai-tool-schema-sanitizer", name: "OpenAI Tool Schema Sanitizer", package: None, registration: "./plugins/openai-tool-schema-sanitizer.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/openai-tool-schema-sanitizer.mjs" },
];

#[rustfmt::skip]
const RETIRED_SPECS: [&str; 25] = ["cursor-acp", "context-mode", "context-mode@1.0.169", "./node_modules/context-mode/build/adapters/opencode/plugin.js", "opencode-antigravity-auth", "opencode-antigravity-auth@latest", "opencode-antigravity-auth@1.6.0", "./node_modules/opencode-antigravity-auth/dist/index.js", "./plugins/devryan-superpowers.mjs", "superpowers@git+https://github.com/obra/superpowers.git", "oh-my-opencode-slim", "oh-my-opencode-slim@2.0.5", "oh-my-opencode-slim@2.2.15", "oh-my-opencode-slim@2.2.18", "oh-my-opencode-slim@2.2.24", "oh-my-opencode-slim@2.2.25", "./plugins/devryan-oh-my-opencode-slim.mjs", "@dietrichgebert/ponytail", "@dietrichgebert/ponytail@latest", "@dietrichgebert/ponytail@4.10.0", "./node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs", "opencode-with-claude", "opencode-with-claude@1.6.18", "opencode-with-claude@1.8.0", "opencode-with-claude@1.11.2"];
#[rustfmt::skip]
const RETIRED_TAIL: [&str; 2] = ["./node_modules/opencode-with-claude/dist/index.js", "./plugins/devryan-claude-transport.mjs"];
#[rustfmt::skip]
const RETIRED_SUFFIXES: [&str; 8] = ["/node_modules/context-mode/build/adapters/opencode/plugin.js", "/node_modules/opencode-antigravity-auth/dist/index.js", "/plugins/devryan-superpowers.mjs", "/plugins/devryan-oh-my-opencode-slim.mjs", "/node_modules/oh-my-opencode-slim/dist/index.js", "/node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs", "/node_modules/opencode-with-claude/dist/index.js", "/plugins/devryan-claude-transport.mjs"];

impl Plugin {
    fn is_registration(&self, spec: &str) -> bool {
        matches_registration(spec, self.registration)
    }

    fn is_legacy_path(&self, spec: &str) -> bool {
        self.legacy_paths.unwrap_or(&[]).iter().any(|path| matches_registration(spec, path))
    }

    fn is_package(&self, spec: &str) -> bool {
        self.package
            .is_some_and(|(name, _, _)| spec == name || spec.strip_prefix(name).and_then(|r| r.strip_prefix('@')).is_some_and(|v| !v.is_empty()))
    }
}

fn js_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// `normalizeSpec`: the first item of an array, trimmed, backslashes made slashes; empty when
/// not a string.
fn normalize(value: &Value) -> Vec<u16> {
    let raw = match value {
        Value::Array(items) => items.first().cloned().unwrap_or_else(js::undefined),
        _ => value.clone(),
    };
    let units = js::string_units(&raw).unwrap_or_default();
    let start = units.iter().position(|u| !js_space(*u)).unwrap_or(units.len());
    let end = units.iter().rposition(|u| !js_space(*u)).map_or(start, |i| i + 1);
    units[start..end].iter().map(|&u| if u == 0x5c { 0x2f } else { u }).collect()
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn matches_registration(spec: &str, registration: &str) -> bool {
    let spec = text(&normalize(&Value::String(spec.into())));
    !spec.is_empty() && (spec == registration || spec.ends_with(&format!("/{}", registration.strip_prefix("./").unwrap_or(registration))))
}

fn plugin_for_spec(value: &Value) -> Option<&'static Plugin> {
    let spec = text(&normalize(value));
    (!spec.is_empty())
        .then(|| {
            PLUGINS
                .iter()
                .find(|p| p.is_registration(&spec) || p.is_package(&spec) || p.legacy_specs.contains(&spec.as_str()) || p.is_legacy_path(&spec))
        })
        .flatten()
}

fn retired(value: &Value) -> bool {
    let spec = text(&normalize(value));
    !spec.is_empty() && (RETIRED_SPECS.iter().chain(&RETIRED_TAIL).any(|s| *s == spec) || RETIRED_SUFFIXES.iter().any(|s| spec.ends_with(s)))
}

fn field(value: &Value, key: &str) -> Value {
    let plain = value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))));
    plain.and_then(|o| o.get(key)).map_or_else(js::undefined, same)
}

fn same(value: &Value) -> Value {
    js::as_number(value).map_or_else(|| value.clone(), js::number)
}

fn truthy(value: &Value) -> bool {
    js::string_units(value).map_or_else(
        || !(value.is_null() || value == &Value::Bool(false) || js::is_undefined(value) || js::as_number(value).is_some_and(|n| n == 0.0 || n.is_nan())),
        |u| !u.is_empty(),
    )
}

/// `String(value)` for the values a recorded file name can be (not a `Date` or function).
fn to_string(value: &Value) -> Vec<u16> {
    if let Some(units) = js::string_units(value) {
        return units;
    }
    if let Some(n) = js::as_number(value) {
        return js::number_to_string(n).encode_utf16().collect();
    }
    match value {
        Value::Null => "null".encode_utf16().collect(),
        Value::Bool(b) => b.to_string().encode_utf16().collect(),
        Value::Array(items) => items
            .iter()
            .map(|i| if i.is_null() || js::is_undefined(i) { Vec::new() } else { to_string(i) })
            .collect::<Vec<_>>()
            .join(&[0x2c][..]),
        Value::Object(o) if o.len() == 1 && o.contains_key("$bigint") => o["$bigint"].as_str().unwrap_or_default().encode_utf16().collect(),
        Value::Object(o) if o.len() == 1 && o.contains_key("$map") => "[object Map]".encode_utf16().collect(),
        Value::Object(o) if o.len() == 1 && o.contains_key("$set") => "[object Set]".encode_utf16().collect(),
        _ if js::is_undefined(value) => "undefined".encode_utf16().collect(),
        _ => "[object Object]".encode_utf16().collect(),
    }
}

fn file_plugin(file_name: &Value) -> Option<&'static Plugin> {
    let name = text(&normalize(file_name)).to_lowercase();
    let basename = |p: &str| p.rsplit('/').next().unwrap_or(p).to_lowercase();
    (!name.is_empty()).then(|| PLUGINS.iter().find(|p| basename(p.registration) == name)).flatten()
}

fn id_or_null(plugin: Option<&'static Plugin>) -> Value {
    plugin.map_or(Value::Null, |p| p.id.into())
}

/// Port of `getDevRyanDefaultPluginIdForSpec` (`default-plugins.js:33`).
pub fn get_dev_ryan_default_plugin_id_for_spec(spec: Value) -> Result<Value, String> {
    Ok(id_or_null(plugin_for_spec(&spec)))
}

/// Port of `getDevRyanDefaultPluginIdForFile` (`default-plugins.js:37`).
pub fn get_dev_ryan_default_plugin_id_for_file(file_name: Value) -> Result<Value, String> {
    Ok(id_or_null(file_plugin(&file_name)))
}

/// The items kept, each with its `defaultPluginId` when it names a default plugin.
fn annotate(items: &[Value], keep: impl Fn(&Value) -> bool, plugin: impl Fn(&Value) -> Option<&'static Plugin>) -> Vec<Value> {
    let annotated = |item: &Value| match (plugin(item), item.as_object()) {
        (Some(p), Some(o)) => {
            let mut copy = o.clone();
            copy.insert("defaultPluginId".into(), p.id.into());
            Value::Object(copy)
        }
        _ => same(item),
    };
    items.iter().filter(|i| keep(i)).map(annotated).collect()
}

fn find_last<'a>(items: &'a [Value], id: &str) -> Result<Option<&'a Value>, String> {
    for item in items.iter().rev() {
        if item.is_null() || js::is_undefined(item) {
            let shown = if item.is_null() { "null" } else { "undefined" };
            return Err(format!("Cannot read properties of {shown} (reading 'defaultPluginId')")); // recorded-literal: V8 TypeError text
        }
        if field(item, "defaultPluginId").as_str() == Some(id) {
            return Ok(Some(item));
        }
    }
    Ok(None)
}

/// An options member; an array, `Map`, `Set` or typed array inherits an `entries` method.
fn list(options: &Value, key: &str) -> Result<Vec<Value>, String> {
    let inherited = options.is_array()
        || ["$map", "$set", "$bytes"]
            .iter()
            .any(|m| options.as_object().is_some_and(|o| o.len() == 1 && o.contains_key(*m)));
    match field(options, key) {
        _ if inherited && key == "entries" => Err("entries.filter is not a function".into()), // recorded-literal: V8 TypeError text
        Value::Array(items) => Ok(items),
        value if js::is_undefined(&value) => Ok(Vec::new()),
        _ => Err(format!("{key}.filter is not a function")), // recorded-literal: V8 TypeError text
    }
}

/// Port of `buildDevRyanDefaultPluginInventory` (`default-plugins.js:41`).
pub fn build_dev_ryan_default_plugin_inventory(options: Value) -> Result<Value, String> {
    if options.is_null() {
        return Err("Cannot destructure 'null' as it is null.".into()); // recorded-literal: V8 TypeError text
    }
    let entries = annotate(
        &list(&options, "entries")?,
        |e| !retired(&field(e, "spec")),
        |e| plugin_for_spec(&field(e, "spec")),
    );
    let files = annotate(
        &list(&options, "files")?,
        |f| {
            let name = field(f, "fileName");
            let name = if name.is_null() || js::is_undefined(&name) {
                Vec::new()
            } else {
                to_string(&name)
            };
            !retired(&js::utf16_string(&["./plugins/".encode_utf16().collect(), name].concat()))
        },
        |f| file_plugin(&field(f, "fileName")),
    );
    let mut defaults = Vec::new();
    for plugin in &PLUGINS {
        let (entry, file) = (find_last(&entries, plugin.id)?, find_last(&files, plugin.id)?);
        let mut out = Map::new();
        let (id, version) = (
            format!("devryan-default:{}", plugin.id),
            plugin.package.map_or(Value::Null, |(_, v, _)| v.into()),
        );
        out.extend([
            ("id".into(), id.into()),
            ("pluginId".into(), plugin.id.into()),
            ("displayName".into(), plugin.name.into()),
            ("shippedSpec".into(), plugin.registration.into()),
            ("version".into(), version),
            ("delivery".into(), plugin.delivery.into()),
            ("sourcePath".into(), plugin.source.into()),
            ("kind".into(), "default".into()),
        ]);
        let spec = entry.map_or_else(js::undefined, |e| field(e, "spec"));
        out.insert("effectiveSpec".into(), if truthy(&spec) { spec } else { plugin.registration.into() });
        let entry_source = entry.map_or_else(js::undefined, |e| field(e, "sourcePath"));
        let file_path = file.map_or_else(js::undefined, |f| field(f, "absolutePath"));
        if let Some(source) = [entry_source, file_path].into_iter().find(truthy) {
            out.insert("configuredSourcePath".into(), source);
        }
        defaults.push(Value::Object(out));
    }
    Ok(serde_json::json!({ "defaults": defaults, "entries": entries, "files": files }))
}

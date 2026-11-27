//! The Rust port of `opencode/managed-plugins.js` (6 of 7 functions; the constant tables stay
//! JS exports). `inspectDevRyanManagedPluginInstallation` reads the file system through the
//! caller's `fs` and stays in JS. Specs compare as UTF-16; a lone surrogate (never in a table)
//! matches nothing either way. `toLowerCase` is Rust's full Unicode lowercasing.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

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
    profile: bool,
    dependencies: Option<&'static [(&'static str, &'static str, &'static str)]>,
}

const PROFILE_PACKAGE: &str = "default-config/user-profile/package.json";

#[rustfmt::skip]
const PLUGINS: [Plugin; 5] = [
    Plugin { id: "@rama_nigg/open-cursor", name: "Open Cursor", package: Some(("@rama_nigg/open-cursor", "2.5.17", "dist/plugin-entry.js")), registration: "./plugins/devryan-open-cursor.mjs", legacy_specs: &["@rama_nigg/open-cursor", "@rama_nigg/open-cursor@latest"], legacy_paths: Some(&["./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js"]), delivery: "installed-local", source: PROFILE_PACKAGE, profile: true, dependencies: None },
    Plugin { id: "opencode-gpt-imagegen", name: "GPT Image Generation", package: Some(("opencode-gpt-imagegen", "0.1.12", "dist/index.js")), registration: "./node_modules/opencode-gpt-imagegen/dist/index.js", legacy_specs: &["opencode-gpt-imagegen", "opencode-gpt-imagegen@latest", "opencode-gpt-imagegen@0.1.10", "opencode-gpt-imagegen@0.1.12"], legacy_paths: None, delivery: "installed-local", source: PROFILE_PACKAGE, profile: true, dependencies: None },
    Plugin { id: "devryan-skill-context", name: "DevRyan Skill Context", package: None, registration: "./plugins/devryan-skill-context.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/devryan-skill-context.mjs", profile: true, dependencies: None },
    Plugin { id: "devryan-document-reader", name: "DevRyan Document Reader", package: None, registration: "./plugins/devryan-document-reader.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/devryan-document-reader.mjs", profile: true, dependencies: Some(&[("@opencode-ai/plugin", "1.18.33", "dist/index.js"), ("adm-zip", "0.6.0", "adm-zip.js"), ("mammoth", "1.12.1", "lib/index.js"), ("unpdf", "1.8.0", "dist/index.mjs")]) },
    Plugin { id: "openai-tool-schema-sanitizer", name: "OpenAI Tool Schema Sanitizer", package: None, registration: "./plugins/openai-tool-schema-sanitizer.mjs", legacy_specs: &[], legacy_paths: None, delivery: "bundled-file", source: "default-config/plugins/openai-tool-schema-sanitizer.mjs", profile: false, dependencies: None },
];

#[rustfmt::skip]
const RETIRED_SPECS: [&str; 25] = ["cursor-acp", "context-mode", "context-mode@1.0.169", "./node_modules/context-mode/build/adapters/opencode/plugin.js", "opencode-antigravity-auth", "opencode-antigravity-auth@latest", "opencode-antigravity-auth@1.6.0", "./node_modules/opencode-antigravity-auth/dist/index.js", "./plugins/devryan-superpowers.mjs", "superpowers@git+https://github.com/obra/superpowers.git", "oh-my-opencode-slim", "oh-my-opencode-slim@2.0.5", "oh-my-opencode-slim@2.2.15", "oh-my-opencode-slim@2.2.18", "oh-my-opencode-slim@2.2.24", "oh-my-opencode-slim@2.2.25", "./plugins/devryan-oh-my-opencode-slim.mjs", "@dietrichgebert/ponytail", "@dietrichgebert/ponytail@latest", "@dietrichgebert/ponytail@4.10.0", "./node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs", "opencode-with-claude", "opencode-with-claude@1.6.18", "opencode-with-claude@1.8.0", "opencode-with-claude@1.11.2"];
#[rustfmt::skip]
const RETIRED_TAIL: [&str; 2] = ["./node_modules/opencode-with-claude/dist/index.js", "./plugins/devryan-claude-transport.mjs"];
#[rustfmt::skip]
const RETIRED_SUFFIXES: [&str; 8] = ["/node_modules/context-mode/build/adapters/opencode/plugin.js", "/node_modules/opencode-antigravity-auth/dist/index.js", "/plugins/devryan-superpowers.mjs", "/plugins/devryan-oh-my-opencode-slim.mjs", "/node_modules/oh-my-opencode-slim/dist/index.js", "/node_modules/@dietrichgebert/ponytail/.opencode/plugins/ponytail.mjs", "/node_modules/opencode-with-claude/dist/index.js", "/plugins/devryan-claude-transport.mjs"];

impl Plugin {
    /// The frozen export: the definition's keys, then `legacyRegistrationPaths` and
    /// `runtimeDependencies` where the definition had none.
    fn value(&self) -> Value {
        let (package, version, entrypoint) = self
            .package
            .map_or((Value::Null, Value::Null, Value::Null), |(p, v, e)| (p.into(), v.into(), e.into()));
        let dependencies = |deps: &[(&str, &str, &str)]| -> Value {
            deps.iter()
                .map(|(p, v, e)| json!({ "packageName": p, "version": v, "entrypoint": e }))
                .collect()
        };
        let mut out = Map::new();
        out.extend([
            ("id".into(), self.id.into()),
            ("displayName".into(), self.name.into()),
            ("packageName".into(), package),
            ("version".into(), version),
            ("entrypoint".into(), entrypoint),
            ("registrationPath".into(), self.registration.into()),
            ("legacySpecs".into(), json!(self.legacy_specs)),
        ]);
        if let Some(paths) = self.legacy_paths {
            out.insert("legacyRegistrationPaths".into(), json!(paths));
        }
        out.extend([
            ("delivery".into(), self.delivery.into()),
            ("sourcePath".into(), self.source.into()),
            ("profileRegistration".into(), self.profile.into()),
        ]);
        if let Some(deps) = self.dependencies {
            out.insert("runtimeDependencies".into(), dependencies(deps));
        }
        out.insert("public".into(), true.into());
        out.entry("legacyRegistrationPaths").or_insert_with(|| json!([]));
        out.entry("runtimeDependencies").or_insert_with(|| json!([]));
        Value::Object(out)
    }

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

fn migration_plugin(value: &Value) -> Option<&'static Plugin> {
    let spec = text(&normalize(value));
    (!spec.is_empty())
        .then(|| {
            PLUGINS
                .iter()
                .filter(|p| p.profile)
                .find(|p| p.is_registration(&spec) || p.legacy_specs.contains(&spec.as_str()) || p.is_legacy_path(&spec))
        })
        .flatten()
}

fn retired(value: &Value) -> bool {
    let spec = text(&normalize(value));
    !spec.is_empty() && (RETIRED_SPECS.iter().chain(&RETIRED_TAIL).any(|s| *s == spec) || RETIRED_SUFFIXES.iter().any(|s| spec.ends_with(s)))
}

fn legacy(value: &Value) -> bool {
    let spec = text(&normalize(value));
    !spec.is_empty()
        && (retired(&Value::String(spec.clone()))
            || PLUGINS
                .iter()
                .filter(|p| p.profile)
                .any(|p| p.legacy_specs.contains(&spec.as_str()) || p.is_legacy_path(&spec)))
}

fn same(value: &Value) -> Value {
    js::as_number(value).map_or_else(|| value.clone(), js::number)
}

/// Port of `getDevRyanManagedPluginForSpec` (`managed-plugins.js:234`).
pub fn get_dev_ryan_managed_plugin_for_spec(value: Value) -> Result<Value, String> {
    Ok(plugin_for_spec(&value).map_or(Value::Null, Plugin::value))
}

/// Port of `getDevRyanManagedPluginForFile` (`managed-plugins.js:245`).
pub fn get_dev_ryan_managed_plugin_for_file(file_name: Value) -> Result<Value, String> {
    let name = text(&normalize(&file_name)).to_lowercase();
    let basename = |p: &str| p.rsplit('/').next().unwrap_or(p).to_lowercase();
    let found = (!name.is_empty()).then(|| PLUGINS.iter().find(|p| basename(p.registration) == name)).flatten();
    Ok(found.map_or(Value::Null, Plugin::value))
}

/// Port of `isRetiredDevRyanPluginSpec` (`managed-plugins.js:263`).
pub fn is_retired_dev_ryan_plugin_spec(value: Value) -> Result<Value, String> {
    Ok(retired(&value).into())
}

/// Port of `isDevRyanManagedLegacyPluginSpec` (`managed-plugins.js:270`).
pub fn is_dev_ryan_managed_legacy_plugin_spec(value: Value) -> Result<Value, String> {
    Ok(legacy(&value).into())
}

/// Port of `removeDevRyanManagedLegacyPluginSpecs` (`managed-plugins.js:278`).
pub fn remove_dev_ryan_managed_legacy_plugin_specs(entries: Value) -> Result<Value, String> {
    Ok(entries.as_array().into_iter().flatten().filter(|e| !legacy(e)).map(same).collect())
}

/// Port of `reconcileDevRyanManagedPluginSpecs` (`managed-plugins.js:284`).
pub fn reconcile_dev_ryan_managed_plugin_specs(current_entries: Value, baseline_entries: Value) -> Result<Value, String> {
    let default: Vec<Value> = PLUGINS.iter().filter(|p| p.profile).map(|p| p.registration.into()).collect();
    let baseline = if js::is_undefined(&baseline_entries) {
        default
    } else {
        baseline_entries.as_array().cloned().unwrap_or_default()
    };
    let mut baseline_by_id: Vec<(&str, Value)> = Vec::new();
    for entry in &baseline {
        if let Some(plugin) = plugin_for_spec(entry).filter(|p| p.profile && !baseline_by_id.iter().any(|(id, _)| *id == p.id)) {
            baseline_by_id.push((plugin.id, js::utf16_string(&normalize(entry))));
        }
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut reconciled = Vec::new();
    for entry in current_entries.as_array().into_iter().flatten() {
        if retired(entry) {
            continue;
        }
        let Some(plugin) = plugin_for_spec(entry).filter(|p| p.profile) else {
            reconciled.push(same(entry));
            continue;
        };
        if seen.contains(&plugin.id) {
            continue;
        }
        seen.push(plugin.id);
        let managed = baseline_by_id.iter().find(|(id, _)| *id == plugin.id).map(|(_, spec)| spec.clone());
        reconciled.push(match (migration_plugin(entry), managed, entry) {
            (Some(_), Some(spec), Value::Array(items)) => std::iter::once(spec).chain(items.iter().skip(1).map(same)).collect(),
            (Some(_), Some(spec), _) => spec,
            _ => same(entry),
        });
    }
    reconciled.extend(baseline_by_id.into_iter().filter(|(id, _)| !seen.contains(id)).map(|(_, spec)| spec));
    Ok(Value::Array(reconciled))
}

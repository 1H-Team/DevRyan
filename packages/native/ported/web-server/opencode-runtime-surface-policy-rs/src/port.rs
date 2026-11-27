//! The Rust port of `opencode/runtime-surface-policy.js` (all 5 functions). The managed-plugin
//! lookup is `managed-plugins.js`'s, as ported in `opencode-managed-plugins-rs` (the table without
//! the fields this unit never reads). Names and ids are trimmed with JS white space.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const BLOCKED_MCP: [&str; 5] = ["ghgrep", "gh-grep", "gh_grep", "grep-app", "grep_app"];

struct Plugin {
    package: Option<(&'static str, &'static str, &'static str)>,
    registration: &'static str,
    legacy_specs: &'static [&'static str],
    legacy_paths: Option<&'static [&'static str]>,
    profile: bool,
}

#[rustfmt::skip]
const PLUGINS: [Plugin; 5] = [
    Plugin { package: Some(("@rama_nigg/open-cursor", "2.5.17", "dist/plugin-entry.js")), registration: "./plugins/devryan-open-cursor.mjs", legacy_specs: &["@rama_nigg/open-cursor", "@rama_nigg/open-cursor@latest"], legacy_paths: Some(&["./node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js"]), profile: true },
    Plugin { package: Some(("opencode-gpt-imagegen", "0.1.12", "dist/index.js")), registration: "./node_modules/opencode-gpt-imagegen/dist/index.js", legacy_specs: &["opencode-gpt-imagegen", "opencode-gpt-imagegen@latest", "opencode-gpt-imagegen@0.1.10", "opencode-gpt-imagegen@0.1.12"], legacy_paths: None, profile: true },
    Plugin { package: None, registration: "./plugins/devryan-skill-context.mjs", legacy_specs: &[], legacy_paths: None, profile: true },
    Plugin { package: None, registration: "./plugins/devryan-document-reader.mjs", legacy_specs: &[], legacy_paths: None, profile: true },
    Plugin { package: None, registration: "./plugins/openai-tool-schema-sanitizer.mjs", legacy_specs: &[], legacy_paths: None, profile: false },
];

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

fn trimmed(value: &Value) -> Option<Vec<u16>> {
    let u = js::string_units(value)?;
    let start = u.iter().position(|c| !js_space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !js_space(*c)).map_or(start, |i| i + 1);
    Some(u[start..end].to_vec())
}

fn allowed(spec: &Value) -> bool {
    let normalized = trimmed(spec).unwrap_or_default();
    if normalized.is_empty() {
        return false;
    }
    let as_text = text(&normalized);
    plugin_for_spec(&js::utf16_string(&normalized)).is_some_and(|p| p.profile && !p.legacy_specs.contains(&as_text.as_str()))
}

/// Port of `isAllowedManagedRuntimePluginSpec` (`runtime-surface-policy.js:32`).
pub fn is_allowed_managed_runtime_plugin_spec(spec: Value) -> Result<Value, String> {
    Ok(allowed(&spec).into())
}

/// Port of `filterManagedRuntimePluginEntries` (`runtime-surface-policy.js:44`): a string entry, or
/// an array entry's first item, is the spec.
pub fn filter_managed_runtime_plugin_entries(entries: Value) -> Result<Value, String> {
    let spec = |e: &Value| match e {
        Value::Array(items) => items.first().cloned().unwrap_or_else(js::undefined),
        _ => e.clone(),
    };
    let same = |e: &Value| js::as_number(e).map_or_else(|| e.clone(), js::number);
    Ok(entries.as_array().into_iter().flatten().filter(|e| allowed(&spec(e))).map(same).collect())
}

/// Port of `isBlockedManagedRuntimeMcpName` (`runtime-surface-policy.js:50`).
pub fn is_blocked_managed_runtime_mcp_name(name: Value) -> Result<Value, String> {
    Ok(trimmed(&name)
        .is_some_and(|n| BLOCKED_MCP.iter().any(|b| b.encode_utf16().eq(n.iter().copied())))
        .into())
}

/// Port of `buildBlockedManagedRuntimeMcpOverlay` (`runtime-surface-policy.js:55`).
pub fn build_blocked_managed_runtime_mcp_overlay(configs: Value) -> Result<Value, String> {
    let configured: Vec<Vec<u16>> = configs
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c
                .as_object()
                .filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
                .and_then(|o| o.get("name"))
                .cloned()
                .unwrap_or_else(js::undefined);
            trimmed(&name).filter(|n| !n.is_empty())
        })
        .collect();
    let mcp: Map<String, Value> = BLOCKED_MCP
        .iter()
        .filter(|b| !configured.iter().any(|n| b.encode_utf16().eq(n.iter().copied())))
        .map(|b| (b.to_string(), json!({ "enabled": false })))
        .collect();
    Ok(if mcp.is_empty() { Value::Null } else { json!({ "mcp": mcp }) })
}

/// Port of `isForbiddenManagedRuntimeToolId` (`runtime-surface-policy.js:72`).
pub fn is_forbidden_managed_runtime_tool_id(tool_id: Value) -> Result<Value, String> {
    let id = text(&trimmed(&tool_id).unwrap_or_default());
    Ok((!id.is_empty() && (id == "invalid" || id.starts_with("ghgrep_") || id.starts_with("grep_app_"))).into())
}

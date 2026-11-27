//! The Rust port of `tools/manifest.ts`: `getToolPermissionAliases`. `normalizeToolIds` and
//! `buildToolManifest` sort with `localeCompare` (ICU collation) and stay in TS.

#![forbid(unsafe_code)]

use serde_json::Value;

const TOOL_PERMISSION_ALIAS_GROUPS: [&[&str]; 7] = [
    &["edit", "write", "patch", "apply_patch"],
    &["read"],
    &["bash"],
    &["task"],
    &["skill"],
    &["question", "ask", "input", "clarification"],
    &["webfetch"],
];

/// Port of `getToolPermissionAliases` (`tools/manifest.ts:28`): the alias group holding the id,
/// else the id alone (as given).
pub fn get_tool_permission_aliases(tool_id: Value) -> Result<Vec<Value>, String> {
    let group = tool_id.as_str().and_then(|id| TOOL_PERMISSION_ALIAS_GROUPS.iter().find(|g| g.contains(&id)));
    Ok(match group {
        Some(group) => group.iter().map(|a| Value::String((*a).into())).collect(),
        None => vec![tool_id],
    })
}

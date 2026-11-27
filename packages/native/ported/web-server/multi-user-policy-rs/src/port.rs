//! The Rust port of `multi-user/policy.js` (all 12 functions; the role tables stay JS constants
//! too). JS semantics written out where the policy relies on them: property reads on any value
//! (`?.`, a string's `length` and indexes, a `Map`'s `size`), `hasOwnProperty` and
//! `Object.entries`/spread of strings and arrays (index keys), `String()` and
//! `toLowerCase`, `Array.prototype.includes` versus a string's substring `includes`, iteration of
//! `assignments`, `JSON.stringify` for change detection, and the role table read through
//! `Object.prototype` (a `constructor`/`toString`/`__proto__` role finds an inherited value and
//! throws later; an array role reads its `String()`). `normalizeNotificationTemplates` is
//! `notification-settings.js`'s, as ported in `opencode-notification-settings-rs`.

#![forbid(unsafe_code)]

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::js;

type Obj = Map<String, Value>;
type Res<T> = Result<T, String>;

#[rustfmt::skip]
const SLUGS: [&str; 22] = ["appearance", "notifications", "shortcuts", "voice", "about", "chat", "sessions", "agents", "magic-prompts", "plugins", "skills.installed", "skills.catalog", "mcp", "providers", "usage", "remote-instances", "tunnel", "users", "bug-reports", "git", "projects", "commands"];
const USER_EDITABLE: [&str; 8] = ["appearance", "notifications", "shortcuts", "voice", "chat", "sessions", "usage", "bug-reports"];
const SENIOR_PAGES: [&str; 7] = ["appearance", "chat", "sessions", "shortcuts", "notifications", "users", "bug-reports"];
const DEVELOPER_PAGES: [&str; 6] = ["appearance", "chat", "sessions", "shortcuts", "notifications", "bug-reports"];
#[rustfmt::skip]
const CAPABILITIES: [&str; 11] = ["files", "terminal", "browser", "createWorktrees", "createBranches", "manageProjects", "manageUsers", "manageGlobalSettings", "manageGit", "push", "github"];
#[rustfmt::skip]
const OBJECT_PROTOTYPE: [&str; 12] = ["constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString", "__proto__"]; // recorded-literal: engine-defined names
const PROTO: &str = "__proto__"; // recorded-literal: the engine's prototype key
const MCP_STATES: [&str; 2] = ["on", "off"];

#[rustfmt::skip]
fn fields_by_page(slug: &str) -> &'static [&'static str] {
    match slug {
        "appearance" => &["themeId", "themeCatalogVersion", "useSystemTheme", "themeVariant", "lightThemeId", "darkThemeId", "splashBgLight", "splashFgLight", "splashBgDark", "splashFgDark", "fontSize", "chatWidth", "terminalFontSize", "uiFont", "monoFont", "padding", "cornerRadius", "inputBarOffset", "pwaAppName", "pwaOrientation", "mobileKeyboardMode", "typographySizes", "timeFormatPreference", "weekStartPreference"],
        "chat" => &["showReasoningTraces", "showDeletionDialog", "queueModeEnabled", "inputSpellcheckEnabled", "showToolFileIcons", "showExpandedBashTools", "showExpandedEditTools", "chatRenderMode", "activityRenderMode", "mermaidRenderingMode", "showSplitAssistantMessageActions", "diffLayoutPreference", "diffViewMode", "userMessageRenderingMode", "collapsibleUserMessages", "stickyUserHeader", "defaultFileViewerPreview"],
        "sessions" => &["autoDeleteEnabled", "autoDeleteAfterDays", "sessionRetentionAction", "defaultModel", "defaultVariant", "defaultAgent", "defaultPlanMode", "helperModelSelection", "autoCreateWorktree", "zenModel", "messageStreamTransport", "messageLimit", "favoriteModels", "favoriteModelsUpdatedAt", "hiddenModels", "hiddenModelsUpdatedAt", "agentModelSelections"],
        "shortcuts" => &["keyboardShortcuts", "appShortcuts"],
        "notifications" => &["nativeNotificationsEnabled", "notificationMode", "notifyOnSubtasks", "notifyOnCompletion", "notifyOnPlanReady", "notifyOnError", "notifyOnQuestion", "notifyOnPermission", "notificationTemplates", "summarizeLastMessage", "summaryThreshold", "summaryLength", "maxLastMessageLength"],
        "agents" => &["globalBehaviorPrompt", "responseStyleEnabled", "responseStylePreset", "responseStyleCustomInstructions", "responseStyleLevel"],
        "skills.installed" => &["hiddenSkills"],
        "skills.catalog" => &["skillCatalogs"],
        "mcp" => &["mcpServerEnabledOverrides"],
        "git" => &["gitmojiEnabled", "gitChangesViewMode", "gitProviderId", "gitModelId", "defaultGitIdentityId", "openInAppId"],
        "projects" => &["pinnedDirectories"],
        "usage" => &["usageAutoRefresh", "usageRefreshIntervalMs", "usageDisplayMode", "usageShowPredValues", "usageDropdownProviders", "usageSelectedModels", "usageCollapsedFamilies", "usageExpandedFamilies", "usageModelGroups"],
        "voice" => &["sttProvider", "sttServerUrl", "sttModel", "wasmSttModel", "sttLanguage", "sttSilenceThresholdDb", "sttSilenceHoldMs"],
        "tunnel" => &["tunnelProvider", "tunnelMode", "tunnelBootstrapTtlMs", "tunnelSessionTtlMs", "managedLocalTunnelConfigPath", "managedRemoteTunnelHostname", "managedRemoteTunnelToken", "managedRemoteTunnelPresets", "managedRemoteTunnelSelectedPresetId", "managedRemoteTunnelPresetTokens"],
        "about" => &["reportUsage", "opencodeBinary", "desktopLanAccessEnabled", "desktopKeepAwakeEnabled", "agentBrowserControlEnabled"],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------------------------
// JS values
// ---------------------------------------------------------------------------------------------

fn marker(v: &Value) -> Option<&str> {
    v.as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

fn undef() -> Value {
    js::undefined()
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `typeof v === 'object' && v !== null` (arrays included).
fn is_object(v: &Value) -> bool {
    v.is_array() || (v.is_object() && !matches!(marker(v), Some("$utf16" | "$num" | "$undefined" | "$bigint" | "$function")))
}

fn record(v: &Value) -> bool {
    is_object(v) && !v.is_array()
}

fn truthy(v: &Value) -> bool {
    if let Some(u) = js::string_units(v) {
        return !u.is_empty();
    }
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ if js::is_undefined(v) => false,
        _ if marker(v) == Some("$bigint") => v["$bigint"].as_str() != Some("0"),
        _ => js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `String(v)`.
fn to_string(v: &Value) -> Vec<u16> {
    if let Some(u) = js::string_units(v) {
        return u;
    }
    match v {
        Value::Null => units("null"),
        Value::Bool(b) => units(&b.to_string()),
        Value::Array(items) => items
            .iter()
            .map(|x| if nullish(x) { Vec::new() } else { to_string(x) })
            .collect::<Vec<_>>()
            .join(&[0x2c][..]),
        _ if js::is_undefined(v) => units("undefined"),
        _ if marker(v) == Some("$map") => units("[object Map]"),
        _ if marker(v) == Some("$set") => units("[object Set]"),
        _ if marker(v) == Some("$bigint") => units(v["$bigint"].as_str().unwrap_or_default()),
        _ => js::as_number(v).map_or_else(|| units("[object Object]"), |n| units(&js::number_to_string(n))),
    }
}

fn text(v: &Value) -> String {
    String::from_utf16_lossy(&to_string(v))
}

fn index(key: &str) -> Option<usize> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key).map(|n| n as usize)
}

fn type_error(v: &Value, key: &str) -> String {
    let shown = if v.is_null() { "null" } else { "undefined" };
    format!("Cannot read properties of {shown} (reading '{key}')") // recorded-literal: V8 TypeError text
}

/// `v[key]` (a method or inherited member reads as `undefined`: none is used as data here).
fn prop(v: &Value, key: &str) -> Res<Value> {
    if nullish(v) {
        return Err(type_error(v, key));
    }
    if let Some(u) = js::string_units(v) {
        return Ok(match (key, index(key)) {
            ("length", _) => js::number(u.len() as f64),
            (_, Some(i)) => u.get(i).map_or_else(undef, |c| js::utf16_string(&[*c])),
            _ => undef(),
        });
    }
    Ok(match (v, marker(v)) {
        (Value::Array(items), _) => match (key, index(key)) {
            ("length", _) => js::number(items.len() as f64),
            (_, Some(i)) => items.get(i).cloned().unwrap_or_else(undef),
            _ => undef(),
        },
        (Value::Object(o), None) => o.get(key).cloned().unwrap_or_else(undef),
        (Value::Object(o), Some(m @ ("$map" | "$set"))) if key == "size" => js::number(o[m].as_array().map_or(0, Vec::len) as f64),
        _ => undef(),
    })
}

/// `v?.[key]`.
fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { undef() } else { prop(v, key).unwrap_or_else(|_| undef()) }
}

/// `Object.entries(v)` (`None` where it throws on `null`/`undefined`).
fn entries(v: &Value) -> Option<Vec<(String, Value)>> {
    if nullish(v) {
        return None;
    }
    let indexed = |items: Vec<Value>| items.into_iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect();
    Some(if let Some(u) = js::string_units(v) {
        indexed(u.iter().map(|c| js::utf16_string(&[*c])).collect())
    } else {
        match (v, marker(v)) {
            (Value::Array(items), _) => indexed(items.clone()),
            (Value::Object(o), None) => o.iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
            (Value::Object(o), Some("$bytes")) => indexed(o["$bytes"].as_array().cloned().unwrap_or_default()),
            _ => Vec::new(),
        }
    })
}

/// `{ ...v }`.
fn spread(v: &Value) -> Obj {
    entries(v).unwrap_or_default().into_iter().collect()
}

/// `Object.prototype.hasOwnProperty.call(v, key)`.
fn has_own(v: &Value, key: &str) -> Res<bool> {
    if nullish(v) {
        return Err("Cannot convert undefined or null to object".into()); // recorded-literal: V8 TypeError text
    }
    Ok(entries(v).unwrap_or_default().iter().any(|(k, _)| k == key) || (key == "length" && (v.is_array() || js::string_units(v).is_some())))
}

fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key)
}

/// An object built by assignment, in JS key order (array indexes first).
fn ordered(map: Obj) -> Value {
    let (mut indexed, rest): (Vec<_>, Vec<_>) = map.into_iter().partition(|(k, _)| index_key(k).is_some());
    indexed.sort_by_key(|(k, _)| index_key(k));
    Value::Object(indexed.into_iter().chain(rest).collect())
}

fn is_bool(v: &Value) -> bool {
    v.is_boolean()
}

fn is(v: &Value, s: &str) -> bool {
    v.as_str() == Some(s)
}

fn quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn single<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1).and_then(|o| o.get(key))
}

/// `JSON.stringify(value)`; `None` for `undefined`.
fn stringify(value: &Value) -> Result<Option<String>, String> {
    if js::is_undefined(value) {
        return Ok(None);
    }
    if let Some(units) = js::string_units(value) {
        return Ok(Some(quote(&units)));
    }
    if let Some(n) = js::as_number(value) {
        return Ok(Some(if n.is_finite() { js::number_to_string(n) } else { "null".into() }));
    }
    if single(value, "$bigint").is_some() {
        return Err("Do not know how to serialize a BigInt".into()); // recorded-literal: V8 TypeError text
    }
    Ok(Some(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(stringify(item)?.unwrap_or_else(|| "null".into()));
            }
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            if let Some(date) = single(value, "$date") {
                return Ok(Some(match date.as_str() {
                    Some("Invalid") | None => "null".into(),
                    Some(iso) => quote(&iso.encode_utf16().collect::<Vec<_>>()),
                }));
            }
            if single(value, "$map").is_some() || single(value, "$set").is_some() {
                return Ok(Some("{}".into()));
            }
            let pairs: Vec<(String, Value)> = match single(value, "$bytes").and_then(Value::as_array) {
                Some(bytes) => bytes.iter().enumerate().map(|(i, b)| (i.to_string(), b.clone())).collect(),
                None => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            };
            let mut parts = Vec::new();
            for (k, v) in pairs {
                if let Some(text) = stringify(&v)? {
                    parts.push(format!("{}:{text}", quote(&k.encode_utf16().collect::<Vec<_>>())));
                }
            }
            format!("{{{}}}", parts.join(","))
        }
        _ => return Ok(None),
    }))
}

// ---------------------------------------------------------------------------------------------
// Settings slugs and role defaults
// ---------------------------------------------------------------------------------------------

fn slug_of(value: &Value) -> Option<&'static str> {
    let raw = if truthy(value) { to_string(value) } else { Vec::new() };
    let trimmed = String::from_utf16_lossy(trim(&raw)).to_lowercase();
    match trimmed.as_str() {
        "behavior" => Some("agents"),
        "home" => None,
        s => SLUGS.iter().find(|x| **x == s).copied(),
    }
}

fn trim(u: &[u16]) -> &[u16] {
    let space = |c: &u16| matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    let start = u.iter().position(|c| !space(c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn legacy_read_pages(pages: &Value) -> HashSet<&'static str> {
    let Value::Array(items) = pages else { return HashSet::new() };
    if items.iter().any(|p| is(p, "*")) {
        return SLUGS.iter().copied().collect();
    }
    items.iter().filter_map(slug_of).collect()
}

fn permission(read: Value, edit: Value) -> Value {
    json!({ "read": read, "edit": edit })
}

fn role_permissions(read_pages: &[&str], edit_pages: &[&str]) -> Value {
    let page = |p: &[&str]| legacy_read_pages(&json!(p));
    let (readable, editable) = (page(read_pages), page(edit_pages));
    Value::Object(
        SLUGS
            .iter()
            .map(|s| {
                (
                    s.to_string(),
                    permission(readable.contains(s).into(), (readable.contains(s) && editable.contains(s)).into()),
                )
            })
            .collect(),
    )
}

fn admin_permissions() -> Value {
    role_permissions(&["*"], &["*"])
}

/// `ROLE_POLICY_DEFAULTS[role]`: a role, or an inherited `Object.prototype` member (`None`).
enum Base {
    Role(&'static str),
    Inherited,
}

fn base_of(role: &Value) -> Base {
    let key = text(role);
    match key.as_str() {
        "admin" => Base::Role("admin"),
        "senior_developer" => Base::Role("senior_developer"),
        k if OBJECT_PROTOTYPE.contains(&k) => Base::Inherited,
        _ => Base::Role("developer"),
    }
}

fn defaults(role: &str) -> Obj {
    let (pages, perms, features, caps): (Vec<&str>, Value, Value, [bool; 11]) = match role {
        "admin" => (vec!["*"], admin_permissions(), json!({}), [true; 11]),
        "senior_developer" => (
            [&["home"][..], &SENIOR_PAGES].concat(),
            role_permissions(&SENIOR_PAGES, &USER_EDITABLE),
            json!({}),
            [false, true, true, true, true, false, false, false, true, true, true],
        ),
        _ => (
            [&["home"][..], &DEVELOPER_PAGES].concat(),
            role_permissions(&DEVELOPER_PAGES, &DEVELOPER_PAGES),
            json!({ "agents": { "hideGlobalBehaviorUi": true } }),
            [false, false, true, false, false, false, false, false, true, true, true],
        ),
    };
    let mut out = Obj::from_iter([
        ("settingsPages".into(), json!(pages)),
        ("settingsPermissions".into(), perms),
        ("featureOverrides".into(), features),
    ]);
    out.extend(CAPABILITIES.iter().zip(caps).map(|(k, c)| (k.to_string(), c.into())));
    out
}

impl Base {
    fn get(&self, key: &str) -> Value {
        match self {
            Self::Role(r) => defaults(r).get(key).cloned().unwrap_or_else(undef),
            Self::Inherited => undef(),
        }
    }
    fn spread(&self) -> Obj {
        match self {
            Self::Role(r) => defaults(r),
            Self::Inherited => Obj::new(),
        }
    }
}

/// Port of `settingsPermissionsFromLegacyPages` (`policy.js:39`).
pub fn settings_permissions_from_legacy_pages(pages: Value, arg1: Value) -> Result<Value, String> {
    let editable = if js::is_undefined(&arg1) {
        undef()
    } else {
        prop(&arg1, "allReadablePagesEditable")?
    };
    let editable = if js::is_undefined(&editable) { Value::Bool(false) } else { editable };
    let readable = legacy_read_pages(&pages);
    let entry = |s: &&str| {
        let read = readable.contains(*s);
        let edit = if !read {
            Value::Bool(false)
        } else if truthy(&editable) {
            editable.clone()
        } else {
            USER_EDITABLE.contains(s).into()
        };
        (s.to_string(), permission(read.into(), edit))
    };
    Ok(Value::Object(SLUGS.iter().map(entry).collect()))
}

/// Port of `buildUserPolicyResetRow` (`policy.js:50`).
pub fn build_user_policy_reset_row(user_id: Value) -> Result<Value, String> {
    Ok(
        json!({ "user_id": user_id, "settings_pages": null, "settings_permission_overrides": {}, "capabilities": {}, "settings_overrides": {}, "feature_overrides": {} }),
    )
}

// ---------------------------------------------------------------------------------------------
// Feature overrides and settings permission payloads
// ---------------------------------------------------------------------------------------------

fn feature_overrides(value: &Value) -> Res<Obj> {
    let mut normalized = Obj::new();
    if !truthy(value) || !record(value) {
        return Ok(normalized);
    }
    let agents = prop(value, "agents")?;
    if truthy(&agents) && record(&agents) {
        let mut out = Obj::new();
        if prop(&agents, "hidePermissionsUi")? == Value::Bool(true) {
            out.insert("hidePermissionsUi".into(), true.into());
        }
        let global = prop(&agents, "hideGlobalBehaviorUi")?;
        if is_bool(&global) {
            out.insert("hideGlobalBehaviorUi".into(), global);
        }
        if !out.is_empty() {
            normalized.insert("agents".into(), Value::Object(out));
        }
    }
    let source = prop(value, "source")?;
    if truthy(&source) && record(&source) {
        let tab = prop(&source, "hideUpdateTab")?;
        if is_bool(&tab) {
            normalized.insert("source".into(), json!({ "hideUpdateTab": tab }));
        }
    }
    let mcp = prop(value, "mcp")?;
    if truthy(&mcp) && record(&mcp) {
        let mut servers = Obj::new();
        for (raw, state) in entries(&mcp).unwrap_or_default() {
            let name = String::from_utf16_lossy(trim(&raw.encode_utf16().collect::<Vec<_>>()));
            if !name.is_empty() && MCP_STATES.iter().any(|s| is(&state, s)) && name != PROTO {
                servers.insert(name, state);
            }
        }
        if !servers.is_empty() {
            normalized.insert("mcp".into(), ordered(servers));
        }
    }
    Ok(normalized)
}

fn invalid(error: String) -> Res<Value> {
    Ok(json!({ "valid": false, "error": error }))
}

/// Port of `validateFeatureOverridesPayload` (`policy.js:96`).
pub fn validate_feature_overrides_payload(value: Value) -> Result<Value, String> {
    if nullish(&value) {
        return Ok(json!({ "valid": true, "featureOverrides": {} }));
    }
    if !record(&value) {
        return invalid("Feature overrides must be an object".into());
    }
    let keys = entries(&value).unwrap_or_default();
    if let Some((key, _)) = keys.iter().find(|(k, _)| !["agents", "source", "mcp"].contains(&k.as_str())) {
        return invalid(format!("Unknown feature override section: {key}"));
    }
    for (section, allowed, label) in [
        ("agents", &["hidePermissionsUi", "hideGlobalBehaviorUi"][..], "Agent"),
        ("source", &["hideUpdateTab"][..], "Source"),
    ] {
        let v = prop(&value, section)?;
        if js::is_undefined(&v) {
            continue;
        }
        if !truthy(&v) || !record(&v) {
            return invalid(format!("{label} feature overrides must be an object"));
        }
        for (key, x) in entries(&v).unwrap_or_default() {
            if !allowed.contains(&key.as_str()) || !is_bool(&x) {
                let kind = if section == "agents" { "agent" } else { "Source" };
                return invalid(format!("Invalid {kind} feature override: {key}"));
            }
        }
    }
    let mcp = prop(&value, "mcp")?;
    if !js::is_undefined(&mcp) {
        if !truthy(&mcp) || !record(&mcp) {
            return invalid("MCP feature overrides must be an object".into());
        }
        for (name, state) in entries(&mcp).unwrap_or_default() {
            if trim(&name.encode_utf16().collect::<Vec<_>>()).is_empty() {
                return invalid("MCP server name is required".into());
            }
            if !is(&state, "inherit") && !MCP_STATES.iter().any(|s| is(&state, s)) {
                return invalid(format!("Invalid MCP override for {name}: expected inherit, on, or off"));
            }
        }
    }
    Ok(json!({ "valid": true, "featureOverrides": Value::Object(feature_overrides(&value)?) }))
}

/// Port of `validateSettingsPermissionsPayload` (`policy.js:285`).
pub fn validate_settings_permissions_payload(value: Value, arg1: Value) -> Result<Value, String> {
    let sparse = if js::is_undefined(&arg1) { false } else { truthy(&prop(&arg1, "sparse")?) };
    if !truthy(&value) || !record(&value) {
        return invalid("Settings permissions must be an object".into());
    }
    let mut normalized = Obj::new();
    for (raw, raw_permission) in entries(&value).unwrap_or_default() {
        let Some(slug) = slug_of(&Value::String(raw.clone())) else {
            return invalid(format!("Unknown settings page: {raw}"));
        };
        if !truthy(&raw_permission) || !record(&raw_permission) {
            return invalid(format!("Invalid settings permission for {slug}"));
        }
        let mut perm = Obj::new();
        for (key, x) in entries(&raw_permission).unwrap_or_default() {
            if !["read", "edit"].contains(&key.as_str()) || !is_bool(&x) {
                return invalid(format!("Invalid {key} permission for {slug}"));
            }
            perm.insert(key, x);
        }
        let (read, edit) = (perm.get("read").cloned(), perm.get("edit").cloned());
        if !sparse && (!read.as_ref().is_some_and(is_bool) || !edit.as_ref().is_some_and(is_bool)) {
            return invalid(format!("Read and edit permissions are required for {slug}"));
        }
        if edit == Some(Value::Bool(true)) && read == Some(Value::Bool(false)) {
            return invalid(format!("Edit permission requires read permission for {slug}"));
        }
        if !perm.is_empty() {
            normalized.insert(slug.into(), Value::Object(perm));
        }
    }
    if let Some(slug) = SLUGS.iter().find(|s| !sparse && !normalized.contains_key(**s)) {
        return invalid(format!("Missing settings permission for {slug}"));
    }
    Ok(json!({ "valid": true, "permissions": normalized }))
}

// ---------------------------------------------------------------------------------------------
// Role policy
// ---------------------------------------------------------------------------------------------

fn stored_role_permissions(role: &Value, base: &Base, row: &Value) -> Res<Value> {
    if is(role, "admin") {
        return Ok(admin_permissions());
    }
    if !truthy(row) || !has_own(row, "settings_permissions")? {
        return Ok(base.get("settingsPermissions"));
    }
    let raw = prop(row, "settings_permissions")?;
    let stored = if truthy(&raw) && is_object(&raw) { raw } else { json!({}) };
    let fallbacks = base.get("settingsPermissions");
    let mut out = Obj::new();
    for slug in SLUGS {
        let fallback = prop(&fallbacks, slug)?;
        let value = if has_own(&stored, slug)? {
            let v = prop(&stored, slug)?;
            if !truthy(&v) || !record(&v) {
                permission(false.into(), false.into())
            } else {
                let read = prop(&v, "read")? == Value::Bool(true);
                permission(read.into(), (read && prop(&v, "edit")? == Value::Bool(true)).into())
            }
        } else {
            Value::Object(spread(&fallback))
        };
        out.insert(slug.into(), value);
    }
    Ok(Value::Object(out))
}

fn permission_overrides(value: &Value) -> Res<Obj> {
    let mut normalized = Obj::new();
    if !truthy(value) || !record(value) {
        return Ok(normalized);
    }
    for (raw, raw_permission) in entries(value).unwrap_or_default() {
        let Some(slug) = slug_of(&Value::String(raw)) else { continue };
        if !truthy(&raw_permission) || !record(&raw_permission) {
            continue;
        }
        let mut perm = Obj::new();
        for key in ["read", "edit"] {
            let x = prop(&raw_permission, key)?;
            if is_bool(&x) {
                perm.insert(key.into(), x);
            }
        }
        if !perm.is_empty() {
            normalized.insert(slug.into(), Value::Object(perm));
        }
    }
    Ok(normalized)
}

fn legacy_user_overrides(pages: &Value) -> Obj {
    if !pages.is_array() {
        return Obj::new();
    }
    let readable = legacy_read_pages(pages);
    SLUGS
        .iter()
        .map(|s| {
            (
                s.to_string(),
                permission(readable.contains(s).into(), (readable.contains(s) && USER_EDITABLE.contains(s)).into()),
            )
        })
        .collect()
}

/// Port of `normalizeRolePolicy` (`policy.js:319`).
pub fn normalize_role_policy(role: Value, row: Value, user_policy: Value) -> Result<Value, String> {
    let row = if js::is_undefined(&row) { Value::Null } else { row };
    let user_policy = if js::is_undefined(&user_policy) { Value::Null } else { user_policy };
    let base = base_of(&role);
    let role_permissions = stored_role_permissions(&role, &base, &row)?;
    if is(&role, "admin") {
        let mut out = base.spread();
        out.extend([
            ("settingsPages".into(), json!(["*"])),
            ("settingsPermissions".into(), admin_permissions()),
            ("featureOverrides".into(), json!({})),
        ]);
        return Ok(Value::Object(out));
    }
    let mut next = if truthy(&row) {
        let browser = prop(&row, "can_use_browser")?;
        let mut o = Obj::from_iter([("settingsPermissions".into(), role_permissions.clone())]);
        for (key, column) in [("files", "can_use_files"), ("terminal", "can_use_terminal")] {
            o.insert(key.into(), prop(&row, column)?);
        }
        o.insert("browser".into(), if is_bool(&browser) { browser } else { base.get("browser") });
        o.insert("createWorktrees".into(), base.get("createWorktrees"));
        o.insert("createBranches".into(), base.get("createBranches"));
        for (key, column) in [
            ("manageProjects", "can_manage_projects"),
            ("manageUsers", "can_manage_users"),
            ("manageGlobalSettings", "can_manage_global_settings"),
            ("manageGit", "can_manage_git"),
            ("push", "can_push"),
            ("github", "can_use_github"),
        ] {
            o.insert(key.into(), prop(&row, column)?);
        }
        o
    } else {
        let mut o = base.spread();
        o.insert("settingsPermissions".into(), role_permissions.clone());
        o
    };
    let caps = opt(&user_policy, "capabilities");
    let overrides = if truthy(&caps) && is_object(&caps) { caps } else { json!({}) };
    let permission_overrides = if truthy(&user_policy) && has_own(&user_policy, "settings_permission_overrides")? {
        permission_overrides(&prop(&user_policy, "settings_permission_overrides")?)?
    } else {
        legacy_user_overrides(&opt(&user_policy, "settings_pages"))
    };
    let mut permissions = Obj::new();
    for slug in SLUGS {
        let inherited = prop(&role_permissions, slug)?;
        let o = permission_overrides.get(slug).filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!({}));
        let pick = |key: &str| -> Res<Value> {
            let x = prop(&o, key)?;
            if is_bool(&x) { Ok(x) } else { prop(&inherited, key) }
        };
        let (read, requested) = (pick("read")?, pick("edit")?);
        let edit = if truthy(&read) { requested } else { read.clone() };
        permissions.insert(slug.into(), permission(read, edit));
    }
    let pages: Vec<Value> = std::iter::once("home".into())
        .chain(SLUGS.iter().filter(|s| truthy(&permissions[**s]["read"])).map(|s| (*s).into()))
        .collect();
    next.insert("settingsPermissions".into(), Value::Object(permissions));
    next.insert("settingsPages".into(), Value::Array(pages));
    for key in CAPABILITIES {
        let v = prop(&overrides, key)?;
        if is_bool(&v) {
            next.insert(key.into(), v);
        }
    }
    let inherited = feature_overrides(&base.get("featureOverrides"))?;
    let user = feature_overrides(&opt(&user_policy, "feature_overrides"))?;
    let mut agents = inherited.get("agents").map(spread).unwrap_or_default();
    agents.extend(user.get("agents").map(spread).unwrap_or_default());
    let mut features = Obj::new();
    if !agents.is_empty() {
        features.insert("agents".into(), Value::Object(agents));
    }
    for key in ["source", "mcp"] {
        if let Some(v) = user.get(key) {
            features.insert(key.into(), v.clone());
        }
    }
    next.insert("featureOverrides".into(), Value::Object(features));
    Ok(Value::Object(next))
}

// ---------------------------------------------------------------------------------------------
// Settings page checks
// ---------------------------------------------------------------------------------------------

fn admin_principal(principal: &Value) -> bool {
    is(&opt(principal, "scope"), "local-admin") || is(&opt(principal, "role"), "admin")
}

fn page_permission(principal: &Value, slug: &str) -> Value {
    opt(&opt(&opt(principal, "policy"), "settingsPermissions"), slug)
}

fn can_read(principal: &Value, raw: &Value) -> Res<bool> {
    if is(raw, "home") || admin_principal(principal) {
        return Ok(true);
    }
    let Some(slug) = slug_of(raw) else { return Ok(false) };
    let permission = page_permission(principal, slug);
    if truthy(&permission) {
        let read = opt(&permission, "read");
        if is_bool(&read) {
            return Ok(read == Value::Bool(true));
        }
    }
    let pages = opt(&opt(principal, "policy"), "settingsPages");
    let pages = if truthy(&pages) { pages } else { json!([]) };
    // `pages.includes`: an array's element test, or a string's substring test.
    if let Some(u) = js::string_units(&pages) {
        let contains = |needle: &str| {
            let n = units(needle);
            u.windows(n.len()).any(|w| w == n.as_slice())
        };
        return Ok(contains("*") || contains(slug));
    }
    match pages {
        Value::Array(items) => Ok(items.iter().any(|p| is(p, "*")) || items.iter().any(|p| is(p, slug))),
        _ => Err("pages.includes is not a function".into()), // recorded-literal: V8 TypeError text
    }
}

fn can_edit(principal: &Value, raw: &Value) -> bool {
    if admin_principal(principal) {
        return true;
    }
    let Some(slug) = slug_of(raw) else { return false };
    let permission = page_permission(principal, slug);
    opt(&permission, "read") == Value::Bool(true) && opt(&permission, "edit") == Value::Bool(true)
}

/// Port of `canReadSettingsPage` (`policy.js:376`).
pub fn can_read_settings_page(principal: Value, raw_slug: Value) -> Result<Value, String> {
    Ok(can_read(&principal, &raw_slug)?.into())
}

/// Port of `canEditSettingsPage` (`policy.js:387`).
pub fn can_edit_settings_page(principal: Value, raw_slug: Value) -> Result<Value, String> {
    Ok(can_edit(&principal, &raw_slug).into())
}

/// Port of `canUseBrowser` (`policy.js:395`).
pub fn can_use_browser(principal: Value) -> Result<Value, String> {
    Ok((admin_principal(&principal) || opt(&opt(&principal, "policy"), "browser") == Value::Bool(true)).into())
}

#[rustfmt::skip]
/// `path` is `prefix` or continues it with `/`.
fn under(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn segment(s: &str) -> bool {
    !s.is_empty() && !s.contains('/')
}

#[rustfmt::skip]
/// `^\/provider\/[^/]+\/(?:auth|source|oauth|usage-auth|runtime-status|accounts)(?:\/|$)`.
fn provider_route(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/provider/") else { return false }; // recorded-literal: spelled in the source's route pattern
    let Some((id, tail)) = rest.split_once('/') else { return false };
    segment(id)
        && ["auth", "source", "oauth", "usage-auth", "runtime-status", "accounts"] // recorded-literal: spelled in the source's route pattern
            .iter()
            .any(|r| under(tail, r))
}

#[rustfmt::skip]
/// `^\/projects\/[^/]+\/(?:branch-target|scheduled-tasks(?:\/[^/]+)?(?:\/run)?)$`.
fn project_runtime(path: &str) -> bool {
    let Some((id, tail)) = path.strip_prefix("/projects/").and_then(|r| r.split_once('/')) else { // recorded-literal: spelled in the source's route pattern
        return false;
    };
    let tasks = tail
        .strip_prefix("scheduled-tasks") // recorded-literal: spelled in the source's route pattern
        .is_some_and(|t| t.is_empty() || t == "/run" || t.strip_prefix('/').is_some_and(|x| segment(x) || x.strip_suffix("/run").is_some_and(segment))); // recorded-literal: spelled in the source's route pattern
    segment(id) && (tail == "branch-target" || tasks) // recorded-literal: spelled in the source's route pattern
}

#[rustfmt::skip]
fn page_for(path: &str, get: bool) -> Option<&'static str> {
    let any = |prefixes: &[&str]| prefixes.iter().any(|p| under(path, p));
    if any(&["/config/settings/agent-defaults"]) { // recorded-literal: spelled in the source's route pattern
        return Some("agents"); // recorded-literal: spelled in the source's route pattern
    }
    if any(&["/config/settings/overrides"]) { // recorded-literal: spelled in the source's route pattern
        return Some("sessions"); // recorded-literal: spelled in the source's route pattern
    }
    if path == "/config/settings" { // recorded-literal: spelled in the source's route pattern
        return None;
    }
    if any(&["/bug-reports", "/error-logs"]) { // recorded-literal: spelled in the source's route pattern
        return Some("bug-reports"); // recorded-literal: spelled in the source's route pattern
    }
    if any(&["/admin"]) { // recorded-literal: spelled in the source's route pattern
        return Some("users"); // recorded-literal: spelled in the source's route pattern
    }
    if path == "/config/agents" && get { // recorded-literal: spelled in the source's route pattern
        return None;
    }
    let table: [(&[&str], &str); 5] = [
        (&["/behavior", "/config/agents", "/config/agent-overrides"], "agents"), // recorded-literal: spelled in the source's route pattern
        (&["/config/commands"], "commands"),                                     (&["/config/mcp", "/mcp"], "mcp"),                                       (&["/config/skills/catalog", "/config/skills/install", "/config/skills/scan"], "skills.catalog"), // recorded-literal: spelled in the source's route pattern
        (&["/config/skills"], "skills.installed"), // recorded-literal: spelled in the source's route pattern
    ];
    if let Some((_, page)) = table.iter().find(|(p, _)| any(p)) {
        return Some(page);
    }
    if any(&["/config/plugins"]) { // recorded-literal: spelled in the source's route pattern
        return Some("plugins"); // recorded-literal: spelled in the source's route pattern
    }
    if any(&["/magic-prompts"]) { // recorded-literal: spelled in the source's route pattern
        return (!get).then_some("magic-prompts"); // recorded-literal: spelled in the source's route pattern
    }
    if path == "/config/providers" && get { // recorded-literal: spelled in the source's route pattern
        return None;
    }
    let named_provider = path.strip_prefix("/provider/").is_some_and(|r| { // recorded-literal: spelled in the source's route pattern
        ["claude-agent/status", "claude-agent/connect", "cursor-acp/configure", "xai/oauth"] // recorded-literal: spelled in the source's route pattern
            .iter()
            .any(|x| under(r, x))
    });
    if path == "/config/providers" // recorded-literal: spelled in the source's route pattern
        || any(&["/auth", "/credential", "/quota/credentials"]) // recorded-literal: spelled in the source's route pattern
        || path == "/provider" // recorded-literal: spelled in the source's route pattern
        || path == "/provider/auth" // recorded-literal: spelled in the source's route pattern
        || provider_route(path)
        || named_provider
    {
        return Some("providers"); // recorded-literal: spelled in the source's route pattern
    }
    if any(&["/devryan/tunnel", "/openchamber/tunnel"]) { // recorded-literal: spelled in the source's route pattern
        return Some("tunnel"); // recorded-literal: spelled in the source's route pattern
    }
    let diagnostics = ["/diagnostics", "/diagnostics/status", "/diagnostics/export", "/diagnostics/sanitize"].contains(&path); // recorded-literal: spelled in the source's route pattern
    if diagnostics
        || any(&[
            "/opencode/update-check",      // recorded-literal: spelled in the source's route pattern
            "/devryan/update-check",       // recorded-literal: spelled in the source's route pattern
            "/devryan/update-install",     // recorded-literal: spelled in the source's route pattern
            "/openchamber/update-check",   // recorded-literal: spelled in the source's route pattern
            "/openchamber/update-install", // recorded-literal: spelled in the source's route pattern
        ])
    {
        return Some("about"); // recorded-literal: spelled in the source's route pattern
    }
    let icon = path.strip_prefix("/projects/").and_then(|r| r.strip_suffix("/icon")).is_some_and(segment); // recorded-literal: spelled in the source's route pattern
    if any(&["/projects"]) && !project_runtime(path) && !(get && icon) { // recorded-literal: spelled in the source's route pattern
        return Some("projects"); // recorded-literal: spelled in the source's route pattern
    }
    if [
        "/github/auth",          "/github/auth/start",    // recorded-literal: spelled in the source's route pattern
        "/github/auth/complete", // recorded-literal: spelled in the source's route pattern
        "/github/auth/activate", // recorded-literal: spelled in the source's route pattern
        "/github/auth/gh-cli",   // recorded-literal: spelled in the source's route pattern
    ]
    .contains(&path)
    {
        return Some("users"); // recorded-literal: spelled in the source's route pattern
    }
    if any(&[
        "/git/identities",           "/git/global-identity",      // recorded-literal: spelled in the source's route pattern
        "/git/discover-credentials", // recorded-literal: spelled in the source's route pattern
        "/git/set-identity",         "/git/commit-template",      // recorded-literal: spelled in the source's route pattern
    ]) {
        return Some("git"); // recorded-literal: spelled in the source's route pattern
    }
    match path {
        "/config/themes" => Some("appearance"), // recorded-literal: spelled in the source's route pattern
        "/config/opencode-resolution" | "/config/opencode-update-check" => Some("about"), // recorded-literal: spelled in the source's route pattern
        _ => None,
    }
}

/// Port of `settingsPageForRequest` (`policy.js:415`): the path's `String()` matched by hand.
pub fn settings_page_for_request(request_path: Value, method: Value) -> Result<Value, String> {
    let path = if truthy(&request_path) { to_string(&request_path) } else { Vec::new() };
    // A lone surrogate is never part of a matched route, so lossy text decides the same.
    let path = String::from_utf16_lossy(&path);
    let get = js::is_undefined(&method) || is(&method, "GET");
    Ok(page_for(&path, get).map_or(Value::Null, Value::from))
}

// ---------------------------------------------------------------------------------------------
// Effective settings
// ---------------------------------------------------------------------------------------------

/// `settingsFieldsForPermission`: `None` for full access.
fn fields_for(principal: &Value, edit: bool) -> Res<Option<Vec<&'static str>>> {
    if admin_principal(principal) {
        return Ok(None);
    }
    let mut fields: Vec<&'static str> = Vec::new();
    for slug in SLUGS {
        let allowed = if edit {
            can_edit(principal, &slug.into())
        } else {
            can_read(principal, &slug.into())?
        };
        if allowed {
            fields.extend(fields_by_page(slug).iter().filter(|f| !fields.contains(f)).collect::<Vec<_>>());
        }
    }
    Ok(Some(fields))
}

fn notification_templates(value: &Value, fallback: Option<&Value>) -> Value {
    const EVENTS: [&str; 6] = ["completion", "planReady", "error", "question", "permission", "subtask"];
    let template = |v: &Value| truthy(v) && record(v) && js::string_units(&opt(v, "title")).is_some() && js::string_units(&opt(v, "message")).is_some();
    let default = |event: &str| {
        let (title, message) = match event {
            "completion" => ("Session complete", "{session_name} is ready to review"),
            "planReady" => ("Plan ready", "A plan is ready for review"),
            "error" => ("Tool error", "{last_message}"),
            "question" => ("Input needed", "{last_message}"),
            "permission" => ("Permissions needed", "Folder access is required: {last_message}"),
            _ => ("{agent_name} is ready", "{model_name} completed the task"),
        };
        json!({ "title": title, "message": message })
    };
    let input = if truthy(value) && record(value) { value.clone() } else { json!({}) };
    let fallback = fallback.filter(|f| truthy(f) && record(f));
    let mut templates = Obj::new();
    for event in EVENTS {
        let entry = opt(&input, event);
        let inherited = fallback.map(|f| opt(f, event)).filter(template).unwrap_or_else(|| default(event));
        let legacy = event == "completion"
            && is(&opt(&entry, "title"), "{agent_name} is ready")
            && (is(&opt(&entry, "message"), "{model_name} completed the task") || is(&opt(&entry, "message"), "{last_message}"));
        templates.insert(event.into(), if template(&entry) && !legacy { entry } else { inherited });
    }
    Value::Object(templates)
}

/// `for (const entry of assignments || [])` then `.find`: only an array (or a falsy value) survives.
fn assignments(principal: &Value) -> Res<Vec<Value>> {
    let value = opt(principal, "assignments");
    match value {
        _ if !truthy(&value) => Ok(Vec::new()),
        Value::Array(items) => {
            items.iter().try_for_each(|e| prop(e, "projectId").map(drop))?;
            Ok(items)
        }
        _ => Err("assignments is not iterable".into()), // recorded-literal: V8 TypeError text
    }
}

/// SameValueZero between two values that crossed the bindings (objects are distinct).
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), _, _) => x == y || (x.is_nan() && y.is_nan()),
        (None, None, Some(x), Some(y)) => x == y,
        (None, None, None, None) => (js::is_undefined(a) && js::is_undefined(b)) || (!a.is_object() && !a.is_array() && a == b),
        _ => false,
    }
}

fn or_null(v: Value) -> Value {
    if nullish(&v) { Value::Null } else { v }
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

/// `Number(v)` for the branch sort.
fn number(v: &Value) -> f64 {
    match v {
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::Array(_) => string_number(&text(v)),
        _ if js::string_units(v).is_some() => string_number(&text(v)),
        _ => js::as_number(v).unwrap_or(f64::NAN),
    }
}

fn projects(list: &[Value]) -> Res<(Value, Value, Value)> {
    let mut groups: Vec<(Value, Value, Vec<Value>)> = Vec::new();
    for entry in list {
        let id = prop(entry, "projectId")?;
        let at = groups.iter().position(|(k, _, _)| same_value_zero(k, &id));
        let i = at.unwrap_or_else(|| {
            groups.push((id, entry.clone(), Vec::new()));
            groups.len() - 1
        });
        groups[i].2.push(entry.clone());
        if truthy(&prop(entry, "isDefault")?) && !truthy(&prop(&groups[i].1, "isDefault")?) {
            groups[i].1 = entry.clone();
        }
    }
    let mut out = Vec::new();
    for (_, rep, members) in groups {
        let mut sorted = members;
        js::sort(&mut sorted, |l, r| number(&opt(r, "isDefault")) - number(&opt(l, "isDefault")));
        let branches: Vec<Value> = sorted
            .iter()
            .map(|a| json!({ "name": opt(a, "branchName"), "directory": opt(a, "repositoryPath"), "isDefault": opt(a, "isDefault") == Value::Bool(true) }))
            .collect();
        out.push(json!({
            "id": opt(&rep, "projectId"), "label": opt(&rep, "label"), "path": opt(&rep, "repositoryPath"),
            "icon": or_null(opt(&rep, "icon")), "color": or_null(opt(&rep, "color")), "iconBackground": or_null(opt(&rep, "iconBackground")), "iconImage": or_null(opt(&rep, "iconImage")),
            "branches": branches,
        }));
    }
    let active = list
        .iter()
        .find(|e| truthy(&opt(e, "isDefault")))
        .or_else(|| list.first())
        .cloned()
        .unwrap_or_else(undef);
    let pick = |k: &str| {
        let v = opt(&active, k);
        if truthy(&v) { v } else { Value::Null }
    };
    Ok((Value::Array(out), pick("projectId"), pick("repositoryPath")))
}

fn sort_units(keys: &mut [String]) {
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// Port of `buildEffectiveSettings` (`policy.js:476`).
pub fn build_effective_settings(arg0: Value) -> Result<Value, String> {
    let principal = prop(&arg0, "principal")?;
    let host = prop(&arg0, "hostSettings")?;
    let user = prop(&arg0, "userOverrides")?;
    let user = if js::is_undefined(&user) { json!({}) } else { user };
    if is(&opt(&principal, "scope"), "local-admin") {
        return Ok(ordered(spread(&host)));
    }
    let allowed = fields_for(&principal, false)?;
    let mut effective = Obj::new();
    match &allowed {
        None => {
            effective.extend(spread(&host));
            effective.extend(spread(&user));
        }
        Some(keys) => {
            for key in keys {
                if has_own(&user, key)? {
                    effective.insert((*key).into(), prop(&user, key)?);
                } else if has_own(&host, key)? {
                    effective.insert((*key).into(), prop(&host, key)?);
                }
            }
        }
    }
    if allowed.as_ref().is_none_or(|k| k.contains(&"notificationTemplates")) {
        let host_templates = notification_templates(&prop(&host, "notificationTemplates")?, None);
        effective.insert(
            "notificationTemplates".into(),
            notification_templates(&prop(&user, "notificationTemplates")?, Some(&host_templates)),
        );
    }
    let list = assignments(&principal)?;
    let (projects, active_id, last_directory) = projects(&list)?;
    effective.insert("projects".into(), projects);
    effective.insert("activeProjectId".into(), active_id);
    effective.insert("lastDirectory".into(), last_directory);
    let policy = opt(&principal, "policy");
    let or_default = |v: Value, d: Value| if truthy(&v) { v } else { d };
    let features = opt(&policy, "featureOverrides");
    let flag = |section: &str, key: &str| opt(&opt(&features, section), key) == Value::Bool(true);
    let mut override_keys: Vec<String> = match &allowed {
        Some(keys) => keys.iter().map(|k| k.to_string()).collect(),
        None => entries(&user)
            .ok_or("Cannot convert undefined or null to object")?
            .into_iter()
            .map(|(k, _)| k)
            .collect(), // recorded-literal: V8 TypeError text
    };
    let mut kept = Vec::new();
    for key in override_keys.drain(..) {
        if has_own(&user, &key)? {
            kept.push(key);
        }
    }
    sort_units(&mut kept);
    let multi = json!({
        "enabled": true,
        "role": opt(&principal, "role"),
        "settingsPages": or_default(opt(&policy, "settingsPages"), json!([])),
        "settingsPermissions": or_default(opt(&policy, "settingsPermissions"), json!({})),
        "capabilities": Value::Object(CAPABILITIES.iter().map(|k| (k.to_string(), (opt(&policy, k) == Value::Bool(true)).into())).collect()),
        "features": {
            "agents": { "hidePermissionsUi": flag("agents", "hidePermissionsUi"), "hideGlobalBehaviorUi": flag("agents", "hideGlobalBehaviorUi") },
            "source": { "hideUpdateTab": flag("source", "hideUpdateTab") },
            "mcp": ordered(spread(&or_default(opt(&features, "mcp"), json!({})))),
        },
        "settingsOverrideKeys": kept,
    });
    effective.insert("multiUser".into(), multi);
    Ok(ordered(effective))
}

/// Port of `validateSettingsChanges` (`policy.js:542`).
pub fn validate_settings_changes(arg0: Value) -> Result<Value, String> {
    let (principal, changes, current) = (prop(&arg0, "principal")?, prop(&arg0, "changes")?, prop(&arg0, "currentEffective")?);
    let Some(allowed) = fields_for(&principal, true)? else {
        return Ok(json!({ "accepted": ordered(spread(&changes)), "rejected": [] }));
    };
    let mut accepted = Obj::new();
    let mut rejected = Vec::new();
    let changes = if truthy(&changes) { changes } else { json!({}) };
    for (key, value) in entries(&changes).unwrap_or_default() {
        if allowed.contains(&key.as_str()) && !["agentModelSelections", "defaultModel", "defaultVariant"].contains(&key.as_str()) {
            let value = if key == "notificationTemplates" {
                let current_templates = notification_templates(&opt(&current, "notificationTemplates"), None);
                notification_templates(&value, Some(&current_templates))
            } else {
                value
            };
            accepted.insert(key, value);
            continue;
        }
        if stringify(&value)? != stringify(&opt(&current, &key))? {
            rejected.push(Value::String(key));
        }
    }
    Ok(json!({ "accepted": ordered(accepted), "rejected": rejected }))
}

/// Port of `publicPrincipal` (`policy.js:560`): each assignment without its repository path,
/// worktree container path and remote URL.
pub fn public_principal(principal: Value) -> Result<Value, String> {
    if !truthy(&principal) {
        return Ok(Value::Null);
    }
    let list = opt(&principal, "assignments");
    let list = match list {
        _ if !truthy(&list) => Vec::new(),
        Value::Array(items) => items,
        _ => return Err("(principal.assignments || []).map is not a function".into()), // recorded-literal: V8 TypeError text
    };
    let mut assignments = Vec::new();
    for entry in &list {
        if nullish(entry) {
            return Err(type_error(entry, "repositoryPath"));
        }
        let mut rest = spread(entry);
        for key in ["repositoryPath", "worktreeContainerPath", "remoteUrl"] {
            rest.shift_remove(key);
        }
        assignments.push(ordered(rest));
    }
    let field = |k: &str| opt(&principal, k);
    Ok(json!({
        "id": field("id"), "email": field("email"), "displayName": field("displayName"), "role": field("role"), "scope": field("scope"),
        "policy": ordered(spread(&field("policy"))), "assignments": assignments,
    }))
}

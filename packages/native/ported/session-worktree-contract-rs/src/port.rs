//! The Rust port of `session-worktree-contract.ts`. Fields are copied as they are (`undefined`
//! included), `??` skips only `null` and `undefined`, and one quirk of the source is kept: in
//! `runtimeResolution.worktreeSource ?? metadata?.source === 'sdk' ? ... : ...` the `===` binds
//! first, so the test is the truthiness of `worktreeSource ?? (source === 'sdk')`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    })
}

/// `value[key]`, failing as V8 does on `null` and `undefined`.
fn get<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    if nullish(value) {
        let kind = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {kind} (reading '{key}')"));
    }
    Ok(value.get(key).filter(|v| !js::is_undefined(v)))
}

/// `value?.[key]`.
fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.filter(|v| !nullish(v)).and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

/// `a ?? b ?? ...`: the first value that is not `null` or `undefined`.
fn coalesce<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().flatten().find(|v| !nullish(v)).copied()
}

/// A member copied into a result: `undefined` when absent.
fn raw(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or_else(js::undefined)
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `normalizePath`: `value.replace(...)` fails on a truthy value that is not a string.
fn normalize_path(value: Option<&Value>) -> Result<String, String> {
    if !truthy(value) {
        return Ok(String::new());
    }
    let Some(text) = value.and_then(Value::as_str) else {
        return Err("value.replace is not a function".to_string()); // recorded-literal: the V8 TypeError text
    };
    let replaced = text.replace('\\', "/");
    if replaced == "/" {
        return Ok(replaced);
    }
    let trimmed = replaced.trim_end_matches('/');
    Ok(if trimmed.is_empty() { replaced.clone() } else { trimmed.to_string() })
}

fn within(candidate: Option<&Value>, root: Option<&Value>) -> Result<bool, String> {
    if !truthy(candidate) || !truthy(root) {
        return Ok(false);
    }
    let (c, r) = (normalize_path(candidate)?, normalize_path(root)?);
    Ok(c == r || c.starts_with(&format!("{r}/")))
}

/// Port of `isWithinWorktreeRoot` (`session-worktree-contract.ts:36`).
pub fn is_within_worktree_root(candidate: Option<String>, worktree_root: Option<String>) -> Result<bool, String> {
    within(candidate.map(Value::String).as_ref(), worktree_root.map(Value::String).as_ref())
}

/// Port of `getAttachedSessionDirectory` (`session-worktree-contract.ts:43`).
pub fn get_attached_session_directory(attachment: Option<Value>, fallback_directory: Option<String>) -> Result<Option<String>, String> {
    let attachment = attachment.filter(|a| truthy(Some(a)));
    let a = attachment.as_ref();
    let (cwd, root) = (opt(a, "cwd"), opt(a, "worktreeRoot"));
    if attachment.is_some() {
        for (ok, path) in [(!truthy(opt(a, "degraded")) && truthy(cwd), cwd), (truthy(root), root), (truthy(cwd), cwd)] {
            if ok {
                return normalize_path(path).map(Some);
            }
        }
    }
    let fallback = fallback_directory.map(Value::String);
    if truthy(fallback.as_ref()) {
        return normalize_path(fallback.as_ref()).map(Some);
    }
    Ok(None)
}

fn attachment(fields: [(&str, Value); 9]) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Map<_, _>>())
}

/// Port of `buildAttachmentFromCanonicalization` (`session-worktree-contract.ts:66`).
pub fn build_attachment_from_canonicalization(canonical: Value, options: Value) -> Result<Value, String> {
    let options = if js::is_undefined(&options) { json!({}) } else { options };
    let existing = get(&options, "existingAttachment")?.filter(|v| !v.is_null());
    let fallback = get(&options, "fallbackDirectory")?.filter(|v| !v.is_null());
    let degraded = get(&canonical, "degraded")?;
    let field = |key: &str| canonical.get(key).filter(|v| !js::is_undefined(v));
    let (root, cwd) = (field("worktreeRoot"), field("cwd"));
    let preferred = if truthy(degraded) {
        coalesce(&[root, cwd, fallback])
    } else {
        coalesce(&[cwd, root, fallback])
    };
    Ok(attachment([
        ("worktreeRoot", or_null(coalesce(&[root, fallback]))),
        ("cwd", or_null(preferred)),
        ("branch", or_null(coalesce(&[field("branch"), opt(existing, "branch")]))),
        ("headState", raw(field("headState"))),
        ("worktreeStatus", raw(field("worktreeStatus"))),
        (
            "worktreeSource",
            or_null(coalesce(&[options.get("worktreeSource"), opt(existing, "worktreeSource")])),
        ),
        ("legacy", raw(field("legacy"))),
        ("degraded", raw(degraded)),
        ("attentionReason", or_null(coalesce(&[field("attentionReason")]))),
    ]))
}

/// `a === b` (objects never the same here).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => match (js::as_number(x), js::as_number(y)) {
            (Some(m), Some(n)) => m == n,
            (None, None) => !matches!(x, Value::Object(_) | Value::Array(_)) && x == y,
            _ => false,
        },
        _ => false,
    }
}

/// Port of `resolveSessionWorktreeState` (`session-worktree-contract.ts:89`).
pub fn resolve_session_worktree_state(input: Value) -> Result<Value, String> {
    if nullish(&input) {
        let kind = if input.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'sessionDirectory' of 'input' as it is {kind}.")); // recorded-literal: the V8 TypeError text
    }
    let field = |key: &str| input.get(key).filter(|v| !js::is_undefined(v));
    let (directory, metadata, runtime) = (field("sessionDirectory"), field("metadata"), field("runtimeResolution"));
    let cwd_exists = field("cwdExists").is_none_or(|v| truthy(Some(v)));
    let sdk = Value::Bool(opt(metadata, "source").and_then(Value::as_str) == Some("sdk"));
    if truthy(runtime) {
        let r = |key: &str| opt(runtime, key);
        let source = coalesce(&[r("worktreeSource"), Some(&sdk)]);
        return Ok(attachment([
            ("worktreeRoot", or_null(coalesce(&[r("worktreeRoot"), opt(metadata, "path"), directory]))),
            ("cwd", or_null(coalesce(&[r("cwd"), directory, opt(metadata, "path")]))),
            ("branch", or_null(coalesce(&[r("branch"), opt(metadata, "branch")]))),
            ("headState", coalesce(&[r("headState")]).cloned().unwrap_or_else(|| json!("branch"))),
            ("worktreeStatus", coalesce(&[r("worktreeStatus")]).cloned().unwrap_or_else(|| json!("ready"))),
            ("worktreeSource", json!(if truthy(source) { "created-for-session" } else { "existing" })),
            ("legacy", json!(false)),
            ("degraded", raw(r("degraded"))),
            ("attentionReason", or_null(coalesce(&[r("attentionReason")]))),
        ]));
    }
    if !truthy(metadata) {
        let directory = or_null(coalesce(&[directory]));
        let status = if truthy(Some(&directory)) { "invalid" } else { "not-a-repo" };
        return Ok(attachment([
            ("worktreeRoot", directory.clone()),
            ("cwd", directory),
            ("branch", Value::Null),
            ("headState", json!("branch")),
            ("worktreeStatus", json!(status)),
            ("worktreeSource", Value::Null),
            ("legacy", json!(true)),
            ("degraded", json!(true)),
            ("attentionReason", Value::Null),
        ]));
    }
    let m = |key: &str| opt(metadata, key);
    let root = coalesce(&[m("worktreeRoot"), m("path")]).or(m("path"));
    let explicit = coalesce(&[directory]);
    let cwd = explicit.or(root);
    let valid = cwd_exists && (explicit.is_none() || same(cwd, root) || within(cwd, root)?);
    let head = coalesce(&[m("headState")])
        .cloned()
        .unwrap_or_else(|| json!(if truthy(m("branch")) { "branch" } else { "detached" }));
    Ok(attachment([
        ("worktreeRoot", raw(root)),
        ("cwd", raw(if valid { cwd } else { root })),
        ("branch", or_null(coalesce(&[m("branch")]))),
        ("headState", head),
        ("worktreeStatus", coalesce(&[m("worktreeStatus")]).cloned().unwrap_or_else(|| json!("ready"))),
        (
            "worktreeSource",
            json!(if sdk == Value::Bool(true) { "created-for-session" } else { "existing" }),
        ),
        ("legacy", json!(false)),
        ("degraded", json!(!valid)),
        ("attentionReason", Value::Null),
    ]))
}

/// JS `String(value)` for a template literal.
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(v) => js::as_number(v).map_or_else(
            || if v.is_boolean() { v.to_string() } else { "[object Object]".to_string() },
            js::number_to_string,
        ),
        None => "undefined".to_string(),
    }
}

/// Port of `formatSessionWorktreeBadge` (`session-worktree-contract.ts:146`).
pub fn format_session_worktree_badge(attachment: Value) -> Result<String, String> {
    let legacy = get(&attachment, "legacy")?;
    let field = |key: &str| attachment.get(key).filter(|v| !js::is_undefined(v));
    let is = |key: &str, expected: &str| field(key).and_then(Value::as_str) == Some(expected);
    Ok(match () {
        _ if truthy(legacy) => "Legacy session".to_string(),
        _ if is("worktreeStatus", "missing") => "Worktree missing".to_string(),
        _ if is("worktreeStatus", "not-a-repo") => "Not a repo".to_string(),
        _ if is("worktreeStatus", "invalid") || truthy(field("attentionReason")) => "Needs attention".to_string(),
        _ if is("headState", "detached") => "Detached HEAD".to_string(),
        _ if is("headState", "unborn") => "Unborn branch".to_string(),
        _ if truthy(field("branch")) => format!("Current branch: {}", text(field("branch"))),
        _ => "No branch".to_string(),
    })
}

/// Port of `getSessionWorktreeRepairActions` (`session-worktree-contract.ts:160`).
pub fn get_session_worktree_repair_actions(attachment: Value) -> Result<Vec<String>, String> {
    let status = get(&attachment, "worktreeStatus")?.and_then(Value::as_str);
    Ok(if matches!(status, Some("missing" | "invalid")) {
        vec!["open-without-worktree-features".to_string()]
    } else {
        Vec::new()
    })
}

/// Port of `getMutationBlockingReasons` (`session-worktree-contract.ts:175`).
pub fn get_mutation_blocking_reasons(attachment: Option<Value>, git_status: Option<Value>) -> Result<Vec<Value>, String> {
    let mut reasons = Vec::new();
    let status = git_status.as_ref().filter(|g| truthy(Some(g)));
    if opt(status, "isClean") == Some(&Value::Bool(false)) {
        let files = opt(status, "files");
        let dirty = match files {
            Some(Value::Array(items)) => Some(js::number(items.len() as f64)),
            Some(Value::String(text)) => Some(js::number(text.encode_utf16().count() as f64)),
            other => opt(other, "length").filter(|v| !v.is_null()).cloned(),
        };
        reasons.push(dirty.map_or_else(|| json!({ "reason": "dirty" }), |n| json!({ "reason": "dirty", "dirtyFiles": n })));
    }
    let Some(attachment) = attachment.filter(|a| truthy(Some(a))) else {
        return Ok(reasons);
    };
    let field = |key: &str| attachment.get(key).filter(|v| !js::is_undefined(v));
    for status in ["missing", "invalid"] {
        if field("worktreeStatus").and_then(Value::as_str) == Some(status) {
            reasons.push(json!({ "reason": status }));
        }
    }
    if let Some(reason) = field("attentionReason").filter(|r| truthy(Some(r))) {
        reasons.push(json!({ "reason": "attention", "attentionReason": reason }));
    }
    Ok(reasons)
}

/// `text.split('/').pop()` (a string).
fn last_segment(value: Option<&Value>, name: &str) -> Result<String, String> {
    match value {
        Some(Value::String(text)) => Ok(text.rsplit('/').next().unwrap_or("").to_string()),
        Some(v) if !nullish(v) => Err(format!("{name}.split is not a function")), // recorded-literal: the V8 TypeError text
        _ => Err(format!(
            "Cannot read properties of {} (reading 'split')",
            if value.is_some() { "null" } else { "undefined" }
        )),
    }
}

/// Port of `buildSessionTargetOptions` (`session-worktree-contract.ts:205`).
pub fn build_session_target_options(input: Value) -> Result<Vec<Value>, String> {
    let project_root = get(&input, "projectRoot")?;
    let field = |key: &str| input.get(key).filter(|v| !js::is_undefined(v));
    let mut options = Vec::new();
    if truthy(project_root) && field("includeRoot") != Some(&Value::Bool(false)) {
        let label = match field("rootBranch").filter(|b| truthy(Some(b))) {
            Some(branch) => branch.clone(),
            None => Some(last_segment(project_root, "input.projectRoot")?)
                .filter(|s| !s.is_empty())
                .map_or_else(|| raw(project_root), Value::String),
        };
        options.push(json!({ "value": raw(project_root), "label": label, "kind": "root" }));
    }
    let pending = field("pendingBootstrapDirectory");
    let pending = if truthy(pending) { Some(normalize_path(pending)?) } else { None };
    let worktrees = match field("worktrees") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|c| Value::String(c.to_string())).collect(),
        _ => return Err("input.worktrees is not iterable".to_string()), // recorded-literal: the V8 TypeError text
    };
    for wt in &worktrees {
        let path = normalize_path(get(wt, "path")?)?;
        if project_root.and_then(Value::as_str) == Some(path.as_str()) {
            continue;
        }
        let branch = match opt(Some(wt), "branch").filter(|b| !b.is_null()) {
            Some(Value::String(b)) => b.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string(),
            Some(_) => return Err("wt.branch?.trim is not a function".to_string()), // recorded-literal: the V8 TypeError text
            None => String::new(),
        };
        let label = if !branch.is_empty() {
            Value::String(branch)
        } else if let Some(label) = opt(Some(wt), "label").filter(|l| truthy(Some(l))) {
            label.clone()
        } else {
            Value::String(path.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(&path).to_string())
        };
        let is_pending = pending.as_deref() == Some(path.as_str());
        let pending_flag = if is_pending { json!(true) } else { js::undefined() };
        options.push(json!({ "value": path, "label": label, "kind": "worktree", "pending": pending_flag }));
    }
    Ok(options)
}

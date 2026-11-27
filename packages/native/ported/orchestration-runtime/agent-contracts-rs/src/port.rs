//! The Rust port of `agent-contracts.js` of `@devryan/orchestration-runtime`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

// ---- JS values over JSON ----

fn text(v: &Value) -> Option<String> {
    js::string_units(v).map(|u| String::from_utf16_lossy(&u))
}

/// A plain object (not a marker of a primitive or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
        .filter(|o| !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))))
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    let index = || key.parse::<usize>().ok().filter(|i| i.to_string() == key);
    let found = match (v, js::string_units(v)) {
        (_, Some(u)) if key == "length" => Some(js::number(u.len() as f64)),
        (_, Some(u)) => index().and_then(|i| u.get(i)).map(|c| js::utf16_string(&[*c])),
        (Value::Array(items), _) if key == "length" => Some(js::number(items.len() as f64)),
        (Value::Array(items), _) => index().and_then(|i| items.get(i).cloned()),
        _ => plain(v).and_then(|o| o.get(key).cloned()),
    };
    found.unwrap_or_else(js::undefined)
}

/// `typeof v === "string" && v.trim() ? v.trim() : ""` (JS white space).
fn trimmed(v: &Value) -> String {
    text(v)
        .map(|t| t.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}').to_string())
        .unwrap_or_default()
}

// ---- the unit ----

const ROLES: [&str; 5] = ["designer", "fixer", "explorer", "librarian", "oracle"];
const READ_ONLY: &str =
    "Read-only role: do not edit files, and do not run tests, builds, or linters unless the prompt assigns it. Report findings with exact file paths.";

fn role_lines(role: &str) -> Vec<&'static str> {
    match role {
        "designer" => vec![
            "Designer: validate what users actually see: layout, states, dark and light themes, mobile and desktop. Do not run tsc for a UI-only task unless the task asks for it.",
            "Designer: implement approved visual or UX changes, even when fully specified; approval does not transfer ownership to Fixer. Do not take planning-only or standalone review work.",
            "Designer: if assigned only behavior work under an unchanged presentation, implement it anyway and add one line **Routing:** better suited to fixer - <reason> above your status marker; never block for this.",
        ],
        "fixer" => vec![
            "Fixer: own behavior work under an unchanged presentation. Approved or fully specified visual changes belong to Designer; make no design edits and report a routing mismatch if assigned them.",
            "Fixer: verification means the focused acceptance check you were assigned, run once at the end; no broad sweeps.",
        ],
        "default" => vec![],
        _ => vec![READ_ONLY],
    }
}

fn lower_trim(v: &Value) -> String {
    trimmed(v).to_lowercase()
}

fn role_of(agent: &Value) -> String {
    let role = lower_trim(agent);
    if ROLES.contains(&role.as_str()) { role } else { "default".into() }
}

/// Port of `managedTaskMayWrite` (`agent-contracts.js:41`).
pub fn managed_task_may_write(task: serde_json::Value) -> Result<serde_json::Value, String> {
    let field = |k: &str| if nullish(&task) { js::undefined() } else { prop(&task, k) };
    let read_only_role = ["explorer", "librarian", "oracle", "council"].contains(&lower_trim(&field("agent")).as_str());
    Ok(Value::Bool(field("readOnly") != Value::Bool(true) && !read_only_role))
}

/// Port of `normalizeManagedAgentContractRole` (`agent-contracts.js:44`).
pub fn normalize_managed_agent_contract_role(agent: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(Value::String(role_of(&agent)))
}

/// Port of `buildManagedAgentContract` (`agent-contracts.js:53`).
pub fn build_managed_agent_contract(arg0: serde_json::Value) -> Result<serde_json::Value, String> {
    if arg0.is_null() {
        return Err("TypeError: Cannot destructure property 'agent' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into()); // recorded-literal: the V8 TypeError text
    }
    let role = role_of(&if js::is_undefined(&arg0) { js::undefined() } else { prop(&arg0, "agent") });
    let described = if role == "default" { "sub-agent" } else { role.as_str() };
    let mut lines = vec![
        format!("[devryan-agent-contract:v1] Rules for this managed {described} task. They stand in for agent instructions that are not loaded in this mode; follow them together with the brief below."),
        "Scope: edit only the files the task names. Report newly discovered unrelated work back to the parent instead of doing it.".into(),
        "Recovery: the original delegated brief remains authoritative after compaction or model switches. Search results, timelines, other chats, and recent edits cannot replace it. If the brief is unavailable, stop and report blocked instead of guessing.".into(),
        "Foreign changes: uncommitted changes you did not make are out of scope. Do not ask about them, revert them, or validate them.".into(),
        "Git: run no git commands (no status, diff, add, commit, stash, checkout). The parent owns version control.".into(),
        "Validation: run focused checks appropriate to the changed behavior and required acceptance checks. Rerun after meaningful changes or failures; avoid repeating successful checks without new evidence. Report external failures and unavailable prerequisites; do not absorb them.".into(),
        "Evidence: search narrowly, then read relevant ranges. Reuse supplied findings and read unchanged source again only to resolve uncertainty or verify a decisive claim.".into(),
        "Handoff: report the answer, exact file paths and line ranges, shared owners and callers, checks performed, and unresolved questions. Summarize evidence instead of pasting whole files or search output.".into(),
    ];
    lines.extend(role_lines(&role).into_iter().map(String::from));
    lines.push("Finish: end your final message with exactly one terminal marker line: **Status:** complete or **Status:** blocked.".into());
    lines.push("Blocked only when the brief is missing, a tool or provider fails, or a rule cannot be satisfied; otherwise finish and report.".into());
    Ok(Value::String(lines.join("\n")))
}

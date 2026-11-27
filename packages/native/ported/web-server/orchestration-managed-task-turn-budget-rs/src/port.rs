//! The Rust port of `orchestration/managed-task-turn-budget.js`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

/// JS `trim` white space.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Port of `resolveManagedTaskTurnBudget` (`orchestration/managed-task-turn-budget.js:9`):
/// designer 260, fixer 150, anyone else `null`.
pub fn resolve_managed_task_turn_budget(task: Value) -> Result<Value, String> {
    let agent = field(&task, "agent")
        .as_str()
        .map(|a| a.trim_matches(js_space).to_lowercase())
        .unwrap_or_default();
    Ok(match agent.as_str() {
        "designer" => Value::from(260),
        "fixer" => Value::from(150),
        _ => Value::Null,
    })
}

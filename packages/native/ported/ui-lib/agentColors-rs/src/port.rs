//! The Rust port of `agentColors.ts`. The name hash runs over UTF-16 code units in int32
//! arithmetic, as the JS does. The fixed-colour lookup is a plain object, so `constructor` and
//! `__proto__` find `Object.prototype` members (kept).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const AGENT_COLOR_PALETTE: [(&str, &str); 8] = [
    ("--status-success", "agent-success"),
    ("--syntax-keyword", "agent-keyword"),
    ("--syntax-type", "agent-type"),
    ("--syntax-function", "agent-function"),
    ("--syntax-number", "agent-number"),
    ("--status-info", "agent-info"),
    ("--status-warning", "agent-warning"),
    ("--syntax-variable", "agent-variable"),
];

const FIXED_AGENT_ICON_COLORS: [(&str, &str); 9] = [
    ("build", "--agent-icon-builder-color"),
    ("builder", "--agent-icon-builder-color"),
    ("council", "--agent-icon-council-color"),
    ("orchestrator", "--agent-icon-orchestrator-color"),
    ("designer", "--agent-icon-designer-color"),
    ("fixer", "--agent-icon-fixer-color"),
    ("explorer", "--agent-icon-explorer-color"),
    ("librarian", "--agent-icon-librarian-color"),
    ("oracle", "--agent-icon-oracle-color"),
];

/// JS `String.prototype.trim` white space and line terminators.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn palette(index: usize) -> Value {
    let (var, class) = AGENT_COLOR_PALETTE[index];
    json!({ "var": var, "class": class })
}

fn normalized(name: &str) -> String {
    name.trim_matches(js_space).to_lowercase()
}

/// Port of `getAgentColor` (`agentColors.ts:25`).
pub fn get_agent_color(agent_name: Option<String>) -> Result<Value, String> {
    let Some(name) = agent_name.filter(|n| !n.is_empty()) else {
        return Ok(palette(0));
    };
    let lower = normalized(&name);
    if lower == "build" || lower == "builder" {
        return Ok(palette(0));
    }
    let mut hash: i32 = 0;
    for unit in name.encode_utf16() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(i32::from(unit));
    }
    let index = 1 + (i64::from(hash).unsigned_abs() % (AGENT_COLOR_PALETTE.len() as u64 - 1)) as usize;
    Ok(palette(index))
}

/// Port of `getAgentIconColor` (`agentColors.ts:46`).
pub fn get_agent_icon_color(agent_name: Option<String>) -> Result<Value, String> {
    if let Some(name) = agent_name.as_deref() {
        let lower = normalized(name);
        if let Some((_, var)) = FIXED_AGENT_ICON_COLORS.iter().find(|(key, _)| *key == lower) {
            return Ok(json!({ "var": var }));
        }
        // The lookup reaches `Object.prototype`: of its keys only these two are lowercase.
        match lower.as_str() {
            "constructor" => return Ok(json!({ "$function": "Object" })), // recorded-literal: how the tool prints the `Object` function
            "__proto__" => return Ok(json!({})),
            _ => {}
        }
    }
    get_agent_color(agent_name)
}

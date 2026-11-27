//! The Rust port of `plans/`: `planSettlementWaitingText` (`planSettlement.ts`) and
//! `sanitizePlanPathSegment` (`sessionPlanFile.ts`). The draft factory, the async file and
//! persistence helpers stay in TS; `planSettlementWait` tests `instanceof Error` and was not
//! bridged. Quirk kept: the waiting-text table is a plain object, so an `Object.prototype` name
//! (`constructor`, `toString`, ...) returns that member instead of the neutral text.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

/// The function-valued members of `Object.prototype`.
const OBJECT_PROTOTYPE_METHODS: [(&str, &str); 11] = [
    ("constructor", "Object"),                        // recorded-literal: the Object constructor's name
    ("__defineGetter__", "__defineGetter__"),         // recorded-literal: an Object.prototype member name
    ("__defineSetter__", "__defineSetter__"),         // recorded-literal: an Object.prototype member name
    ("hasOwnProperty", "hasOwnProperty"),             // recorded-literal: an Object.prototype member name
    ("__lookupGetter__", "__lookupGetter__"),         // recorded-literal: an Object.prototype member name
    ("__lookupSetter__", "__lookupSetter__"),         // recorded-literal: an Object.prototype member name
    ("isPrototypeOf", "isPrototypeOf"),               // recorded-literal: an Object.prototype member name
    ("propertyIsEnumerable", "propertyIsEnumerable"), // recorded-literal: an Object.prototype member name
    ("toString", "toString"),                         // recorded-literal: an Object.prototype member name
    ("valueOf", "valueOf"),                           // recorded-literal: an Object.prototype member name
    ("toLocaleString", "toLocaleString"),             // recorded-literal: an Object.prototype member name
];

/// Port of `planSettlementWaitingText` (`plans/planSettlement.ts:30`).
pub fn plan_settlement_waiting_text(reason: Value) -> Result<Value, String> {
    let known = match reason.as_str() {
        Some("tasks_active" | "sessions_busy") => Some(Value::String("Waiting for subagents to finish\u{2026}".into())),
        Some("leases_active") => Some(Value::String("Waiting for running commands to finish\u{2026}".into())),
        Some("__proto__") => Some(json!({})),
        Some(name) => OBJECT_PROTOTYPE_METHODS
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, f)| json!({ "$function": f })),
        None => None,
    };
    Ok(known.unwrap_or_else(|| Value::String("Waiting for the run to settle\u{2026}".into())))
}

/// Port of `sanitizePlanPathSegment` (`plans/sessionPlanFile.ts:40`): every run of characters
/// outside `[A-Za-z0-9_]` becomes one `-`, trimmed of `-` at both ends.
pub fn sanitize_plan_path_segment(value: String) -> Result<String, String> {
    let mut out = String::with_capacity(value.len());
    for c in value
        .trim_matches(|c: char| {
            matches!(
                c,
                '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
                    | '\u{205f}' | '\u{3000}' | '\u{feff}'
            )
        })
        .chars()
    {
        let keep = c.is_ascii_alphanumeric() || c == '_';
        if keep {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    Ok(out.trim_matches('-').to_string())
}

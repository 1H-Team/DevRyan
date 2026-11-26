//! `packages/ui/src/lib/toolStatus.ts` (family `tool-status`).

use crate::js::{Js, Obj, Str, Value, get_opt, s, string};
use crate::plant;

pub const EXPORTS: &[&str] = &["getToolLifecycleState", "isFinalToolStatus", "normalizeToolStatus"];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let first = super::arg(args, 0);
    Some(Ok(match export {
        "normalizeToolStatus" => normalize_tool_status(&first).map_or(Value::Undefined, Value::String),
        "isFinalToolStatus" => Value::Bool(is_final_tool_status(&first)),
        "getToolLifecycleState" => Value::Object(get_tool_lifecycle_state(&first).to_object()),
        _ => return None,
    }))
}

const ACTIVE_TOOL_STATUSES: [&str; 6] = ["pending", "running", "started", "inprogress", "processing", "executing"];
const FINAL_TOOL_STATUSES: [&str; 10] = [
    "completed",
    "complete",
    "error",
    "failed",
    "aborted",
    "timeout",
    "timedout",
    "done",
    "cancelled",
    "canceled",
];

fn listed(list: &[&str], status: &[u16]) -> bool {
    list.iter().any(|item| item.encode_utf16().eq(status.iter().copied()))
}

fn is_active(status: &[u16]) -> bool {
    listed(&ACTIVE_TOOL_STATUSES, status) && !(plant::on("tool-status-pending-not-active") && listed(&["pending"], status))
}

fn is_final(status: &[u16]) -> bool {
    listed(&FINAL_TOOL_STATUSES, status) && !(plant::on("tool-status-canceled-not-final") && listed(&["canceled"], status))
}

/// `readTimestamp`: a finite number, else `undefined`.
fn read_timestamp(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) if number.is_finite() || plant::on("tool-status-infinite-timestamp") => Some(*number),
        _ => None,
    }
}

/// `normalizeToolStatus`: lower case, trimmed, with every run of white space, `_` and `-` removed.
pub fn normalize_tool_status(status: &Value) -> Option<Str> {
    let Value::String(text) = status else { return None };
    let lower = if plant::on("tool-status-no-lowercase") {
        text.to_vec()
    } else {
        string::to_lower_case(text)
    };
    let trimmed = string::trim(&lower);
    // .replace(/[\s_-]+/g, ''): JavaScript `\s` (no `u` flag) is WhiteSpace and LineTerminator.
    let removed = |unit: u16| {
        string::is_space(unit) && !(plant::on("rv-ts-no-line-separators") && (unit == 0x2028 || unit == 0x2029))
            || (unit == u16::from(b'_') && !plant::on("tool-status-underscore-kept"))
            || (unit == u16::from(b'-') && !plant::on("tool-status-hyphen-kept"))
    };
    let normalized: Vec<u16> = trimmed.iter().copied().filter(|unit| !removed(*unit)).collect();
    (!normalized.is_empty() || plant::on("tool-status-empty-kept")).then(|| normalized.into())
}

pub fn is_final_tool_status(status: &Value) -> bool {
    normalize_tool_status(status).is_some_and(|normalized| !normalized.is_empty() && is_final(&normalized))
}

/// What `getToolLifecycleState` returns.
pub struct ToolLifecycleState {
    pub status: Option<Str>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub has_started: bool,
    pub has_ended: bool,
    pub is_status_active: bool,
    pub is_status_final: bool,
    pub is_in_flight: bool,
    pub is_finalized: bool,
}

impl ToolLifecycleState {
    pub fn to_object(&self) -> Obj {
        let number = |value: Option<f64>| value.map_or(Value::Undefined, Value::Number);
        Obj::object_from(vec![
            (s("status"), self.status.clone().map_or(Value::Undefined, Value::String)),
            (s("start"), number(self.start)),
            (s("end"), number(self.end)),
            (s("hasStarted"), Value::Bool(self.has_started)),
            (s("hasEnded"), Value::Bool(self.has_ended)),
            (s("isStatusActive"), Value::Bool(self.is_status_active)),
            (s("isStatusFinal"), Value::Bool(self.is_status_final)),
            (s("isInFlight"), Value::Bool(self.is_in_flight)),
            (s("isFinalized"), Value::Bool(self.is_finalized)),
        ])
    }
}

pub fn get_tool_lifecycle_state(state: &Value) -> ToolLifecycleState {
    let status = normalize_tool_status(&get_opt(state, "status"));
    let time = get_opt(state, "time");
    let start = read_timestamp(&get_opt(&time, "start"));
    let raw_end = read_timestamp(&get_opt(&time, "end"));
    let has_invalid_time_range = match (start, raw_end) {
        (Some(start), Some(end)) => {
            if plant::on("tool-status-range-inclusive") {
                end <= start
            } else {
                end < start
            }
        }
        _ => false,
    };
    let has_ended = raw_end.is_some() && !has_invalid_time_range;
    let end = if has_ended { raw_end } else { None };
    // `status ? ... : ...`: an empty string is falsy (it never comes out of normalizeToolStatus).
    let truthy = status.as_ref().filter(|status| !status.is_empty());
    let is_status_active = truthy.is_some_and(|status| is_active(status));
    let is_status_final = truthy.is_some_and(|status| is_final(status));
    let is_unknown_non_final = truthy.is_none_or(|_| !is_status_active && !is_status_final);
    let is_in_flight = !has_ended && (is_status_active || (is_unknown_non_final && !plant::on("tool-status-unknown-not-in-flight")));
    let is_finalized = if plant::on("tool-status-finalized-ignores-range") {
        has_ended || is_status_final
    } else {
        !has_invalid_time_range && (has_ended || is_status_final)
    };
    ToolLifecycleState {
        status,
        start,
        end,
        has_started: start.is_some(),
        has_ended,
        is_status_active,
        is_status_final,
        is_in_flight,
        is_finalized,
    }
}

//! `packages/ui/src/sync/session-working.ts` (family `session-working`; inlined by `materialization`).

use crate::js::{Js, Value, get, get_opt, iterate, number, strict_equals, string, truthy};
use crate::plant;

use super::tool_status::get_tool_lifecycle_state;

pub const EXPORTS: &[&str] = &[
    "hasInFlightToolParts",
    "hasTerminalAssistantFinish",
    "hasToolCallAssistantFinish",
    "hasVisibleAssistantSummary",
    "isAssistantTurnComplete",
    "isFinalAssistantSummaryMessage",
    "isIncompleteAssistantMessage",
    "isLiveAssistantMessage",
    "isSessionWorkingFromState",
    "isTerminalAssistantMessage",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(
        match export {
            "hasTerminalAssistantFinish" => Ok(has_terminal_assistant_finish(&first)),
            "hasToolCallAssistantFinish" => Ok(has_tool_call_assistant_finish(&first)),
            "isTerminalAssistantMessage" => Ok(is_terminal_assistant_message(&first)),
            "isAssistantTurnComplete" => Ok(is_assistant_turn_complete(&first)),
            "isIncompleteAssistantMessage" => Ok(is_incomplete_assistant_message(&first)),
            "hasInFlightToolParts" => has_in_flight_tool_parts(&first),
            "hasVisibleAssistantSummary" => has_visible_assistant_summary(&first),
            "isFinalAssistantSummaryMessage" => is_final_assistant_summary_message(&first, &second),
            "isLiveAssistantMessage" => is_live_assistant_message(&first, &second),
            "isSessionWorkingFromState" => is_session_working_from_state(&first),
            _ => return None,
        }
        .map(Value::Bool),
    )
}

/// `!message || message.role !== "assistant"`.
fn not_assistant(message: &Value) -> bool {
    !truthy(message) || !get_opt(message, "role").is_str("assistant")
}

/// `text.trim().toLowerCase()`.
fn trimmed_lower(text: &[u16]) -> Vec<u16> {
    if plant::on("rv-sw-lower-then-trim") {
        return string::trim(&string::to_lower_case(text)).to_vec();
    }
    string::to_lower_case(if plant::on("session-working-no-trim") { text } else { string::trim(text) })
}

fn equals(units: &[u16], text: &str) -> bool {
    units.iter().copied().eq(text.encode_utf16())
}

pub fn has_terminal_assistant_finish(message: &Value) -> bool {
    if not_assistant(message) {
        return false;
    }
    let Value::String(finish) = get_opt(message, "finish") else { return false };
    let normalized = trimmed_lower(&finish);
    !normalized.is_empty() && (!equals(&normalized, "tool-calls") || plant::on("session-working-tool-calls-terminal"))
}

pub fn has_tool_call_assistant_finish(message: &Value) -> bool {
    if not_assistant(message) {
        return false;
    }
    matches!(get_opt(message, "finish"), Value::String(finish) if equals(&trimmed_lower(&finish), "tool-calls"))
}

pub fn is_terminal_assistant_message(message: &Value) -> bool {
    if not_assistant(message) {
        return false;
    }
    let completed = get_opt(&get_opt(message, "time"), "completed");
    let has_completed_timestamp =
        matches!(completed, Value::Number(number) if number.is_finite() && (number > 0.0 || plant::on("session-working-zero-completed")));
    has_completed_timestamp || has_terminal_assistant_finish(message)
}

pub fn is_assistant_turn_complete(message: &Value) -> bool {
    if not_assistant(message) {
        return false;
    }
    if matches!(get_opt(message, "streaming"), Value::Bool(true)) && !plant::on("session-working-streaming-ignored") {
        return false;
    }
    if let Value::String(status) = get_opt(message, "status") {
        let status = trimmed_lower(&status);
        if equals(&status, "running") || equals(&status, "pending") || equals(&status, "streaming") {
            return false;
        }
        if equals(&status, "complete") || equals(&status, "completed") || (equals(&status, "done") && !plant::on("session-working-done-not-complete")) {
            return true;
        }
    }
    is_terminal_assistant_message(message)
}

pub fn is_incomplete_assistant_message(message: &Value) -> bool {
    truthy(message) && get_opt(message, "role").is_str("assistant") && !is_assistant_turn_complete(message)
}

/// `parts ?? []`, as `for...of` walks it.
fn parts_of(parts: &Value) -> Js<Vec<Value>> {
    if parts.is_nullish() { Ok(Vec::new()) } else { iterate(parts, "parts ?? []") }
}

pub fn has_in_flight_tool_parts(parts: &Value) -> Js<bool> {
    for part in parts_of(parts)? {
        if !get(&part, "type", "part.type")?.is_str("tool") {
            continue;
        }
        let state = get(&part, "state", "part.state")?;
        let lifecycle = get_tool_lifecycle_state(&state);
        if if plant::on("session-working-in-flight-is-unfinalized") {
            !lifecycle.is_finalized
        } else {
            lifecycle.is_in_flight
        } {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn has_visible_assistant_summary(parts: &Value) -> Js<bool> {
    for part in parts_of(parts)? {
        let kind = get(&part, "type", "part.type")?;
        if !kind.is_str("text") && !kind.is_str("reasoning") {
            continue;
        }
        if let Value::String(text) = get(&part, "text", "part.text")?
            && !string::trim(&text).is_empty()
        {
            return Ok(true);
        }
        if plant::on("session-working-output-ignored") {
            continue;
        }
        if let Value::String(output) = get(&part, "output", "part.output")?
            && !string::trim(&output).is_empty()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn is_final_assistant_summary_message(message: &Value, parts: &Value) -> Js<bool> {
    if !is_assistant_turn_complete(message) {
        return Ok(false);
    }
    if has_tool_call_assistant_finish(message) {
        return Ok(false);
    }
    if has_in_flight_tool_parts(parts)? {
        return Ok(false);
    }
    has_visible_assistant_summary(parts)
}

pub fn is_live_assistant_message(message: &Value, parts: &Value) -> Js<bool> {
    if not_assistant(message) {
        return Ok(false);
    }
    if is_incomplete_assistant_message(message) {
        return Ok(true);
    }
    Ok(has_tool_call_assistant_finish(message) && has_in_flight_tool_parts(parts)?)
}

pub fn is_session_working_from_state(input: &Value) -> Js<bool> {
    let status = get(input, "status", "{ status, permissions, messages, liveStreamingMessageId, liveParts }")?;
    let permissions = get_opt(input, "permissions");
    let messages = get_opt(input, "messages");
    let live_streaming_message_id = get_opt(input, "liveStreamingMessageId");
    let live_parts = get_opt(input, "liveParts");
    if crate::js::to_number(&get(&permissions, "length", "permissions.length")?) > 0.0 {
        return Ok(false);
    }
    let has_authoritative_status = !matches!(status, Value::Undefined);
    let status_working = has_authoritative_status && !get(&status, "type", "status.type")?.is_str("idle");
    let length = crate::js::to_number(&get(&messages, "length", "messages.length")?);
    let last_message = crate::js::get_key_opt(&messages, &number::to_string(length - 1.0).encode_utf16().collect::<Vec<u16>>());
    let parts_belong_to_last = !truthy(&live_streaming_message_id) || strict_equals(&get_opt(&last_message, "id"), &live_streaming_message_id);
    let tracked_live_streaming = truthy(&live_streaming_message_id) && {
        let mut found = false;
        // `for (let index = messages.length - 1; index >= 0; index -= 1) messages[index]`: any value with a length.
        let mut index = length - 1.0;
        while index >= 0.0 {
            let message = crate::js::get_key(&messages, &number::to_string(index).encode_utf16().collect::<Vec<u16>>(), "messages[index]")?;
            index -= 1.0;
            if get(&message, "role", "message.role")?.is_str("user") && !plant::on("session-working-scan-past-user") {
                break;
            }
            if !strict_equals(&get(&message, "id", "message.id")?, &live_streaming_message_id) {
                continue;
            }
            found = is_live_assistant_message(&message, &live_parts)?;
            break;
        }
        found
    };
    if has_authoritative_status && !plant::on("session-working-status-not-authoritative") {
        return Ok(status_working);
    }
    let parts = if parts_belong_to_last || plant::on("session-working-parts-always-last") {
        live_parts
    } else {
        Value::Undefined
    };
    Ok(tracked_live_streaming || is_live_assistant_message(&last_message, &parts)?)
}

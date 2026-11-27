//! `packages/ui/src/sync/materialization.ts` (family `materialization`; inlined: toolStatus, nativeCursorText,
//! revert-transactions, session-working, tool-output, message-order, sessionDiffStats).

use crate::js::{
    Js, JsMap, Kind, Obj, Value, delete, error, get, get_key_opt, get_opt, json_stringify, s, same_value_zero, set, sort_by, spread, strict_equals, to_number,
    to_string, truthy,
};
use crate::plant;

use super::message_order::{
    array_items, compare_messages_chronologically, find_message_index, messages_before, messages_from, present_items, sort_messages_chronologically,
};
use super::native_cursor_text::has_native_cursor_text_provenance;
use super::revert_transactions::{filter_messages_for_revert, get_effective_session_revert_message_id};
use super::session_diff_stats::strip_untrusted_session_diff_summary;
use super::session_working::is_assistant_turn_complete;
use super::tool_output::keep_full_tool_output;
use super::tool_status::get_tool_lifecycle_state;

pub const EXPORTS: &[&str] = &["getSessionMaterializationStatus", "materializeSessionSnapshots"];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second, third, fourth) = (super::arg(args, 0), super::arg(args, 1), super::arg(args, 2), super::arg(args, 3));
    Some(match export {
        "materializeSessionSnapshots" => materialize_session_snapshots(&first, &second, &third, &fourth),
        "getSessionMaterializationStatus" => get_session_materialization_status(&first, &second),
        _ => return None,
    })
}

const STREAMING_PART_FIELDS: [&str; 2] = ["text", "output"];

/// `set.has(value)` for the `skipPartTypes` Set.
fn set_has(set: &Value, value: &Value) -> Js<bool> {
    match set.as_object().map(|object| object.borrow()) {
        Some(data) => match &data.kind {
            Kind::Set(values) => Ok(values.iter().any(|item| same_value_zero(item, value))),
            _ => Err(error(
                "TypeError",
                "client-engine: skipPartTypes.has of a value that is no Set is not reproduced",
            )),
        },
        None => Err(error(
            "TypeError",
            "client-engine: skipPartTypes.has of a value that is no Set is not reproduced",
        )),
    }
}

/// `value.length` as a number.
fn length(value: &Value, expression: &str) -> Js<f64> {
    Ok(to_number(&get(value, "length", expression)?))
}

fn filter_renderable_parts(parts: &Value, skip_part_types: &Value) -> Js<Obj> {
    let mut kept = Vec::new();
    for part in present_items(parts, "parts.filter")? {
        if !truthy(&get_opt(&part, "id")) {
            continue;
        }
        if set_has(skip_part_types, &get(&part, "type", "part.type")?)? && !plant::on("materialization-skip-types-ignored") {
            continue;
        }
        kept.push(part);
    }
    Ok(Obj::array(kept))
}

fn have_equivalent_part_snapshots(left: &Value, right: &Value) -> Js<bool> {
    if !truthy(left) {
        return Ok(length(right, "right.length")? == 0.0);
    }
    if length(left, "left.length")? != length(right, "right.length")? {
        return Ok(false);
    }
    let (left, right) = (array_items(left, "left[index]")?, array_items(right, "right[index]")?);
    for (left_part, right_part) in left.iter().zip(&right) {
        if !truthy(left_part) || !truthy(right_part) {
            return Ok(false);
        }
        if !strict_equals(&get(left_part, "id", "leftPart.id")?, &get(right_part, "id", "rightPart.id")?) {
            return Ok(false);
        }
        if !plant::on("materialization-part-content-ignored") && json_stringify(left_part)? != json_stringify(right_part)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn merge_materialized_message(existing: &Value, next: &Value) -> Js {
    let assistant = |message: &Value| -> Js<bool> { Ok(get(message, "role", "existing.role")?.is_str("assistant")) };
    if assistant(existing)?
        && assistant(next)?
        && is_assistant_turn_complete(existing)
        && !is_assistant_turn_complete(next)
        && !plant::on("materialization-incomplete-replaces-complete")
    {
        return Ok(existing.clone());
    }
    Ok(next.clone())
}

fn merge_materialized_messages(existing: &Value, next_messages: &Value) -> Js {
    if length(existing, "existing.length")? == 0.0 && !(plant::on("rv-mat-len-strict") && !existing.as_object().is_some_and(crate::js::Obj::is_array)) {
        return Ok(Value::Object(Obj::array(array_items(next_messages, "[...nextMessages]")?)));
    }
    if length(next_messages, "nextMessages.length")? == 0.0 {
        return Ok(existing.clone());
    }
    let mut merged = super::message_order::map_by_id(existing, "existing.map", "item.id")?;
    let mut changed = false;
    for next_message in crate::js::iterate(next_messages, "nextMessages")? {
        let id = get(&next_message, "id", "nextMessage.id")?;
        let Some(current) = merged.get(&id).cloned() else {
            merged.set(id, next_message);
            changed = true;
            continue;
        };
        let merged_message = merge_materialized_message(&current, &next_message)?;
        if strict_equals(&merged_message, &current)
            || (!plant::on("rv-mat-message-json-ignored") && json_stringify(&current)? == json_stringify(&merged_message)?)
        {
            continue;
        }
        merged.set(get(&next_message, "id", "nextMessage.id")?, merged_message);
        changed = true;
    }
    if !changed && !plant::on("materialization-unchanged-messages-copied") {
        return Ok(existing.clone());
    }
    Ok(Value::Object(sort_messages_chronologically(&Value::Object(Obj::array(merged.values())))?))
}

fn part_end_time(part: &Value) -> Js<Option<f64>> {
    let state_end = get_opt(&get_opt(&get(part, "state", "part.state")?, "time"), "end");
    if let Value::Number(end) = state_end {
        return Ok(Some(end));
    }
    if plant::on("materialization-part-time-ignored") {
        return Ok(None);
    }
    Ok(get_opt(&get(part, "time", "part.time")?, "end").as_number())
}

fn string_field(part: &Value, field: &str) -> Js<Option<crate::js::Str>> {
    Ok(match get(part, field, "part[field]")? {
        Value::String(text) => Some(text),
        _ => None,
    })
}

fn has_live_streaming_field(part: &Value) -> Js<bool> {
    if part_end_time(part)?.is_some() {
        return Ok(false);
    }
    for field in STREAMING_PART_FIELDS {
        if string_field(part, field)?.is_some_and(|value| !value.is_empty()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn merge_materialized_part(existing: &Value, next: &Value) -> Js {
    let kept = keep_full_tool_output(existing, next)?;
    if !strict_equals(&kept, next) {
        return Ok(kept);
    }
    if has_native_cursor_text_provenance(next)? {
        return Ok(next.clone());
    }
    if !truthy(existing) || part_end_time(next)?.is_some() {
        return Ok(next.clone());
    }
    if get(existing, "type", "existing.type")?.is_str("tool") && get(next, "type", "next.type")?.is_str("tool") {
        let existing_state = get(existing, "state", "existing.state")?;
        let next_state = get(next, "state", "next.state")?;
        if get_tool_lifecycle_state(&existing_state).is_finalized
            && get_tool_lifecycle_state(&next_state).is_in_flight
            && !plant::on("materialization-finalized-tool-replaced")
        {
            return Ok(existing.clone());
        }
    }
    let mut merged = next.clone();
    for field in STREAMING_PART_FIELDS {
        let Some(existing_value) = string_field(existing, field)? else { continue };
        if existing_value.is_empty() {
            continue;
        }
        let next_value = string_field(next, field)?;
        if next_value.as_ref().is_some_and(|value| value.len() >= existing_value.len()) {
            continue;
        }
        if let Some(value) = &next_value
            && !value.is_empty()
            && !existing_value.starts_with(value)
            && !plant::on("materialization-diverging-text-kept")
        {
            continue;
        }
        if strict_equals(&merged, next) {
            merged = Value::Object(spread(next));
        }
        if let Value::Object(object) = &merged {
            set(object, s(field), Value::String(existing_value));
        }
    }
    Ok(merged)
}

fn merge_materialized_parts(existing: &Value, next_parts: &Obj, skip_part_types: &Value, preserve_live_streaming_parts: bool) -> Js {
    if !truthy(existing) || length(existing, "existing.length")? == 0.0 {
        return Ok(Value::Object(next_parts.clone()));
    }
    if !preserve_live_streaming_parts {
        return Ok(Value::Object(next_parts.clone()));
    }
    let existing_by_id = super::message_order::map_by_id(existing, "existing.map", "part.id")?;
    let parts = next_parts.elements().transpose()?.unwrap_or_default();
    let mut merged_parts: Option<Vec<Value>> = None;
    for (index, next_part) in parts.iter().enumerate() {
        let known = existing_by_id.get(&get(next_part, "id", "nextPart.id")?).cloned().unwrap_or(Value::Undefined);
        let merged_part = merge_materialized_part(&known, next_part)?;
        if strict_equals(&merged_part, next_part) {
            continue;
        }
        merged_parts.get_or_insert_with(|| parts.clone())[index] = merged_part;
    }
    let mut snapshot_ids = JsMap::default();
    for part in &parts {
        snapshot_ids.set(get(part, "id", "part.id")?, Value::Undefined);
    }
    let mut missing_live_parts = Vec::new();
    for part in present_items(existing, "existing.filter")? {
        let id = get_opt(&part, "id");
        if !truthy(&id) || snapshot_ids.has(&id) || set_has(skip_part_types, &get(&part, "type", "part.type")?)? || has_native_cursor_text_provenance(&part)? {
            continue;
        }
        if has_live_streaming_field(&part)? && !plant::on("materialization-missing-live-parts-dropped") {
            missing_live_parts.push(part);
        }
    }
    let merged = merged_parts.map_or(Value::Object(next_parts.clone()), |list| Value::Object(Obj::array(list)));
    if missing_live_parts.is_empty() {
        return Ok(merged);
    }
    let mut all = array_items(&merged, "[...mergedParts]")?;
    all.extend(missing_live_parts);
    Ok(Value::Object(Obj::array(all)))
}

fn records_in_order(records: &Value) -> Js<Vec<Value>> {
    let mut ordered = Vec::new();
    for record in present_items(records, "records.filter")? {
        if truthy(&get_opt(&get_opt(&record, "info"), "id")) {
            ordered.push(record);
        }
    }
    sort_by(&mut ordered, &mut |left, right| {
        compare_messages_chronologically(&get(left, "info", "left.info")?, &get(right, "info", "right.info")?)
    })?;
    Ok(ordered)
}

/// `state.message[sessionID] ?? []`.
fn session_messages(state: &Value, session_id: &Value) -> Js {
    let messages = get(state, "message", "state.message")?;
    if messages.is_nullish() {
        return Err(crate::js::not_an_object(&messages, "state.message[sessionID]"));
    }
    let found = get_key_opt(&messages, &to_string(session_id)?);
    Ok(if found.is_nullish() { Value::Object(Obj::array(Vec::new())) } else { found })
}

pub fn materialize_session_snapshots(state: &Value, session_id: &Value, records: &Value, options: &Value) -> Js {
    let options = if matches!(options, Value::Undefined) {
        Value::Object(Obj::object())
    } else {
        options.clone()
    };
    let given_skip = get(&options, "skipPartTypes", "options.skipPartTypes")?;
    let skip_part_types = if given_skip.is_nullish() {
        Value::Object(Obj::new(Kind::Set(Vec::new()), crate::js::Props::default()))
    } else {
        given_skip
    };
    let given_revert = get(&options, "revertMessageID", "options.revertMessageID")?;
    let revert_message_id = if given_revert.is_nullish() {
        get_effective_session_revert_message_id(state, session_id, &Value::Undefined)?
    } else {
        given_revert
    };
    let ordered_snapshots = records_in_order(records)?;
    let mut ordered = Vec::with_capacity(ordered_snapshots.len());
    for record in &ordered_snapshots {
        ordered.push(get(record, "info", "record.info")?);
    }
    let ordered_messages = Value::Object(Obj::array(ordered));
    let visible_messages = if truthy(&revert_message_id) {
        messages_before(&ordered_messages, &revert_message_id)?
    } else {
        ordered_messages.clone()
    };
    let mut visible_ids = JsMap::default();
    for message in present_items(&visible_messages, "visibleMessages.map")? {
        visible_ids.set(get(&message, "id", "message.id")?, Value::Undefined);
    }
    let snapshots = if strict_equals(&visible_messages, &ordered_messages) {
        ordered_snapshots
    } else {
        let mut kept = Vec::new();
        for record in ordered_snapshots {
            if visible_ids.has(&get(&get(&record, "info", "record.info")?, "id", "record.info.id")?) {
                kept.push(record);
            }
        }
        kept
    };
    let mut next = Vec::with_capacity(snapshots.len());
    for record in &snapshots {
        next.push(get(record, "info", "record.info")?);
    }
    let next_messages = Value::Object(Obj::array(next));
    let raw_current_messages = session_messages(state, session_id)?;
    let current_messages = filter_messages_for_revert(&raw_current_messages, &revert_message_id)?;
    let messages = merge_materialized_messages(&current_messages, &next_messages)?;
    let messages_changed = !strict_equals(&messages, &raw_current_messages);
    let mut sessions_changed = false;
    let state_sessions = get(state, "session", "state.session")?;
    let mut next_sessions = state_sessions.clone();
    if truthy(&state_sessions) {
        let index = find_index_by_id(&state_sessions, session_id)?;
        if index >= 0 {
            let mut list = array_items(&state_sessions, "state.session[sessionIndex]")?;
            let current_session = list[index as usize].clone();
            let next_session = strip_untrusted_session_diff_summary(&current_session)?;
            if !strict_equals(&next_session, &current_session) && !plant::on("materialization-session-summary-kept") {
                list[index as usize] = next_session;
                next_sessions = Value::Object(Obj::array(list));
                sessions_changed = true;
            }
        }
    }
    let mut parts_changed = false;
    let next_part_state = spread(&get(state, "part", "state.part")?);
    let is_prepend = get(&options, "mode", "options.mode")?.is_str("prepend");
    if truthy(&revert_message_id) {
        for message in array_items(&messages_from(&raw_current_messages, &revert_message_id)?, "messagesFrom")? {
            let key = to_string(&get(&message, "id", "message.id")?)?;
            if !next_part_state.borrow().props.has(&key) {
                continue;
            }
            delete(&next_part_state, &key);
            parts_changed = true;
        }
    }
    for record in &snapshots {
        let info = get(record, "info", "record.info")?;
        let message_id = get(&info, "id", "record.info.id")?;
        let key = to_string(&message_id)?;
        if is_prepend && truthy(&get_key_opt(&Value::Object(next_part_state.clone()), &key)) {
            continue;
        }
        let record_parts = get(record, "parts", "record.parts")?;
        let parts_is_array = record_parts.as_object().is_some_and(Obj::is_array);
        let user = get(&info, "role", "record.info.role")?.is_str("user");
        if user && !parts_is_array && !plant::on("materialization-user-envelope-materialized") {
            continue;
        }
        let existing = get_key_opt(&Value::Object(next_part_state.clone()), &key);
        if !existing.is_nullish() && any_native_cursor_part(&existing)? && !is_assistant_turn_complete(&get(record, "info", "record.info")?) {
            let previous_index = find_message_index(&current_messages, &message_id)?;
            if previous_index >= 0 && is_assistant_turn_complete(&array_items(&current_messages, "currentMessages[previousIndex]")?[previous_index as usize]) {
                continue;
            }
        }
        let renderable = filter_renderable_parts(
            &if record_parts.is_nullish() {
                Value::Object(Obj::array(Vec::new()))
            } else {
                record_parts.clone()
            },
            &skip_part_types,
        )?;
        let assistant = get(&info, "role", "record.info.role")?.is_str("assistant");
        let next_parts = merge_materialized_parts(&existing, &renderable, &skip_part_types, assistant)?;
        let next_length = length(&next_parts, "nextParts.length")?;
        let known_empty_user_parts = user && parts_is_array && matches!(existing, Value::Undefined) && next_length == 0.0;
        if have_equivalent_part_snapshots(&existing, &next_parts)? && !known_empty_user_parts {
            continue;
        }
        if next_length == 0.0 && !user {
            delete(&next_part_state, &key);
        } else {
            set(&next_part_state, key, next_parts);
        }
        parts_changed = true;
    }
    let message_member = if messages_changed {
        let copy = spread(&get(state, "message", "state.message")?);
        set(&copy, to_string(session_id)?, messages.clone());
        Value::Object(copy)
    } else {
        get(state, "message", "state.message")?
    };
    Ok(Value::Object(Obj::object_from(vec![
        (
            s("session"),
            if sessions_changed {
                next_sessions
            } else {
                get(state, "session", "state.session")?
            },
        ),
        (s("message"), message_member),
        (
            s("part"),
            if parts_changed {
                Value::Object(next_part_state)
            } else {
                get(state, "part", "state.part")?
            },
        ),
        (s("messages"), messages),
        (s("sessionsChanged"), Value::Bool(sessions_changed)),
        (s("messagesChanged"), Value::Bool(messages_changed)),
        (s("partsChanged"), Value::Bool(parts_changed)),
    ])))
}

/// `existing?.some(hasNativeCursorTextProvenance)` (holes skipped).
fn any_native_cursor_part(existing: &Value) -> Js<bool> {
    for part in present_items(existing, "existing.some")? {
        if has_native_cursor_text_provenance(&part)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `state.session.findIndex((session) => session.id === sessionID)`.
fn find_index_by_id(sessions: &Value, session_id: &Value) -> Js<i64> {
    for (index, session) in array_items(sessions, "state.session.findIndex")?.iter().enumerate() {
        if strict_equals(&get(session, "id", "session.id")?, session_id) {
            return Ok(index as i64);
        }
    }
    Ok(-1)
}

pub fn get_session_materialization_status(state: &Value, session_id: &Value) -> Js {
    let raw = session_messages(state, session_id)?;
    let revert = get_effective_session_revert_message_id(state, session_id, &Value::Undefined)?;
    let messages = filter_messages_for_revert(&raw, &revert)?;
    let holder = get(state, "message", "state.message")?;
    let own = holder
        .as_object()
        .is_some_and(|object| object.borrow().props.has(&to_string(session_id).unwrap_or_else(|_| s(""))));
    if !own && !plant::on("materialization-status-without-own-key") {
        return Ok(Value::Object(Obj::object_from(vec![
            (s("hasMessages"), Value::Bool(false)),
            (s("renderable"), Value::Bool(false)),
            (s("missingPartMessageIDs"), Value::Object(Obj::array(Vec::new()))),
        ])));
    }
    let mut missing = Vec::new();
    for message in crate::js::iterate(&messages, "messages")? {
        if !get(&message, "role", "message.role")?.is_str("assistant") {
            continue;
        }
        // `state.part[message.id]`: a TypeError when `state.part` is absent (the C0i review's S4(a)).
        let parts = crate::js::get_key(
            &get(state, "part", "state.part")?,
            &to_string(&get(&message, "id", "message.id")?)?,
            "state.part[message.id]",
        )?;
        if !truthy(&parts) || length(&parts, "parts.length")? == 0.0 {
            missing.push(get(&message, "id", "message.id")?);
        }
    }
    let renderable = missing.is_empty() || plant::on("materialization-always-renderable");
    Ok(Value::Object(Obj::object_from(vec![
        (s("hasMessages"), Value::Bool(true)),
        (s("renderable"), Value::Bool(renderable)),
        (s("missingPartMessageIDs"), Value::Object(Obj::array(missing))),
    ])))
}

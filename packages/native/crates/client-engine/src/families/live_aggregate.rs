//! `packages/ui/src/sync/live-aggregate.ts` (family `live-aggregate`).

use crate::js::{Js, JsMap, Obj, Value, error, get, get_key_opt, get_opt, has_property, iterate, join, own_keys, s, sort_by, strict_equals, truthy};
use crate::plant;

use super::message_order::array_items;
use super::session_diff_stats::get_session_summary_diff_totals;

pub const EXPORTS: &[&str] = &[
    "aggregateLiveSessionStatuses",
    "aggregateLiveSessions",
    "areSessionListsEquivalent",
    "areStatusMapsEquivalent",
    "findLiveSession",
    "findLiveSessionStatus",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(match export {
        "areSessionListsEquivalent" => are_session_lists_equivalent(&first, &second).map(Value::Bool),
        "areStatusMapsEquivalent" => are_status_maps_equivalent(&first, &second).map(Value::Bool),
        "aggregateLiveSessions" => aggregate_live_sessions(&first),
        "aggregateLiveSessionStatuses" => aggregate_live_session_statuses(&first),
        "findLiveSession" => find_live_session(&first, &second),
        "findLiveSessionStatus" => find_live_session_status(&first, &second),
        _ => return None,
    })
}

fn finite(value: &Value) -> Option<f64> {
    value.as_number().filter(|number| number.is_finite())
}

/// `getSessionUpdatedAt`: a finite `time.updated`, else a finite `time.created`, else 0.
fn session_updated_at(session: &Value) -> Js<f64> {
    let time = get(session, "time", "session.time")?;
    if let Some(updated) = finite(&get_opt(&time, "updated")) {
        return Ok(updated);
    }
    if plant::on("live-aggregate-created-ignored") {
        return Ok(0.0);
    }
    Ok(finite(&get_opt(&get(session, "time", "session.time")?, "created")).unwrap_or(0.0))
}

/// `value ?? fallback`.
fn or(value: Value, fallback: Value) -> Value {
    if value.is_nullish() { fallback } else { value }
}

fn session_signature(session: &Value) -> Js<crate::js::Str> {
    let directory = or(get(session, "directory", "session.directory")?, Value::str(""));
    let parent_id = or(get(session, "parentID", "session.parentID")?, Value::str(""));
    let (additions, deletions) = get_session_summary_diff_totals(&get(session, "summary", "session.summary")?)?;
    let time = || get(session, "time", "session.time");
    let mut parts = vec![
        get(session, "id", "session.id")?,
        or(get(session, "title", "session.title")?, Value::str("")),
        or(get_opt(&time()?, "created"), Value::Number(0.0)),
        or(get_opt(&time()?, "updated"), Value::Number(0.0)),
        or(get_opt(&time()?, "archived"), Value::Number(0.0)),
        directory,
        parent_id,
        or(get_opt(&get(session, "share", "session.share")?, "url"), Value::str("")),
        Value::Number(additions),
        Value::Number(deletions),
    ];
    if plant::on("live-aggregate-signature-without-title") {
        parts.remove(1);
    }
    join(&Obj::array(parts), &s("|"))
}

fn status_priority(status: &Value) -> f64 {
    let kind = get_opt(status, "type");
    if kind.is_str("retry") {
        4.0
    } else if kind.is_str("busy") {
        if plant::on("live-aggregate-busy-over-retry") { 5.0 } else { 3.0 }
    } else if kind.is_str("idle") {
        1.0
    } else {
        0.0
    }
}

fn status_message(status: &Value) -> Value {
    match get_opt(status, "message") {
        Value::String(text) => Value::String(text),
        _ => Value::Null,
    }
}

fn status_number_field(status: &Value, field: &str) -> Value {
    match get_opt(status, field) {
        Value::Number(number) => Value::Number(number),
        _ => Value::Null,
    }
}

fn are_statuses_equivalent(left: &Value, right: &Value) -> bool {
    strict_equals(&get_opt(left, "type"), &get_opt(right, "type"))
        && strict_equals(&status_message(left), &status_message(right))
        && (plant::on("live-aggregate-attempt-ignored") || strict_equals(&status_number_field(left, "attempt"), &status_number_field(right, "attempt")))
        && strict_equals(&status_number_field(left, "next"), &status_number_field(right, "next"))
}

/// A status candidate: the status and its session's updated time (-1 when the state has no such session).
struct Candidate {
    status: Value,
    session_updated_at: f64,
}

fn status_candidate(state: &Value, session_id: &Value) -> Js<Option<Candidate>> {
    // `state.session_status?.[sessionId]`.
    let status = crate::js::get_value_key_opt(&get(state, "session_status", "state.session_status")?, session_id)?;
    if !truthy(&status) {
        return Ok(None);
    }
    let sessions = get(state, "session", "state.session")?;
    let mut found = None;
    for candidate in array_items(&sessions, "state.session.find")? {
        if strict_equals(&get(&candidate, "id", "candidate.id")?, session_id) {
            found = Some(candidate);
            break;
        }
    }
    let session_updated_at = match found {
        Some(session) => session_updated_at(&session)?,
        None => {
            if plant::on("live-aggregate-missing-session-zero") {
                0.0
            } else {
                -1.0
            }
        }
    };
    Ok(Some(Candidate { status, session_updated_at }))
}

fn should_replace(current: Option<&Candidate>, next: &Candidate) -> bool {
    let Some(current) = current else { return true };
    if next.session_updated_at != current.session_updated_at {
        return next.session_updated_at > current.session_updated_at;
    }
    if plant::on("live-aggregate-priority-ties-keep-first") {
        return status_priority(&next.status) > status_priority(&current.status);
    }
    status_priority(&next.status) >= status_priority(&current.status)
}

pub fn are_session_lists_equivalent(left: &Value, right: &Value) -> Js<bool> {
    if strict_equals(left, right) && !plant::on("live-aggregate-identity-not-shortcut") {
        return Ok(true);
    }
    if !strict_equals(&get(left, "length", "left.length")?, &get(right, "length", "right.length")?) {
        return Ok(false);
    }
    let (left, right) = (array_items(left, "left[index]")?, array_items(right, "right[index]")?);
    for (a, b) in left.iter().zip(&right) {
        if session_signature(a)? != session_signature(b)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `Object.keys(value)` (a TypeError for `null` and `undefined`, as there).
fn keys_of(value: &Value, expression: &str) -> Js<Vec<crate::js::Str>> {
    match value {
        Value::Object(object) => Ok(own_keys(object)),
        Value::String(text) => Ok((0..text.len()).map(|index| s(&index.to_string())).collect()),
        Value::Undefined | Value::Null => Err(error(
            "TypeError",
            &format!("client-engine: Object.keys of {} ({expression}) is not reproduced", crate::js::type_of(value)),
        )),
        _ => Ok(Vec::new()),
    }
}

pub fn are_status_maps_equivalent(left: &Value, right: &Value) -> Js<bool> {
    if strict_equals(left, right) {
        return Ok(true);
    }
    let left_keys = keys_of(left, "left")?;
    let right_keys = keys_of(right, "right")?;
    if left_keys.len() != right_keys.len() {
        return Ok(false);
    }
    for key in left_keys {
        // `key in right`: a TypeError on a primitive, met only when there is a key to look for.
        let Value::Object(right_object) = right else {
            return Err(error("TypeError", "client-engine: the in operator on a primitive"));
        };
        if !has_property(right_object, &key) && !plant::on("live-aggregate-missing-key-equal") {
            return Ok(false);
        }
        if !are_statuses_equivalent(&get_key_opt(left, &key), &get_key_opt(right, &key)) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The states, as `for (const state of states)` walks them.
fn states_of(states: &Value) -> Js<Vec<Value>> {
    iterate(states, "states")
}

pub fn aggregate_live_sessions(states: &Value) -> Js {
    let mut sessions_by_id = JsMap::default();
    for state in states_of(states)? {
        for session in iterate(&get(&state, "session", "state.session")?, "state.session")? {
            let id = get_opt(&session, "id");
            if !truthy(&id) {
                continue;
            }
            let replace = match sessions_by_id.get(&id) {
                None => true,
                Some(current) => {
                    let current = current.clone();
                    let (next, known) = (session_updated_at(&session)?, session_updated_at(&current)?);
                    if plant::on("live-aggregate-ties-keep-first") {
                        next > known
                    } else {
                        next >= known
                    }
                }
            };
            if replace {
                sessions_by_id.set(get(&session, "id", "session.id")?, session.clone());
            }
        }
    }
    let mut list = sessions_by_id.values();
    sort_by(&mut list, &mut |left, right| {
        let order = session_updated_at(right)? - session_updated_at(left)?;
        Ok(if plant::on("live-aggregate-oldest-first") { -order } else { order })
    })?;
    Ok(Value::Object(Obj::array(list)))
}

pub fn aggregate_live_session_statuses(states: &Value) -> Js {
    let mut candidates: Vec<(Value, Candidate)> = Vec::new();
    for state in states_of(states)? {
        let statuses = or(get(&state, "session_status", "state.session_status")?, Value::Object(Obj::object()));
        for session_id in keys_of(&statuses, "state.session_status ?? {}")? {
            let session_id = Value::String(session_id);
            let Some(next) = status_candidate(&state, &session_id)? else { continue };
            let at = candidates.iter().position(|(id, _)| {
                if plant::on("rv-la-status-candidate-svz") {
                    crate::js::same_value_zero(id, &session_id)
                } else {
                    strict_equals(id, &session_id)
                }
            });
            if should_replace(at.map(|at| &candidates[at].1), &next) {
                match at {
                    Some(at) => candidates[at].1 = next,
                    None => candidates.push((session_id, next)),
                }
            }
        }
    }
    let out = Obj::object();
    for (session_id, candidate) in candidates {
        let key = crate::js::to_string(&session_id)?;
        // `statuses[sessionId] = status` with the key `__proto__` is the prototype setter on a plain object (the C0i
        // review's S4(d)): a primitive is ignored; an object would become the prototype, which this engine refuses.
        if key.iter().copied().eq("__proto__".encode_utf16()) {
            if crate::js::is_object(&candidate.status) || matches!(candidate.status, Value::Null) {
                return Err(error("TypeError", "client-engine: a prototype set through __proto__ is not reproduced"));
            }
            continue;
        }
        crate::js::set(&out, key, candidate.status);
    }
    Ok(Value::Object(out))
}

pub fn find_live_session(states: &Value, session_id: &Value) -> Js {
    if !truthy(session_id) {
        return Ok(Value::Undefined);
    }
    let mut found: Option<Value> = None;
    for state in states_of(states)? {
        let mut session = None;
        for candidate in array_items(&get(&state, "session", "state.session")?, "state.session.find")? {
            if strict_equals(&get(&candidate, "id", "candidate.id")?, session_id) {
                session = Some(candidate);
                break;
            }
        }
        let Some(session) = session else { continue };
        let replace = match &found {
            None => true,
            Some(current) => session_updated_at(&session)? >= session_updated_at(current)?,
        };
        if replace {
            found = Some(session);
        }
    }
    Ok(found.unwrap_or(Value::Undefined))
}

pub fn find_live_session_status(states: &Value, session_id: &Value) -> Js {
    if !truthy(session_id) {
        return Ok(Value::Undefined);
    }
    let mut found: Option<Candidate> = None;
    for state in states_of(states)? {
        let Some(next) = status_candidate(&state, session_id)? else { continue };
        if should_replace(found.as_ref(), &next) {
            found = Some(next);
        }
    }
    Ok(found.map_or(Value::Undefined, |candidate| candidate.status))
}

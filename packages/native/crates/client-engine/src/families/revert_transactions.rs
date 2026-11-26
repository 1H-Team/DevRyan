//! `packages/ui/src/sync/revert-transactions.ts` (family `revert-transactions`; message-order inlined).
//! The committed-resend exports keep module state no export snapshots: the port map inlines them, so no step calls
//! them and they are not ported here.

use crate::js::{Js, Kind, Value, error, get, get_opt, own_entries, same_value_zero, strict_equals, truthy};
use crate::plant;

use super::message_order::{array_items, messages_before, present_items};

pub const EXPORTS: &[&str] = &[
    "filterMessagesForRevert",
    "getEffectiveSessionRevertMessageID",
    "getSessionRevertMessageID",
    "isMessageHiddenByAnyActiveRevert",
    "isMessageHiddenByRevert",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second, third) = (super::arg(args, 0), super::arg(args, 1), super::arg(args, 2));
    Some(match export {
        "getSessionRevertMessageID" => Ok(get_session_revert_message_id(&first)),
        "getEffectiveSessionRevertMessageID" => get_effective_session_revert_message_id(&first, &second, &third),
        "isMessageHiddenByRevert" => is_message_hidden_by_revert(&first, &second, &third).map(Value::Bool),
        "isMessageHiddenByAnyActiveRevert" => is_message_hidden_by_any_active_revert(&first, &second).map(Value::Bool),
        "filterMessagesForRevert" => filter_messages_for_revert(&first, &second),
        _ => return None,
    })
}

pub fn get_session_revert_message_id(session: &Value) -> Value {
    get_opt(
        &get_opt(session, "revert"),
        if plant::on("revert-transactions-revert-key") { "id" } else { "messageID" },
    )
}

/// `state.session?.find((candidate) => candidate.id === sessionID)`.
fn find_session(state: &Value, session_id: &Value) -> Js {
    let sessions = get(state, "session", "state.session")?;
    if sessions.is_nullish() {
        return Ok(Value::Undefined);
    }
    for candidate in array_items(&sessions, "state.session.find")? {
        if strict_equals(&get(&candidate, "id", "candidate.id")?, session_id) {
            return Ok(candidate);
        }
    }
    Ok(Value::Undefined)
}

/// `state.revert_transaction?.[sessionID]`.
fn transaction_of(state: &Value, session_id: &Value) -> Js {
    // `state.revert_transaction?.[sessionID]`: the key is made a string only when there is a map to read.
    crate::js::get_value_key_opt(&get(state, "revert_transaction", "state.revert_transaction")?, session_id)
}

pub fn get_effective_session_revert_message_id(state: &Value, session_id: &Value, session: &Value) -> Js {
    let transaction = transaction_of(state, session_id)?;
    if truthy(&transaction) && (!get(&transaction, "status", "transaction.status")?.is_str("failed") || plant::on("revert-transactions-failed-counts")) {
        return get(&transaction, "messageID", "transaction.messageID");
    }
    let session = if session.is_nullish() || plant::on("revert-transactions-session-argument-ignored") {
        find_session(state, session_id)?
    } else {
        session.clone()
    };
    Ok(get_session_revert_message_id(&session))
}

/// `transaction?.hiddenMessageIDs?.has(messageID)`.
fn hides(transaction: &Value, message_id: &Value) -> Js<bool> {
    let hidden = get_opt(transaction, "hiddenMessageIDs");
    match &hidden {
        Value::Undefined | Value::Null => Ok(false),
        Value::Object(object) => match &object.borrow().kind {
            Kind::Set(values) => Ok(values.iter().any(|value| same_value_zero(value, message_id))),
            Kind::Array { elements, .. } if plant::on("rv-rt-hidden-array-ok") => Ok(elements.present().any(|(_, value)| same_value_zero(value, message_id))),
            _ => Err(error(
                "TypeError",
                "client-engine: hiddenMessageIDs.has of a value that is no Set is not reproduced",
            )),
        },
        _ => Err(error(
            "TypeError",
            "client-engine: hiddenMessageIDs.has of a value that is no Set is not reproduced",
        )),
    }
}

pub fn is_message_hidden_by_revert(state: &Value, session_id: &Value, message_id: &Value) -> Js<bool> {
    if !truthy(session_id) {
        return Ok(false);
    }
    let revert_message_id = get_effective_session_revert_message_id(state, session_id, &Value::Undefined)?;
    if !truthy(&revert_message_id) {
        return Ok(false);
    }
    let transaction = transaction_of(state, session_id)?;
    let failed = get_opt(&transaction, "status").is_str("failed");
    if (!failed || plant::on("revert-transactions-failed-hides")) && hides(&transaction, message_id)? && !plant::on("revert-transactions-hidden-set-ignored") {
        return Ok(true);
    }
    let messages = crate::js::get_value_key_opt(&get(state, "message", "state.message")?, session_id)?;
    if !truthy(&messages) {
        return Ok(false);
    }
    let visible = messages_before(&messages, &revert_message_id)?;
    if strict_equals(&visible, &messages) && !plant::on("revert-transactions-unchanged-list-hides") {
        return Ok(false);
    }
    for message in present_items(&visible, "visible.some")? {
        if strict_equals(&get(&message, "id", "message.id")?, message_id) {
            return Ok(plant::on("revert-transactions-visible-hidden"));
        }
    }
    Ok(true)
}

pub fn is_message_hidden_by_any_active_revert(state: &Value, message_id: &Value) -> Js<bool> {
    let transactions = get(state, "revert_transaction", "state.revert_transaction")?;
    let Value::Object(object) = &transactions else { return Ok(false) };
    if !truthy(&transactions) {
        return Ok(false);
    }
    for (session_id, transaction) in own_entries(object) {
        if !truthy(&transaction) || get(&transaction, "status", "transaction.status")?.is_str("failed") {
            continue;
        }
        if hides(&transaction, message_id)? {
            let session_id = Value::String(session_id);
            let session = find_session(state, &session_id)?;
            if !truthy(&session) && !plant::on("revert-transactions-missing-session-visible") {
                return Ok(true);
            }
            if !truthy(&session) {
                continue;
            }
            let effective = get_effective_session_revert_message_id(state, &session_id, &session)?;
            if strict_equals(&effective, &get(&transaction, "messageID", "transaction.messageID")?) || plant::on("revert-transactions-any-session-hides") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn filter_messages_for_revert(messages: &Value, revert_message_id: &Value) -> Js {
    if !truthy(revert_message_id) && !plant::on("revert-transactions-filter-without-marker") {
        return Ok(messages.clone());
    }
    messages_before(messages, revert_message_id)
}

//! `packages/ui/src/sync/message-order.ts` (family `message-order`; inlined by `optimistic`, `revert-transactions`).

use crate::js::{Elements, Js, Kind, Obj, Value, error, get, get_opt, is_finite_number, less_than, sort_by, strict_equals};
use crate::plant;

pub const EXPORTS: &[&str] = &[
    "compareMessagesChronologically",
    "findMessageIndex",
    "insertMessageChronologically",
    "messagesBefore",
    "messagesFrom",
    "sortMessagesChronologically",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(match export {
        "compareMessagesChronologically" => compare_messages_chronologically(&first, &second).map(Value::Number),
        "sortMessagesChronologically" => sort_messages_chronologically(&first).map(Value::Object),
        "insertMessageChronologically" => insert_message_chronologically(&first, &second).map(Value::Object),
        "findMessageIndex" => find_message_index(&first, &second).map(|index| Value::Number(index as f64)),
        "messagesBefore" => messages_before(&first, &second),
        "messagesFrom" => messages_from(&first, &second),
        _ => return None,
    })
}

/// An array's members as `[...messages]`, a loop over its indices or a callback method sees them (holes as `undefined`).
pub(crate) fn array_items(value: &Value, method: &str) -> Js<Vec<Value>> {
    match value.as_object().and_then(Obj::elements) {
        Some(items) => items,
        None => Err(error(
            "TypeError",
            &format!("client-engine: {method} of a value that is no array is not reproduced"),
        )),
    }
}

/// An array's members as `some`, `filter` and `forEach` visit them (holes skipped).
pub(crate) fn present_items(value: &Value, method: &str) -> Js<Vec<Value>> {
    let Some(object) = value.as_object().filter(|object| object.is_array()) else {
        return Err(error(
            "TypeError",
            &format!("client-engine: {method} of a value that is no array is not reproduced"),
        ));
    };
    Ok(object.present_elements().unwrap_or_default())
}

/// `new Map(list.map((item) => [item.id, item]))`: the callback reads each present member's `id` in order (a hole is
/// skipped and kept), then the Map reads the mapped array, where a kept hole is no entry: a TypeError (the C0i
/// review's S4(b)). `expression` names the member read.
pub(crate) fn map_by_id(list: &Value, method: &str, expression: &str) -> Js<crate::js::JsMap> {
    let Some(object) = list.as_object().filter(|object| object.is_array()) else {
        return Err(error("TypeError", &format!("client-engine: {method} of a value that is no array")));
    };
    let (present, len) = match &object.borrow().kind {
        Kind::Array { elements, .. } => (elements.present().map(|(_, item)| item.clone()).collect::<Vec<_>>(), elements.len()),
        _ => (Vec::new(), 0),
    };
    let mut pairs = Vec::with_capacity(present.len());
    for item in present {
        pairs.push((get(&item, "id", expression)?, item));
    }
    if pairs.len() < len as usize {
        return Err(error("TypeError", "client-engine: a hole in the entries of new Map"));
    }
    let mut map = crate::js::JsMap::default();
    for (key, value) in pairs {
        map.set(key, value);
    }
    Ok(map)
}

/// Whether an array has a hole (an index below its length with no member).
pub(crate) fn has_holes(value: &Value) -> bool {
    matches!(value.as_object().map(|object| object.borrow()), Some(data) if matches!(&data.kind, Kind::Array { elements, .. } if elements.present().count() < elements.len() as usize))
}

/// `createdAt`: a finite `time.created`, else 0.
fn created_at(message: &Value) -> Js<f64> {
    let time = get(message, "time", "message.time")?;
    let value = get_opt(&time, "created");
    Ok(
        if is_finite_number(&value) || (plant::on("message-order-infinite-time") && value.as_number().is_some()) {
            value.as_number().unwrap_or(0.0)
        } else {
            0.0
        },
    )
}

fn compare_ids(left: &Value, right: &Value) -> Js<f64> {
    if plant::on("message-order-ids-reversed") {
        return Ok(if less_than(left, right)? {
            1.0
        } else if less_than(right, left)? {
            -1.0
        } else {
            0.0
        });
    }
    Ok(if less_than(left, right)? {
        -1.0
    } else if less_than(right, left)? {
        1.0
    } else {
        0.0
    })
}

pub fn compare_messages_chronologically(left: &Value, right: &Value) -> Js<f64> {
    let time_delta = created_at(left)? - created_at(right)?;
    if time_delta == 0.0 && !plant::on("message-order-ids-ignored") {
        return compare_ids(&get(left, "id", "left.id")?, &get(right, "id", "right.id")?);
    }
    Ok(time_delta)
}

pub fn sort_messages_chronologically(messages: &Value) -> Js<Obj> {
    let mut items = array_items(messages, "a spread")?;
    if plant::on("message-order-sort-unstable") {
        items.reverse();
    }
    sort_by(&mut items, &mut |a, b| compare_messages_chronologically(a, b))?;
    Ok(Obj::array(items))
}

pub fn insert_message_chronologically(messages: &Value, message: &Value) -> Js<Obj> {
    let items = array_items(messages, "insertMessageChronologically")?;
    let (mut low, mut high) = (0usize, items.len());
    while low < high {
        let middle = (low + high) / 2;
        let order = compare_messages_chronologically(&items[middle], message)?;
        let after = if plant::on("message-order-insert-before-equal") {
            order < 0.0
        } else {
            order <= 0.0
        };
        if after {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    let mut next = items;
    next.insert(low, message.clone());
    Ok(Obj::array(next))
}

pub fn find_message_index(messages: &Value, message_id: &Value) -> Js<i64> {
    let items = array_items(messages, "findIndex")?;
    let mut found = -1;
    for (index, message) in items.iter().enumerate() {
        if strict_equals(&get(message, "id", "message.id")?, message_id) {
            found = index as i64;
            if !plant::on("message-order-find-last") {
                break;
            }
        }
    }
    Ok(found)
}

/// `messages.slice(start, end)`: holes kept.
fn slice(messages: &Value, start: u32, end: Option<u32>) -> Value {
    let Some(object) = messages.as_object() else { return Value::Undefined };
    let elements = match &object.borrow().kind {
        Kind::Array { elements, .. } => elements.clone(),
        _ => Elements::default(),
    };
    let end = end.unwrap_or(elements.len()).min(elements.len());
    let start = start.min(end);
    Value::Object(Obj::array_of(elements.slice(start, end)))
}

pub fn messages_before(messages: &Value, marker_id: &Value) -> Js {
    let index = find_message_index(messages, marker_id)?;
    if index < 0 {
        return Ok(if plant::on("message-order-before-copies") {
            slice(messages, 0, None)
        } else {
            messages.clone()
        });
    }
    let end = if plant::on("message-order-before-includes-marker") {
        index as u32 + 1
    } else {
        index as u32
    };
    Ok(slice(messages, 0, Some(end)))
}

pub fn messages_from(messages: &Value, marker_id: &Value) -> Js {
    let index = find_message_index(messages, marker_id)?;
    if index < 0 {
        return Ok(if plant::on("message-order-from-missing-keeps-all") {
            messages.clone()
        } else {
            Value::Object(Obj::array(Vec::new()))
        });
    }
    let start = if plant::on("message-order-from-excludes-marker") {
        index as u32 + 1
    } else {
        index as u32
    };
    Ok(slice(messages, start, None))
}

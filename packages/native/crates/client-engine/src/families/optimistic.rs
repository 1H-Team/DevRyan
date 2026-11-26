//! `packages/ui/src/sync/optimistic.ts` (family `optimistic`; message-order inlined).
//! `applyOptimisticAdd` and `applyOptimisticRemove` change their draft (argument 0) in place.

use crate::js::{Js, JsMap, Obj, Value, delete, error, get, get_key_opt, get_opt, iterate, s, set, spread, to_string, truthy};
use crate::plant;

use super::message_order::{array_items, find_message_index, insert_message_chronologically};

pub const EXPORTS: &[&str] = &["applyOptimisticAdd", "applyOptimisticRemove", "mergeOptimisticPage"];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(match export {
        "mergeOptimisticPage" => merge_optimistic_page(&first, &second),
        "applyOptimisticAdd" => apply_optimistic_add(&first, &second).map(|()| Value::Undefined),
        "applyOptimisticRemove" => apply_optimistic_remove(&first, &second).map(|()| Value::Undefined),
        _ => return None,
    })
}

/// `parts.filter((part) => !!part?.id)` (a hole is skipped).
fn filter_renderable_parts(parts: &Value) -> Js<Obj> {
    let Some(object) = parts.as_object().filter(|object| object.is_array()) else {
        return Err(crate::js::error(
            "TypeError",
            "client-engine: parts.filter of a value that is no array is not reproduced",
        ));
    };
    let kept: Vec<Value> = object
        .present_elements()
        .unwrap_or_default()
        .into_iter()
        .filter(|part| {
            plant::on("optimistic-parts-unfiltered")
                || if plant::on("rv-op-id-nonnull") {
                    !get_opt(part, "id").is_nullish()
                } else {
                    truthy(&get_opt(part, "id"))
                }
        })
        .collect();
    Ok(Obj::array(kept))
}

fn merge_parts(parts: &Value, want: &Value) -> Js {
    if !truthy(parts) {
        return filter_renderable_parts(want).map(Value::Object);
    }
    let mut next = iterate(parts, "[...parts]")?;
    let mut ids = JsMap::default();
    for part in &next {
        ids.set(get(part, "id", "part.id")?, Value::Undefined);
    }
    let mut changed = false;
    for part in iterate(want, "want")? {
        let id = get(&part, "id", "part.id")?;
        if ids.has(&id) && !plant::on("optimistic-duplicate-parts") {
            continue;
        }
        ids.set(get(&part, "id", "part.id")?, Value::Undefined);
        next.push(part);
        changed = true;
    }
    if !changed && !plant::on("optimistic-unchanged-parts-copied") {
        return Ok(parts.clone());
    }
    Ok(Value::Object(Obj::array(next)))
}

/// `list.splice(0, list.length, ...items)`: the same array, its members replaced.
fn replace_members(list: &Value, items: Vec<Value>) {
    if let Some(object) = list.as_object() {
        object.set_elements(items);
    }
}

pub fn merge_optimistic_page(page: &Value, items: &Value) -> Js {
    // `items.length === 0`: any value with a length (an empty string too).
    if crate::js::strict_equals(&get(items, "length", "items.length")?, &Value::Number(0.0)) {
        let copy = spread(page);
        set(&copy, s("confirmed"), Value::Object(Obj::array(Vec::new())));
        return Ok(Value::Object(copy));
    }
    let session = Value::Object(Obj::array(iterate(&get(page, "session", "page.session")?, "[...page.session]")?));
    // `new Map(page.part.map((item) => [item.id, filterRenderableParts(item.part)]))`: present members, then a kept
    // hole is no entry.
    let page_part = get(page, "part", "page.part")?;
    let mut part = JsMap::default();
    for item in super::message_order::present_items(&page_part, "page.part.map")? {
        let id = get(&item, "id", "item.id")?;
        part.set(id, Value::Object(filter_renderable_parts(&get(&item, "part", "item.part")?)?));
    }
    if super::message_order::has_holes(&page_part) {
        return Err(error("TypeError", "client-engine: a hole in the entries of new Map"));
    }
    let mut confirmed: Vec<Value> = Vec::new();
    for item in iterate(items, "items")? {
        let message = get(&item, "message", "item.message")?;
        if find_message_index(&session, &get(&message, "id", "item.message.id")?)? >= 0 {
            confirmed.push(get(&get(&item, "message", "item.message")?, "id", "item.message.id")?);
            if !plant::on("optimistic-confirmed-also-inserted") {
                continue;
            }
        }
        let inserted = insert_message_chronologically(&session, &get(&item, "message", "item.message")?)?;
        replace_members(&session, inserted.elements().transpose()?.unwrap_or_default());
        let id = get(&get(&item, "message", "item.message")?, "id", "item.message.id")?;
        let current = part.get(&id).cloned().unwrap_or(Value::Undefined);
        let merged = merge_parts(&current, &get(&item, "parts", "item.parts")?)?;
        part.set(get(&get(&item, "message", "item.message")?, "id", "item.message.id")?, merged);
    }
    let mut pages: Vec<Value> = Vec::new();
    for message in array_items(&session, "session.flatMap")? {
        let id = get(&message, "id", "message.id")?;
        let message_parts = part.get(&id).cloned().unwrap_or(Value::Undefined);
        if truthy(&message_parts) || plant::on("optimistic-empty-part-pages") {
            pages.push(Value::Object(Obj::object_from(vec![
                (s("id"), get(&message, "id", "message.id")?),
                (s("part"), message_parts),
            ])));
        }
    }
    let mut members = vec![
        (s("cursor"), get(page, "cursor", "page.cursor")?),
        (s("complete"), get(page, "complete", "page.complete")?),
        (s("session"), session),
        (s("part"), Value::Object(Obj::array(pages))),
        (s("confirmed"), Value::Object(Obj::array(confirmed))),
    ];
    if plant::on("optimistic-cursor-dropped") {
        members.remove(0);
    }
    Ok(Value::Object(Obj::object_from(members)))
}

/// `draft.message[input.sessionID]` (evaluated in that order), and its key.
fn messages_of(draft: &Value, input: &Value) -> Js<(Value, crate::js::Str)> {
    let messages = get(draft, "message", "draft.message")?;
    let session_id = get(input, "sessionID", "input.sessionID")?;
    if messages.is_nullish() {
        return Err(crate::js::not_an_object(&messages, "draft.message[input.sessionID]"));
    }
    let key = to_string(&session_id)?;
    Ok((get_key_opt(&messages, &key), key))
}

pub fn apply_optimistic_add(draft: &Value, input: &Value) -> Js<()> {
    let (messages, key) = messages_of(draft, input)?;
    if truthy(&messages) {
        let message = get(input, "message", "input.message")?;
        let present = find_message_index(&messages, &get(&message, "id", "input.message.id")?)? >= 0;
        if !present || plant::on("optimistic-add-duplicates") {
            let inserted = insert_message_chronologically(&messages, &get(input, "message", "input.message")?)?;
            if plant::on("optimistic-add-replaces-list") {
                if let Value::Object(holder) = get(draft, "message", "draft.message")? {
                    set(&holder, key, Value::Object(inserted));
                }
            } else {
                replace_members(&messages, inserted.elements().transpose()?.unwrap_or_default());
            }
        }
    } else {
        // `draft.message[input.sessionID] = [input.message]`: the right side first, then the write, which a primitive
        // base refuses in strict code (the C0i review's S4(c)).
        let made = Value::Object(Obj::array(vec![get(input, "message", "input.message")?]));
        assign(&get(draft, "message", "draft.message")?, key, made)?;
    }
    let parts = get(draft, "part", "draft.part")?;
    if parts.is_nullish() {
        return Err(crate::js::not_an_object(&parts, "draft.part[input.message.id]"));
    }
    let message_id = get(&get(input, "message", "input.message")?, "id", "input.message.id")?;
    let filtered = filter_renderable_parts(&get(input, "parts", "input.parts")?)?;
    assign(&parts, to_string(&message_id)?, Value::Object(filtered))
}

pub fn apply_optimistic_remove(draft: &Value, input: &Value) -> Js<()> {
    let (messages, _) = messages_of(draft, input)?;
    if truthy(&messages) {
        let index = find_message_index(&messages, &get(input, "messageID", "input.messageID")?)?;
        if index >= 0
            && !plant::on("optimistic-remove-keeps-message")
            && let Some(object) = messages.as_object()
            && let crate::js::Kind::Array { elements, .. } = &mut object.borrow_mut().kind
            && (index as u64) < u64::from(elements.len())
        {
            // `messages.splice(index, 1)`: later members, holes included, move down one.
            elements.remove_at(index as u32);
        }
    }
    let parts = get(draft, "part", "draft.part")?;
    if parts.is_nullish() {
        return Err(crate::js::not_an_object(&parts, "draft.part[input.messageID]"));
    }
    let key = to_string(&get(input, "messageID", "input.messageID")?)?;
    // `delete draft.part[key]`: on a primitive base it deletes from a wrapper and gives true (a string's own index is
    // no configurable member: a TypeError in strict code).
    if let Value::String(text) = &parts
        && crate::js::array_index(&key).is_some_and(|index| (index as usize) < text.len())
    {
        return Err(error("TypeError", "client-engine: a string's index member cannot be deleted"));
    }
    if let Value::Object(holder) = &parts
        && !plant::on("optimistic-remove-keeps-parts")
    {
        delete(holder, &key);
    }
    Ok(())
}

/// `base[key] = value` in strict code: an object's member written; a primitive base is a TypeError.
fn assign(base: &Value, key: crate::js::Str, value: Value) -> Js<()> {
    match base {
        Value::Object(holder) => {
            set(holder, key, value);
            Ok(())
        }
        Value::Undefined | Value::Null => Err(crate::js::not_an_object(base, "a member write")),
        _ => Err(error("TypeError", "client-engine: a member written on a primitive")),
    }
}

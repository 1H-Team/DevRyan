//! `packages/ui/src/lib/messages/nativeCursorText.ts` (family `native-cursor-text`).

use crate::js::{Js, Value, get, is_object, strict_equals, type_of};
use crate::plant;

pub const EXPORTS: &[&str] = &["hasNativeCursorTextProvenance"];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    match export {
        "hasNativeCursorTextProvenance" => Some(has_native_cursor_text_provenance(&super::arg(args, 0)).map(Value::Bool)),
        _ => None,
    }
}

/// `record(value)`: an object that is no array.
fn record(value: &Value) -> bool {
    let array = value.as_object().is_some_and(|object| object.is_array());
    is_object(value) && (!array || plant::on("native-cursor-text-array-is-record"))
}

pub fn has_native_cursor_text_provenance(part: &Value) -> Js<bool> {
    let kind = get(part, "type", "part.type")?;
    let reasoning = kind.is_str("reasoning") && !plant::on("native-cursor-text-reasoning-dropped");
    let id_unchecked = plant::on("native-cursor-text-id-unchecked");
    if !kind.is_str("text") && !reasoning
        || (type_of(&get(part, "id", "part.id")?) != "string" && !id_unchecked)
        || !record(&get(part, "metadata", "part.metadata")?)
    {
        return Ok(false);
    }
    let metadata = get(part, "metadata", "part.metadata")?;
    let mut text = get(part, "type", "part.type")?.is_str("text");
    if plant::on("native-cursor-text-state-swapped") {
        text = !text;
    }
    let state = if text {
        get(&metadata, "providerState", "part.metadata.providerState")?
    } else {
        metadata
    };
    if !record(&state) {
        return Ok(false);
    }
    let devryan = get(&state, "devryan", "state.devryan")?;
    if !record(&devryan) {
        return Ok(plant::on("native-cursor-text-missing-namespace-true"));
    }
    let namespace = if plant::on("native-cursor-text-wrong-namespace") {
        "native"
    } else {
        "cursor"
    };
    let cursor = get(&devryan, namespace, "state.devryan.cursor")?;
    if !record(&cursor) {
        return Ok(plant::on("native-cursor-text-missing-cursor-true"));
    }
    let owner = get(
        &cursor,
        if plant::on("native-cursor-text-owner-key") { "id" } else { "partID" },
        "state.devryan.cursor.partID",
    )?;
    let id = get(part, "id", "part.id")?;
    if plant::on("native-cursor-text-any-string-owner") {
        return Ok(type_of(&owner) == "string");
    }
    let same = if crate::plant::on("rv-nct-owner-svz") {
        crate::js::same_value_zero(&owner, &id)
    } else {
        strict_equals(&owner, &id)
    };
    Ok(same != plant::on("native-cursor-text-negated"))
}

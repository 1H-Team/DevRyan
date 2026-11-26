//! `packages/ui/src/sync/tool-output.ts` (family `tool-output`; inlined by `materialization`).

use crate::js::{Js, JsMap, Kind, Obj, Props, Proto, Value, get, get_opt, has_property, json_stringify, own_entries, s, spread, strict_equals};
use crate::plant;

use super::message_order::array_items;

pub const EXPORTS: &[&str] = &[
    "getOmittedToolOutputBytes",
    "isToolOutputOmitted",
    "keepFullToolOutput",
    "mergeLoadedToolOutput",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(match export {
        "isToolOutputOmitted" => Ok(Value::Bool(is_tool_output_omitted(&first))),
        "getOmittedToolOutputBytes" => get_omitted_tool_output_bytes(&first).map(|bytes| bytes.map_or(Value::Undefined, Value::Number)),
        "keepFullToolOutput" => keep_full_tool_output(&first, &second),
        "mergeLoadedToolOutput" => merge_loaded_tool_output(&first, &second),
        _ => return None,
    })
}

/// `part?.type === "tool" && part.state?.status === "completed"`.
fn completed_tool(part: &Value) -> bool {
    get_opt(part, "type").is_str("tool")
        && get_opt(&get_opt(part, "state"), "status").is_str(if plant::on("tool-output-status-done") { "done" } else { "completed" })
}

pub fn is_tool_output_omitted(part: &Value) -> bool {
    if !completed_tool(part) {
        return false;
    }
    let state = get_opt(part, "state");
    let Value::Object(object) = &state else { return false };
    let marker = s("outputOmitted");
    if !has_property(object, &marker) {
        return false;
    }
    let flag = get_opt(&state, "outputOmitted");
    if plant::on("tool-output-truthy-marker") {
        crate::js::truthy(&flag)
    } else {
        matches!(flag, Value::Bool(true))
    }
}

pub fn get_omitted_tool_output_bytes(part: &Value) -> Js<Option<f64>> {
    let state = get(part, "state", "part.state")?;
    let bytes = get(&state, "outputBytes", "part.state.outputBytes")?;
    Ok(match bytes {
        Value::Number(number)
            if number.is_finite()
                && (number >= 0.0 || plant::on("tool-output-negative-bytes"))
                && !(plant::on("rv-to-zero-bytes-rejected") && number == 0.0) =>
        {
            Some(number)
        }
        _ => None,
    })
}

fn has_full_completed_output(part: &Value) -> bool {
    completed_tool(part) && !is_tool_output_omitted(part)
}

pub fn keep_full_tool_output(existing: &Value, next: &Value) -> Js {
    let same_id = || -> Js<bool> { Ok(strict_equals(&get(existing, "id", "existing.id")?, &get(next, "id", "next.id")?)) };
    if !is_tool_output_omitted(next) || !has_full_completed_output(existing) || (!plant::on("tool-output-ids-unchecked") && !same_id()?) {
        return Ok(next.clone());
    }
    // `const { outputOmitted, outputBytes, ...state } = next.state`.
    let next_state = get(next, "state", "next.state")?;
    let mut state = Props::default();
    if let Value::Object(object) = &next_state {
        for (key, value) in own_entries(object) {
            let dropped = key.iter().copied().eq("outputOmitted".encode_utf16())
                || (key.iter().copied().eq("outputBytes".encode_utf16()) && !plant::on("tool-output-bytes-kept"));
            if !dropped {
                state.set(key, value);
            }
        }
    }
    let existing_state = get(existing, "state", "existing.state")?;
    state.set(s("output"), get(&existing_state, "output", "existing.state.output")?);
    if !plant::on("tool-output-metadata-dropped") {
        state.set(s("metadata"), get(&existing_state, "metadata", "existing.state.metadata")?);
    }
    let restored = spread(next);
    restored
        .borrow_mut()
        .props
        .set(s("state"), Value::Object(Obj::new(Kind::Object(Proto::Object), state)));
    let restored = Value::Object(restored);
    if plant::on("tool-output-never-keeps-existing") {
        return Ok(restored);
    }
    Ok(if json_stringify(&restored)? == json_stringify(existing)? {
        existing.clone()
    } else {
        restored
    })
}

pub fn merge_loaded_tool_output(current: &Value, full: &Value) -> Js {
    let mut by_id = JsMap::default();
    // `new Map(full.map((part) => [part.id, part]))`: present members in order, then a kept hole is no entry.
    for part in super::message_order::present_items(full, "full.map")? {
        let id = get(&part, "id", "part.id")?;
        if plant::on("tool-output-first-loaded-wins") && by_id.has(&id) {
            continue;
        }
        by_id.set(id, part);
    }
    if super::message_order::has_holes(full) {
        return Err(crate::js::error("TypeError", "client-engine: a hole in the entries of new Map"));
    }
    let items = array_items(current, "a loop over current")?;
    let mut merged: Option<Vec<Value>> = None;
    for (index, part) in items.iter().enumerate() {
        if !is_tool_output_omitted(part) {
            continue;
        }
        let loaded = by_id.get(&get(part, "id", "part.id")?).cloned().unwrap_or(Value::Undefined);
        if !has_full_completed_output(&loaded) && !plant::on("tool-output-any-loaded") {
            continue;
        }
        let list = merged.get_or_insert_with(|| items.clone());
        list[index] = loaded;
    }
    Ok(match merged {
        Some(list) => Value::Object(Obj::array(list)),
        None if plant::on("tool-output-always-copies") => Value::Object(Obj::array(items)),
        None => current.clone(),
    })
}

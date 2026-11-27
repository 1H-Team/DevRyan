//! The Rust port of `opencode/notification-settings.js`. The `= DEFAULT_NOTIFICATION_TEMPLATES`
//! default applies to `undefined` only; any non-object fallback falls back to the defaults too.

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

const EVENTS: [&str; 6] = ["completion", "planReady", "error", "question", "permission", "subtask"];

fn defaults(event: &str) -> Value {
    let (title, message) = match event {
        "completion" => ("Session complete", "{session_name} is ready to review"),
        "planReady" => ("Plan ready", "A plan is ready for review"),
        "error" => ("Tool error", "{last_message}"),
        "question" => ("Input needed", "{last_message}"),
        "permission" => ("Permissions needed", "Folder access is required: {last_message}"),
        _ => ("{agent_name} is ready", "{model_name} completed the task"),
    };
    json!({ "title": title, "message": message })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn object_not_array(value: &Value) -> bool {
    truthy(value) && value.is_object() && js::string_units(value).is_none() && js::as_number(value).is_none()
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn is_template(value: &Value) -> bool {
    object_not_array(value) && js::string_units(&field(value, "title")).is_some() && js::string_units(&field(value, "message")).is_some()
}

/// Port of `normalizeNotificationTemplates` (`opencode/notification-settings.js:32`).
pub fn normalize_notification_templates(value: Value, fallback: Value) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let input = if object_not_array(&value) { &value } else { &empty };
    let fallback_input = if !js::is_undefined(&fallback) && object_not_array(&fallback) {
        Some(&fallback)
    } else {
        None
    };
    let mut templates = Map::new();
    let mut changed = false;
    for event in EVENTS {
        let entry = field(input, event);
        let inherited = match fallback_input.map(|f| field(f, event)) {
            Some(t) if is_template(&t) => t,
            _ => defaults(event),
        };
        let legacy = event == "completion"
            && [
                ("{agent_name} is ready", "{model_name} completed the task"),
                ("{agent_name} is ready", "{last_message}"),
            ]
            .iter()
            .any(|(t, m)| {
                let read = |k: &str| {
                    if entry.is_null() || js::is_undefined(&entry) {
                        js::undefined()
                    } else {
                        field(&entry, k)
                    }
                };
                read("title").as_str() == Some(t) && read("message").as_str() == Some(m)
            });
        if is_template(&entry) && !legacy {
            templates.insert(event.into(), entry);
            continue;
        }
        templates.insert(event.into(), inherited);
        changed = true;
    }
    Ok(json!({ "templates": templates, "changed": changed }))
}

//! The Rust port of `question-orphan.ts`. Property reads fail as V8 does on `null` and
//! `undefined` (with the key as `String(key)`), ids compare with `===`, and the answer text
//! uses JS `trim` (U+FEFF stripped, U+0085 kept).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

/// The code the server refuses an orphaned question reply with.
const QUESTION_ORPHANED_CODE: &str = "question_orphaned";

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn kind(value: &Value) -> &'static str {
    if value.is_null() { "null" } else { "undefined" }
}

/// JS `String(key)` for a property key.
fn key_text(key: Option<&Value>) -> String {
    match key {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(v) if js::is_undefined(v) => "undefined".to_string(),
        Some(v) => js::as_number(v).map_or_else(|| v.to_string(), js::number_to_string),
    }
}

/// `value[key]` (`None` for `undefined`), failing on `null` and `undefined`.
fn get(value: &Value, key: &str) -> Result<Option<Value>, String> {
    if nullish(value) {
        return Err(format!("Cannot read properties of {} (reading '{key}')", kind(value)));
    }
    let found = match value {
        Value::Array(items) if key == "length" => Some(js::number(items.len() as f64)),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i).cloned()),
        Value::String(text) if key == "length" => Some(js::number(text.encode_utf16().count() as f64)),
        _ => value.get(key).cloned(),
    };
    Ok(found.filter(|v| !js::is_undefined(v)))
}

fn opt(value: Option<&Value>, key: &str) -> Option<Value> {
    value.filter(|v| !nullish(v)).and_then(|v| get(v, key).ok().flatten())
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ => !js::is_undefined(v) && js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    })
}

/// `a === b` (objects are never the same here).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => match (js::as_number(x), js::as_number(y)) {
            (Some(m), Some(n)) => m == n,
            (None, None) => !matches!(x, Value::Object(_) | Value::Array(_)) && x == y,
            _ => false,
        },
        _ => false,
    }
}

/// `list?.find(predicate)` with the predicate's own failures.
fn find(list: Option<Value>, name: &str, mut predicate: impl FnMut(&Value) -> Result<bool, String>) -> Result<Option<Value>, String> {
    match list {
        None => Ok(None),
        Some(Value::Array(items)) => {
            for item in items {
                if predicate(&item)? {
                    return Ok(Some(item));
                }
            }
            Ok(None)
        }
        Some(_) => Err(format!("{name}?.find is not a function")),
    }
}

/// JS `String.prototype.trim`.
fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// The items `for...of` walks (strings by code point).
fn iterate(value: &Value, name: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(format!("{name} is not iterable")),
    }
}

/// Port of `isQuestionOrphaned` (`question-orphan.ts:34`).
pub fn is_question_orphaned(request: Value, evidence: Value) -> Result<bool, String> {
    let tool = get(&request, "tool")?;
    let (message_id, call_id) = (opt(tool.as_ref(), "messageID"), opt(tool.as_ref(), "callID"));
    if !truthy(message_id.as_ref()) || !truthy(call_id.as_ref()) {
        return Ok(false);
    }
    let parts = get(&evidence, "parts")?.filter(|v| !v.is_null());
    let tool_part = find(parts, "evidence.parts", |part| {
        Ok(get(part, "type")?.as_ref().and_then(Value::as_str) == Some("tool") && same(get(part, "callID")?.as_ref(), call_id.as_ref()))
    })?;
    if let Some(part) = tool_part.filter(|p| truthy(Some(p))) {
        let status = opt(opt(Some(&part), "state").as_ref(), "status");
        // `typeof status === "string" && status.length > 0 && status !== "pending" && status !== "running"`.
        let text = status.as_ref().and_then(js::string_units).map(|u| String::from_utf16_lossy(&u));
        return Ok(text.is_some_and(|s| !s.is_empty() && s != "pending" && s != "running"));
    }
    let messages = get(&evidence, "messages")?.filter(|v| !v.is_null());
    let message = find(messages, "evidence.messages", |entry| Ok(same(get(entry, "id")?.as_ref(), message_id.as_ref())))?;
    let Some(message) = message.filter(|m| truthy(Some(m))) else {
        return Ok(false);
    };
    if !same(opt(Some(&message), "role").as_ref(), Some(&json!("assistant"))) {
        return Ok(false);
    }
    let aborted = opt(opt(Some(&message), "error").as_ref(), "name").as_ref().and_then(Value::as_str) == Some("MessageAbortedError");
    Ok(aborted
        && opt(opt(Some(&message), "time").as_ref(), "completed")
            .as_ref()
            .and_then(js::as_number)
            .is_some())
}

/// Port of `isPendingQuestionOrphaned` (`question-orphan.ts:62`).
pub fn is_pending_question_orphaned(state: Value, request: Value) -> Result<bool, String> {
    let tool = get(&request, "tool")?;
    let parts = if truthy(tool.as_ref()) {
        let table = get(&state, "part")?.unwrap_or_else(js::undefined);
        get(&table, &key_text(opt(tool.as_ref(), "messageID").as_ref()))?
    } else {
        None
    };
    let table = get(&state, "message")?.unwrap_or_else(js::undefined);
    let messages = get(&table, &key_text(get(&request, "sessionID")?.as_ref()))?;
    let undefined = || js::undefined();
    is_question_orphaned(
        request,
        json!({ "parts": parts.unwrap_or_else(undefined), "messages": messages.unwrap_or_else(undefined) }),
    )
}

/// Port of `countLivePendingQuestions` (`question-orphan.ts:73`).
pub fn count_live_pending_questions(state: Value, session_id: String) -> Result<f64, String> {
    let table = get(&state, "question")?.unwrap_or_else(js::undefined);
    let Some(questions) = get(&table, &session_id)?.filter(|q| truthy(Some(q))) else {
        return Ok(0.0);
    };
    if get(&questions, "length")?.as_ref().and_then(js::as_number) == Some(0.0) {
        return Ok(0.0);
    }
    let mut count = 0.0;
    for question in iterate(&questions, "questions")? {
        if !is_pending_question_orphaned(state.clone(), question)? {
            count += 1.0;
        }
    }
    Ok(count)
}

/// Port of `isQuestionOrphanedError` (`question-orphan.ts:85`).
pub fn is_question_orphaned_error(error: Value) -> Result<bool, String> {
    Ok(error.get("code").and_then(Value::as_str) == Some(QUESTION_ORPHANED_CODE))
}

/// `value.trim()` of a string member, failing as V8 does on anything else.
fn trimmed(value: Option<Value>, name: &str, optional: bool) -> Result<Option<String>, String> {
    match value {
        Some(Value::String(text)) => Ok(Some(trim(&text).to_string())),
        None if optional => Ok(None),
        Some(Value::Null) if optional => Ok(None),
        None => Err("Cannot read properties of undefined (reading 'trim')".to_string()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'trim')".to_string()),
        Some(_) => Err(format!("{name}{}trim is not a function", if optional { "?." } else { "." })),
    }
}

/// Port of `formatOrphanedQuestionAnswers` (`question-orphan.ts:97`).
pub fn format_orphaned_question_answers(entries: Value) -> Result<String, String> {
    let mut lines: Vec<String> = Vec::new();
    for entry in iterate(&entries, "entries")? {
        if nullish(&entry) {
            let shown = if entry.is_null() { "object null" } else { "undefined" };
            return Err(format!("Cannot destructure property 'request' of '{shown}' as it is {}.", kind(&entry)));
        }
        let (request, answers) = (get(&entry, "request")?, get(&entry, "answers")?);
        let questions = get(&request.unwrap_or_else(js::undefined), "questions")?;
        let Some(Value::Array(questions)) = questions else {
            let shown = questions.unwrap_or_else(js::undefined);
            get(&shown, "forEach")?;
            return Err("request.questions.forEach is not a function".to_string());
        };
        let answers = answers.unwrap_or_else(js::undefined);
        for (index, item) in questions.iter().enumerate() {
            let question = trimmed(get(item, "question")?, "entry.question", false)?.unwrap_or_default();
            let header = || trimmed(opt(Some(item), "header"), "entry.header", true);
            let question = match (question.is_empty(), if question.is_empty() { header()? } else { None }) {
                (false, _) => question,
                (true, Some(h)) if !h.is_empty() => h,
                _ => format!("Question {}", lines.len() + 1),
            };
            let given = get(&answers, &index.to_string())?.filter(|v| !v.is_null());
            let given = match given {
                None => Vec::new(),
                Some(Value::Array(values)) => values,
                Some(_) => return Err("(answers[index] ?? []).map is not a function".to_string()),
            };
            let mut answer = Vec::new();
            for value in given {
                answer.extend(trimmed(Some(value).filter(|v| !js::is_undefined(v)), "value", false)?.filter(|a| !a.is_empty()));
            }
            let shown = if answer.is_empty() { "(no answer)".to_string() } else { answer.join(", ") };
            lines.push(format!("- {question}\n  Answer: {shown}"));
        }
    }
    let mut all = vec!["My answers to the question you asked before the previous turn stopped:".to_string()];
    all.extend(lines);
    all.push("Continue the task using these answers.".to_string());
    Ok(all.join("\n"))
}

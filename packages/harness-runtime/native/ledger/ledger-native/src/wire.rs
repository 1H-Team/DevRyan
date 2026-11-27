//! The wire markers of the seam (`session-mutation-wire.js`): a function in
//! a call's input is `{"__devryanFunction":n}`, an async iterable in a result
//! is `{"__devryanStream":n}`, and an `Error` is
//! `{"__devryanError":true,name,message,code?,status?,committed?,rollbackFailed?,retryable?,reason?,errors?,cause?}`
//! with `errors` and `cause` at most four levels deep. Natively `stack` is
//! never written: the host keeps its own. Values nest at most 64 deep
//! (`mutation_wire_too_deep`).
#![forbid(unsafe_code)]

use std::rc::Rc;

use ledger_core::js::JsStr;

use crate::value::{ERROR_FIELDS, Func, JsError, Obj, Stream, W, code_error, to_js_string, truthy};

pub const FUNCTION: &str = "__devryanFunction";
pub const STREAM: &str = "__devryanStream";
pub const ERROR: &str = "__devryanError";
/// The deepest level `encodeWireValue` visits.
pub const MAX_WIRE_DEPTH: usize = 64;

pub type OnFunction<'a> = &'a mut dyn FnMut(&Rc<Func>) -> W;
pub type OnStream<'a> = &'a mut dyn FnMut(&Rc<dyn Stream>) -> W;

/// `encodeWireValue(value, { onFunction, onStream })`.
pub fn encode_wire_value(
    value: &W,
    mut on_function: Option<OnFunction<'_>>,
    mut on_stream: Option<OnStream<'_>>,
) -> Result<W, W> {
    visit(value, 0, &mut on_function, &mut on_stream)
}

fn visit(
    item: &W,
    depth: usize,
    on_function: &mut Option<OnFunction<'_>>,
    on_stream: &mut Option<OnStream<'_>>,
) -> Result<W, W> {
    if depth > MAX_WIRE_DEPTH {
        return Err(code_error("mutation_wire_too_deep"));
    }
    Ok(match item {
        W::Function(func) => match on_function {
            Some(assign) => W::object(vec![(FUNCTION, assign(func))]),
            None => return Err(code_error("mutation_wire_function")),
        },
        W::Error(_) => encode_wire_error(item, 0),
        W::Stream(stream) => match on_stream {
            Some(assign) => W::object(vec![(STREAM, assign(stream))]),
            None => return Err(code_error("mutation_wire_stream")),
        },
        W::Array(items) => W::Array(
            items
                .iter()
                .map(|entry| visit(entry, depth + 1, on_function, on_stream))
                .collect::<Result<_, _>>()?,
        ),
        W::Object(object) => {
            let mut out = Obj::new();
            for (key, entry) in object.iter() {
                out.set(
                    key.clone(),
                    visit(entry, depth + 1, on_function, on_stream)?,
                );
            }
            W::Object(out)
        }
        other => other.clone(),
    })
}

/// `decodeWireValue(value, { toFunction })` (the worker never decodes streams).
pub fn decode_wire_value(value: &W, to_function: Option<&dyn Fn(&W) -> W>) -> W {
    match value {
        W::Array(items) => W::Array(
            items
                .iter()
                .map(|item| decode_wire_value(item, to_function))
                .collect(),
        ),
        W::Object(object) => {
            if let (Some(id @ W::Number(_)), Some(make)) = (object.get(FUNCTION), to_function) {
                return make(id);
            }
            if matches!(object.get(ERROR), Some(W::Bool(true))) {
                return decode_wire_error(value);
            }
            let mut out = Obj::new();
            for (key, entry) in object.iter() {
                out.set(key.clone(), decode_wire_value(entry, to_function));
            }
            W::Object(out)
        }
        other => other.clone(),
    }
}

/// `encodeWireError(error, depth)`.
pub fn encode_wire_error(error: &W, depth: usize) -> W {
    let W::Error(error) = error else {
        return W::object(vec![
            (ERROR, W::Bool(true)),
            ("name", W::string("Error")),
            ("message", W::String(to_js_string(error))),
        ]);
    };
    let mut out = Obj::with(vec![
        (ERROR, W::Bool(true)),
        ("name", W::String(error.name.clone())),
        ("message", W::String(error.message.clone())),
    ]);
    for field in ERROR_FIELDS {
        if let Some(value @ (W::String(_) | W::Number(_) | W::Bool(_))) = error.field(field) {
            out.put(field, value.clone());
        }
    }
    if depth < 4 {
        if let Some(errors) = &error.errors {
            out.put(
                "errors",
                W::Array(
                    errors
                        .iter()
                        .map(|entry| encode_wire_error(entry, depth + 1))
                        .collect(),
                ),
            );
        }
        if let Some(cause) = &error.cause
            && !cause.is_undefined()
        {
            out.put("cause", encode_wire_error(cause, depth + 1));
        }
    }
    W::Object(out)
}

/// `decodeWireError(encoded)`: an `AggregateError` when `errors` is an array.
pub fn decode_wire_error(encoded: &W) -> W {
    let errors = match encoded.get("errors") {
        W::Array(items) => Some(items.iter().map(decode_wire_error).collect::<Vec<_>>()),
        _ => None,
    };
    let cause = encoded.get("cause");
    let cause = truthy(&cause).then(|| decode_wire_error(&cause));
    let message = encoded.get("message");
    let (default_name, message) = if errors.is_some() {
        // `new AggregateError(errors, encoded.message)`: no default text.
        (
            "AggregateError",
            if message.is_undefined() {
                JsStr::new()
            } else {
                to_js_string(&message)
            },
        )
    } else {
        match message {
            W::Undefined | W::Null => ("Error", JsStr::from("mutation_runtime_failed")),
            other => ("Error", to_js_string(&other)),
        }
    };
    let mut error = JsError::new(default_name, "");
    error.message = message;
    error.errors = errors;
    error.cause = cause;
    if let W::String(name) = encoded.get("name") {
        error.name = name;
    }
    for field in ERROR_FIELDS {
        let value = encoded.get(field);
        if !value.is_undefined() {
            error.set_field(field, value);
        }
    }
    if let W::String(stack) = encoded.get("stack") {
        error.stack = Some(stack);
    }
    W::Error(Rc::new(error))
}

/// A call's input spread into arguments (`runtime[method](...input)`),
/// with V8's `TypeError` for a value that is not iterable.
pub fn spread_arguments(input: &W) -> Result<Vec<W>, W> {
    match input {
        W::Array(items) => Ok(items.clone()),
        W::String(text) => {
            // A string spreads by code point; a lone surrogate is one element.
            let units = text.units();
            let mut out = Vec::new();
            let mut at = 0;
            while at < units.len() {
                let width = if (0xd800..0xdc00).contains(&units[at])
                    && at + 1 < units.len()
                    && (0xdc00..0xe000).contains(&units[at + 1])
                {
                    2
                } else {
                    1
                };
                out.push(W::String(JsStr::from_units(units[at..at + width].to_vec())));
                at += width;
            }
            Ok(out)
        }
        W::Bytes(bytes) => Ok(bytes
            .iter()
            .map(|byte| W::Number(f64::from(*byte)))
            .collect()),
        W::Undefined | W::Null => {
            let shown = if input.is_undefined() {
                "undefined"
            } else {
                "null"
            };
            Err(W::Error(Rc::new(JsError::new(
                "TypeError",
                &format!("input is not iterable (cannot read property {shown})"),
            ))))
        }
        _ => Err(W::Error(Rc::new(JsError::new(
            "TypeError",
            "Spread syntax requires ...iterable[Symbol.iterator] to be a function",
        )))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode_line, encode_line};

    fn text(value: &W) -> String {
        String::from_utf8(encode_line(value).unwrap())
            .unwrap()
            .trim_end()
            .to_string()
    }

    #[test]
    fn errors_round_trip_with_their_fields_and_a_bounded_chain() {
        let line = r#"{"__devryanError":true,"name":"Custom","message":"m","stack":"s","code":"c","status":409,"committed":true,"reason":{"x":1},"cause":{"__devryanError":true,"message":"1","cause":{"__devryanError":true,"message":"2","cause":{"__devryanError":true,"message":"3","cause":{"__devryanError":true,"message":"4","cause":{"__devryanError":true,"message":"5"}}}}}}"#;
        let decoded = decode_wire_value(&decode_line(line.as_bytes()).unwrap(), None);
        let encoded = encode_wire_error(&decoded, 0);
        assert_eq!(
            text(&encoded),
            r#"{"__devryanError":true,"name":"Custom","message":"m","code":"c","status":409,"committed":true,"cause":{"__devryanError":true,"name":"Error","message":"1","cause":{"__devryanError":true,"name":"Error","message":"2","cause":{"__devryanError":true,"name":"Error","message":"3","cause":{"__devryanError":true,"name":"Error","message":"4"}}}}}"#
        );
    }

    #[test]
    fn aggregate_errors_have_no_default_message() {
        let decoded = decode_wire_error(&decode_line(br#"{"errors":[5,null]}"#).unwrap());
        assert_eq!(
            text(&encode_wire_error(&decoded, 0)),
            r#"{"__devryanError":true,"name":"AggregateError","message":"","errors":[{"__devryanError":true,"name":"Error","message":"mutation_runtime_failed"},{"__devryanError":true,"name":"Error","message":"mutation_runtime_failed"}]}"#
        );
    }

    #[test]
    fn depth_is_bounded_at_sixty_four() {
        let mut value = W::Array(vec![]);
        for _ in 0..64 {
            value = W::Array(vec![value]);
        }
        assert!(encode_wire_value(&value, None, None).is_ok());
        let mut deeper = W::Number(1.0);
        for _ in 0..65 {
            deeper = W::Array(vec![deeper]);
        }
        assert!(encode_wire_value(&deeper, None, None).is_err());
    }
}

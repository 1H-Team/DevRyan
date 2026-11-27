//! A JavaScript throw as a Rust value, and the refusal of an input this port
//! does not cover.

use devryan_js_layer::js::{JsStr, Value};

/// What a JavaScript `throw` carries here: the error's `name` (its class for
/// the built-in errors: `TypeError`, `RangeError`, `Error`), its `message`,
/// and its own `code` property when the JavaScript sets one.
#[derive(Clone, Debug, PartialEq)]
pub struct JsError {
    pub name: String,
    pub message: JsStr,
    pub code: Option<Value>,
}

impl JsError {
    pub fn new(name: &str, message: impl Into<JsStr>) -> JsError {
        JsError {
            name: name.to_owned(),
            message: message.into(),
            code: None,
        }
    }

    /// The same error with an own `code` property (`Object.assign(error, { code })`).
    pub fn with_code(mut self, code: &str) -> JsError {
        self.code = Some(Value::string(code));
        self
    }
}

/// Why a call did not return.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    /// The JavaScript throws this error for the same input.
    Throw(Box<JsError>),
    /// The input reaches behaviour this port does not reproduce (named: the
    /// JavaScript leaf or semantics). The JavaScript answers something for it;
    /// the Rust answers nothing rather than something different.
    Unsupported(&'static str),
}

impl Failure {
    /// `Failure::Throw` of an error.
    pub fn throw(error: JsError) -> Failure {
        Failure::Throw(Box::new(error))
    }
}

pub type JsResult<T> = Result<T, Failure>;

/// `new TypeError(message)`.
pub fn type_error<T>(message: impl Into<JsStr>) -> JsResult<T> {
    Err(Failure::throw(JsError::new("TypeError", message)))
}

/// `new RangeError(message)`.
pub fn range_error<T>(message: impl Into<JsStr>) -> JsResult<T> {
    Err(Failure::throw(JsError::new("RangeError", message)))
}

/// `new Error(message)`.
pub fn plain_error<T>(message: impl Into<JsStr>) -> JsResult<T> {
    Err(Failure::throw(JsError::new("Error", message)))
}

/// `Object.assign(new TypeError(message), { code })`.
pub fn coded_type_error<T>(message: impl Into<JsStr>, code: &str) -> JsResult<T> {
    Err(Failure::throw(JsError::new("TypeError", message).with_code(code)))
}

/// The refusal of an input outside this port.
pub fn unsupported<T>(what: &'static str) -> JsResult<T> {
    Err(Failure::Unsupported(what))
}

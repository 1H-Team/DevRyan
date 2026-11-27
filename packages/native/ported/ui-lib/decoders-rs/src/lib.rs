//! JS bindings for `decoders/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!("Rust panic: {}", panic_message(&*payload)))),
    }
}

/// `decodeAssistantMessageError`.
#[napi(js_name = "decodeAssistantMessageError")]
pub fn decode_assistant_message_error(error: String) -> napi::Result<String> {
    run(move || {
        let error = crate::js::from_json(&error)?;
        let out = port::decode_assistant_message_error(error)?;
        crate::js::to_json(&out)
    })
}

/// `readAssistantMessageError`.
#[napi(js_name = "readAssistantMessageError")]
pub fn read_assistant_message_error(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_assistant_message_error(info)?;
        crate::js::to_json(&out)
    })
}

/// `isRecord`.
#[napi(js_name = "isRecord")]
pub fn is_record(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_record(value)?;
        Ok(out)
    })
}

/// `readString`.
#[napi(js_name = "readString")]
pub fn read_string(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::read_string(value)?;
        crate::js::to_json(&out)
    })
}

/// `isNullableString`.
#[napi(js_name = "isNullableString")]
pub fn is_nullable_string(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_nullable_string(value)?;
        Ok(out)
    })
}

/// `isOptionalNullableString`.
#[napi(js_name = "isOptionalNullableString")]
pub fn is_optional_nullable_string(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_optional_nullable_string(value)?;
        Ok(out)
    })
}

/// `isTimestamp`.
#[napi(js_name = "isTimestamp")]
pub fn is_timestamp(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_timestamp(value)?;
        Ok(out)
    })
}

/// `isNullableTimestamp`.
#[napi(js_name = "isNullableTimestamp")]
pub fn is_nullable_timestamp(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_nullable_timestamp(value)?;
        Ok(out)
    })
}

/// `isOptionalNullableTimestamp`.
#[napi(js_name = "isOptionalNullableTimestamp")]
pub fn is_optional_nullable_timestamp(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_optional_nullable_timestamp(value)?;
        Ok(out)
    })
}

/// `isCount`.
#[napi(js_name = "isCount")]
pub fn is_count(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_count(value)?;
        Ok(out)
    })
}

/// `decodeManagedTaskToolPart`.
#[napi(js_name = "decodeManagedTaskToolPart")]
pub fn decode_managed_task_tool_part(part: String) -> napi::Result<String> {
    run(move || {
        let part = crate::js::from_json(&part)?;
        let out = port::decode_managed_task_tool_part(part)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageRole`.
#[napi(js_name = "readMessageRole")]
pub fn read_message_role(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_role(info)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageId`.
#[napi(js_name = "readMessageId")]
pub fn read_message_id(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_id(info)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageParentId`.
#[napi(js_name = "readMessageParentId")]
pub fn read_message_parent_id(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_parent_id(info)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageSessionId`.
#[napi(js_name = "readMessageSessionId")]
pub fn read_message_session_id(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_session_id(info)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageClientRole`.
#[napi(js_name = "readMessageClientRole")]
pub fn read_message_client_role(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_client_role(info)?;
        crate::js::to_json(&out)
    })
}

/// `readMessageCreatedAt`.
#[napi(js_name = "readMessageCreatedAt")]
pub fn read_message_created_at(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::read_message_created_at(info)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

type WireBuffers = (
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint32Array,
);

thread_local! {
    static WIRE: std::cell::RefCell<Option<WireBuffers>> = const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument, result and argument-length buffers `index.cjs` uses.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(input: napi::bindgen_prelude::Uint8Array, output: napi::bindgen_prelude::Uint8Array, len: napi::bindgen_prelude::Uint32Array) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output, len)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output, _)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads the argument bytes (`wLen[0]` of them), runs `f`, and writes its result; a negative
/// return is the size of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output, len)) = guard.as_mut() else {
            return Err(napi::Error::from_reason("rust-anything: the wire buffers are not registered"));
        };
        let len = (len.first().copied().unwrap_or(0) as usize).min(input.len());
        let mut w = wire::Writer(SCRATCH.with(|s| std::mem::take(&mut *s.borrow_mut())));
        w.0.clear();
        let result = run(|| f(&mut wire::Reader::new(&input[..len]), &mut w));
        let keep = |w: wire::Writer| SCRATCH.with(|s| *s.borrow_mut() = w.0);
        match result {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => {
                keep(w);
                return Ok(f64::NAN);
            }
            Err(e) => {
                keep(w);
                let mut m = wire::Writer::default();
                m.string16(&e.reason);
                // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
                let out = unsafe { output.as_mut() };
                if m.0.len() > out.len() {
                    return Err(e);
                }
                out[..m.0.len()].copy_from_slice(&m.0);
                return Ok(f64::INFINITY);
            }
            Ok(()) => {}
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        keep(w);
        Ok(n as f64)
    })
}

static S_DECODE_ASSISTANT_MESSAGE_ERROR_0: wire::Schema = wire::Schema::Dyn;
static S_DECODE_ASSISTANT_MESSAGE_ERROR_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("name", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("message", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("dataMessage", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("detail", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("abortSource", wire::Schema::Dyn),
]));

/// `decodeAssistantMessageError` over the binary wire.
#[napi(js_name = "decodeAssistantMessageErrorWire")]
pub fn decode_assistant_message_error_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let error: Value = wire::read_value(r, &S_DECODE_ASSISTANT_MESSAGE_ERROR_0)?;
        let out = &port::decode_assistant_message_error(error)?;
        wire::write_value(w, out, &S_DECODE_ASSISTANT_MESSAGE_ERROR_OUT)?;
        Ok(())
    })
}

static S_READ_ASSISTANT_MESSAGE_ERROR_0: wire::Schema = wire::Schema::Dyn;
static S_READ_ASSISTANT_MESSAGE_ERROR_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("name", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("message", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("dataMessage", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("detail", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("abortSource", wire::Schema::Dyn),
]));

/// `readAssistantMessageError` over the binary wire.
#[napi(js_name = "readAssistantMessageErrorWire")]
pub fn read_assistant_message_error_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_ASSISTANT_MESSAGE_ERROR_0)?;
        let out = &port::read_assistant_message_error(info)?;
        wire::write_value(w, out, &S_READ_ASSISTANT_MESSAGE_ERROR_OUT)?;
        Ok(())
    })
}

static S_IS_RECORD_0: wire::Schema = wire::Schema::Dyn;

/// `isRecord` over the binary wire.
#[napi(js_name = "isRecordWire")]
pub fn is_record_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_RECORD_0)?;
        let out = &port::is_record(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_READ_STRING_0: wire::Schema = wire::Schema::Dyn;
static S_READ_STRING_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readString` over the binary wire.
#[napi(js_name = "readStringWire")]
pub fn read_string_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_READ_STRING_0)?;
        let out = &port::read_string(value)?;
        wire::write_value(w, out, &S_READ_STRING_OUT)?;
        Ok(())
    })
}

static S_IS_NULLABLE_STRING_0: wire::Schema = wire::Schema::Dyn;

/// `isNullableString` over the binary wire.
#[napi(js_name = "isNullableStringWire")]
pub fn is_nullable_string_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_NULLABLE_STRING_0)?;
        let out = &port::is_nullable_string(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_OPTIONAL_NULLABLE_STRING_0: wire::Schema = wire::Schema::Dyn;

/// `isOptionalNullableString` over the binary wire.
#[napi(js_name = "isOptionalNullableStringWire")]
pub fn is_optional_nullable_string_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_OPTIONAL_NULLABLE_STRING_0)?;
        let out = &port::is_optional_nullable_string(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_TIMESTAMP_0: wire::Schema = wire::Schema::Dyn;

/// `isTimestamp` over the binary wire.
#[napi(js_name = "isTimestampWire")]
pub fn is_timestamp_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_TIMESTAMP_0)?;
        let out = &port::is_timestamp(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_NULLABLE_TIMESTAMP_0: wire::Schema = wire::Schema::Dyn;

/// `isNullableTimestamp` over the binary wire.
#[napi(js_name = "isNullableTimestampWire")]
pub fn is_nullable_timestamp_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_NULLABLE_TIMESTAMP_0)?;
        let out = &port::is_nullable_timestamp(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_OPTIONAL_NULLABLE_TIMESTAMP_0: wire::Schema = wire::Schema::Dyn;

/// `isOptionalNullableTimestamp` over the binary wire.
#[napi(js_name = "isOptionalNullableTimestampWire")]
pub fn is_optional_nullable_timestamp_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_OPTIONAL_NULLABLE_TIMESTAMP_0)?;
        let out = &port::is_optional_nullable_timestamp(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_COUNT_0: wire::Schema = wire::Schema::Dyn;

/// `isCount` over the binary wire.
#[napi(js_name = "isCountWire")]
pub fn is_count_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_COUNT_0)?;
        let out = &port::is_count(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_DECODE_MANAGED_TASK_TOOL_PART_0: wire::Schema = wire::Schema::Dyn;
static S_DECODE_MANAGED_TASK_TOOL_PART_OUT: wire::Schema = wire::Schema::Obj(&[
    ("action", wire::Schema::Str16),
    ("status", wire::Schema::Str16),
    ("agent", wire::Schema::Str16),
    ("label", wire::Schema::Str16),
    ("inputTaskId", wire::Schema::Str16),
    ("output", wire::Schema::OptJs(&wire::Schema::Map16(&wire::Schema::Dyn))),
    ("outputTask", wire::Schema::OptJs(&wire::Schema::Map16(&wire::Schema::Dyn))),
    ("followUpTask", wire::Schema::OptJs(&wire::Schema::Map16(&wire::Schema::Dyn))),
    ("error", wire::Schema::Dyn),
]);

/// `decodeManagedTaskToolPart` over the binary wire.
#[napi(js_name = "decodeManagedTaskToolPartWire")]
pub fn decode_managed_task_tool_part_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let part: Value = wire::read_value(r, &S_DECODE_MANAGED_TASK_TOOL_PART_0)?;
        let out = &port::decode_managed_task_tool_part(part)?;
        wire::write_value(w, out, &S_DECODE_MANAGED_TASK_TOOL_PART_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_ROLE_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_ROLE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readMessageRole` over the binary wire.
#[napi(js_name = "readMessageRoleWire")]
pub fn read_message_role_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_ROLE_0)?;
        let out = &port::read_message_role(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_ROLE_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_ID_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readMessageId` over the binary wire.
#[napi(js_name = "readMessageIdWire")]
pub fn read_message_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_ID_0)?;
        let out = &port::read_message_id(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_ID_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_PARENT_ID_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_PARENT_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readMessageParentId` over the binary wire.
#[napi(js_name = "readMessageParentIdWire")]
pub fn read_message_parent_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_PARENT_ID_0)?;
        let out = &port::read_message_parent_id(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_PARENT_ID_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_SESSION_ID_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_SESSION_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readMessageSessionId` over the binary wire.
#[napi(js_name = "readMessageSessionIdWire")]
pub fn read_message_session_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_SESSION_ID_0)?;
        let out = &port::read_message_session_id(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_SESSION_ID_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_CLIENT_ROLE_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_CLIENT_ROLE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `readMessageClientRole` over the binary wire.
#[napi(js_name = "readMessageClientRoleWire")]
pub fn read_message_client_role_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_CLIENT_ROLE_0)?;
        let out = &port::read_message_client_role(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_CLIENT_ROLE_OUT)?;
        Ok(())
    })
}

static S_READ_MESSAGE_CREATED_AT_0: wire::Schema = wire::Schema::Dyn;
static S_READ_MESSAGE_CREATED_AT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Num);

/// `readMessageCreatedAt` over the binary wire.
#[napi(js_name = "readMessageCreatedAtWire")]
pub fn read_message_created_at_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_READ_MESSAGE_CREATED_AT_0)?;
        let out = &port::read_message_created_at(info)?;
        wire::write_value(w, out, &S_READ_MESSAGE_CREATED_AT_OUT)?;
        Ok(())
    })
}

//! JS bindings for `status.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `toV1RetryStatus`.
#[napi(js_name = "toV1RetryStatus")]
pub fn to_v1_retry_status(retry: String) -> napi::Result<String> {
    run(move || {
        let retry = crate::js::from_json(&retry)?;
        let out = port::to_v1_retry_status(retry)?;
        crate::js::to_json(&out)
    })
}

/// `statusForEvent`.
#[napi(js_name = "statusForEvent")]
pub fn status_for_event(r#type: String, data: String) -> napi::Result<String> {
    run(move || {
        let r#type = crate::js::from_json(&r#type)?;
        let data = crate::js::from_json(&data)?;
        let out = port::status_for_event(r#type, data)?;
        crate::js::to_json(&out)
    })
}

/// `isSameStatus`.
#[napi(js_name = "isSameStatus")]
pub fn is_same_status(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::is_same_status(left, right)?;
        Ok(out)
    })
}

/// `retryStatusFromMessages`.
#[napi(js_name = "retryStatusFromMessages")]
pub fn retry_status_from_messages(messages: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::retry_status_from_messages(messages)?;
        crate::js::to_json(&out)
    })
}

/// `activeSessionIDs`.
#[napi(js_name = "activeSessionIDs")]
pub fn active_session_i_ds(body: String) -> napi::Result<String> {
    run(move || {
        let body = crate::js::from_json(&body)?;
        let out = port::active_session_i_ds(body)?;
        crate::js::to_json(&out)
    })
}

/// `statusesFromActive`.
#[napi(js_name = "statusesFromActive")]
pub fn statuses_from_active(body: String, options: String) -> napi::Result<String> {
    run(move || {
        let body = crate::js::from_json(&body)?;
        let options = crate::js::from_json(&options)?;
        let out = port::statuses_from_active(body, options)?;
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

static S_TO_V1_RETRY_STATUS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_RETRY_STATUS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1RetryStatus` over the binary wire.
#[napi(js_name = "toV1RetryStatusWire")]
pub fn to_v1_retry_status_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let retry: Value = wire::read_value(r, &S_TO_V1_RETRY_STATUS_0)?;
        let out = &port::to_v1_retry_status(retry)?;
        wire::write_value(w, out, &S_TO_V1_RETRY_STATUS_OUT)?;
        Ok(())
    })
}

static S_STATUS_FOR_EVENT_0: wire::Schema = wire::Schema::Dyn;
static S_STATUS_FOR_EVENT_1: wire::Schema = wire::Schema::Dyn;
static S_STATUS_FOR_EVENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `statusForEvent` over the binary wire.
#[napi(js_name = "statusForEventWire")]
pub fn status_for_event_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let r#type: Value = wire::read_value(r, &S_STATUS_FOR_EVENT_0)?;
        let data: Value = wire::read_value(r, &S_STATUS_FOR_EVENT_1)?;
        let out = &port::status_for_event(r#type, data)?;
        wire::write_value(w, out, &S_STATUS_FOR_EVENT_OUT)?;
        Ok(())
    })
}

static S_IS_SAME_STATUS_0: wire::Schema = wire::Schema::Dyn;
static S_IS_SAME_STATUS_1: wire::Schema = wire::Schema::Dyn;

/// `isSameStatus` over the binary wire.
#[napi(js_name = "isSameStatusWire")]
pub fn is_same_status_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_IS_SAME_STATUS_0)?;
        let right: Value = wire::read_value(r, &S_IS_SAME_STATUS_1)?;
        let out = &port::is_same_status(left, right)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_RETRY_STATUS_FROM_MESSAGES_0: wire::Schema = wire::Schema::Dyn;
static S_RETRY_STATUS_FROM_MESSAGES_OUT: wire::Schema = wire::Schema::Dyn;

/// `retryStatusFromMessages` over the binary wire.
#[napi(js_name = "retryStatusFromMessagesWire")]
pub fn retry_status_from_messages_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_RETRY_STATUS_FROM_MESSAGES_0)?;
        let out = &port::retry_status_from_messages(messages)?;
        wire::write_value(w, out, &S_RETRY_STATUS_FROM_MESSAGES_OUT)?;
        Ok(())
    })
}

static S_ACTIVE_SESSION_I_DS_0: wire::Schema = wire::Schema::Dyn;
static S_ACTIVE_SESSION_I_DS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Str16);

/// `activeSessionIDs` over the binary wire.
#[napi(js_name = "activeSessionIDsWire")]
pub fn active_session_i_ds_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let body: Value = wire::read_value(r, &S_ACTIVE_SESSION_I_DS_0)?;
        let out = &port::active_session_i_ds(body)?;
        wire::write_value(w, out, &S_ACTIVE_SESSION_I_DS_OUT)?;
        Ok(())
    })
}

static S_STATUSES_FROM_ACTIVE_0: wire::Schema = wire::Schema::Dyn;
static S_STATUSES_FROM_ACTIVE_1: wire::Schema = wire::Schema::Dyn;
static S_STATUSES_FROM_ACTIVE_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Dyn);

/// `statusesFromActive` over the binary wire.
#[napi(js_name = "statusesFromActiveWire")]
pub fn statuses_from_active_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let body: Value = wire::read_value(r, &S_STATUSES_FROM_ACTIVE_0)?;
        let options: Value = wire::read_value(r, &S_STATUSES_FROM_ACTIVE_1)?;
        let out = &port::statuses_from_active(body, options)?;
        wire::write_value(w, out, &S_STATUSES_FROM_ACTIVE_OUT)?;
        Ok(())
    })
}

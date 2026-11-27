//! JS bindings for `display-session.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isSessionLifecycleTimestamp`.
#[napi(js_name = "isSessionLifecycleTimestamp")]
pub fn is_session_lifecycle_timestamp(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_session_lifecycle_timestamp(value)?;
        Ok(out)
    })
}

/// `isSessionOutcome`.
#[napi(js_name = "isSessionOutcome")]
pub fn is_session_outcome(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_session_outcome(value)?;
        Ok(out)
    })
}

/// `isSessionFork`.
#[napi(js_name = "isSessionFork")]
pub fn is_session_fork(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_session_fork(value)?;
        Ok(out)
    })
}

/// `readSessionLifecycle`.
#[napi(js_name = "readSessionLifecycle")]
pub fn read_session_lifecycle(session: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::read_session_lifecycle(session)?;
        crate::js::to_json(&out)
    })
}

/// `sameSessionLifecycle`.
#[napi(js_name = "sameSessionLifecycle")]
pub fn same_session_lifecycle(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::same_session_lifecycle(left, right)?;
        Ok(out)
    })
}

/// `withSessionLifecycle`.
#[napi(js_name = "withSessionLifecycle")]
pub fn with_session_lifecycle(session: String, lifecycle: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let lifecycle = crate::js::from_json(&lifecycle)?;
        let out = port::with_session_lifecycle(session, lifecycle)?;
        crate::js::to_json(&out)
    })
}

/// `decodeDisplaySession`.
#[napi(js_name = "decodeDisplaySession")]
pub fn decode_display_session(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::decode_display_session(value)?;
        crate::js::to_json(&out)
    })
}

/// `decodeSessionEventInfo`.
#[napi(js_name = "decodeSessionEventInfo")]
pub fn decode_session_event_info(properties: String) -> napi::Result<String> {
    run(move || {
        let properties = crate::js::from_json(&properties)?;
        let out = port::decode_session_event_info(properties)?;
        crate::js::to_json(&out)
    })
}

/// `decodeDisplaySessionList`.
#[napi(js_name = "decodeDisplaySessionList")]
pub fn decode_display_session_list(values: String) -> napi::Result<String> {
    run(move || {
        let values = crate::js::from_json(&values)?;
        let out = port::decode_display_session_list(values)?;
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

static S_IS_SESSION_LIFECYCLE_TIMESTAMP_0: wire::Schema = wire::Schema::Dyn;

/// `isSessionLifecycleTimestamp` over the binary wire.
#[napi(js_name = "isSessionLifecycleTimestampWire")]
pub fn is_session_lifecycle_timestamp_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_SESSION_LIFECYCLE_TIMESTAMP_0)?;
        let out = &port::is_session_lifecycle_timestamp(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_SESSION_OUTCOME_0: wire::Schema = wire::Schema::Dyn;

/// `isSessionOutcome` over the binary wire.
#[napi(js_name = "isSessionOutcomeWire")]
pub fn is_session_outcome_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_SESSION_OUTCOME_0)?;
        let out = &port::is_session_outcome(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_SESSION_FORK_0: wire::Schema = wire::Schema::Dyn;

/// `isSessionFork` over the binary wire.
#[napi(js_name = "isSessionForkWire")]
pub fn is_session_fork_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_SESSION_FORK_0)?;
        let out = &port::is_session_fork(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_READ_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_READ_SESSION_LIFECYCLE_OUT: wire::Schema = wire::Schema::Obj(&[
    ("busy", wire::Schema::OptJs(&wire::Schema::Num)),
    ("idle", wire::Schema::OptJs(&wire::Schema::Num)),
    ("viewed", wire::Schema::OptJs(&wire::Schema::Num)),
    ("outcome", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "fork",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("sessionID", wire::Schema::Str16),
            (
                "boundary",
                wire::Schema::Obj(&[("type", wire::Schema::Str16), ("messageID", wire::Schema::Str16)]),
            ),
        ])),
    ),
]);

/// `readSessionLifecycle` over the binary wire.
#[napi(js_name = "readSessionLifecycleWire")]
pub fn read_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Value = wire::read_value(r, &S_READ_SESSION_LIFECYCLE_0)?;
        let out = &port::read_session_lifecycle(session)?;
        wire::write_value(w, out, &S_READ_SESSION_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_SAME_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_SAME_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;

/// `sameSessionLifecycle` over the binary wire.
#[napi(js_name = "sameSessionLifecycleWire")]
pub fn same_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_SAME_SESSION_LIFECYCLE_0)?;
        let right: Value = wire::read_value(r, &S_SAME_SESSION_LIFECYCLE_1)?;
        let out = &port::same_session_lifecycle(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_WITH_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_WITH_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_WITH_SESSION_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `withSessionLifecycle` over the binary wire.
#[napi(js_name = "withSessionLifecycleWire")]
pub fn with_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Value = wire::read_value(r, &S_WITH_SESSION_LIFECYCLE_0)?;
        let lifecycle: Value = wire::read_value(r, &S_WITH_SESSION_LIFECYCLE_1)?;
        let out = &port::with_session_lifecycle(session, lifecycle)?;
        wire::write_value(w, out, &S_WITH_SESSION_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_DECODE_DISPLAY_SESSION_0: wire::Schema = wire::Schema::Dyn;
static S_DECODE_DISPLAY_SESSION_OUT: wire::Schema = wire::Schema::Dyn;

/// `decodeDisplaySession` over the binary wire.
#[napi(js_name = "decodeDisplaySessionWire")]
pub fn decode_display_session_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_DECODE_DISPLAY_SESSION_0)?;
        let out = &port::decode_display_session(value)?;
        wire::write_value(w, out, &S_DECODE_DISPLAY_SESSION_OUT)?;
        Ok(())
    })
}

static S_DECODE_SESSION_EVENT_INFO_0: wire::Schema = wire::Schema::Dyn;
static S_DECODE_SESSION_EVENT_INFO_OUT: wire::Schema = wire::Schema::Dyn;

/// `decodeSessionEventInfo` over the binary wire.
#[napi(js_name = "decodeSessionEventInfoWire")]
pub fn decode_session_event_info_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let properties: Value = wire::read_value(r, &S_DECODE_SESSION_EVENT_INFO_0)?;
        let out = &port::decode_session_event_info(properties)?;
        wire::write_value(w, out, &S_DECODE_SESSION_EVENT_INFO_OUT)?;
        Ok(())
    })
}

static S_DECODE_DISPLAY_SESSION_LIST_0: wire::Schema = wire::Schema::Dyn;

/// `decodeDisplaySessionList` over the binary wire.
#[napi(js_name = "decodeDisplaySessionListWire")]
pub fn decode_display_session_list_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let values: Value = wire::read_value(r, &S_DECODE_DISPLAY_SESSION_LIST_0)?;
        let out = &port::decode_display_session_list(values)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

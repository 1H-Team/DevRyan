//! JS bindings for `revert-transactions.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `beginCommittedRevertResend`.
#[napi(js_name = "beginCommittedRevertResend")]
pub fn begin_committed_revert_resend(session_id: String, message_id: Option<String>) -> napi::Result<()> {
    run(move || {
        port::begin_committed_revert_resend(session_id, message_id)?;
        Ok(())
    })
}

/// `endCommittedRevertResend`.
#[napi(js_name = "endCommittedRevertResend")]
pub fn end_committed_revert_resend(session_id: String, message_id: Option<String>) -> napi::Result<()> {
    run(move || {
        port::end_committed_revert_resend(session_id, message_id)?;
        Ok(())
    })
}

/// `clearCommittedRevertResendsForSessions`.
#[napi(js_name = "clearCommittedRevertResendsForSessions")]
pub fn clear_committed_revert_resends_for_sessions(session_i_ds: String) -> napi::Result<()> {
    run(move || {
        let session_i_ds = crate::js::from_json(&session_i_ds)?;
        port::clear_committed_revert_resends_for_sessions(session_i_ds)?;
        Ok(())
    })
}

/// `isCommittedRevertResendInFlight`.
#[napi(js_name = "isCommittedRevertResendInFlight")]
pub fn is_committed_revert_resend_in_flight(session_id: String, message_id: Option<String>) -> napi::Result<bool> {
    run(move || {
        let out = port::is_committed_revert_resend_in_flight(session_id, message_id)?;
        Ok(out)
    })
}

/// `getSessionRevertMessageID`.
#[napi(js_name = "getSessionRevertMessageID")]
pub fn get_session_revert_message_id(session: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::get_session_revert_message_id(session)?;
        crate::js::to_json(&out)
    })
}

/// `getEffectiveSessionRevertMessageID`.
#[napi(js_name = "getEffectiveSessionRevertMessageID")]
pub fn get_effective_session_revert_message_id(state: String, session_id: String, session: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let session = crate::js::from_json(&session)?;
        let out = port::get_effective_session_revert_message_id(state, session_id, session)?;
        crate::js::to_json(&out)
    })
}

/// `isMessageHiddenByRevert`.
#[napi(js_name = "isMessageHiddenByRevert")]
pub fn is_message_hidden_by_revert(state: String, session_id: Option<String>, message_id: String) -> napi::Result<bool> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let out = port::is_message_hidden_by_revert(state, session_id, message_id)?;
        Ok(out)
    })
}

/// `isMessageHiddenByAnyActiveRevert`.
#[napi(js_name = "isMessageHiddenByAnyActiveRevert")]
pub fn is_message_hidden_by_any_active_revert(state: String, message_id: String) -> napi::Result<bool> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let out = port::is_message_hidden_by_any_active_revert(state, message_id)?;
        Ok(out)
    })
}

/// `filterMessagesForRevert`.
#[napi(js_name = "filterMessagesForRevert")]
pub fn filter_messages_for_revert(messages: String, revert_message_id: Option<String>) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::filter_messages_for_revert(messages, revert_message_id)?;
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

/// `beginCommittedRevertResend` over the binary wire.
#[napi(js_name = "beginCommittedRevertResendWire")]
pub fn begin_committed_revert_resend_wire() -> napi::Result<f64> {
    wire_io(|r, _w| {
        let session_id: String = r.string16()?;
        let message_id: Option<String> = r.opt_js(|r| r.string16())?;
        let () = port::begin_committed_revert_resend(session_id, message_id)?;
        Ok(())
    })
}

/// `endCommittedRevertResend` over the binary wire.
#[napi(js_name = "endCommittedRevertResendWire")]
pub fn end_committed_revert_resend_wire() -> napi::Result<f64> {
    wire_io(|r, _w| {
        let session_id: String = r.string16()?;
        let message_id: Option<String> = r.opt_js(|r| r.string16())?;
        let () = port::end_committed_revert_resend(session_id, message_id)?;
        Ok(())
    })
}

static S_CLEAR_COMMITTED_REVERT_RESENDS_FOR_SESSIONS_0: wire::Schema = wire::Schema::Dyn;

/// `clearCommittedRevertResendsForSessions` over the binary wire.
#[napi(js_name = "clearCommittedRevertResendsForSessionsWire")]
pub fn clear_committed_revert_resends_for_sessions_wire() -> napi::Result<f64> {
    wire_io(|r, _w| {
        let session_i_ds: Value = wire::read_value(r, &S_CLEAR_COMMITTED_REVERT_RESENDS_FOR_SESSIONS_0)?;
        let () = port::clear_committed_revert_resends_for_sessions(session_i_ds)?;
        Ok(())
    })
}

/// `isCommittedRevertResendInFlight` over the binary wire.
#[napi(js_name = "isCommittedRevertResendInFlightWire")]
pub fn is_committed_revert_resend_in_flight_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session_id: String = r.string16()?;
        let message_id: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::is_committed_revert_resend_in_flight(session_id, message_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_GET_SESSION_REVERT_MESSAGE_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getSessionRevertMessageID` over the binary wire.
#[napi(js_name = "getSessionRevertMessageIDWire")]
pub fn get_session_revert_message_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::get_session_revert_message_id(session)?;
        wire::write_value(w, out, &S_GET_SESSION_REVERT_MESSAGE_ID_OUT)?;
        Ok(())
    })
}

static S_GET_EFFECTIVE_SESSION_REVERT_MESSAGE_ID_0: wire::Schema = wire::Schema::Dyn;
static S_GET_EFFECTIVE_SESSION_REVERT_MESSAGE_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getEffectiveSessionRevertMessageID` over the binary wire.
#[napi(js_name = "getEffectiveSessionRevertMessageIDWire")]
pub fn get_effective_session_revert_message_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_GET_EFFECTIVE_SESSION_REVERT_MESSAGE_ID_0)?;
        let session_id: String = r.string16()?;
        let session: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::get_effective_session_revert_message_id(state, session_id, session)?;
        wire::write_value(w, out, &S_GET_EFFECTIVE_SESSION_REVERT_MESSAGE_ID_OUT)?;
        Ok(())
    })
}

static S_IS_MESSAGE_HIDDEN_BY_REVERT_0: wire::Schema = wire::Schema::Dyn;

/// `isMessageHiddenByRevert` over the binary wire.
#[napi(js_name = "isMessageHiddenByRevertWire")]
pub fn is_message_hidden_by_revert_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_IS_MESSAGE_HIDDEN_BY_REVERT_0)?;
        let session_id: Option<String> = r.opt_js(|r| r.string16())?;
        let message_id: String = r.string16()?;
        let out = &port::is_message_hidden_by_revert(state, session_id, message_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_MESSAGE_HIDDEN_BY_ANY_ACTIVE_REVERT_0: wire::Schema = wire::Schema::Dyn;

/// `isMessageHiddenByAnyActiveRevert` over the binary wire.
#[napi(js_name = "isMessageHiddenByAnyActiveRevertWire")]
pub fn is_message_hidden_by_any_active_revert_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_IS_MESSAGE_HIDDEN_BY_ANY_ACTIVE_REVERT_0)?;
        let message_id: String = r.string16()?;
        let out = &port::is_message_hidden_by_any_active_revert(state, message_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_FILTER_MESSAGES_FOR_REVERT_0: wire::Schema = wire::Schema::Dyn;
static S_FILTER_MESSAGES_FOR_REVERT_OUT: wire::Schema = wire::Schema::Dyn;

/// `filterMessagesForRevert` over the binary wire.
#[napi(js_name = "filterMessagesForRevertWire")]
pub fn filter_messages_for_revert_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_FILTER_MESSAGES_FOR_REVERT_0)?;
        let revert_message_id: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::filter_messages_for_revert(messages, revert_message_id)?;
        wire::write_value(w, out, &S_FILTER_MESSAGES_FOR_REVERT_OUT)?;
        Ok(())
    })
}

//! JS bindings for `session-working.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `hasTerminalAssistantFinish`.
#[napi(js_name = "hasTerminalAssistantFinish")]
pub fn has_terminal_assistant_finish(message: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::has_terminal_assistant_finish(message)?;
        Ok(out)
    })
}

/// `hasToolCallAssistantFinish`.
#[napi(js_name = "hasToolCallAssistantFinish")]
pub fn has_tool_call_assistant_finish(message: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::has_tool_call_assistant_finish(message)?;
        Ok(out)
    })
}

/// `isTerminalAssistantMessage`.
#[napi(js_name = "isTerminalAssistantMessage")]
pub fn is_terminal_assistant_message(message: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::is_terminal_assistant_message(message)?;
        Ok(out)
    })
}

/// `isAssistantTurnComplete`.
#[napi(js_name = "isAssistantTurnComplete")]
pub fn is_assistant_turn_complete(message: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::is_assistant_turn_complete(message)?;
        Ok(out)
    })
}

/// `isIncompleteAssistantMessage`.
#[napi(js_name = "isIncompleteAssistantMessage")]
pub fn is_incomplete_assistant_message(message: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::is_incomplete_assistant_message(message)?;
        Ok(out)
    })
}

/// `hasInFlightToolParts`.
#[napi(js_name = "hasInFlightToolParts")]
pub fn has_in_flight_tool_parts(parts: String) -> napi::Result<bool> {
    run(move || {
        let parts = crate::js::from_json(&parts)?;
        let out = port::has_in_flight_tool_parts(parts)?;
        Ok(out)
    })
}

/// `hasVisibleAssistantSummary`.
#[napi(js_name = "hasVisibleAssistantSummary")]
pub fn has_visible_assistant_summary(parts: String) -> napi::Result<bool> {
    run(move || {
        let parts = crate::js::from_json(&parts)?;
        let out = port::has_visible_assistant_summary(parts)?;
        Ok(out)
    })
}

/// `isFinalAssistantSummaryMessage`.
#[napi(js_name = "isFinalAssistantSummaryMessage")]
pub fn is_final_assistant_summary_message(message: String, parts: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let parts = crate::js::from_json(&parts)?;
        let out = port::is_final_assistant_summary_message(message, parts)?;
        Ok(out)
    })
}

/// `isLiveAssistantMessage`.
#[napi(js_name = "isLiveAssistantMessage")]
pub fn is_live_assistant_message(message: String, parts: String) -> napi::Result<bool> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let parts = crate::js::from_json(&parts)?;
        let out = port::is_live_assistant_message(message, parts)?;
        Ok(out)
    })
}

/// `isSessionWorkingFromState`.
#[napi(js_name = "isSessionWorkingFromState")]
pub fn is_session_working_from_state(arg0: String) -> napi::Result<bool> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::is_session_working_from_state(arg0)?;
        Ok(out)
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

/// `hasTerminalAssistantFinish` over the binary wire.
#[napi(js_name = "hasTerminalAssistantFinishWire")]
pub fn has_terminal_assistant_finish_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::has_terminal_assistant_finish(message)?;
        w.bool(*out);
        Ok(())
    })
}

/// `hasToolCallAssistantFinish` over the binary wire.
#[napi(js_name = "hasToolCallAssistantFinishWire")]
pub fn has_tool_call_assistant_finish_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::has_tool_call_assistant_finish(message)?;
        w.bool(*out);
        Ok(())
    })
}

/// `isTerminalAssistantMessage` over the binary wire.
#[napi(js_name = "isTerminalAssistantMessageWire")]
pub fn is_terminal_assistant_message_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::is_terminal_assistant_message(message)?;
        w.bool(*out);
        Ok(())
    })
}

/// `isAssistantTurnComplete` over the binary wire.
#[napi(js_name = "isAssistantTurnCompleteWire")]
pub fn is_assistant_turn_complete_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::is_assistant_turn_complete(message)?;
        w.bool(*out);
        Ok(())
    })
}

/// `isIncompleteAssistantMessage` over the binary wire.
#[napi(js_name = "isIncompleteAssistantMessageWire")]
pub fn is_incomplete_assistant_message_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::is_incomplete_assistant_message(message)?;
        w.bool(*out);
        Ok(())
    })
}

static S_HAS_IN_FLIGHT_TOOL_PARTS_0: wire::Schema = wire::Schema::Dyn;

/// `hasInFlightToolParts` over the binary wire.
#[napi(js_name = "hasInFlightToolPartsWire")]
pub fn has_in_flight_tool_parts_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let parts: Value = wire::read_value(r, &S_HAS_IN_FLIGHT_TOOL_PARTS_0)?;
        let out = &port::has_in_flight_tool_parts(parts)?;
        w.bool(*out);
        Ok(())
    })
}

static S_HAS_VISIBLE_ASSISTANT_SUMMARY_0: wire::Schema = wire::Schema::Dyn;

/// `hasVisibleAssistantSummary` over the binary wire.
#[napi(js_name = "hasVisibleAssistantSummaryWire")]
pub fn has_visible_assistant_summary_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let parts: Value = wire::read_value(r, &S_HAS_VISIBLE_ASSISTANT_SUMMARY_0)?;
        let out = &port::has_visible_assistant_summary(parts)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_FINAL_ASSISTANT_SUMMARY_MESSAGE_1: wire::Schema = wire::Schema::Dyn;

/// `isFinalAssistantSummaryMessage` over the binary wire.
#[napi(js_name = "isFinalAssistantSummaryMessageWire")]
pub fn is_final_assistant_summary_message_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let parts: Value = wire::read_value(r, &S_IS_FINAL_ASSISTANT_SUMMARY_MESSAGE_1)?;
        let out = &port::is_final_assistant_summary_message(message, parts)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_LIVE_ASSISTANT_MESSAGE_1: wire::Schema = wire::Schema::Dyn;

/// `isLiveAssistantMessage` over the binary wire.
#[napi(js_name = "isLiveAssistantMessageWire")]
pub fn is_live_assistant_message_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Option<Value> = wire::read_dyn_opt(r)?;
        let parts: Value = wire::read_value(r, &S_IS_LIVE_ASSISTANT_MESSAGE_1)?;
        let out = &port::is_live_assistant_message(message, parts)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_SESSION_WORKING_FROM_STATE_0: wire::Schema = wire::Schema::Dyn;

/// `isSessionWorkingFromState` over the binary wire.
#[napi(js_name = "isSessionWorkingFromStateWire")]
pub fn is_session_working_from_state_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_IS_SESSION_WORKING_FROM_STATE_0)?;
        let out = &port::is_session_working_from_state(arg0)?;
        w.bool(*out);
        Ok(())
    })
}

//! JS bindings for `subtaskParentMaterialization.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getTerminalSessionIdForParentMaterialization`.
#[napi(js_name = "getTerminalSessionIdForParentMaterialization")]
pub fn get_terminal_session_id_for_parent_materialization(event: String) -> napi::Result<String> {
    run(move || {
        let event = crate::js::from_json(&event)?;
        let out = port::get_terminal_session_id_for_parent_materialization(event)?;
        crate::js::to_json(&out)
    })
}

/// `resolveParentSessionIdForTerminalChild`.
#[napi(js_name = "resolveParentSessionIdForTerminalChild")]
pub fn resolve_parent_session_id_for_terminal_child(state: String, child_session_id: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let out = port::resolve_parent_session_id_for_terminal_child(state, child_session_id)?;
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

static S_GET_TERMINAL_SESSION_ID_FOR_PARENT_MATERIALIZATION_0: wire::Schema = wire::Schema::Dyn;
static S_GET_TERMINAL_SESSION_ID_FOR_PARENT_MATERIALIZATION_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getTerminalSessionIdForParentMaterialization` over the binary wire.
#[napi(js_name = "getTerminalSessionIdForParentMaterializationWire")]
pub fn get_terminal_session_id_for_parent_materialization_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let event: Value = wire::read_value(r, &S_GET_TERMINAL_SESSION_ID_FOR_PARENT_MATERIALIZATION_0)?;
        let out = &port::get_terminal_session_id_for_parent_materialization(event)?;
        wire::write_value(w, out, &S_GET_TERMINAL_SESSION_ID_FOR_PARENT_MATERIALIZATION_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_PARENT_SESSION_ID_FOR_TERMINAL_CHILD_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_PARENT_SESSION_ID_FOR_TERMINAL_CHILD_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `resolveParentSessionIdForTerminalChild` over the binary wire.
#[napi(js_name = "resolveParentSessionIdForTerminalChildWire")]
pub fn resolve_parent_session_id_for_terminal_child_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_RESOLVE_PARENT_SESSION_ID_FOR_TERMINAL_CHILD_0)?;
        let child_session_id: String = r.string16()?;
        let out = &port::resolve_parent_session_id_for_terminal_child(state, child_session_id)?;
        wire::write_value(w, out, &S_RESOLVE_PARENT_SESSION_ID_FOR_TERMINAL_CHILD_OUT)?;
        Ok(())
    })
}

//! JS bindings for `pending-part-deltas.ts`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;
pub mod utf16;

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

/// `readPendingPartDeltaFromEvent`.
#[napi(js_name = "readPendingPartDeltaFromEvent")]
pub fn read_pending_part_delta_from_event(event: String) -> napi::Result<String> {
    run(move || {
        let event = crate::js::from_json(&event)?;
        let out = port::read_pending_part_delta_from_event(event)?;
        crate::js::to_json(&out)
    })
}

/// `buildProvisionalPartFromPendingDeltas`.
#[napi(js_name = "buildProvisionalPartFromPendingDeltas")]
pub fn build_provisional_part_from_pending_deltas(
    message_id: String,
    part_id: String,
    session_id: String,
    pending_deltas: String,
    part_type_hint: Option<String>,
) -> napi::Result<String> {
    run(move || {
        let pending_deltas = crate::js::from_json(&pending_deltas)?;
        let out = port::build_provisional_part_from_pending_deltas(message_id, part_id, session_id, pending_deltas, part_type_hint)?;
        crate::js::to_json(&out)
    })
}

/// `applyPendingPartDeltasToParts`.
#[napi(js_name = "applyPendingPartDeltasToParts")]
pub fn apply_pending_part_deltas_to_parts(parts: String, part_id: String, pending_deltas: String, options: String) -> napi::Result<String> {
    run(move || {
        let parts = crate::js::from_json(&parts)?;
        let pending_deltas = crate::js::from_json(&pending_deltas)?;
        let options = crate::js::from_json(&options)?;
        let out = port::apply_pending_part_deltas_to_parts(parts, part_id, pending_deltas, options)?;
        crate::js::to_json(&out)
    })
}

/// `applyPendingPartDeltasToState`.
#[napi(js_name = "applyPendingPartDeltasToState")]
pub fn apply_pending_part_deltas_to_state(state: String, message_id: String, part_id: String, pending_deltas: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let pending_deltas = crate::js::from_json(&pending_deltas)?;
        let out = port::apply_pending_part_deltas_to_state(state, message_id, part_id, pending_deltas)?;
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

static S_READ_PENDING_PART_DELTA_FROM_EVENT_0: wire::Schema = wire::Schema::Dyn;

/// `readPendingPartDeltaFromEvent` over the binary wire.
#[napi(js_name = "readPendingPartDeltaFromEventWire")]
pub fn read_pending_part_delta_from_event_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let event: serde_json::Value = wire::read_value(r, &S_READ_PENDING_PART_DELTA_FROM_EVENT_0)?;
        let out = &port::read_pending_part_delta_from_event(event)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_BUILD_PROVISIONAL_PART_FROM_PENDING_DELTAS_3: wire::Schema = wire::Schema::Dyn;

/// `buildProvisionalPartFromPendingDeltas` over the binary wire.
#[napi(js_name = "buildProvisionalPartFromPendingDeltasWire")]
pub fn build_provisional_part_from_pending_deltas_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: String = r.string16()?;
        let part_id: String = r.string16()?;
        let session_id: String = r.string16()?;
        let pending_deltas: serde_json::Value = wire::read_value(r, &S_BUILD_PROVISIONAL_PART_FROM_PENDING_DELTAS_3)?;
        let part_type_hint: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::build_provisional_part_from_pending_deltas(message_id, part_id, session_id, pending_deltas, part_type_hint)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_APPLY_PENDING_PART_DELTAS_TO_PARTS_0: wire::Schema = wire::Schema::Dyn;
static S_APPLY_PENDING_PART_DELTAS_TO_PARTS_2: wire::Schema = wire::Schema::Dyn;
static S_APPLY_PENDING_PART_DELTAS_TO_PARTS_3: wire::Schema = wire::Schema::Dyn;
static S_APPLY_PENDING_PART_DELTAS_TO_PARTS_OUT: wire::Schema =
    wire::Schema::Obj(&[("parts", wire::Schema::List(&wire::Schema::Dyn)), ("applied", wire::Schema::Bool)]);

/// `applyPendingPartDeltasToParts` over the binary wire.
#[napi(js_name = "applyPendingPartDeltasToPartsWire")]
pub fn apply_pending_part_deltas_to_parts_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let parts: serde_json::Value = wire::read_value(r, &S_APPLY_PENDING_PART_DELTAS_TO_PARTS_0)?;
        let part_id: String = r.string16()?;
        let pending_deltas: serde_json::Value = wire::read_value(r, &S_APPLY_PENDING_PART_DELTAS_TO_PARTS_2)?;
        let options: serde_json::Value = wire::read_value(r, &S_APPLY_PENDING_PART_DELTAS_TO_PARTS_3)?;
        let out = &port::apply_pending_part_deltas_to_parts(parts, part_id, pending_deltas, options)?;
        wire::write_value(w, out, &S_APPLY_PENDING_PART_DELTAS_TO_PARTS_OUT)?;
        Ok(())
    })
}

static S_APPLY_PENDING_PART_DELTAS_TO_STATE_0: wire::Schema = wire::Schema::Dyn;
static S_APPLY_PENDING_PART_DELTAS_TO_STATE_3: wire::Schema = wire::Schema::Dyn;
static S_APPLY_PENDING_PART_DELTAS_TO_STATE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[("part", wire::Schema::Dyn)]));

/// `applyPendingPartDeltasToState` over the binary wire.
#[napi(js_name = "applyPendingPartDeltasToStateWire")]
pub fn apply_pending_part_deltas_to_state_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: serde_json::Value = wire::read_value(r, &S_APPLY_PENDING_PART_DELTAS_TO_STATE_0)?;
        let message_id: String = r.string16()?;
        let part_id: String = r.string16()?;
        let pending_deltas: serde_json::Value = wire::read_value(r, &S_APPLY_PENDING_PART_DELTAS_TO_STATE_3)?;
        let out = &port::apply_pending_part_deltas_to_state(state, message_id, part_id, pending_deltas)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_APPLY_PENDING_PART_DELTAS_TO_STATE_OUT.inner())?;
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

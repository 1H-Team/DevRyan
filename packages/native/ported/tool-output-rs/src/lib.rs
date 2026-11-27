//! JS bindings for `tool-output.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isToolOutputOmitted`.
#[napi(js_name = "isToolOutputOmitted")]
pub fn is_tool_output_omitted(part: String) -> napi::Result<bool> {
    run(move || {
        let part = crate::js::from_json(&part)?;
        let out = port::is_tool_output_omitted(part)?;
        Ok(out)
    })
}

/// `getOmittedToolOutputBytes`.
#[napi(js_name = "getOmittedToolOutputBytes")]
pub fn get_omitted_tool_output_bytes(part: String) -> napi::Result<napi::bindgen_prelude::Either<f64, ()>> {
    run(move || {
        let part = crate::js::from_json(&part)?;
        let out = port::get_omitted_tool_output_bytes(part)?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `keepFullToolOutput`.
#[napi(js_name = "keepFullToolOutput")]
pub fn keep_full_tool_output(existing: String, next: String) -> napi::Result<String> {
    run(move || {
        let existing = crate::js::from_json(&existing)?;
        let next = crate::js::from_json(&next)?;
        let out = port::keep_full_tool_output(existing, next)?;
        crate::js::to_json(&out)
    })
}

/// `mergeLoadedToolOutput`.
#[napi(js_name = "mergeLoadedToolOutput")]
pub fn merge_loaded_tool_output(current: String, full: String) -> napi::Result<String> {
    run(move || {
        let current = crate::js::from_json(&current)?;
        let full = crate::js::from_json(&full)?;
        let out = port::merge_loaded_tool_output(current, full)?;
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

/// `isToolOutputOmitted` over the binary wire.
#[napi(js_name = "isToolOutputOmittedWire")]
pub fn is_tool_output_omitted_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let part: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::is_tool_output_omitted(part)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_GET_OMITTED_TOOL_OUTPUT_BYTES_0: wire::Schema = wire::Schema::Dyn;

/// `getOmittedToolOutputBytes` over the binary wire.
#[napi(js_name = "getOmittedToolOutputBytesWire")]
pub fn get_omitted_tool_output_bytes_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let part: Value = wire::read_value(r, &S_GET_OMITTED_TOOL_OUTPUT_BYTES_0)?;
        let out = &port::get_omitted_tool_output_bytes(part)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.f64(*x0);
            }
            None => w.tag(0),
        }
        Ok(())
    })
}

static S_KEEP_FULL_TOOL_OUTPUT_1: wire::Schema = wire::Schema::Dyn;
static S_KEEP_FULL_TOOL_OUTPUT_OUT: wire::Schema = wire::Schema::Dyn;

/// `keepFullToolOutput` over the binary wire.
#[napi(js_name = "keepFullToolOutputWire")]
pub fn keep_full_tool_output_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let existing: Option<Value> = wire::read_dyn_opt(r)?;
        let next: Value = wire::read_value(r, &S_KEEP_FULL_TOOL_OUTPUT_1)?;
        let out = &port::keep_full_tool_output(existing, next)?;
        wire::write_value(w, out, &S_KEEP_FULL_TOOL_OUTPUT_OUT)?;
        Ok(())
    })
}

static S_MERGE_LOADED_TOOL_OUTPUT_0: wire::Schema = wire::Schema::Dyn;
static S_MERGE_LOADED_TOOL_OUTPUT_1: wire::Schema = wire::Schema::Dyn;
static S_MERGE_LOADED_TOOL_OUTPUT_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `mergeLoadedToolOutput` over the binary wire.
#[napi(js_name = "mergeLoadedToolOutputWire")]
pub fn merge_loaded_tool_output_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: Value = wire::read_value(r, &S_MERGE_LOADED_TOOL_OUTPUT_0)?;
        let full: Value = wire::read_value(r, &S_MERGE_LOADED_TOOL_OUTPUT_1)?;
        let out = &port::merge_loaded_tool_output(current, full)?;
        wire::write_value(w, out, &S_MERGE_LOADED_TOOL_OUTPUT_OUT)?;
        Ok(())
    })
}

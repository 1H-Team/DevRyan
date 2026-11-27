//! JS bindings for `native-provider-deadlines.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `nativeProviderDeadlines`.
#[napi(js_name = "nativeProviderDeadlines")]
pub fn native_provider_deadlines(id: String, settings: String) -> napi::Result<String> {
    run(move || {
        let id = crate::js::from_json(&id)?;
        let settings = crate::js::from_json(&settings)?;
        let out = port::native_provider_deadlines(id, settings)?;
        crate::js::to_json(&out)
    })
}

/// `withNativeProviderDeadlines`.
#[napi(js_name = "withNativeProviderDeadlines")]
pub fn with_native_provider_deadlines(id: String, provider: String) -> napi::Result<String> {
    run(move || {
        let id = crate::js::from_json(&id)?;
        let provider = crate::js::from_json(&provider)?;
        let out = port::with_native_provider_deadlines(id, provider)?;
        crate::js::to_json(&out)
    })
}

/// `nativeRequestHeaderDeadline`.
#[napi(js_name = "nativeRequestHeaderDeadline")]
pub fn native_request_header_deadline(provider_id: String, configured: String, core_default: String) -> napi::Result<String> {
    run(move || {
        let provider_id = crate::js::from_json(&provider_id)?;
        let configured = crate::js::from_json(&configured)?;
        let core_default = crate::js::from_json(&core_default)?;
        let out = port::native_request_header_deadline(provider_id, configured, core_default)?;
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

static S_NATIVE_PROVIDER_DEADLINES_0: wire::Schema = wire::Schema::Dyn;
static S_NATIVE_PROVIDER_DEADLINES_1: wire::Schema = wire::Schema::Dyn;
static S_NATIVE_PROVIDER_DEADLINES_OUT: wire::Schema = wire::Schema::Dyn;

/// `nativeProviderDeadlines` over the binary wire.
#[napi(js_name = "nativeProviderDeadlinesWire")]
pub fn native_provider_deadlines_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let id: Value = wire::read_value(r, &S_NATIVE_PROVIDER_DEADLINES_0)?;
        let settings: Value = wire::read_value(r, &S_NATIVE_PROVIDER_DEADLINES_1)?;
        let out = &port::native_provider_deadlines(id, settings)?;
        wire::write_value(w, out, &S_NATIVE_PROVIDER_DEADLINES_OUT)?;
        Ok(())
    })
}

static S_WITH_NATIVE_PROVIDER_DEADLINES_0: wire::Schema = wire::Schema::Dyn;
static S_WITH_NATIVE_PROVIDER_DEADLINES_1: wire::Schema = wire::Schema::Dyn;
static S_WITH_NATIVE_PROVIDER_DEADLINES_OUT: wire::Schema = wire::Schema::Dyn;

/// `withNativeProviderDeadlines` over the binary wire.
#[napi(js_name = "withNativeProviderDeadlinesWire")]
pub fn with_native_provider_deadlines_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let id: Value = wire::read_value(r, &S_WITH_NATIVE_PROVIDER_DEADLINES_0)?;
        let provider: Value = wire::read_value(r, &S_WITH_NATIVE_PROVIDER_DEADLINES_1)?;
        let out = &port::with_native_provider_deadlines(id, provider)?;
        wire::write_value(w, out, &S_WITH_NATIVE_PROVIDER_DEADLINES_OUT)?;
        Ok(())
    })
}

static S_NATIVE_REQUEST_HEADER_DEADLINE_0: wire::Schema = wire::Schema::Dyn;
static S_NATIVE_REQUEST_HEADER_DEADLINE_1: wire::Schema = wire::Schema::Dyn;
static S_NATIVE_REQUEST_HEADER_DEADLINE_2: wire::Schema = wire::Schema::Dyn;
static S_NATIVE_REQUEST_HEADER_DEADLINE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Num);

/// `nativeRequestHeaderDeadline` over the binary wire.
#[napi(js_name = "nativeRequestHeaderDeadlineWire")]
pub fn native_request_header_deadline_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_id: Value = wire::read_value(r, &S_NATIVE_REQUEST_HEADER_DEADLINE_0)?;
        let configured: Value = wire::read_value(r, &S_NATIVE_REQUEST_HEADER_DEADLINE_1)?;
        let core_default: Value = wire::read_value(r, &S_NATIVE_REQUEST_HEADER_DEADLINE_2)?;
        let out = &port::native_request_header_deadline(provider_id, configured, core_default)?;
        wire::write_value(w, out, &S_NATIVE_REQUEST_HEADER_DEADLINE_OUT)?;
        Ok(())
    })
}

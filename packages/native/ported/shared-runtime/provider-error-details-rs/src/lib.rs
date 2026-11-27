//! JS bindings for `lib/provider-error-details.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isSafeProviderCode`.
#[napi(js_name = "isSafeProviderCode")]
pub fn is_safe_provider_code(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_safe_provider_code(value)?;
        crate::js::to_json(&out)
    })
}

/// `isSafeProviderParam`.
#[napi(js_name = "isSafeProviderParam")]
pub fn is_safe_provider_param(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_safe_provider_param(value)?;
        crate::js::to_json(&out)
    })
}

/// `isSafeErrorType`.
#[napi(js_name = "isSafeErrorType")]
pub fn is_safe_error_type(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_safe_error_type(value)?;
        crate::js::to_json(&out)
    })
}

/// `providerErrorDetails`.
#[napi(js_name = "providerErrorDetails")]
pub fn provider_error_details(body: String) -> napi::Result<String> {
    run(move || {
        let body = crate::js::from_json(&body)?;
        let out = port::provider_error_details(body)?;
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

static S_IS_SAFE_PROVIDER_CODE_0: wire::Schema = wire::Schema::Dyn;
static S_IS_SAFE_PROVIDER_CODE_OUT: wire::Schema = wire::Schema::Dyn;

/// `isSafeProviderCode` over the binary wire.
#[napi(js_name = "isSafeProviderCodeWire")]
pub fn is_safe_provider_code_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_IS_SAFE_PROVIDER_CODE_0)?;
        let out = &port::is_safe_provider_code(value)?;
        wire::write_value(w, out, &S_IS_SAFE_PROVIDER_CODE_OUT)?;
        Ok(())
    })
}

static S_IS_SAFE_PROVIDER_PARAM_0: wire::Schema = wire::Schema::Dyn;
static S_IS_SAFE_PROVIDER_PARAM_OUT: wire::Schema = wire::Schema::Dyn;

/// `isSafeProviderParam` over the binary wire.
#[napi(js_name = "isSafeProviderParamWire")]
pub fn is_safe_provider_param_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_IS_SAFE_PROVIDER_PARAM_0)?;
        let out = &port::is_safe_provider_param(value)?;
        wire::write_value(w, out, &S_IS_SAFE_PROVIDER_PARAM_OUT)?;
        Ok(())
    })
}

static S_IS_SAFE_ERROR_TYPE_0: wire::Schema = wire::Schema::Dyn;
static S_IS_SAFE_ERROR_TYPE_OUT: wire::Schema = wire::Schema::Dyn;

/// `isSafeErrorType` over the binary wire.
#[napi(js_name = "isSafeErrorTypeWire")]
pub fn is_safe_error_type_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_IS_SAFE_ERROR_TYPE_0)?;
        let out = &port::is_safe_error_type(value)?;
        wire::write_value(w, out, &S_IS_SAFE_ERROR_TYPE_OUT)?;
        Ok(())
    })
}

static S_PROVIDER_ERROR_DETAILS_0: wire::Schema = wire::Schema::Dyn;
static S_PROVIDER_ERROR_DETAILS_OUT: wire::Schema = wire::Schema::Dyn;

/// `providerErrorDetails` over the binary wire.
#[napi(js_name = "providerErrorDetailsWire")]
pub fn provider_error_details_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let body: serde_json::Value = wire::read_value(r, &S_PROVIDER_ERROR_DETAILS_0)?;
        let out = &port::provider_error_details(body)?;
        wire::write_value(w, out, &S_PROVIDER_ERROR_DETAILS_OUT)?;
        Ok(())
    })
}

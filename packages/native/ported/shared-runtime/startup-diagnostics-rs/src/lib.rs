//! JS bindings for `startup-diagnostics.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `parseArtifactDiagnostic`.
#[napi(js_name = "parseArtifactDiagnostic")]
pub fn parse_artifact_diagnostic(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::parse_artifact_diagnostic(value)?;
        crate::js::to_json(&out)
    })
}

/// `artifactDiagnostic`.
#[napi(js_name = "artifactDiagnostic")]
pub fn artifact_diagnostic(error: String) -> napi::Result<String> {
    run(move || {
        let error = crate::js::from_json(&error)?;
        let out = port::artifact_diagnostic(error)?;
        crate::js::to_json(&out)
    })
}

/// `startupFailureDetail`.
#[napi(js_name = "startupFailureDetail")]
pub fn startup_failure_detail(error: String) -> napi::Result<String> {
    run(move || {
        let error = crate::js::from_json(&error)?;
        let out = port::startup_failure_detail(error)?;
        crate::js::to_json(&out)
    })
}

/// `startupDiagnosticSummary`.
#[napi(js_name = "startupDiagnosticSummary")]
pub fn startup_diagnostic_summary(error: String) -> napi::Result<String> {
    run(move || {
        let error = crate::js::from_json(&error)?;
        let out = port::startup_diagnostic_summary(error)?;
        Ok(out)
    })
}

/// `describeReferenceFailure`.
#[napi(js_name = "describeReferenceFailure")]
pub fn describe_reference_failure(error: String) -> napi::Result<String> {
    run(move || {
        let error = crate::js::from_json(&error)?;
        let out = port::describe_reference_failure(error)?;
        Ok(out)
    })
}

/// `describeArtifactFailure`.
#[napi(js_name = "describeArtifactFailure")]
pub fn describe_artifact_failure(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::describe_artifact_failure(value)?;
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

static S_PARSE_ARTIFACT_DIAGNOSTIC_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_ARTIFACT_DIAGNOSTIC_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseArtifactDiagnostic` over the binary wire.
#[napi(js_name = "parseArtifactDiagnosticWire")]
pub fn parse_artifact_diagnostic_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_PARSE_ARTIFACT_DIAGNOSTIC_0)?;
        let out = &port::parse_artifact_diagnostic(value)?;
        wire::write_value(w, out, &S_PARSE_ARTIFACT_DIAGNOSTIC_OUT)?;
        Ok(())
    })
}

static S_ARTIFACT_DIAGNOSTIC_0: wire::Schema = wire::Schema::Dyn;
static S_ARTIFACT_DIAGNOSTIC_OUT: wire::Schema = wire::Schema::Dyn;

/// `artifactDiagnostic` over the binary wire.
#[napi(js_name = "artifactDiagnosticWire")]
pub fn artifact_diagnostic_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let error: serde_json::Value = wire::read_value(r, &S_ARTIFACT_DIAGNOSTIC_0)?;
        let out = &port::artifact_diagnostic(error)?;
        wire::write_value(w, out, &S_ARTIFACT_DIAGNOSTIC_OUT)?;
        Ok(())
    })
}

static S_STARTUP_FAILURE_DETAIL_0: wire::Schema = wire::Schema::Dyn;
static S_STARTUP_FAILURE_DETAIL_OUT: wire::Schema = wire::Schema::Dyn;

/// `startupFailureDetail` over the binary wire.
#[napi(js_name = "startupFailureDetailWire")]
pub fn startup_failure_detail_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let error: serde_json::Value = wire::read_value(r, &S_STARTUP_FAILURE_DETAIL_0)?;
        let out = &port::startup_failure_detail(error)?;
        wire::write_value(w, out, &S_STARTUP_FAILURE_DETAIL_OUT)?;
        Ok(())
    })
}

static S_STARTUP_DIAGNOSTIC_SUMMARY_0: wire::Schema = wire::Schema::Dyn;

/// `startupDiagnosticSummary` over the binary wire.
#[napi(js_name = "startupDiagnosticSummaryWire")]
pub fn startup_diagnostic_summary_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let error: serde_json::Value = wire::read_value(r, &S_STARTUP_DIAGNOSTIC_SUMMARY_0)?;
        let out = &port::startup_diagnostic_summary(error)?;
        w.string16(out);
        Ok(())
    })
}

static S_DESCRIBE_REFERENCE_FAILURE_0: wire::Schema = wire::Schema::Dyn;

/// `describeReferenceFailure` over the binary wire.
#[napi(js_name = "describeReferenceFailureWire")]
pub fn describe_reference_failure_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let error: serde_json::Value = wire::read_value(r, &S_DESCRIBE_REFERENCE_FAILURE_0)?;
        let out = &port::describe_reference_failure(error)?;
        w.string16(out);
        Ok(())
    })
}

static S_DESCRIBE_ARTIFACT_FAILURE_0: wire::Schema = wire::Schema::Dyn;

/// `describeArtifactFailure` over the binary wire.
#[napi(js_name = "describeArtifactFailureWire")]
pub fn describe_artifact_failure_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_DESCRIBE_ARTIFACT_FAILURE_0)?;
        let out = &port::describe_artifact_failure(value)?;
        w.string16(out);
        Ok(())
    })
}

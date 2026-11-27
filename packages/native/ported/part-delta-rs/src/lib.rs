//! JS bindings for `part-delta.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `appendNonOverlappingDelta`.
#[napi(js_name = "appendNonOverlappingDelta")]
pub fn append_non_overlapping_delta(existing_value: String, delta: String, context: String) -> napi::Result<String> {
    run(move || {
        let existing_value = crate::js::from_json(&existing_value)?;
        let delta = crate::js::from_json(&delta)?;
        let context = crate::js::from_json(&context)?;
        let out = port::append_non_overlapping_delta(existing_value, delta, context)?;
        crate::js::to_json(&out)
    })
}

/// `collapseExactAdjacentTextRepeats`.
#[napi(js_name = "collapseExactAdjacentTextRepeats")]
pub fn collapse_exact_adjacent_text_repeats(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::collapse_exact_adjacent_text_repeats(value)?;
        crate::js::to_json(&out)
    })
}

/// `stripInternalToolRunnerDiagnostics`.
#[napi(js_name = "stripInternalToolRunnerDiagnostics")]
pub fn strip_internal_tool_runner_diagnostics(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::strip_internal_tool_runner_diagnostics(value)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeAssistantVisibleText`.
#[napi(js_name = "normalizeAssistantVisibleText")]
pub fn normalize_assistant_visible_text(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::normalize_assistant_visible_text(value)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeAssistantReasoningText`.
#[napi(js_name = "normalizeAssistantReasoningText")]
pub fn normalize_assistant_reasoning_text(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::normalize_assistant_reasoning_text(value)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeAssistantPartText`.
#[napi(js_name = "normalizeAssistantPartText")]
pub fn normalize_assistant_part_text(value: String, part_type: Option<String>) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::normalize_assistant_part_text(value, part_type)?;
        crate::js::to_json(&out)
    })
}

/// `appendStreamingTextDelta`.
#[napi(js_name = "appendStreamingTextDelta")]
pub fn append_streaming_text_delta(existing_value: String, delta: String) -> napi::Result<String> {
    run(move || {
        let existing_value = crate::js::from_json(&existing_value)?;
        let delta = crate::js::from_json(&delta)?;
        let out = port::append_streaming_text_delta(existing_value, delta)?;
        crate::js::to_json(&out)
    })
}

/// `appendStreamingOutputDelta`.
#[napi(js_name = "appendStreamingOutputDelta")]
pub fn append_streaming_output_delta(existing_value: String, delta: String) -> napi::Result<String> {
    run(move || {
        let existing_value = crate::js::from_json(&existing_value)?;
        let delta = crate::js::from_json(&delta)?;
        let out = port::append_streaming_output_delta(existing_value, delta)?;
        crate::js::to_json(&out)
    })
}

/// `appendStreamingFieldDelta`.
#[napi(js_name = "appendStreamingFieldDelta")]
pub fn append_streaming_field_delta(field: String, existing_value: String, delta: String) -> napi::Result<String> {
    run(move || {
        let existing_value = crate::js::from_json(&existing_value)?;
        let delta = crate::js::from_json(&delta)?;
        let out = port::append_streaming_field_delta(field, existing_value, delta)?;
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

static S_APPEND_NON_OVERLAPPING_DELTA_0: wire::Schema = wire::Schema::Dyn;
static S_APPEND_NON_OVERLAPPING_DELTA_1: wire::Schema = wire::Schema::Dyn;
static S_APPEND_NON_OVERLAPPING_DELTA_2: wire::Schema = wire::Schema::Dyn;
static S_APPEND_NON_OVERLAPPING_DELTA_OUT: wire::Schema = wire::Schema::Dyn;

/// `appendNonOverlappingDelta` over the binary wire.
#[napi(js_name = "appendNonOverlappingDeltaWire")]
pub fn append_non_overlapping_delta_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let existing_value: Value = wire::read_value(r, &S_APPEND_NON_OVERLAPPING_DELTA_0)?;
        let delta: Value = wire::read_value(r, &S_APPEND_NON_OVERLAPPING_DELTA_1)?;
        let context: Value = wire::read_value(r, &S_APPEND_NON_OVERLAPPING_DELTA_2)?;
        let out = &port::append_non_overlapping_delta(existing_value, delta, context)?;
        wire::write_value(w, out, &S_APPEND_NON_OVERLAPPING_DELTA_OUT)?;
        Ok(())
    })
}

static S_COLLAPSE_EXACT_ADJACENT_TEXT_REPEATS_0: wire::Schema = wire::Schema::Dyn;
static S_COLLAPSE_EXACT_ADJACENT_TEXT_REPEATS_OUT: wire::Schema = wire::Schema::Str16;

/// `collapseExactAdjacentTextRepeats` over the binary wire.
#[napi(js_name = "collapseExactAdjacentTextRepeatsWire")]
pub fn collapse_exact_adjacent_text_repeats_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_COLLAPSE_EXACT_ADJACENT_TEXT_REPEATS_0)?;
        let out = &port::collapse_exact_adjacent_text_repeats(value)?;
        wire::write_value(w, out, &S_COLLAPSE_EXACT_ADJACENT_TEXT_REPEATS_OUT)?;
        Ok(())
    })
}

static S_STRIP_INTERNAL_TOOL_RUNNER_DIAGNOSTICS_0: wire::Schema = wire::Schema::Dyn;
static S_STRIP_INTERNAL_TOOL_RUNNER_DIAGNOSTICS_OUT: wire::Schema = wire::Schema::Str16;

/// `stripInternalToolRunnerDiagnostics` over the binary wire.
#[napi(js_name = "stripInternalToolRunnerDiagnosticsWire")]
pub fn strip_internal_tool_runner_diagnostics_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_STRIP_INTERNAL_TOOL_RUNNER_DIAGNOSTICS_0)?;
        let out = &port::strip_internal_tool_runner_diagnostics(value)?;
        wire::write_value(w, out, &S_STRIP_INTERNAL_TOOL_RUNNER_DIAGNOSTICS_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_ASSISTANT_VISIBLE_TEXT_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ASSISTANT_VISIBLE_TEXT_OUT: wire::Schema = wire::Schema::Str16;

/// `normalizeAssistantVisibleText` over the binary wire.
#[napi(js_name = "normalizeAssistantVisibleTextWire")]
pub fn normalize_assistant_visible_text_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_NORMALIZE_ASSISTANT_VISIBLE_TEXT_0)?;
        let out = &port::normalize_assistant_visible_text(value)?;
        wire::write_value(w, out, &S_NORMALIZE_ASSISTANT_VISIBLE_TEXT_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_ASSISTANT_REASONING_TEXT_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ASSISTANT_REASONING_TEXT_OUT: wire::Schema = wire::Schema::Str16;

/// `normalizeAssistantReasoningText` over the binary wire.
#[napi(js_name = "normalizeAssistantReasoningTextWire")]
pub fn normalize_assistant_reasoning_text_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_NORMALIZE_ASSISTANT_REASONING_TEXT_0)?;
        let out = &port::normalize_assistant_reasoning_text(value)?;
        wire::write_value(w, out, &S_NORMALIZE_ASSISTANT_REASONING_TEXT_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_ASSISTANT_PART_TEXT_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ASSISTANT_PART_TEXT_OUT: wire::Schema = wire::Schema::Str16;

/// `normalizeAssistantPartText` over the binary wire.
#[napi(js_name = "normalizeAssistantPartTextWire")]
pub fn normalize_assistant_part_text_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_NORMALIZE_ASSISTANT_PART_TEXT_0)?;
        let part_type: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::normalize_assistant_part_text(value, part_type)?;
        wire::write_value(w, out, &S_NORMALIZE_ASSISTANT_PART_TEXT_OUT)?;
        Ok(())
    })
}

static S_APPEND_STREAMING_TEXT_DELTA_0: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_TEXT_DELTA_1: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_TEXT_DELTA_OUT: wire::Schema = wire::Schema::Dyn;

/// `appendStreamingTextDelta` over the binary wire.
#[napi(js_name = "appendStreamingTextDeltaWire")]
pub fn append_streaming_text_delta_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let existing_value: Value = wire::read_value(r, &S_APPEND_STREAMING_TEXT_DELTA_0)?;
        let delta: Value = wire::read_value(r, &S_APPEND_STREAMING_TEXT_DELTA_1)?;
        let out = &port::append_streaming_text_delta(existing_value, delta)?;
        wire::write_value(w, out, &S_APPEND_STREAMING_TEXT_DELTA_OUT)?;
        Ok(())
    })
}

static S_APPEND_STREAMING_OUTPUT_DELTA_0: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_OUTPUT_DELTA_1: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_OUTPUT_DELTA_OUT: wire::Schema = wire::Schema::Dyn;

/// `appendStreamingOutputDelta` over the binary wire.
#[napi(js_name = "appendStreamingOutputDeltaWire")]
pub fn append_streaming_output_delta_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let existing_value: Value = wire::read_value(r, &S_APPEND_STREAMING_OUTPUT_DELTA_0)?;
        let delta: Value = wire::read_value(r, &S_APPEND_STREAMING_OUTPUT_DELTA_1)?;
        let out = &port::append_streaming_output_delta(existing_value, delta)?;
        wire::write_value(w, out, &S_APPEND_STREAMING_OUTPUT_DELTA_OUT)?;
        Ok(())
    })
}

static S_APPEND_STREAMING_FIELD_DELTA_1: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_FIELD_DELTA_2: wire::Schema = wire::Schema::Dyn;
static S_APPEND_STREAMING_FIELD_DELTA_OUT: wire::Schema = wire::Schema::Dyn;

/// `appendStreamingFieldDelta` over the binary wire.
#[napi(js_name = "appendStreamingFieldDeltaWire")]
pub fn append_streaming_field_delta_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let field: String = r.string16()?;
        let existing_value: Value = wire::read_value(r, &S_APPEND_STREAMING_FIELD_DELTA_1)?;
        let delta: Value = wire::read_value(r, &S_APPEND_STREAMING_FIELD_DELTA_2)?;
        let out = &port::append_streaming_field_delta(field, existing_value, delta)?;
        wire::write_value(w, out, &S_APPEND_STREAMING_FIELD_DELTA_OUT)?;
        Ok(())
    })
}

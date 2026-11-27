//! JS bindings for `tools.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `toV1ToolName`.
#[napi(js_name = "toV1ToolName")]
pub fn to_v1_tool_name(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::to_v1_tool_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `toV2ToolName`.
#[napi(js_name = "toV2ToolName")]
pub fn to_v2_tool_name(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::to_v2_tool_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ToolInput`.
#[napi(js_name = "toV1ToolInput")]
pub fn to_v1_tool_input(name: String, input: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let input = crate::js::from_json(&input)?;
        let out = port::to_v1_tool_input(name, input)?;
        crate::js::to_json(&out)
    })
}

/// `toV2ToolInput`.
#[napi(js_name = "toV2ToolInput")]
pub fn to_v2_tool_input(name: String, input: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let input = crate::js::from_json(&input)?;
        let out = port::to_v2_tool_input(name, input)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ToolMetadata`.
#[napi(js_name = "toV1ToolMetadata")]
pub fn to_v1_tool_metadata(name: String, metadata: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::to_v1_tool_metadata(name, metadata)?;
        crate::js::to_json(&out)
    })
}

/// `toV2ToolMetadata`.
#[napi(js_name = "toV2ToolMetadata")]
pub fn to_v2_tool_metadata(name: String, metadata: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::to_v2_tool_metadata(name, metadata)?;
        crate::js::to_json(&out)
    })
}

/// `synthesizeToolTitle`.
#[napi(js_name = "synthesizeToolTitle")]
pub fn synthesize_tool_title(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::synthesize_tool_title(input)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ToolState`.
#[napi(js_name = "toV1ToolState")]
pub fn to_v1_tool_state(tool: String, context: String) -> napi::Result<String> {
    run(move || {
        let tool = crate::js::from_json(&tool)?;
        let context = crate::js::from_json(&context)?;
        let out = port::to_v1_tool_state(tool, context)?;
        crate::js::to_json(&out)
    })
}

/// `projectProviderState`.
#[napi(js_name = "projectProviderState")]
pub fn project_provider_state(state: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let out = port::project_provider_state(state)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ToolPart`.
#[napi(js_name = "toV1ToolPart")]
pub fn to_v1_tool_part(tool: String, context: String) -> napi::Result<String> {
    run(move || {
        let tool = crate::js::from_json(&tool)?;
        let context = crate::js::from_json(&context)?;
        let out = port::to_v1_tool_part(tool, context)?;
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

static S_TO_V1_TOOL_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ToolName` over the binary wire.
#[napi(js_name = "toV1ToolNameWire")]
pub fn to_v1_tool_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V1_TOOL_NAME_0)?;
        let out = &port::to_v1_tool_name(name)?;
        wire::write_value(w, out, &S_TO_V1_TOOL_NAME_OUT)?;
        Ok(())
    })
}

static S_TO_V2_TOOL_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V2_TOOL_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV2ToolName` over the binary wire.
#[napi(js_name = "toV2ToolNameWire")]
pub fn to_v2_tool_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V2_TOOL_NAME_0)?;
        let out = &port::to_v2_tool_name(name)?;
        wire::write_value(w, out, &S_TO_V2_TOOL_NAME_OUT)?;
        Ok(())
    })
}

static S_TO_V1_TOOL_INPUT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_INPUT_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_INPUT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ToolInput` over the binary wire.
#[napi(js_name = "toV1ToolInputWire")]
pub fn to_v1_tool_input_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V1_TOOL_INPUT_0)?;
        let input: Value = wire::read_value(r, &S_TO_V1_TOOL_INPUT_1)?;
        let out = &port::to_v1_tool_input(name, input)?;
        wire::write_value(w, out, &S_TO_V1_TOOL_INPUT_OUT)?;
        Ok(())
    })
}

static S_TO_V2_TOOL_INPUT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V2_TOOL_INPUT_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V2_TOOL_INPUT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV2ToolInput` over the binary wire.
#[napi(js_name = "toV2ToolInputWire")]
pub fn to_v2_tool_input_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V2_TOOL_INPUT_0)?;
        let input: Value = wire::read_value(r, &S_TO_V2_TOOL_INPUT_1)?;
        let out = &port::to_v2_tool_input(name, input)?;
        wire::write_value(w, out, &S_TO_V2_TOOL_INPUT_OUT)?;
        Ok(())
    })
}

static S_TO_V1_TOOL_METADATA_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_METADATA_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_METADATA_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ToolMetadata` over the binary wire.
#[napi(js_name = "toV1ToolMetadataWire")]
pub fn to_v1_tool_metadata_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V1_TOOL_METADATA_0)?;
        let metadata: Value = wire::read_value(r, &S_TO_V1_TOOL_METADATA_1)?;
        let out = &port::to_v1_tool_metadata(name, metadata)?;
        wire::write_value(w, out, &S_TO_V1_TOOL_METADATA_OUT)?;
        Ok(())
    })
}

static S_TO_V2_TOOL_METADATA_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V2_TOOL_METADATA_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V2_TOOL_METADATA_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV2ToolMetadata` over the binary wire.
#[napi(js_name = "toV2ToolMetadataWire")]
pub fn to_v2_tool_metadata_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_TO_V2_TOOL_METADATA_0)?;
        let metadata: Value = wire::read_value(r, &S_TO_V2_TOOL_METADATA_1)?;
        let out = &port::to_v2_tool_metadata(name, metadata)?;
        wire::write_value(w, out, &S_TO_V2_TOOL_METADATA_OUT)?;
        Ok(())
    })
}

static S_SYNTHESIZE_TOOL_TITLE_0: wire::Schema = wire::Schema::Dyn;
static S_SYNTHESIZE_TOOL_TITLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `synthesizeToolTitle` over the binary wire.
#[napi(js_name = "synthesizeToolTitleWire")]
pub fn synthesize_tool_title_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: Value = wire::read_value(r, &S_SYNTHESIZE_TOOL_TITLE_0)?;
        let out = &port::synthesize_tool_title(input)?;
        wire::write_value(w, out, &S_SYNTHESIZE_TOOL_TITLE_OUT)?;
        Ok(())
    })
}

static S_TO_V1_TOOL_STATE_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_STATE_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_STATE_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ToolState` over the binary wire.
#[napi(js_name = "toV1ToolStateWire")]
pub fn to_v1_tool_state_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tool: Value = wire::read_value(r, &S_TO_V1_TOOL_STATE_0)?;
        let context: Value = wire::read_value(r, &S_TO_V1_TOOL_STATE_1)?;
        let out = &port::to_v1_tool_state(tool, context)?;
        wire::write_value(w, out, &S_TO_V1_TOOL_STATE_OUT)?;
        Ok(())
    })
}

static S_PROJECT_PROVIDER_STATE_0: wire::Schema = wire::Schema::Dyn;
static S_PROJECT_PROVIDER_STATE_OUT: wire::Schema = wire::Schema::Dyn;

/// `projectProviderState` over the binary wire.
#[napi(js_name = "projectProviderStateWire")]
pub fn project_provider_state_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_PROJECT_PROVIDER_STATE_0)?;
        let out = &port::project_provider_state(state)?;
        wire::write_value(w, out, &S_PROJECT_PROVIDER_STATE_OUT)?;
        Ok(())
    })
}

static S_TO_V1_TOOL_PART_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_PART_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOOL_PART_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ToolPart` over the binary wire.
#[napi(js_name = "toV1ToolPartWire")]
pub fn to_v1_tool_part_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tool: Value = wire::read_value(r, &S_TO_V1_TOOL_PART_0)?;
        let context: Value = wire::read_value(r, &S_TO_V1_TOOL_PART_1)?;
        let out = &port::to_v1_tool_part(tool, context)?;
        wire::write_value(w, out, &S_TO_V1_TOOL_PART_OUT)?;
        Ok(())
    })
}

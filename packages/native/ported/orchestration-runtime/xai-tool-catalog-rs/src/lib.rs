//! JS bindings for `xai-tool-catalog.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `deriveXaiDuplicateToolOverrides`.
#[napi(js_name = "deriveXaiDuplicateToolOverrides")]
pub fn derive_xai_duplicate_tool_overrides(catalog: String) -> napi::Result<String> {
    run(move || {
        let catalog = crate::js::from_json(&catalog)?;
        let out = port::derive_xai_duplicate_tool_overrides(catalog)?;
        crate::js::to_json(&out)
    })
}

/// `haveEquivalentToolSchemas`.
#[napi(js_name = "haveEquivalentToolSchemas")]
pub fn have_equivalent_tool_schemas(left: String, right: String) -> napi::Result<String> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::have_equivalent_tool_schemas(left, right)?;
        crate::js::to_json(&out)
    })
}

/// `isXaiProviderID`.
#[napi(js_name = "isXaiProviderID")]
pub fn is_xai_provider_id(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_xai_provider_id(value)?;
        crate::js::to_json(&out)
    })
}

/// `listXaiModelIds`.
#[napi(js_name = "listXaiModelIds")]
pub fn list_xai_model_ids(provider_payload: String) -> napi::Result<String> {
    run(move || {
        let provider_payload = crate::js::from_json(&provider_payload)?;
        let out = port::list_xai_model_ids(provider_payload)?;
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

static S_DERIVE_XAI_DUPLICATE_TOOL_OVERRIDES_0: wire::Schema = wire::Schema::Dyn;
static S_DERIVE_XAI_DUPLICATE_TOOL_OVERRIDES_OUT: wire::Schema = wire::Schema::Dyn;

/// `deriveXaiDuplicateToolOverrides` over the binary wire.
#[napi(js_name = "deriveXaiDuplicateToolOverridesWire")]
pub fn derive_xai_duplicate_tool_overrides_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let catalog: serde_json::Value = wire::read_value(r, &S_DERIVE_XAI_DUPLICATE_TOOL_OVERRIDES_0)?;
        let out = &port::derive_xai_duplicate_tool_overrides(catalog)?;
        wire::write_value(w, out, &S_DERIVE_XAI_DUPLICATE_TOOL_OVERRIDES_OUT)?;
        Ok(())
    })
}

static S_HAVE_EQUIVALENT_TOOL_SCHEMAS_0: wire::Schema = wire::Schema::Dyn;
static S_HAVE_EQUIVALENT_TOOL_SCHEMAS_1: wire::Schema = wire::Schema::Dyn;
static S_HAVE_EQUIVALENT_TOOL_SCHEMAS_OUT: wire::Schema = wire::Schema::Dyn;

/// `haveEquivalentToolSchemas` over the binary wire.
#[napi(js_name = "haveEquivalentToolSchemasWire")]
pub fn have_equivalent_tool_schemas_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: serde_json::Value = wire::read_value(r, &S_HAVE_EQUIVALENT_TOOL_SCHEMAS_0)?;
        let right: serde_json::Value = wire::read_value(r, &S_HAVE_EQUIVALENT_TOOL_SCHEMAS_1)?;
        let out = &port::have_equivalent_tool_schemas(left, right)?;
        wire::write_value(w, out, &S_HAVE_EQUIVALENT_TOOL_SCHEMAS_OUT)?;
        Ok(())
    })
}

static S_IS_XAI_PROVIDER_ID_0: wire::Schema = wire::Schema::Dyn;
static S_IS_XAI_PROVIDER_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `isXaiProviderID` over the binary wire.
#[napi(js_name = "isXaiProviderIDWire")]
pub fn is_xai_provider_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_IS_XAI_PROVIDER_ID_0)?;
        let out = &port::is_xai_provider_id(value)?;
        wire::write_value(w, out, &S_IS_XAI_PROVIDER_ID_OUT)?;
        Ok(())
    })
}

static S_LIST_XAI_MODEL_IDS_0: wire::Schema = wire::Schema::Dyn;
static S_LIST_XAI_MODEL_IDS_OUT: wire::Schema = wire::Schema::Dyn;

/// `listXaiModelIds` over the binary wire.
#[napi(js_name = "listXaiModelIdsWire")]
pub fn list_xai_model_ids_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_payload: serde_json::Value = wire::read_value(r, &S_LIST_XAI_MODEL_IDS_0)?;
        let out = &port::list_xai_model_ids(provider_payload)?;
        wire::write_value(w, out, &S_LIST_XAI_MODEL_IDS_OUT)?;
        Ok(())
    })
}

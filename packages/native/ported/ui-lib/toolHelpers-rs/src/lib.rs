//! JS bindings for `toolHelpers.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getToolMetadata`.
#[napi(js_name = "getToolMetadata")]
pub fn get_tool_metadata(tool_name: String) -> napi::Result<String> {
    run(move || {
        let tool_name = crate::js::from_json(&tool_name)?;
        let out = port::get_tool_metadata(tool_name)?;
        crate::js::to_json(&out)
    })
}

/// `detectToolOutputLanguage`.
#[napi(js_name = "detectToolOutputLanguage")]
pub fn detect_tool_output_language(tool_name: String, output: String, input: String) -> napi::Result<String> {
    run(move || {
        let tool_name = crate::js::from_json(&tool_name)?;
        let output = crate::js::from_json(&output)?;
        let input = crate::js::from_json(&input)?;
        let out = port::detect_tool_output_language(tool_name, output, input)?;
        crate::js::to_json(&out)
    })
}

/// `getLanguageFromExtension`.
#[napi(js_name = "getLanguageFromExtension")]
pub fn get_language_from_extension(file_path: String) -> napi::Result<String> {
    run(move || {
        let file_path = crate::js::from_json(&file_path)?;
        let out = port::get_language_from_extension(file_path)?;
        crate::js::to_json(&out)
    })
}

/// `isImageFile`.
#[napi(js_name = "isImageFile")]
pub fn is_image_file(file_path: String) -> napi::Result<bool> {
    run(move || {
        let out = port::is_image_file(file_path)?;
        Ok(out)
    })
}

/// `getImageMimeType`.
#[napi(js_name = "getImageMimeType")]
pub fn get_image_mime_type(file_path: String) -> napi::Result<String> {
    run(move || {
        let out = port::get_image_mime_type(file_path)?;
        crate::js::to_json(&out)
    })
}

/// `formatToolInput`.
#[napi(js_name = "formatToolInput")]
pub fn format_tool_input(input: String, tool_name: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let tool_name = crate::js::from_json(&tool_name)?;
        let out = port::format_tool_input(input, tool_name)?;
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

static S_GET_TOOL_METADATA_0: wire::Schema = wire::Schema::Dyn;
static S_GET_TOOL_METADATA_OUT: wire::Schema = wire::Schema::Obj(&[
    ("displayName", wire::Schema::Str16),
    ("icon", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("outputLanguage", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "inputFields",
        wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Obj(&[
            ("key", wire::Schema::Str16),
            ("label", wire::Schema::Str16),
            ("type", wire::Schema::Str16),
            ("language", wire::Schema::OptJs(&wire::Schema::Str16)),
        ]))),
    ),
    ("category", wire::Schema::Str16),
]);

/// `getToolMetadata` over the binary wire.
#[napi(js_name = "getToolMetadataWire")]
pub fn get_tool_metadata_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tool_name: Value = wire::read_value(r, &S_GET_TOOL_METADATA_0)?;
        let out = &port::get_tool_metadata(tool_name)?;
        wire::write_value(w, out, &S_GET_TOOL_METADATA_OUT)?;
        Ok(())
    })
}

static S_DETECT_TOOL_OUTPUT_LANGUAGE_0: wire::Schema = wire::Schema::Dyn;
static S_DETECT_TOOL_OUTPUT_LANGUAGE_1: wire::Schema = wire::Schema::Dyn;
static S_DETECT_TOOL_OUTPUT_LANGUAGE_2: wire::Schema = wire::Schema::Dyn;
static S_DETECT_TOOL_OUTPUT_LANGUAGE_OUT: wire::Schema = wire::Schema::Str16;

/// `detectToolOutputLanguage` over the binary wire.
#[napi(js_name = "detectToolOutputLanguageWire")]
pub fn detect_tool_output_language_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tool_name: Value = wire::read_value(r, &S_DETECT_TOOL_OUTPUT_LANGUAGE_0)?;
        let output: Value = wire::read_value(r, &S_DETECT_TOOL_OUTPUT_LANGUAGE_1)?;
        let input: Value = wire::read_value(r, &S_DETECT_TOOL_OUTPUT_LANGUAGE_2)?;
        let out = &port::detect_tool_output_language(tool_name, output, input)?;
        wire::write_value(w, out, &S_DETECT_TOOL_OUTPUT_LANGUAGE_OUT)?;
        Ok(())
    })
}

static S_GET_LANGUAGE_FROM_EXTENSION_0: wire::Schema = wire::Schema::Dyn;
static S_GET_LANGUAGE_FROM_EXTENSION_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getLanguageFromExtension` over the binary wire.
#[napi(js_name = "getLanguageFromExtensionWire")]
pub fn get_language_from_extension_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let file_path: Value = wire::read_value(r, &S_GET_LANGUAGE_FROM_EXTENSION_0)?;
        let out = &port::get_language_from_extension(file_path)?;
        wire::write_value(w, out, &S_GET_LANGUAGE_FROM_EXTENSION_OUT)?;
        Ok(())
    })
}

/// `isImageFile` over the binary wire.
#[napi(js_name = "isImageFileWire")]
pub fn is_image_file_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let file_path: String = r.string16()?;
        let out = &port::is_image_file(file_path)?;
        w.bool(*out);
        Ok(())
    })
}

static S_GET_IMAGE_MIME_TYPE_OUT: wire::Schema = wire::Schema::Str16;

/// `getImageMimeType` over the binary wire.
#[napi(js_name = "getImageMimeTypeWire")]
pub fn get_image_mime_type_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let file_path: String = r.string16()?;
        let out = &port::get_image_mime_type(file_path)?;
        wire::write_value(w, out, &S_GET_IMAGE_MIME_TYPE_OUT)?;
        Ok(())
    })
}

static S_FORMAT_TOOL_INPUT_0: wire::Schema = wire::Schema::Dyn;
static S_FORMAT_TOOL_INPUT_1: wire::Schema = wire::Schema::Dyn;
static S_FORMAT_TOOL_INPUT_OUT: wire::Schema = wire::Schema::Str16;

/// `formatToolInput` over the binary wire.
#[napi(js_name = "formatToolInputWire")]
pub fn format_tool_input_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: Value = wire::read_value(r, &S_FORMAT_TOOL_INPUT_0)?;
        let tool_name: Value = wire::read_value(r, &S_FORMAT_TOOL_INPUT_1)?;
        let out = &port::format_tool_input(input, tool_name)?;
        wire::write_value(w, out, &S_FORMAT_TOOL_INPUT_OUT)?;
        Ok(())
    })
}

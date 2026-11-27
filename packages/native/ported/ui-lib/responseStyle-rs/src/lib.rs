//! JS bindings for `responseStyle.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isResponseStyleLevel`.
#[napi(js_name = "isResponseStyleLevel")]
pub fn is_response_style_level(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_response_style_level(value)?;
        Ok(out)
    })
}

/// `isResponseStylePreset`.
#[napi(js_name = "isResponseStylePreset")]
pub fn is_response_style_preset(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_response_style_preset(value)?;
        Ok(out)
    })
}

/// `resolveResponseStyleLevel`.
#[napi(js_name = "resolveResponseStyleLevel")]
pub fn resolve_response_style_level(settings: String) -> napi::Result<String> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let out = port::resolve_response_style_level(settings)?;
        crate::js::to_json(&out)
    })
}

/// `getResponseStylePresetInstructions`.
#[napi(js_name = "getResponseStylePresetInstructions")]
pub fn get_response_style_preset_instructions(preset: String) -> napi::Result<String> {
    run(move || {
        let preset = crate::js::from_json(&preset)?;
        let out = port::get_response_style_preset_instructions(preset)?;
        crate::js::to_json(&out)
    })
}

/// `buildResponseStyleInstruction`.
#[napi(js_name = "buildResponseStyleInstruction")]
pub fn build_response_style_instruction(arg0: String) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::build_response_style_instruction(arg0)?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `wrapResponseStyleReminder`.
#[napi(js_name = "wrapResponseStyleReminder")]
pub fn wrap_response_style_reminder(level: String, instruction: String) -> napi::Result<String> {
    run(move || {
        let level = crate::js::from_json(&level)?;
        let out = port::wrap_response_style_reminder(level, instruction)?;
        Ok(out)
    })
}

/// `readResponseStyleLevelFromParts`.
#[napi(js_name = "readResponseStyleLevelFromParts")]
pub fn read_response_style_level_from_parts(parts: String) -> napi::Result<String> {
    run(move || {
        let parts = crate::js::from_json(&parts)?;
        let out = port::read_response_style_level_from_parts(parts)?;
        crate::js::to_json(&out)
    })
}

/// `readSessionResponseStyleLevel`.
#[napi(js_name = "readSessionResponseStyleLevel")]
pub fn read_session_response_style_level(messages: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::read_session_response_style_level(messages)?;
        crate::js::to_json(&out)
    })
}

/// `shouldAttachResponseStyleReminder`.
#[napi(js_name = "shouldAttachResponseStyleReminder")]
pub fn should_attach_response_style_reminder(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::should_attach_response_style_reminder(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `cacheResponseStyleInstructionFromSettings`.
#[napi(js_name = "cacheResponseStyleInstructionFromSettings")]
pub fn cache_response_style_instruction_from_settings(settings: String) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let out = port::cache_response_style_instruction_from_settings(settings)?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `getCachedResponseStyleInstruction`.
#[napi(js_name = "getCachedResponseStyleInstruction")]
pub fn get_cached_response_style_instruction() -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let out = port::get_cached_response_style_instruction()?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `getCachedResponseStyleLevel`.
#[napi(js_name = "getCachedResponseStyleLevel")]
pub fn get_cached_response_style_level() -> napi::Result<String> {
    run(move || {
        let out = port::get_cached_response_style_level()?;
        crate::js::to_json(&out)
    })
}

/// `isResponseStyleInstructionLoaded`.
#[napi(js_name = "isResponseStyleInstructionLoaded")]
pub fn is_response_style_instruction_loaded() -> napi::Result<bool> {
    run(move || {
        let out = port::is_response_style_instruction_loaded()?;
        Ok(out)
    })
}

/// `clearResponseStyleInstructionCacheForTests`.
#[napi(js_name = "clearResponseStyleInstructionCacheForTests")]
pub fn clear_response_style_instruction_cache_for_tests() -> napi::Result<()> {
    run(move || {
        port::clear_response_style_instruction_cache_for_tests()?;
        Ok(())
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

static S_IS_RESPONSE_STYLE_LEVEL_0: wire::Schema = wire::Schema::Dyn;

/// `isResponseStyleLevel` over the binary wire.
#[napi(js_name = "isResponseStyleLevelWire")]
pub fn is_response_style_level_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_RESPONSE_STYLE_LEVEL_0)?;
        let out = &port::is_response_style_level(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_IS_RESPONSE_STYLE_PRESET_0: wire::Schema = wire::Schema::Dyn;

/// `isResponseStylePreset` over the binary wire.
#[napi(js_name = "isResponseStylePresetWire")]
pub fn is_response_style_preset_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_RESPONSE_STYLE_PRESET_0)?;
        let out = &port::is_response_style_preset(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_RESOLVE_RESPONSE_STYLE_LEVEL_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_RESPONSE_STYLE_LEVEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `resolveResponseStyleLevel` over the binary wire.
#[napi(js_name = "resolveResponseStyleLevelWire")]
pub fn resolve_response_style_level_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let settings: Value = wire::read_value(r, &S_RESOLVE_RESPONSE_STYLE_LEVEL_0)?;
        let out = &port::resolve_response_style_level(settings)?;
        wire::write_value(w, out, &S_RESOLVE_RESPONSE_STYLE_LEVEL_OUT)?;
        Ok(())
    })
}

static S_GET_RESPONSE_STYLE_PRESET_INSTRUCTIONS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_RESPONSE_STYLE_PRESET_INSTRUCTIONS_OUT: wire::Schema = wire::Schema::Str16;

/// `getResponseStylePresetInstructions` over the binary wire.
#[napi(js_name = "getResponseStylePresetInstructionsWire")]
pub fn get_response_style_preset_instructions_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let preset: Value = wire::read_value(r, &S_GET_RESPONSE_STYLE_PRESET_INSTRUCTIONS_0)?;
        let out = &port::get_response_style_preset_instructions(preset)?;
        wire::write_value(w, out, &S_GET_RESPONSE_STYLE_PRESET_INSTRUCTIONS_OUT)?;
        Ok(())
    })
}

static S_BUILD_RESPONSE_STYLE_INSTRUCTION_0: wire::Schema = wire::Schema::Dyn;

/// `buildResponseStyleInstruction` over the binary wire.
#[napi(js_name = "buildResponseStyleInstructionWire")]
pub fn build_response_style_instruction_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_BUILD_RESPONSE_STYLE_INSTRUCTION_0)?;
        let out = &port::build_response_style_instruction(arg0)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.string16(x0);
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

static S_WRAP_RESPONSE_STYLE_REMINDER_0: wire::Schema = wire::Schema::Dyn;

/// `wrapResponseStyleReminder` over the binary wire.
#[napi(js_name = "wrapResponseStyleReminderWire")]
pub fn wrap_response_style_reminder_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let level: Value = wire::read_value(r, &S_WRAP_RESPONSE_STYLE_REMINDER_0)?;
        let instruction: String = r.string16()?;
        let out = &port::wrap_response_style_reminder(level, instruction)?;
        w.string16(out);
        Ok(())
    })
}

static S_READ_RESPONSE_STYLE_LEVEL_FROM_PARTS_0: wire::Schema = wire::Schema::Dyn;
static S_READ_RESPONSE_STYLE_LEVEL_FROM_PARTS_OUT: wire::Schema = wire::Schema::Dyn;

/// `readResponseStyleLevelFromParts` over the binary wire.
#[napi(js_name = "readResponseStyleLevelFromPartsWire")]
pub fn read_response_style_level_from_parts_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let parts: Value = wire::read_value(r, &S_READ_RESPONSE_STYLE_LEVEL_FROM_PARTS_0)?;
        let out = &port::read_response_style_level_from_parts(parts)?;
        wire::write_value(w, out, &S_READ_RESPONSE_STYLE_LEVEL_FROM_PARTS_OUT)?;
        Ok(())
    })
}

static S_READ_SESSION_RESPONSE_STYLE_LEVEL_0: wire::Schema = wire::Schema::Dyn;
static S_READ_SESSION_RESPONSE_STYLE_LEVEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `readSessionResponseStyleLevel` over the binary wire.
#[napi(js_name = "readSessionResponseStyleLevelWire")]
pub fn read_session_response_style_level_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_READ_SESSION_RESPONSE_STYLE_LEVEL_0)?;
        let out = &port::read_session_response_style_level(messages)?;
        wire::write_value(w, out, &S_READ_SESSION_RESPONSE_STYLE_LEVEL_OUT)?;
        Ok(())
    })
}

static S_SHOULD_ATTACH_RESPONSE_STYLE_REMINDER_0: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_ATTACH_RESPONSE_STYLE_REMINDER_OUT: wire::Schema = wire::Schema::Bool;

/// `shouldAttachResponseStyleReminder` over the binary wire.
#[napi(js_name = "shouldAttachResponseStyleReminderWire")]
pub fn should_attach_response_style_reminder_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_SHOULD_ATTACH_RESPONSE_STYLE_REMINDER_0)?;
        let out = &port::should_attach_response_style_reminder(arg0)?;
        wire::write_value(w, out, &S_SHOULD_ATTACH_RESPONSE_STYLE_REMINDER_OUT)?;
        Ok(())
    })
}

static S_CACHE_RESPONSE_STYLE_INSTRUCTION_FROM_SETTINGS_0: wire::Schema = wire::Schema::Dyn;

/// `cacheResponseStyleInstructionFromSettings` over the binary wire.
#[napi(js_name = "cacheResponseStyleInstructionFromSettingsWire")]
pub fn cache_response_style_instruction_from_settings_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let settings: Value = wire::read_value(r, &S_CACHE_RESPONSE_STYLE_INSTRUCTION_FROM_SETTINGS_0)?;
        let out = &port::cache_response_style_instruction_from_settings(settings)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.string16(x0);
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

/// `getCachedResponseStyleInstruction` over the binary wire.
#[napi(js_name = "getCachedResponseStyleInstructionWire")]
pub fn get_cached_response_style_instruction_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::get_cached_response_style_instruction()?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.string16(x0);
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

static S_GET_CACHED_RESPONSE_STYLE_LEVEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `getCachedResponseStyleLevel` over the binary wire.
#[napi(js_name = "getCachedResponseStyleLevelWire")]
pub fn get_cached_response_style_level_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::get_cached_response_style_level()?;
        wire::write_value(w, out, &S_GET_CACHED_RESPONSE_STYLE_LEVEL_OUT)?;
        Ok(())
    })
}

/// `isResponseStyleInstructionLoaded` over the binary wire.
#[napi(js_name = "isResponseStyleInstructionLoadedWire")]
pub fn is_response_style_instruction_loaded_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::is_response_style_instruction_loaded()?;
        w.bool(*out);
        Ok(())
    })
}

/// `clearResponseStyleInstructionCacheForTests` over the binary wire.
#[napi(js_name = "clearResponseStyleInstructionCacheForTestsWire")]
pub fn clear_response_style_instruction_cache_for_tests_wire() -> napi::Result<f64> {
    wire_io(|_r, _w| {
        let () = port::clear_response_style_instruction_cache_for_tests()?;
        Ok(())
    })
}

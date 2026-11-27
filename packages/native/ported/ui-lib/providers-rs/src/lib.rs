//! JS bindings for `providers/`: generated from the signatures in `port.rs` by rust-anything.
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

/// `resolveChatThinkingLevel`.
#[napi(js_name = "resolveChatThinkingLevel")]
pub fn resolve_chat_thinking_level(value: String, levels: String, model_default: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let levels = crate::js::from_json(&levels)?;
        let model_default = crate::js::from_json(&model_default)?;
        let out = port::resolve_chat_thinking_level(value, levels, model_default)?;
        crate::js::to_json(&out)
    })
}

/// `isCursorAcpProvider`.
#[napi(js_name = "isCursorAcpProvider")]
pub fn is_cursor_acp_provider(provider: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let out = port::is_cursor_acp_provider(provider)?;
        crate::js::to_json(&out)
    })
}

/// `getCursorAcpBaseModelId`.
#[napi(js_name = "getCursorAcpBaseModelId")]
pub fn get_cursor_acp_base_model_id(model_id: String) -> napi::Result<String> {
    run(move || {
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::get_cursor_acp_base_model_id(model_id)?;
        crate::js::to_json(&out)
    })
}

/// `getCursorAcpFastModelId`.
#[napi(js_name = "getCursorAcpFastModelId")]
pub fn get_cursor_acp_fast_model_id(model_id: String) -> napi::Result<String> {
    run(move || {
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::get_cursor_acp_fast_model_id(model_id)?;
        crate::js::to_json(&out)
    })
}

/// `findCursorAcpModel`.
#[napi(js_name = "findCursorAcpModel")]
pub fn find_cursor_acp_model(provider: String, model_id: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::find_cursor_acp_model(provider, model_id)?;
        crate::js::to_json(&out)
    })
}

/// `shouldHideCursorAcpFastModel`.
#[napi(js_name = "shouldHideCursorAcpFastModel")]
pub fn should_hide_cursor_acp_fast_model(provider: String, model_id: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::should_hide_cursor_acp_fast_model(provider, model_id)?;
        crate::js::to_json(&out)
    })
}

/// `parseCursorAcpVariantKey`.
#[napi(js_name = "parseCursorAcpVariantKey")]
pub fn parse_cursor_acp_variant_key(variant: String) -> napi::Result<String> {
    run(move || {
        let variant = crate::js::from_json(&variant)?;
        let out = port::parse_cursor_acp_variant_key(variant)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeCursorAcpVariantKey`.
#[napi(js_name = "normalizeCursorAcpVariantKey")]
pub fn normalize_cursor_acp_variant_key(variant: String) -> napi::Result<String> {
    run(move || {
        let variant = crate::js::from_json(&variant)?;
        let out = port::normalize_cursor_acp_variant_key(variant)?;
        crate::js::to_json(&out)
    })
}

/// `isAnthropicOAuthProviderId`.
#[napi(js_name = "isAnthropicOAuthProviderId")]
pub fn is_anthropic_o_auth_provider_id(provider_id: String) -> napi::Result<String> {
    run(move || {
        let provider_id = crate::js::from_json(&provider_id)?;
        let out = port::is_anthropic_o_auth_provider_id(provider_id)?;
        crate::js::to_json(&out)
    })
}

/// `getProviderDisplayName`.
#[napi(js_name = "getProviderDisplayName")]
pub fn get_provider_display_name(provider: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let out = port::get_provider_display_name(provider)?;
        crate::js::to_json(&out)
    })
}

/// `shouldPreserveProviderLogoColor`.
#[napi(js_name = "shouldPreserveProviderLogoColor")]
pub fn should_preserve_provider_logo_color(provider_id: String) -> napi::Result<bool> {
    run(move || {
        let provider_id = crate::js::from_json(&provider_id)?;
        let out = port::should_preserve_provider_logo_color(provider_id)?;
        Ok(out)
    })
}

/// `isProviderModelAvailable`.
#[napi(js_name = "isProviderModelAvailable")]
pub fn is_provider_model_available(model: String) -> napi::Result<bool> {
    run(move || {
        let model = crate::js::from_json(&model)?;
        let out = port::is_provider_model_available(model)?;
        Ok(out)
    })
}

/// `resolveAvailableProviderModel`.
#[napi(js_name = "resolveAvailableProviderModel")]
pub fn resolve_available_provider_model(providers: String, preferred_provider_id: String, preferred_model_id: String) -> napi::Result<String> {
    run(move || {
        let providers = crate::js::from_json(&providers)?;
        let preferred_provider_id = crate::js::from_json(&preferred_provider_id)?;
        let preferred_model_id = crate::js::from_json(&preferred_model_id)?;
        let out = port::resolve_available_provider_model(providers, preferred_provider_id, preferred_model_id)?;
        crate::js::to_json(&out)
    })
}

/// `getProviderModelUnavailability`.
#[napi(js_name = "getProviderModelUnavailability")]
pub fn get_provider_model_unavailability(model: String) -> napi::Result<String> {
    run(move || {
        let model = crate::js::from_json(&model)?;
        let out = port::get_provider_model_unavailability(model)?;
        crate::js::to_json(&out)
    })
}

/// `getProviderModelUnavailableMessage`.
#[napi(js_name = "getProviderModelUnavailableMessage")]
pub fn get_provider_model_unavailable_message(model: String) -> napi::Result<String> {
    run(move || {
        let model = crate::js::from_json(&model)?;
        let out = port::get_provider_model_unavailable_message(model)?;
        crate::js::to_json(&out)
    })
}

/// `getModelDisplayName`.
#[napi(js_name = "getModelDisplayName")]
pub fn get_model_display_name(model: String) -> napi::Result<String> {
    run(move || {
        let model = crate::js::from_json(&model)?;
        let out = port::get_model_display_name(model)?;
        crate::js::to_json(&out)
    })
}

/// `getExecutionProviderId`.
#[napi(js_name = "getExecutionProviderId")]
pub fn get_execution_provider_id(provider_id: String, model: String) -> napi::Result<String> {
    run(move || {
        let provider_id = crate::js::from_json(&provider_id)?;
        let model = crate::js::from_json(&model)?;
        let out = port::get_execution_provider_id(provider_id, model)?;
        crate::js::to_json(&out)
    })
}

/// `getHiddenModelRefsForProviderModel`.
#[napi(js_name = "getHiddenModelRefsForProviderModel")]
pub fn get_hidden_model_refs_for_provider_model(provider_id: String, model: String) -> napi::Result<String> {
    run(move || {
        let provider_id = crate::js::from_json(&provider_id)?;
        let model = crate::js::from_json(&model)?;
        let out = port::get_hidden_model_refs_for_provider_model(provider_id, model)?;
        crate::js::to_json(&out)
    })
}

/// `isHiddenModelRef`.
#[napi(js_name = "isHiddenModelRef")]
pub fn is_hidden_model_ref(hidden_models: String, provider_id: String, model_id: String) -> napi::Result<bool> {
    run(move || {
        let hidden_models = crate::js::from_json(&hidden_models)?;
        let provider_id = crate::js::from_json(&provider_id)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::is_hidden_model_ref(hidden_models, provider_id, model_id)?;
        Ok(out)
    })
}

/// `isHiddenProviderModelRef`.
#[napi(js_name = "isHiddenProviderModelRef")]
pub fn is_hidden_provider_model_ref(hidden_models: String, provider_id: String, model: String) -> napi::Result<bool> {
    run(move || {
        let hidden_models = crate::js::from_json(&hidden_models)?;
        let provider_id = crate::js::from_json(&provider_id)?;
        let model = crate::js::from_json(&model)?;
        let out = port::is_hidden_provider_model_ref(hidden_models, provider_id, model)?;
        Ok(out)
    })
}

/// `getModelDefaultThinkingLevel`.
#[napi(js_name = "getModelDefaultThinkingLevel")]
pub fn get_model_default_thinking_level(provider: String, model_id: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::get_model_default_thinking_level(provider, model_id)?;
        crate::js::to_json(&out)
    })
}

/// `resolveThinkingVariant`.
#[napi(js_name = "resolveThinkingVariant")]
pub fn resolve_thinking_variant(variant: String, variants: String, context: String) -> napi::Result<String> {
    run(move || {
        let variant = crate::js::from_json(&variant)?;
        let variants = crate::js::from_json(&variants)?;
        let context = crate::js::from_json(&context)?;
        let out = port::resolve_thinking_variant(variant, variants, context)?;
        crate::js::to_json(&out)
    })
}

/// `getFastModelBaseId`.
#[napi(js_name = "getFastModelBaseId")]
pub fn get_fast_model_base_id(model_id: String) -> napi::Result<String> {
    run(move || {
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::get_fast_model_base_id(model_id)?;
        crate::js::to_json(&out)
    })
}

/// `findProviderModel`.
#[napi(js_name = "findProviderModel")]
pub fn find_provider_model(provider: String, model_id: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::find_provider_model(provider, model_id)?;
        crate::js::to_json(&out)
    })
}

/// `shouldHidePairedFastModel`.
#[napi(js_name = "shouldHidePairedFastModel")]
pub fn should_hide_paired_fast_model(provider: String, model_id: String) -> napi::Result<bool> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let out = port::should_hide_paired_fast_model(provider, model_id)?;
        Ok(out)
    })
}

/// `resolveProviderModelVariant`.
#[napi(js_name = "resolveProviderModelVariant")]
pub fn resolve_provider_model_variant(provider: String, model_id: String, variant: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let model_id = crate::js::from_json(&model_id)?;
        let variant = crate::js::from_json(&variant)?;
        let out = port::resolve_provider_model_variant(provider, model_id, variant)?;
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

static S_RESOLVE_CHAT_THINKING_LEVEL_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_CHAT_THINKING_LEVEL_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_CHAT_THINKING_LEVEL_2: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_CHAT_THINKING_LEVEL_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `resolveChatThinkingLevel` over the binary wire.
#[napi(js_name = "resolveChatThinkingLevelWire")]
pub fn resolve_chat_thinking_level_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_RESOLVE_CHAT_THINKING_LEVEL_0)?;
        let levels: Value = wire::read_value(r, &S_RESOLVE_CHAT_THINKING_LEVEL_1)?;
        let model_default: Value = wire::read_value(r, &S_RESOLVE_CHAT_THINKING_LEVEL_2)?;
        let out = &port::resolve_chat_thinking_level(value, levels, model_default)?;
        wire::write_value(w, out, &S_RESOLVE_CHAT_THINKING_LEVEL_OUT)?;
        Ok(())
    })
}

static S_IS_CURSOR_ACP_PROVIDER_0: wire::Schema = wire::Schema::Dyn;
static S_IS_CURSOR_ACP_PROVIDER_OUT: wire::Schema = wire::Schema::Dyn;

/// `isCursorAcpProvider` over the binary wire.
#[napi(js_name = "isCursorAcpProviderWire")]
pub fn is_cursor_acp_provider_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_IS_CURSOR_ACP_PROVIDER_0)?;
        let out = &port::is_cursor_acp_provider(provider)?;
        wire::write_value(w, out, &S_IS_CURSOR_ACP_PROVIDER_OUT)?;
        Ok(())
    })
}

static S_GET_CURSOR_ACP_BASE_MODEL_ID_0: wire::Schema = wire::Schema::Dyn;
static S_GET_CURSOR_ACP_BASE_MODEL_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `getCursorAcpBaseModelId` over the binary wire.
#[napi(js_name = "getCursorAcpBaseModelIdWire")]
pub fn get_cursor_acp_base_model_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model_id: Value = wire::read_value(r, &S_GET_CURSOR_ACP_BASE_MODEL_ID_0)?;
        let out = &port::get_cursor_acp_base_model_id(model_id)?;
        wire::write_value(w, out, &S_GET_CURSOR_ACP_BASE_MODEL_ID_OUT)?;
        Ok(())
    })
}

static S_GET_CURSOR_ACP_FAST_MODEL_ID_0: wire::Schema = wire::Schema::Dyn;
static S_GET_CURSOR_ACP_FAST_MODEL_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `getCursorAcpFastModelId` over the binary wire.
#[napi(js_name = "getCursorAcpFastModelIdWire")]
pub fn get_cursor_acp_fast_model_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model_id: Value = wire::read_value(r, &S_GET_CURSOR_ACP_FAST_MODEL_ID_0)?;
        let out = &port::get_cursor_acp_fast_model_id(model_id)?;
        wire::write_value(w, out, &S_GET_CURSOR_ACP_FAST_MODEL_ID_OUT)?;
        Ok(())
    })
}

static S_FIND_CURSOR_ACP_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_CURSOR_ACP_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_FIND_CURSOR_ACP_MODEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `findCursorAcpModel` over the binary wire.
#[napi(js_name = "findCursorAcpModelWire")]
pub fn find_cursor_acp_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_FIND_CURSOR_ACP_MODEL_0)?;
        let model_id: Value = wire::read_value(r, &S_FIND_CURSOR_ACP_MODEL_1)?;
        let out = &port::find_cursor_acp_model(provider, model_id)?;
        wire::write_value(w, out, &S_FIND_CURSOR_ACP_MODEL_OUT)?;
        Ok(())
    })
}

static S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `shouldHideCursorAcpFastModel` over the binary wire.
#[napi(js_name = "shouldHideCursorAcpFastModelWire")]
pub fn should_hide_cursor_acp_fast_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_0)?;
        let model_id: Value = wire::read_value(r, &S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_1)?;
        let out = &port::should_hide_cursor_acp_fast_model(provider, model_id)?;
        wire::write_value(w, out, &S_SHOULD_HIDE_CURSOR_ACP_FAST_MODEL_OUT)?;
        Ok(())
    })
}

static S_PARSE_CURSOR_ACP_VARIANT_KEY_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_CURSOR_ACP_VARIANT_KEY_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("effort", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("thinking", wire::Schema::Bool),
    ("canonical", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `parseCursorAcpVariantKey` over the binary wire.
#[napi(js_name = "parseCursorAcpVariantKeyWire")]
pub fn parse_cursor_acp_variant_key_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let variant: Value = wire::read_value(r, &S_PARSE_CURSOR_ACP_VARIANT_KEY_0)?;
        let out = &port::parse_cursor_acp_variant_key(variant)?;
        wire::write_value(w, out, &S_PARSE_CURSOR_ACP_VARIANT_KEY_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_CURSOR_ACP_VARIANT_KEY_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_CURSOR_ACP_VARIANT_KEY_OUT: wire::Schema = wire::Schema::Dyn;

/// `normalizeCursorAcpVariantKey` over the binary wire.
#[napi(js_name = "normalizeCursorAcpVariantKeyWire")]
pub fn normalize_cursor_acp_variant_key_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let variant: Value = wire::read_value(r, &S_NORMALIZE_CURSOR_ACP_VARIANT_KEY_0)?;
        let out = &port::normalize_cursor_acp_variant_key(variant)?;
        wire::write_value(w, out, &S_NORMALIZE_CURSOR_ACP_VARIANT_KEY_OUT)?;
        Ok(())
    })
}

static S_IS_ANTHROPIC_O_AUTH_PROVIDER_ID_0: wire::Schema = wire::Schema::Dyn;
static S_IS_ANTHROPIC_O_AUTH_PROVIDER_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `isAnthropicOAuthProviderId` over the binary wire.
#[napi(js_name = "isAnthropicOAuthProviderIdWire")]
pub fn is_anthropic_o_auth_provider_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_id: Value = wire::read_value(r, &S_IS_ANTHROPIC_O_AUTH_PROVIDER_ID_0)?;
        let out = &port::is_anthropic_o_auth_provider_id(provider_id)?;
        wire::write_value(w, out, &S_IS_ANTHROPIC_O_AUTH_PROVIDER_ID_OUT)?;
        Ok(())
    })
}

static S_GET_PROVIDER_DISPLAY_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PROVIDER_DISPLAY_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `getProviderDisplayName` over the binary wire.
#[napi(js_name = "getProviderDisplayNameWire")]
pub fn get_provider_display_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_GET_PROVIDER_DISPLAY_NAME_0)?;
        let out = &port::get_provider_display_name(provider)?;
        wire::write_value(w, out, &S_GET_PROVIDER_DISPLAY_NAME_OUT)?;
        Ok(())
    })
}

static S_SHOULD_PRESERVE_PROVIDER_LOGO_COLOR_0: wire::Schema = wire::Schema::Dyn;

/// `shouldPreserveProviderLogoColor` over the binary wire.
#[napi(js_name = "shouldPreserveProviderLogoColorWire")]
pub fn should_preserve_provider_logo_color_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_id: Value = wire::read_value(r, &S_SHOULD_PRESERVE_PROVIDER_LOGO_COLOR_0)?;
        let out = &port::should_preserve_provider_logo_color(provider_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_PROVIDER_MODEL_AVAILABLE_0: wire::Schema = wire::Schema::Dyn;

/// `isProviderModelAvailable` over the binary wire.
#[napi(js_name = "isProviderModelAvailableWire")]
pub fn is_provider_model_available_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: Value = wire::read_value(r, &S_IS_PROVIDER_MODEL_AVAILABLE_0)?;
        let out = &port::is_provider_model_available(model)?;
        w.bool(*out);
        Ok(())
    })
}

static S_RESOLVE_AVAILABLE_PROVIDER_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_AVAILABLE_PROVIDER_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_AVAILABLE_PROVIDER_MODEL_2: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_AVAILABLE_PROVIDER_MODEL_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[("providerId", wire::Schema::Str16), ("modelId", wire::Schema::Str16)]));

/// `resolveAvailableProviderModel` over the binary wire.
#[napi(js_name = "resolveAvailableProviderModelWire")]
pub fn resolve_available_provider_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let providers: Value = wire::read_value(r, &S_RESOLVE_AVAILABLE_PROVIDER_MODEL_0)?;
        let preferred_provider_id: Value = wire::read_value(r, &S_RESOLVE_AVAILABLE_PROVIDER_MODEL_1)?;
        let preferred_model_id: Value = wire::read_value(r, &S_RESOLVE_AVAILABLE_PROVIDER_MODEL_2)?;
        let out = &port::resolve_available_provider_model(providers, preferred_provider_id, preferred_model_id)?;
        wire::write_value(w, out, &S_RESOLVE_AVAILABLE_PROVIDER_MODEL_OUT)?;
        Ok(())
    })
}

static S_GET_PROVIDER_MODEL_UNAVAILABILITY_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PROVIDER_MODEL_UNAVAILABILITY_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[("message", wire::Schema::Str16), ("retryable", wire::Schema::Bool)]));

/// `getProviderModelUnavailability` over the binary wire.
#[napi(js_name = "getProviderModelUnavailabilityWire")]
pub fn get_provider_model_unavailability_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: Value = wire::read_value(r, &S_GET_PROVIDER_MODEL_UNAVAILABILITY_0)?;
        let out = &port::get_provider_model_unavailability(model)?;
        wire::write_value(w, out, &S_GET_PROVIDER_MODEL_UNAVAILABILITY_OUT)?;
        Ok(())
    })
}

static S_GET_PROVIDER_MODEL_UNAVAILABLE_MESSAGE_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PROVIDER_MODEL_UNAVAILABLE_MESSAGE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getProviderModelUnavailableMessage` over the binary wire.
#[napi(js_name = "getProviderModelUnavailableMessageWire")]
pub fn get_provider_model_unavailable_message_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: Value = wire::read_value(r, &S_GET_PROVIDER_MODEL_UNAVAILABLE_MESSAGE_0)?;
        let out = &port::get_provider_model_unavailable_message(model)?;
        wire::write_value(w, out, &S_GET_PROVIDER_MODEL_UNAVAILABLE_MESSAGE_OUT)?;
        Ok(())
    })
}

static S_GET_MODEL_DISPLAY_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_GET_MODEL_DISPLAY_NAME_OUT: wire::Schema = wire::Schema::Str16;

/// `getModelDisplayName` over the binary wire.
#[napi(js_name = "getModelDisplayNameWire")]
pub fn get_model_display_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: Value = wire::read_value(r, &S_GET_MODEL_DISPLAY_NAME_0)?;
        let out = &port::get_model_display_name(model)?;
        wire::write_value(w, out, &S_GET_MODEL_DISPLAY_NAME_OUT)?;
        Ok(())
    })
}

static S_GET_EXECUTION_PROVIDER_ID_0: wire::Schema = wire::Schema::Dyn;
static S_GET_EXECUTION_PROVIDER_ID_1: wire::Schema = wire::Schema::Dyn;
static S_GET_EXECUTION_PROVIDER_ID_OUT: wire::Schema = wire::Schema::Str16;

/// `getExecutionProviderId` over the binary wire.
#[napi(js_name = "getExecutionProviderIdWire")]
pub fn get_execution_provider_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_id: Value = wire::read_value(r, &S_GET_EXECUTION_PROVIDER_ID_0)?;
        let model: Value = wire::read_value(r, &S_GET_EXECUTION_PROVIDER_ID_1)?;
        let out = &port::get_execution_provider_id(provider_id, model)?;
        wire::write_value(w, out, &S_GET_EXECUTION_PROVIDER_ID_OUT)?;
        Ok(())
    })
}

static S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_OUT: wire::Schema = wire::Schema::Obj(&[
    (
        "canonical",
        wire::Schema::OptJs(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
    (
        "aliases",
        wire::Schema::List(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
]);

/// `getHiddenModelRefsForProviderModel` over the binary wire.
#[napi(js_name = "getHiddenModelRefsForProviderModelWire")]
pub fn get_hidden_model_refs_for_provider_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider_id: Value = wire::read_value(r, &S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_0)?;
        let model: Value = wire::read_value(r, &S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_1)?;
        let out = &port::get_hidden_model_refs_for_provider_model(provider_id, model)?;
        wire::write_value(w, out, &S_GET_HIDDEN_MODEL_REFS_FOR_PROVIDER_MODEL_OUT)?;
        Ok(())
    })
}

static S_IS_HIDDEN_MODEL_REF_0: wire::Schema = wire::Schema::Dyn;
static S_IS_HIDDEN_MODEL_REF_1: wire::Schema = wire::Schema::Dyn;
static S_IS_HIDDEN_MODEL_REF_2: wire::Schema = wire::Schema::Dyn;

/// `isHiddenModelRef` over the binary wire.
#[napi(js_name = "isHiddenModelRefWire")]
pub fn is_hidden_model_ref_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let hidden_models: Value = wire::read_value(r, &S_IS_HIDDEN_MODEL_REF_0)?;
        let provider_id: Value = wire::read_value(r, &S_IS_HIDDEN_MODEL_REF_1)?;
        let model_id: Value = wire::read_value(r, &S_IS_HIDDEN_MODEL_REF_2)?;
        let out = &port::is_hidden_model_ref(hidden_models, provider_id, model_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_IS_HIDDEN_PROVIDER_MODEL_REF_0: wire::Schema = wire::Schema::Dyn;
static S_IS_HIDDEN_PROVIDER_MODEL_REF_1: wire::Schema = wire::Schema::Dyn;
static S_IS_HIDDEN_PROVIDER_MODEL_REF_2: wire::Schema = wire::Schema::Dyn;

/// `isHiddenProviderModelRef` over the binary wire.
#[napi(js_name = "isHiddenProviderModelRefWire")]
pub fn is_hidden_provider_model_ref_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let hidden_models: Value = wire::read_value(r, &S_IS_HIDDEN_PROVIDER_MODEL_REF_0)?;
        let provider_id: Value = wire::read_value(r, &S_IS_HIDDEN_PROVIDER_MODEL_REF_1)?;
        let model: Value = wire::read_value(r, &S_IS_HIDDEN_PROVIDER_MODEL_REF_2)?;
        let out = &port::is_hidden_provider_model_ref(hidden_models, provider_id, model)?;
        w.bool(*out);
        Ok(())
    })
}

static S_GET_MODEL_DEFAULT_THINKING_LEVEL_0: wire::Schema = wire::Schema::Dyn;
static S_GET_MODEL_DEFAULT_THINKING_LEVEL_1: wire::Schema = wire::Schema::Dyn;
static S_GET_MODEL_DEFAULT_THINKING_LEVEL_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `getModelDefaultThinkingLevel` over the binary wire.
#[napi(js_name = "getModelDefaultThinkingLevelWire")]
pub fn get_model_default_thinking_level_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_GET_MODEL_DEFAULT_THINKING_LEVEL_0)?;
        let model_id: Value = wire::read_value(r, &S_GET_MODEL_DEFAULT_THINKING_LEVEL_1)?;
        let out = &port::get_model_default_thinking_level(provider, model_id)?;
        wire::write_value(w, out, &S_GET_MODEL_DEFAULT_THINKING_LEVEL_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_THINKING_VARIANT_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_THINKING_VARIANT_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_THINKING_VARIANT_2: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_THINKING_VARIANT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `resolveThinkingVariant` over the binary wire.
#[napi(js_name = "resolveThinkingVariantWire")]
pub fn resolve_thinking_variant_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let variant: Value = wire::read_value(r, &S_RESOLVE_THINKING_VARIANT_0)?;
        let variants: Value = wire::read_value(r, &S_RESOLVE_THINKING_VARIANT_1)?;
        let context: Value = wire::read_value(r, &S_RESOLVE_THINKING_VARIANT_2)?;
        let out = &port::resolve_thinking_variant(variant, variants, context)?;
        wire::write_value(w, out, &S_RESOLVE_THINKING_VARIANT_OUT)?;
        Ok(())
    })
}

static S_GET_FAST_MODEL_BASE_ID_0: wire::Schema = wire::Schema::Dyn;
static S_GET_FAST_MODEL_BASE_ID_OUT: wire::Schema = wire::Schema::Str16;

/// `getFastModelBaseId` over the binary wire.
#[napi(js_name = "getFastModelBaseIdWire")]
pub fn get_fast_model_base_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model_id: Value = wire::read_value(r, &S_GET_FAST_MODEL_BASE_ID_0)?;
        let out = &port::get_fast_model_base_id(model_id)?;
        wire::write_value(w, out, &S_GET_FAST_MODEL_BASE_ID_OUT)?;
        Ok(())
    })
}

static S_FIND_PROVIDER_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_PROVIDER_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_FIND_PROVIDER_MODEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `findProviderModel` over the binary wire.
#[napi(js_name = "findProviderModelWire")]
pub fn find_provider_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_FIND_PROVIDER_MODEL_0)?;
        let model_id: Value = wire::read_value(r, &S_FIND_PROVIDER_MODEL_1)?;
        let out = &port::find_provider_model(provider, model_id)?;
        wire::write_value(w, out, &S_FIND_PROVIDER_MODEL_OUT)?;
        Ok(())
    })
}

static S_SHOULD_HIDE_PAIRED_FAST_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_HIDE_PAIRED_FAST_MODEL_1: wire::Schema = wire::Schema::Dyn;

/// `shouldHidePairedFastModel` over the binary wire.
#[napi(js_name = "shouldHidePairedFastModelWire")]
pub fn should_hide_paired_fast_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_SHOULD_HIDE_PAIRED_FAST_MODEL_0)?;
        let model_id: Value = wire::read_value(r, &S_SHOULD_HIDE_PAIRED_FAST_MODEL_1)?;
        let out = &port::should_hide_paired_fast_model(provider, model_id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_RESOLVE_PROVIDER_MODEL_VARIANT_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_PROVIDER_MODEL_VARIANT_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_PROVIDER_MODEL_VARIANT_2: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_PROVIDER_MODEL_VARIANT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `resolveProviderModelVariant` over the binary wire.
#[napi(js_name = "resolveProviderModelVariantWire")]
pub fn resolve_provider_model_variant_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_RESOLVE_PROVIDER_MODEL_VARIANT_0)?;
        let model_id: Value = wire::read_value(r, &S_RESOLVE_PROVIDER_MODEL_VARIANT_1)?;
        let variant: Value = wire::read_value(r, &S_RESOLVE_PROVIDER_MODEL_VARIANT_2)?;
        let out = &port::resolve_provider_model_variant(provider, model_id, variant)?;
        wire::write_value(w, out, &S_RESOLVE_PROVIDER_MODEL_VARIANT_OUT)?;
        Ok(())
    })
}

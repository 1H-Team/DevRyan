//! JS bindings for `agentSelection.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `normalizeAgentName`.
#[napi(js_name = "normalizeAgentName")]
pub fn normalize_agent_name(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::normalize_agent_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `isPrimaryAgentMode`.
#[napi(js_name = "isPrimaryAgentMode")]
pub fn is_primary_agent_mode(mode: String) -> napi::Result<String> {
    run(move || {
        let mode = crate::js::from_json(&mode)?;
        let out = port::is_primary_agent_mode(mode)?;
        crate::js::to_json(&out)
    })
}

/// `isHiddenBuiltinAgentOption`.
#[napi(js_name = "isHiddenBuiltinAgentOption")]
pub fn is_hidden_builtin_agent_option(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::is_hidden_builtin_agent_option(name)?;
        crate::js::to_json(&out)
    })
}

/// `isBuilderAgentName`.
#[napi(js_name = "isBuilderAgentName")]
pub fn is_builder_agent_name(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::is_builder_agent_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `isAgentHidden`.
#[napi(js_name = "isAgentHidden")]
pub fn is_agent_hidden(agent: String) -> napi::Result<String> {
    run(move || {
        let agent = crate::js::from_json(&agent)?;
        let out = port::is_agent_hidden(agent)?;
        crate::js::to_json(&out)
    })
}

/// `isSelectablePrimaryAgentOption`.
#[napi(js_name = "isSelectablePrimaryAgentOption")]
pub fn is_selectable_primary_agent_option(agent: String) -> napi::Result<String> {
    run(move || {
        let agent = crate::js::from_json(&agent)?;
        let out = port::is_selectable_primary_agent_option(agent)?;
        crate::js::to_json(&out)
    })
}

/// `findSelectableAgentByName`.
#[napi(js_name = "findSelectableAgentByName")]
pub fn find_selectable_agent_by_name(agents: String, agent_name: String) -> napi::Result<String> {
    run(move || {
        let agents = crate::js::from_json(&agents)?;
        let agent_name = crate::js::from_json(&agent_name)?;
        let out = port::find_selectable_agent_by_name(agents, agent_name)?;
        crate::js::to_json(&out)
    })
}

/// `resolveDefaultAgentName`.
#[napi(js_name = "resolveDefaultAgentName")]
pub fn resolve_default_agent_name(saved_agent: String, selectable_agents: String) -> napi::Result<String> {
    run(move || {
        let saved_agent = crate::js::from_json(&saved_agent)?;
        let selectable_agents = crate::js::from_json(&selectable_agents)?;
        let out = port::resolve_default_agent_name(saved_agent, selectable_agents)?;
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

static S_NORMALIZE_AGENT_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_AGENT_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `normalizeAgentName` over the binary wire.
#[napi(js_name = "normalizeAgentNameWire")]
pub fn normalize_agent_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_NORMALIZE_AGENT_NAME_0)?;
        let out = &port::normalize_agent_name(name)?;
        wire::write_value(w, out, &S_NORMALIZE_AGENT_NAME_OUT)?;
        Ok(())
    })
}

static S_IS_PRIMARY_AGENT_MODE_0: wire::Schema = wire::Schema::Dyn;
static S_IS_PRIMARY_AGENT_MODE_OUT: wire::Schema = wire::Schema::Dyn;

/// `isPrimaryAgentMode` over the binary wire.
#[napi(js_name = "isPrimaryAgentModeWire")]
pub fn is_primary_agent_mode_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let mode: Value = wire::read_value(r, &S_IS_PRIMARY_AGENT_MODE_0)?;
        let out = &port::is_primary_agent_mode(mode)?;
        wire::write_value(w, out, &S_IS_PRIMARY_AGENT_MODE_OUT)?;
        Ok(())
    })
}

static S_IS_HIDDEN_BUILTIN_AGENT_OPTION_0: wire::Schema = wire::Schema::Dyn;
static S_IS_HIDDEN_BUILTIN_AGENT_OPTION_OUT: wire::Schema = wire::Schema::Dyn;

/// `isHiddenBuiltinAgentOption` over the binary wire.
#[napi(js_name = "isHiddenBuiltinAgentOptionWire")]
pub fn is_hidden_builtin_agent_option_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_IS_HIDDEN_BUILTIN_AGENT_OPTION_0)?;
        let out = &port::is_hidden_builtin_agent_option(name)?;
        wire::write_value(w, out, &S_IS_HIDDEN_BUILTIN_AGENT_OPTION_OUT)?;
        Ok(())
    })
}

static S_IS_BUILDER_AGENT_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_IS_BUILDER_AGENT_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `isBuilderAgentName` over the binary wire.
#[napi(js_name = "isBuilderAgentNameWire")]
pub fn is_builder_agent_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_IS_BUILDER_AGENT_NAME_0)?;
        let out = &port::is_builder_agent_name(name)?;
        wire::write_value(w, out, &S_IS_BUILDER_AGENT_NAME_OUT)?;
        Ok(())
    })
}

static S_IS_AGENT_HIDDEN_0: wire::Schema = wire::Schema::Dyn;
static S_IS_AGENT_HIDDEN_OUT: wire::Schema = wire::Schema::Dyn;

/// `isAgentHidden` over the binary wire.
#[napi(js_name = "isAgentHiddenWire")]
pub fn is_agent_hidden_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agent: Value = wire::read_value(r, &S_IS_AGENT_HIDDEN_0)?;
        let out = &port::is_agent_hidden(agent)?;
        wire::write_value(w, out, &S_IS_AGENT_HIDDEN_OUT)?;
        Ok(())
    })
}

static S_IS_SELECTABLE_PRIMARY_AGENT_OPTION_0: wire::Schema = wire::Schema::Dyn;
static S_IS_SELECTABLE_PRIMARY_AGENT_OPTION_OUT: wire::Schema = wire::Schema::Dyn;

/// `isSelectablePrimaryAgentOption` over the binary wire.
#[napi(js_name = "isSelectablePrimaryAgentOptionWire")]
pub fn is_selectable_primary_agent_option_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agent: Value = wire::read_value(r, &S_IS_SELECTABLE_PRIMARY_AGENT_OPTION_0)?;
        let out = &port::is_selectable_primary_agent_option(agent)?;
        wire::write_value(w, out, &S_IS_SELECTABLE_PRIMARY_AGENT_OPTION_OUT)?;
        Ok(())
    })
}

static S_FIND_SELECTABLE_AGENT_BY_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_SELECTABLE_AGENT_BY_NAME_1: wire::Schema = wire::Schema::Dyn;
static S_FIND_SELECTABLE_AGENT_BY_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `findSelectableAgentByName` over the binary wire.
#[napi(js_name = "findSelectableAgentByNameWire")]
pub fn find_selectable_agent_by_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agents: Value = wire::read_value(r, &S_FIND_SELECTABLE_AGENT_BY_NAME_0)?;
        let agent_name: Value = wire::read_value(r, &S_FIND_SELECTABLE_AGENT_BY_NAME_1)?;
        let out = &port::find_selectable_agent_by_name(agents, agent_name)?;
        wire::write_value(w, out, &S_FIND_SELECTABLE_AGENT_BY_NAME_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_DEFAULT_AGENT_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_DEFAULT_AGENT_NAME_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_DEFAULT_AGENT_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `resolveDefaultAgentName` over the binary wire.
#[napi(js_name = "resolveDefaultAgentNameWire")]
pub fn resolve_default_agent_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let saved_agent: Value = wire::read_value(r, &S_RESOLVE_DEFAULT_AGENT_NAME_0)?;
        let selectable_agents: Value = wire::read_value(r, &S_RESOLVE_DEFAULT_AGENT_NAME_1)?;
        let out = &port::resolve_default_agent_name(saved_agent, selectable_agents)?;
        wire::write_value(w, out, &S_RESOLVE_DEFAULT_AGENT_NAME_OUT)?;
        Ok(())
    })
}

//! JS bindings for `managed-agent-defaults.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `findManagedAgent`.
#[napi(js_name = "findManagedAgent")]
pub fn find_managed_agent(agents: String, agent_name: String) -> napi::Result<String> {
    run(move || {
        let agents = crate::js::from_json(&agents)?;
        let agent_name = crate::js::from_json(&agent_name)?;
        let out = port::find_managed_agent(agents, agent_name)?;
        crate::js::to_json(&out)
    })
}

/// `backupExecutionFromManagedAgent`.
#[napi(js_name = "backupExecutionFromManagedAgent")]
pub fn backup_execution_from_managed_agent(agent: String) -> napi::Result<String> {
    run(move || {
        let agent = crate::js::from_json(&agent)?;
        let out = port::backup_execution_from_managed_agent(agent)?;
        crate::js::to_json(&out)
    })
}

/// `isSingleModelManagedAgent`.
#[napi(js_name = "isSingleModelManagedAgent")]
pub fn is_single_model_managed_agent(agent: String) -> napi::Result<bool> {
    run(move || {
        let agent = crate::js::from_json(&agent)?;
        let out = port::is_single_model_managed_agent(agent)?;
        Ok(out)
    })
}

/// `getPersonalAgentDefault`.
#[napi(js_name = "getPersonalAgentDefault")]
pub fn get_personal_agent_default(settings_overrides: String, agent_name: String) -> napi::Result<String> {
    run(move || {
        let settings_overrides = crate::js::from_json(&settings_overrides)?;
        let agent_name = crate::js::from_json(&agent_name)?;
        let out = port::get_personal_agent_default(settings_overrides, agent_name)?;
        crate::js::to_json(&out)
    })
}

/// `validatePersonalAgentDefault`.
#[napi(js_name = "validatePersonalAgentDefault")]
pub fn validate_personal_agent_default(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::validate_personal_agent_default(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `resolveManagedAgentExecution`.
#[napi(js_name = "resolveManagedAgentExecution")]
pub fn resolve_managed_agent_execution(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::resolve_managed_agent_execution(arg0)?;
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

static S_FIND_MANAGED_AGENT_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_MANAGED_AGENT_1: wire::Schema = wire::Schema::Dyn;
static S_FIND_MANAGED_AGENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `findManagedAgent` over the binary wire.
#[napi(js_name = "findManagedAgentWire")]
pub fn find_managed_agent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agents: Value = wire::read_value(r, &S_FIND_MANAGED_AGENT_0)?;
        let agent_name: Value = wire::read_value(r, &S_FIND_MANAGED_AGENT_1)?;
        let out = &port::find_managed_agent(agents, agent_name)?;
        wire::write_value(w, out, &S_FIND_MANAGED_AGENT_OUT)?;
        Ok(())
    })
}

static S_BACKUP_EXECUTION_FROM_MANAGED_AGENT_0: wire::Schema = wire::Schema::Dyn;
static S_BACKUP_EXECUTION_FROM_MANAGED_AGENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `backupExecutionFromManagedAgent` over the binary wire.
#[napi(js_name = "backupExecutionFromManagedAgentWire")]
pub fn backup_execution_from_managed_agent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agent: Value = wire::read_value(r, &S_BACKUP_EXECUTION_FROM_MANAGED_AGENT_0)?;
        let out = &port::backup_execution_from_managed_agent(agent)?;
        wire::write_value(w, out, &S_BACKUP_EXECUTION_FROM_MANAGED_AGENT_OUT)?;
        Ok(())
    })
}

static S_IS_SINGLE_MODEL_MANAGED_AGENT_0: wire::Schema = wire::Schema::Dyn;

/// `isSingleModelManagedAgent` over the binary wire.
#[napi(js_name = "isSingleModelManagedAgentWire")]
pub fn is_single_model_managed_agent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agent: Value = wire::read_value(r, &S_IS_SINGLE_MODEL_MANAGED_AGENT_0)?;
        let out = &port::is_single_model_managed_agent(agent)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_GET_PERSONAL_AGENT_DEFAULT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PERSONAL_AGENT_DEFAULT_1: wire::Schema = wire::Schema::Dyn;
static S_GET_PERSONAL_AGENT_DEFAULT_OUT: wire::Schema = wire::Schema::Dyn;

/// `getPersonalAgentDefault` over the binary wire.
#[napi(js_name = "getPersonalAgentDefaultWire")]
pub fn get_personal_agent_default_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let settings_overrides: Value = wire::read_value(r, &S_GET_PERSONAL_AGENT_DEFAULT_0)?;
        let agent_name: Value = wire::read_value(r, &S_GET_PERSONAL_AGENT_DEFAULT_1)?;
        let out = &port::get_personal_agent_default(settings_overrides, agent_name)?;
        wire::write_value(w, out, &S_GET_PERSONAL_AGENT_DEFAULT_OUT)?;
        Ok(())
    })
}

static S_VALIDATE_PERSONAL_AGENT_DEFAULT_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_PERSONAL_AGENT_DEFAULT_OUT: wire::Schema = wire::Schema::Dyn;

/// `validatePersonalAgentDefault` over the binary wire.
#[napi(js_name = "validatePersonalAgentDefaultWire")]
pub fn validate_personal_agent_default_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_VALIDATE_PERSONAL_AGENT_DEFAULT_0)?;
        let out = &port::validate_personal_agent_default(arg0)?;
        wire::write_value(w, out, &S_VALIDATE_PERSONAL_AGENT_DEFAULT_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_MANAGED_AGENT_EXECUTION_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_MANAGED_AGENT_EXECUTION_OUT: wire::Schema = wire::Schema::Dyn;

/// `resolveManagedAgentExecution` over the binary wire.
#[napi(js_name = "resolveManagedAgentExecutionWire")]
pub fn resolve_managed_agent_execution_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_RESOLVE_MANAGED_AGENT_EXECUTION_0)?;
        let out = &port::resolve_managed_agent_execution(arg0)?;
        wire::write_value(w, out, &S_RESOLVE_MANAGED_AGENT_EXECUTION_OUT)?;
        Ok(())
    })
}

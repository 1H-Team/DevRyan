//! JS bindings for `runtime-surface-policy.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isAllowedManagedRuntimePluginSpec`.
#[napi(js_name = "isAllowedManagedRuntimePluginSpec")]
pub fn is_allowed_managed_runtime_plugin_spec(spec: String) -> napi::Result<String> {
    run(move || {
        let spec = crate::js::from_json(&spec)?;
        let out = port::is_allowed_managed_runtime_plugin_spec(spec)?;
        crate::js::to_json(&out)
    })
}

/// `filterManagedRuntimePluginEntries`.
#[napi(js_name = "filterManagedRuntimePluginEntries")]
pub fn filter_managed_runtime_plugin_entries(entries: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::filter_managed_runtime_plugin_entries(entries)?;
        crate::js::to_json(&out)
    })
}

/// `isBlockedManagedRuntimeMcpName`.
#[napi(js_name = "isBlockedManagedRuntimeMcpName")]
pub fn is_blocked_managed_runtime_mcp_name(name: String) -> napi::Result<String> {
    run(move || {
        let name = crate::js::from_json(&name)?;
        let out = port::is_blocked_managed_runtime_mcp_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `buildBlockedManagedRuntimeMcpOverlay`.
#[napi(js_name = "buildBlockedManagedRuntimeMcpOverlay")]
pub fn build_blocked_managed_runtime_mcp_overlay(configs: String) -> napi::Result<String> {
    run(move || {
        let configs = crate::js::from_json(&configs)?;
        let out = port::build_blocked_managed_runtime_mcp_overlay(configs)?;
        crate::js::to_json(&out)
    })
}

/// `isForbiddenManagedRuntimeToolId`.
#[napi(js_name = "isForbiddenManagedRuntimeToolId")]
pub fn is_forbidden_managed_runtime_tool_id(tool_id: String) -> napi::Result<String> {
    run(move || {
        let tool_id = crate::js::from_json(&tool_id)?;
        let out = port::is_forbidden_managed_runtime_tool_id(tool_id)?;
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

static S_IS_ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_0: wire::Schema = wire::Schema::Dyn;
static S_IS_ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_OUT: wire::Schema = wire::Schema::Dyn;

/// `isAllowedManagedRuntimePluginSpec` over the binary wire.
#[napi(js_name = "isAllowedManagedRuntimePluginSpecWire")]
pub fn is_allowed_managed_runtime_plugin_spec_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let spec: Value = wire::read_value(r, &S_IS_ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_0)?;
        let out = &port::is_allowed_managed_runtime_plugin_spec(spec)?;
        wire::write_value(w, out, &S_IS_ALLOWED_MANAGED_RUNTIME_PLUGIN_SPEC_OUT)?;
        Ok(())
    })
}

static S_FILTER_MANAGED_RUNTIME_PLUGIN_ENTRIES_0: wire::Schema = wire::Schema::Dyn;
static S_FILTER_MANAGED_RUNTIME_PLUGIN_ENTRIES_OUT: wire::Schema = wire::Schema::Dyn;

/// `filterManagedRuntimePluginEntries` over the binary wire.
#[napi(js_name = "filterManagedRuntimePluginEntriesWire")]
pub fn filter_managed_runtime_plugin_entries_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: Value = wire::read_value(r, &S_FILTER_MANAGED_RUNTIME_PLUGIN_ENTRIES_0)?;
        let out = &port::filter_managed_runtime_plugin_entries(entries)?;
        wire::write_value(w, out, &S_FILTER_MANAGED_RUNTIME_PLUGIN_ENTRIES_OUT)?;
        Ok(())
    })
}

static S_IS_BLOCKED_MANAGED_RUNTIME_MCP_NAME_0: wire::Schema = wire::Schema::Dyn;
static S_IS_BLOCKED_MANAGED_RUNTIME_MCP_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `isBlockedManagedRuntimeMcpName` over the binary wire.
#[napi(js_name = "isBlockedManagedRuntimeMcpNameWire")]
pub fn is_blocked_managed_runtime_mcp_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: Value = wire::read_value(r, &S_IS_BLOCKED_MANAGED_RUNTIME_MCP_NAME_0)?;
        let out = &port::is_blocked_managed_runtime_mcp_name(name)?;
        wire::write_value(w, out, &S_IS_BLOCKED_MANAGED_RUNTIME_MCP_NAME_OUT)?;
        Ok(())
    })
}

static S_BUILD_BLOCKED_MANAGED_RUNTIME_MCP_OVERLAY_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_BLOCKED_MANAGED_RUNTIME_MCP_OVERLAY_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildBlockedManagedRuntimeMcpOverlay` over the binary wire.
#[napi(js_name = "buildBlockedManagedRuntimeMcpOverlayWire")]
pub fn build_blocked_managed_runtime_mcp_overlay_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let configs: Value = wire::read_value(r, &S_BUILD_BLOCKED_MANAGED_RUNTIME_MCP_OVERLAY_0)?;
        let out = &port::build_blocked_managed_runtime_mcp_overlay(configs)?;
        wire::write_value(w, out, &S_BUILD_BLOCKED_MANAGED_RUNTIME_MCP_OVERLAY_OUT)?;
        Ok(())
    })
}

static S_IS_FORBIDDEN_MANAGED_RUNTIME_TOOL_ID_0: wire::Schema = wire::Schema::Dyn;
static S_IS_FORBIDDEN_MANAGED_RUNTIME_TOOL_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `isForbiddenManagedRuntimeToolId` over the binary wire.
#[napi(js_name = "isForbiddenManagedRuntimeToolIdWire")]
pub fn is_forbidden_managed_runtime_tool_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tool_id: Value = wire::read_value(r, &S_IS_FORBIDDEN_MANAGED_RUNTIME_TOOL_ID_0)?;
        let out = &port::is_forbidden_managed_runtime_tool_id(tool_id)?;
        wire::write_value(w, out, &S_IS_FORBIDDEN_MANAGED_RUNTIME_TOOL_ID_OUT)?;
        Ok(())
    })
}

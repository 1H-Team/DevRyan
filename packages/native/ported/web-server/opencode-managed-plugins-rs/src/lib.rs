//! JS bindings for `managed-plugins.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getDevRyanManagedPluginForSpec`.
#[napi(js_name = "getDevRyanManagedPluginForSpec")]
pub fn get_dev_ryan_managed_plugin_for_spec(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::get_dev_ryan_managed_plugin_for_spec(value)?;
        crate::js::to_json(&out)
    })
}

/// `getDevRyanManagedPluginForFile`.
#[napi(js_name = "getDevRyanManagedPluginForFile")]
pub fn get_dev_ryan_managed_plugin_for_file(file_name: String) -> napi::Result<String> {
    run(move || {
        let file_name = crate::js::from_json(&file_name)?;
        let out = port::get_dev_ryan_managed_plugin_for_file(file_name)?;
        crate::js::to_json(&out)
    })
}

/// `isRetiredDevRyanPluginSpec`.
#[napi(js_name = "isRetiredDevRyanPluginSpec")]
pub fn is_retired_dev_ryan_plugin_spec(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_retired_dev_ryan_plugin_spec(value)?;
        crate::js::to_json(&out)
    })
}

/// `isDevRyanManagedLegacyPluginSpec`.
#[napi(js_name = "isDevRyanManagedLegacyPluginSpec")]
pub fn is_dev_ryan_managed_legacy_plugin_spec(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_dev_ryan_managed_legacy_plugin_spec(value)?;
        crate::js::to_json(&out)
    })
}

/// `removeDevRyanManagedLegacyPluginSpecs`.
#[napi(js_name = "removeDevRyanManagedLegacyPluginSpecs")]
pub fn remove_dev_ryan_managed_legacy_plugin_specs(entries: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::remove_dev_ryan_managed_legacy_plugin_specs(entries)?;
        crate::js::to_json(&out)
    })
}

/// `reconcileDevRyanManagedPluginSpecs`.
#[napi(js_name = "reconcileDevRyanManagedPluginSpecs")]
pub fn reconcile_dev_ryan_managed_plugin_specs(current_entries: String, baseline_entries: String) -> napi::Result<String> {
    run(move || {
        let current_entries = crate::js::from_json(&current_entries)?;
        let baseline_entries = crate::js::from_json(&baseline_entries)?;
        let out = port::reconcile_dev_ryan_managed_plugin_specs(current_entries, baseline_entries)?;
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

static S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_SPEC_0: wire::Schema = wire::Schema::Dyn;
static S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_SPEC_OUT: wire::Schema = wire::Schema::Dyn;

/// `getDevRyanManagedPluginForSpec` over the binary wire.
#[napi(js_name = "getDevRyanManagedPluginForSpecWire")]
pub fn get_dev_ryan_managed_plugin_for_spec_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_SPEC_0)?;
        let out = &port::get_dev_ryan_managed_plugin_for_spec(value)?;
        wire::write_value(w, out, &S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_SPEC_OUT)?;
        Ok(())
    })
}

static S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_FILE_0: wire::Schema = wire::Schema::Dyn;
static S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_FILE_OUT: wire::Schema = wire::Schema::Dyn;

/// `getDevRyanManagedPluginForFile` over the binary wire.
#[napi(js_name = "getDevRyanManagedPluginForFileWire")]
pub fn get_dev_ryan_managed_plugin_for_file_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let file_name: Value = wire::read_value(r, &S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_FILE_0)?;
        let out = &port::get_dev_ryan_managed_plugin_for_file(file_name)?;
        wire::write_value(w, out, &S_GET_DEV_RYAN_MANAGED_PLUGIN_FOR_FILE_OUT)?;
        Ok(())
    })
}

static S_IS_RETIRED_DEV_RYAN_PLUGIN_SPEC_0: wire::Schema = wire::Schema::Dyn;
static S_IS_RETIRED_DEV_RYAN_PLUGIN_SPEC_OUT: wire::Schema = wire::Schema::Bool;

/// `isRetiredDevRyanPluginSpec` over the binary wire.
#[napi(js_name = "isRetiredDevRyanPluginSpecWire")]
pub fn is_retired_dev_ryan_plugin_spec_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_RETIRED_DEV_RYAN_PLUGIN_SPEC_0)?;
        let out = &port::is_retired_dev_ryan_plugin_spec(value)?;
        wire::write_value(w, out, &S_IS_RETIRED_DEV_RYAN_PLUGIN_SPEC_OUT)?;
        Ok(())
    })
}

static S_IS_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPEC_0: wire::Schema = wire::Schema::Dyn;
static S_IS_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPEC_OUT: wire::Schema = wire::Schema::Bool;

/// `isDevRyanManagedLegacyPluginSpec` over the binary wire.
#[napi(js_name = "isDevRyanManagedLegacyPluginSpecWire")]
pub fn is_dev_ryan_managed_legacy_plugin_spec_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_IS_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPEC_0)?;
        let out = &port::is_dev_ryan_managed_legacy_plugin_spec(value)?;
        wire::write_value(w, out, &S_IS_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPEC_OUT)?;
        Ok(())
    })
}

static S_REMOVE_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPECS_0: wire::Schema = wire::Schema::Dyn;
static S_REMOVE_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPECS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `removeDevRyanManagedLegacyPluginSpecs` over the binary wire.
#[napi(js_name = "removeDevRyanManagedLegacyPluginSpecsWire")]
pub fn remove_dev_ryan_managed_legacy_plugin_specs_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: Value = wire::read_value(r, &S_REMOVE_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPECS_0)?;
        let out = &port::remove_dev_ryan_managed_legacy_plugin_specs(entries)?;
        wire::write_value(w, out, &S_REMOVE_DEV_RYAN_MANAGED_LEGACY_PLUGIN_SPECS_OUT)?;
        Ok(())
    })
}

static S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_0: wire::Schema = wire::Schema::Dyn;
static S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_1: wire::Schema = wire::Schema::Dyn;
static S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `reconcileDevRyanManagedPluginSpecs` over the binary wire.
#[napi(js_name = "reconcileDevRyanManagedPluginSpecsWire")]
pub fn reconcile_dev_ryan_managed_plugin_specs_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current_entries: Value = wire::read_value(r, &S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_0)?;
        let baseline_entries: Value = wire::read_value(r, &S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_1)?;
        let out = &port::reconcile_dev_ryan_managed_plugin_specs(current_entries, baseline_entries)?;
        wire::write_value(w, out, &S_RECONCILE_DEV_RYAN_MANAGED_PLUGIN_SPECS_OUT)?;
        Ok(())
    })
}

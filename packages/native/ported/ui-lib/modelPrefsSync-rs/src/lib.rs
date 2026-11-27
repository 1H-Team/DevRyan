//! JS bindings for `modelPrefsSync.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `modelRefsEqual`.
#[napi(js_name = "modelRefsEqual")]
pub fn model_refs_equal(a: String, b: String) -> napi::Result<bool> {
    run(move || {
        let a = crate::js::from_json(&a)?;
        let b = crate::js::from_json(&b)?;
        let out = port::model_refs_equal(a, b)?;
        Ok(out)
    })
}

/// `createModelPrefsBaseline`.
#[napi(js_name = "createModelPrefsBaseline")]
pub fn create_model_prefs_baseline(snapshot: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let out = port::create_model_prefs_baseline(snapshot)?;
        crate::js::to_json(&out)
    })
}

/// `getChangedModelPrefsKeys`.
#[napi(js_name = "getChangedModelPrefsKeys")]
pub fn get_changed_model_prefs_keys(baseline: String, current: String) -> napi::Result<Vec<String>> {
    run(move || {
        let baseline = crate::js::from_json(&baseline)?;
        let current = crate::js::from_json(&current)?;
        let out = port::get_changed_model_prefs_keys(baseline, current)?;
        Ok(out)
    })
}

/// `modelPrefsEqual`.
#[napi(js_name = "modelPrefsEqual")]
pub fn model_prefs_equal(a: String, b: String) -> napi::Result<bool> {
    run(move || {
        let a = crate::js::from_json(&a)?;
        let b = crate::js::from_json(&b)?;
        let out = port::model_prefs_equal(a, b)?;
        Ok(out)
    })
}

/// `resolveModelPrefsFromSettingsSnapshot`.
#[napi(js_name = "resolveModelPrefsFromSettingsSnapshot")]
pub fn resolve_model_prefs_from_settings_snapshot(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::resolve_model_prefs_from_settings_snapshot(arg0)?;
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

static S_MODEL_REFS_EQUAL_0: wire::Schema = wire::Schema::Dyn;
static S_MODEL_REFS_EQUAL_1: wire::Schema = wire::Schema::Dyn;

/// `modelRefsEqual` over the binary wire.
#[napi(js_name = "modelRefsEqualWire")]
pub fn model_refs_equal_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: Value = wire::read_value(r, &S_MODEL_REFS_EQUAL_0)?;
        let b: Value = wire::read_value(r, &S_MODEL_REFS_EQUAL_1)?;
        let out = &port::model_refs_equal(a, b)?;
        w.bool(*out);
        Ok(())
    })
}

static S_CREATE_MODEL_PREFS_BASELINE_0: wire::Schema = wire::Schema::Dyn;
static S_CREATE_MODEL_PREFS_BASELINE_OUT: wire::Schema = wire::Schema::Obj(&[
    (
        "favoriteModels",
        wire::Schema::List(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
    ("favoriteModelsUpdatedAt", wire::Schema::Num),
    (
        "hiddenModels",
        wire::Schema::List(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
    ("hiddenModelsUpdatedAt", wire::Schema::Num),
]);

/// `createModelPrefsBaseline` over the binary wire.
#[napi(js_name = "createModelPrefsBaselineWire")]
pub fn create_model_prefs_baseline_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: Value = wire::read_value(r, &S_CREATE_MODEL_PREFS_BASELINE_0)?;
        let out = &port::create_model_prefs_baseline(snapshot)?;
        wire::write_value(w, out, &S_CREATE_MODEL_PREFS_BASELINE_OUT)?;
        Ok(())
    })
}

static S_GET_CHANGED_MODEL_PREFS_KEYS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_CHANGED_MODEL_PREFS_KEYS_1: wire::Schema = wire::Schema::Dyn;

/// `getChangedModelPrefsKeys` over the binary wire.
#[napi(js_name = "getChangedModelPrefsKeysWire")]
pub fn get_changed_model_prefs_keys_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let baseline: Value = wire::read_value(r, &S_GET_CHANGED_MODEL_PREFS_KEYS_0)?;
        let current: Value = wire::read_value(r, &S_GET_CHANGED_MODEL_PREFS_KEYS_1)?;
        let out = &port::get_changed_model_prefs_keys(baseline, current)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.string16(x0);
        }
        Ok(())
    })
}

static S_MODEL_PREFS_EQUAL_0: wire::Schema = wire::Schema::Dyn;
static S_MODEL_PREFS_EQUAL_1: wire::Schema = wire::Schema::Dyn;

/// `modelPrefsEqual` over the binary wire.
#[napi(js_name = "modelPrefsEqualWire")]
pub fn model_prefs_equal_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: Value = wire::read_value(r, &S_MODEL_PREFS_EQUAL_0)?;
        let b: Value = wire::read_value(r, &S_MODEL_PREFS_EQUAL_1)?;
        let out = &port::model_prefs_equal(a, b)?;
        w.bool(*out);
        Ok(())
    })
}

static S_RESOLVE_MODEL_PREFS_FROM_SETTINGS_SNAPSHOT_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_MODEL_PREFS_FROM_SETTINGS_SNAPSHOT_OUT: wire::Schema = wire::Schema::Obj(&[
    (
        "favoriteModels",
        wire::Schema::List(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
    ("favoriteModelsUpdatedAt", wire::Schema::Num),
    (
        "hiddenModels",
        wire::Schema::List(&wire::Schema::Obj(&[("providerID", wire::Schema::Str16), ("modelID", wire::Schema::Str16)])),
    ),
    ("hiddenModelsUpdatedAt", wire::Schema::Num),
]);

/// `resolveModelPrefsFromSettingsSnapshot` over the binary wire.
#[napi(js_name = "resolveModelPrefsFromSettingsSnapshotWire")]
pub fn resolve_model_prefs_from_settings_snapshot_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_RESOLVE_MODEL_PREFS_FROM_SETTINGS_SNAPSHOT_0)?;
        let out = &port::resolve_model_prefs_from_settings_snapshot(arg0)?;
        wire::write_value(w, out, &S_RESOLVE_MODEL_PREFS_FROM_SETTINGS_SNAPSHOT_OUT)?;
        Ok(())
    })
}

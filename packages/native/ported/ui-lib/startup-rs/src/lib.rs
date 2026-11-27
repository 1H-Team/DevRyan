//! JS bindings for `startup/`: generated from the signatures in `port.rs` by rust-anything.
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

/// `createStartupReadinessSnapshot`.
#[napi(js_name = "createStartupReadinessSnapshot")]
pub fn create_startup_readiness_snapshot(status: String) -> napi::Result<String> {
    run(move || {
        let status = crate::js::from_json(&status)?;
        let out = port::create_startup_readiness_snapshot(status)?;
        crate::js::to_json(&out)
    })
}

/// `withStartupReadinessPhase`.
#[napi(js_name = "withStartupReadinessPhase")]
pub fn with_startup_readiness_phase(snapshot: String, phase: String, next: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let phase = crate::js::from_json(&phase)?;
        let next = crate::js::from_json(&next)?;
        let out = port::with_startup_readiness_phase(snapshot, phase, next)?;
        crate::js::to_json(&out)
    })
}

/// `withStartupBootstrapReadiness`.
#[napi(js_name = "withStartupBootstrapReadiness")]
pub fn with_startup_bootstrap_readiness(snapshot: String, readiness: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let readiness = crate::js::from_json(&readiness)?;
        let out = port::with_startup_bootstrap_readiness(snapshot, readiness)?;
        crate::js::to_json(&out)
    })
}

/// `summarizeStartupReadiness`.
#[napi(js_name = "summarizeStartupReadiness")]
pub fn summarize_startup_readiness(snapshot: String, options: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let options = crate::js::from_json(&options)?;
        let out = port::summarize_startup_readiness(snapshot, options)?;
        crate::js::to_json(&out)
    })
}

/// `shouldShowStartupReadinessScreen`.
#[napi(js_name = "shouldShowStartupReadinessScreen")]
pub fn should_show_startup_readiness_screen(summary: String, has_completed_startup: String) -> napi::Result<bool> {
    run(move || {
        let summary = crate::js::from_json(&summary)?;
        let has_completed_startup = crate::js::from_json(&has_completed_startup)?;
        let out = port::should_show_startup_readiness_screen(summary, has_completed_startup)?;
        Ok(out)
    })
}

/// `shouldRestartOpenCodeForStartupRecovery`.
#[napi(js_name = "shouldRestartOpenCodeForStartupRecovery")]
pub fn should_restart_open_code_for_startup_recovery(health: String) -> napi::Result<bool> {
    run(move || {
        let health = crate::js::from_json(&health)?;
        let out = port::should_restart_open_code_for_startup_recovery(health)?;
        Ok(out)
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

static S_CREATE_STARTUP_READINESS_SNAPSHOT_0: wire::Schema = wire::Schema::Dyn;
static S_CREATE_STARTUP_READINESS_SNAPSHOT_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Obj(&[
    ("status", wire::Schema::Str16),
    ("error", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `createStartupReadinessSnapshot` over the binary wire.
#[napi(js_name = "createStartupReadinessSnapshotWire")]
pub fn create_startup_readiness_snapshot_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let status: Value = wire::read_value(r, &S_CREATE_STARTUP_READINESS_SNAPSHOT_0)?;
        let out = &port::create_startup_readiness_snapshot(status)?;
        wire::write_value(w, out, &S_CREATE_STARTUP_READINESS_SNAPSHOT_OUT)?;
        Ok(())
    })
}

static S_WITH_STARTUP_READINESS_PHASE_0: wire::Schema = wire::Schema::Dyn;
static S_WITH_STARTUP_READINESS_PHASE_1: wire::Schema = wire::Schema::Dyn;
static S_WITH_STARTUP_READINESS_PHASE_2: wire::Schema = wire::Schema::Dyn;
static S_WITH_STARTUP_READINESS_PHASE_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Obj(&[
    ("status", wire::Schema::Str16),
    ("error", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `withStartupReadinessPhase` over the binary wire.
#[napi(js_name = "withStartupReadinessPhaseWire")]
pub fn with_startup_readiness_phase_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: Value = wire::read_value(r, &S_WITH_STARTUP_READINESS_PHASE_0)?;
        let phase: Value = wire::read_value(r, &S_WITH_STARTUP_READINESS_PHASE_1)?;
        let next: Value = wire::read_value(r, &S_WITH_STARTUP_READINESS_PHASE_2)?;
        let out = &port::with_startup_readiness_phase(snapshot, phase, next)?;
        wire::write_value(w, out, &S_WITH_STARTUP_READINESS_PHASE_OUT)?;
        Ok(())
    })
}

static S_WITH_STARTUP_BOOTSTRAP_READINESS_0: wire::Schema = wire::Schema::Dyn;
static S_WITH_STARTUP_BOOTSTRAP_READINESS_1: wire::Schema = wire::Schema::Dyn;
static S_WITH_STARTUP_BOOTSTRAP_READINESS_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Obj(&[
    ("status", wire::Schema::Str16),
    ("error", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `withStartupBootstrapReadiness` over the binary wire.
#[napi(js_name = "withStartupBootstrapReadinessWire")]
pub fn with_startup_bootstrap_readiness_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: Value = wire::read_value(r, &S_WITH_STARTUP_BOOTSTRAP_READINESS_0)?;
        let readiness: Value = wire::read_value(r, &S_WITH_STARTUP_BOOTSTRAP_READINESS_1)?;
        let out = &port::with_startup_bootstrap_readiness(snapshot, readiness)?;
        wire::write_value(w, out, &S_WITH_STARTUP_BOOTSTRAP_READINESS_OUT)?;
        Ok(())
    })
}

static S_SUMMARIZE_STARTUP_READINESS_0: wire::Schema = wire::Schema::Dyn;
static S_SUMMARIZE_STARTUP_READINESS_1: wire::Schema = wire::Schema::Dyn;
static S_SUMMARIZE_STARTUP_READINESS_OUT: wire::Schema = wire::Schema::Obj(&[
    ("ready", wire::Schema::Bool),
    ("phase", wire::Schema::Dyn),
    ("status", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("error", wire::Schema::OptJs(&wire::Schema::Str16)),
]);

/// `summarizeStartupReadiness` over the binary wire.
#[napi(js_name = "summarizeStartupReadinessWire")]
pub fn summarize_startup_readiness_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: Value = wire::read_value(r, &S_SUMMARIZE_STARTUP_READINESS_0)?;
        let options: Value = wire::read_value(r, &S_SUMMARIZE_STARTUP_READINESS_1)?;
        let out = &port::summarize_startup_readiness(snapshot, options)?;
        wire::write_value(w, out, &S_SUMMARIZE_STARTUP_READINESS_OUT)?;
        Ok(())
    })
}

static S_SHOULD_SHOW_STARTUP_READINESS_SCREEN_0: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_SHOW_STARTUP_READINESS_SCREEN_1: wire::Schema = wire::Schema::Dyn;

/// `shouldShowStartupReadinessScreen` over the binary wire.
#[napi(js_name = "shouldShowStartupReadinessScreenWire")]
pub fn should_show_startup_readiness_screen_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let summary: Value = wire::read_value(r, &S_SHOULD_SHOW_STARTUP_READINESS_SCREEN_0)?;
        let has_completed_startup: Value = wire::read_value(r, &S_SHOULD_SHOW_STARTUP_READINESS_SCREEN_1)?;
        let out = &port::should_show_startup_readiness_screen(summary, has_completed_startup)?;
        w.bool(*out);
        Ok(())
    })
}

static S_SHOULD_RESTART_OPEN_CODE_FOR_STARTUP_RECOVERY_0: wire::Schema = wire::Schema::Dyn;

/// `shouldRestartOpenCodeForStartupRecovery` over the binary wire.
#[napi(js_name = "shouldRestartOpenCodeForStartupRecoveryWire")]
pub fn should_restart_open_code_for_startup_recovery_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let health: Value = wire::read_value(r, &S_SHOULD_RESTART_OPEN_CODE_FOR_STARTUP_RECOVERY_0)?;
        let out = &port::should_restart_open_code_for_startup_recovery(health)?;
        w.bool(*out);
        Ok(())
    })
}

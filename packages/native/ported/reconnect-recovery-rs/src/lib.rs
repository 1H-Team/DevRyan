//! JS bindings for `reconnect-recovery.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getActiveSessionRecoveryCooldownMs`.
#[napi(js_name = "getActiveSessionRecoveryCooldownMs")]
pub fn get_active_session_recovery_cooldown_ms(failure_count: String) -> napi::Result<f64> {
    run(move || {
        let failure_count = crate::js::from_json(&failure_count)?;
        let out = port::get_active_session_recovery_cooldown_ms(failure_count)?;
        Ok(out)
    })
}

/// `getActiveSessionRecoveryActivityAt`.
#[napi(js_name = "getActiveSessionRecoveryActivityAt")]
pub fn get_active_session_recovery_activity_at(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::get_active_session_recovery_activity_at(input)?;
        crate::js::to_json(&out)
    })
}

/// `getPendingToolInputStallFingerprint`.
#[napi(js_name = "getPendingToolInputStallFingerprint")]
pub fn get_pending_tool_input_stall_fingerprint(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::get_pending_tool_input_stall_fingerprint(input)?;
        crate::js::to_json(&out)
    })
}

/// `getProviderInferenceStallFingerprint`.
#[napi(js_name = "getProviderInferenceStallFingerprint")]
pub fn get_provider_inference_stall_fingerprint(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::get_provider_inference_stall_fingerprint(input)?;
        crate::js::to_json(&out)
    })
}

/// `getProviderStallFingerprint`.
#[napi(js_name = "getProviderStallFingerprint")]
pub fn get_provider_stall_fingerprint(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::get_provider_stall_fingerprint(input)?;
        crate::js::to_json(&out)
    })
}

/// `getLongRunningToolFingerprint`.
#[napi(js_name = "getLongRunningToolFingerprint")]
pub fn get_long_running_tool_fingerprint(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::get_long_running_tool_fingerprint(input)?;
        crate::js::to_json(&out)
    })
}

/// `haveSameLongRunningToolFingerprint`.
#[napi(js_name = "haveSameLongRunningToolFingerprint")]
pub fn have_same_long_running_tool_fingerprint(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::have_same_long_running_tool_fingerprint(left, right)?;
        Ok(out)
    })
}

/// `shouldConfirmLongRunningTool`.
#[napi(js_name = "shouldConfirmLongRunningTool")]
pub fn should_confirm_long_running_tool(input: String) -> napi::Result<bool> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::should_confirm_long_running_tool(input)?;
        Ok(out)
    })
}

/// `haveSameProviderStallFingerprint`.
#[napi(js_name = "haveSameProviderStallFingerprint")]
pub fn have_same_provider_stall_fingerprint(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::have_same_provider_stall_fingerprint(left, right)?;
        Ok(out)
    })
}

/// `haveSamePendingToolInputStallFingerprint`.
#[napi(js_name = "haveSamePendingToolInputStallFingerprint")]
pub fn have_same_pending_tool_input_stall_fingerprint(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::have_same_pending_tool_input_stall_fingerprint(left, right)?;
        Ok(out)
    })
}

/// `filterUnchangedSessionStatusCandidates`.
#[napi(js_name = "filterUnchangedSessionStatusCandidates")]
pub fn filter_unchanged_session_status_candidates(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::filter_unchanged_session_status_candidates(input)?;
        crate::js::to_json(&out)
    })
}

/// `toAuthoritativeSessionStatus`.
#[napi(js_name = "toAuthoritativeSessionStatus")]
pub fn to_authoritative_session_status(status: String) -> napi::Result<String> {
    run(move || {
        let status = crate::js::from_json(&status)?;
        let out = port::to_authoritative_session_status(status)?;
        crate::js::to_json(&out)
    })
}

/// `getReconnectCandidateSessionIds`.
#[napi(js_name = "getReconnectCandidateSessionIds")]
pub fn get_reconnect_candidate_session_ids(state: String, options: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let options = crate::js::from_json(&options)?;
        let out = port::get_reconnect_candidate_session_ids(state, options)?;
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

static S_GET_ACTIVE_SESSION_RECOVERY_COOLDOWN_MS_0: wire::Schema = wire::Schema::Dyn;

/// `getActiveSessionRecoveryCooldownMs` over the binary wire.
#[napi(js_name = "getActiveSessionRecoveryCooldownMsWire")]
pub fn get_active_session_recovery_cooldown_ms_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let failure_count: serde_json::Value = wire::read_value(r, &S_GET_ACTIVE_SESSION_RECOVERY_COOLDOWN_MS_0)?;
        let out = &port::get_active_session_recovery_cooldown_ms(failure_count)?;
        w.f64(*out);
        Ok(())
    })
}

static S_GET_ACTIVE_SESSION_RECOVERY_ACTIVITY_AT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_ACTIVE_SESSION_RECOVERY_ACTIVITY_AT_OUT: wire::Schema = wire::Schema::Num;

/// `getActiveSessionRecoveryActivityAt` over the binary wire.
#[napi(js_name = "getActiveSessionRecoveryActivityAtWire")]
pub fn get_active_session_recovery_activity_at_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_GET_ACTIVE_SESSION_RECOVERY_ACTIVITY_AT_0)?;
        let out = &port::get_active_session_recovery_activity_at(input)?;
        wire::write_value(w, out, &S_GET_ACTIVE_SESSION_RECOVERY_ACTIVITY_AT_OUT)?;
        Ok(())
    })
}

static S_GET_PENDING_TOOL_INPUT_STALL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PENDING_TOOL_INPUT_STALL_FINGERPRINT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("kind", wire::Schema::Str16),
    ("sessionID", wire::Schema::Str16),
    ("assistantMessageID", wire::Schema::Str16),
    ("anchorUserMessageID", wire::Schema::Str16),
    ("partID", wire::Schema::Str16),
    ("callID", wire::Schema::Str16),
    ("tool", wire::Schema::Str16),
]));

/// `getPendingToolInputStallFingerprint` over the binary wire.
#[napi(js_name = "getPendingToolInputStallFingerprintWire")]
pub fn get_pending_tool_input_stall_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_GET_PENDING_TOOL_INPUT_STALL_FINGERPRINT_0)?;
        let out = &port::get_pending_tool_input_stall_fingerprint(input)?;
        wire::write_value(w, out, &S_GET_PENDING_TOOL_INPUT_STALL_FINGERPRINT_OUT)?;
        Ok(())
    })
}

static S_GET_PROVIDER_INFERENCE_STALL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PROVIDER_INFERENCE_STALL_FINGERPRINT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("kind", wire::Schema::Str16),
    ("sessionID", wire::Schema::Str16),
    ("assistantMessageID", wire::Schema::Str16),
    ("anchorUserMessageID", wire::Schema::Str16),
    ("stepStartPartID", wire::Schema::Str16),
    ("partID", wire::Schema::Str16),
    ("partType", wire::Schema::Str16),
]));

/// `getProviderInferenceStallFingerprint` over the binary wire.
#[napi(js_name = "getProviderInferenceStallFingerprintWire")]
pub fn get_provider_inference_stall_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_GET_PROVIDER_INFERENCE_STALL_FINGERPRINT_0)?;
        let out = &port::get_provider_inference_stall_fingerprint(input)?;
        wire::write_value(w, out, &S_GET_PROVIDER_INFERENCE_STALL_FINGERPRINT_OUT)?;
        Ok(())
    })
}

static S_GET_PROVIDER_STALL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PROVIDER_STALL_FINGERPRINT_OUT: wire::Schema = wire::Schema::Dyn;

/// `getProviderStallFingerprint` over the binary wire.
#[napi(js_name = "getProviderStallFingerprintWire")]
pub fn get_provider_stall_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_GET_PROVIDER_STALL_FINGERPRINT_0)?;
        let out = &port::get_provider_stall_fingerprint(input)?;
        wire::write_value(w, out, &S_GET_PROVIDER_STALL_FINGERPRINT_OUT)?;
        Ok(())
    })
}

static S_GET_LONG_RUNNING_TOOL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_GET_LONG_RUNNING_TOOL_FINGERPRINT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("kind", wire::Schema::Str16),
    ("sessionID", wire::Schema::Str16),
    ("assistantMessageID", wire::Schema::Str16),
    ("anchorUserMessageID", wire::Schema::Str16),
    ("partID", wire::Schema::Str16),
    ("callID", wire::Schema::Str16),
    ("tool", wire::Schema::Str16),
]));

/// `getLongRunningToolFingerprint` over the binary wire.
#[napi(js_name = "getLongRunningToolFingerprintWire")]
pub fn get_long_running_tool_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_GET_LONG_RUNNING_TOOL_FINGERPRINT_0)?;
        let out = &port::get_long_running_tool_fingerprint(input)?;
        wire::write_value(w, out, &S_GET_LONG_RUNNING_TOOL_FINGERPRINT_OUT)?;
        Ok(())
    })
}

static S_HAVE_SAME_LONG_RUNNING_TOOL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_HAVE_SAME_LONG_RUNNING_TOOL_FINGERPRINT_1: wire::Schema = wire::Schema::Dyn;

/// `haveSameLongRunningToolFingerprint` over the binary wire.
#[napi(js_name = "haveSameLongRunningToolFingerprintWire")]
pub fn have_same_long_running_tool_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_LONG_RUNNING_TOOL_FINGERPRINT_0)?;
        let right: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_LONG_RUNNING_TOOL_FINGERPRINT_1)?;
        let out = &port::have_same_long_running_tool_fingerprint(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_SHOULD_CONFIRM_LONG_RUNNING_TOOL_0: wire::Schema = wire::Schema::Dyn;

/// `shouldConfirmLongRunningTool` over the binary wire.
#[napi(js_name = "shouldConfirmLongRunningToolWire")]
pub fn should_confirm_long_running_tool_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_SHOULD_CONFIRM_LONG_RUNNING_TOOL_0)?;
        let out = &port::should_confirm_long_running_tool(input)?;
        w.bool(*out);
        Ok(())
    })
}

static S_HAVE_SAME_PROVIDER_STALL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_HAVE_SAME_PROVIDER_STALL_FINGERPRINT_1: wire::Schema = wire::Schema::Dyn;

/// `haveSameProviderStallFingerprint` over the binary wire.
#[napi(js_name = "haveSameProviderStallFingerprintWire")]
pub fn have_same_provider_stall_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_PROVIDER_STALL_FINGERPRINT_0)?;
        let right: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_PROVIDER_STALL_FINGERPRINT_1)?;
        let out = &port::have_same_provider_stall_fingerprint(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_HAVE_SAME_PENDING_TOOL_INPUT_STALL_FINGERPRINT_0: wire::Schema = wire::Schema::Dyn;
static S_HAVE_SAME_PENDING_TOOL_INPUT_STALL_FINGERPRINT_1: wire::Schema = wire::Schema::Dyn;

/// `haveSamePendingToolInputStallFingerprint` over the binary wire.
#[napi(js_name = "haveSamePendingToolInputStallFingerprintWire")]
pub fn have_same_pending_tool_input_stall_fingerprint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_PENDING_TOOL_INPUT_STALL_FINGERPRINT_0)?;
        let right: serde_json::Value = wire::read_value(r, &S_HAVE_SAME_PENDING_TOOL_INPUT_STALL_FINGERPRINT_1)?;
        let out = &port::have_same_pending_tool_input_stall_fingerprint(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_FILTER_UNCHANGED_SESSION_STATUS_CANDIDATES_0: wire::Schema = wire::Schema::Dyn;
static S_FILTER_UNCHANGED_SESSION_STATUS_CANDIDATES_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Str16);

/// `filterUnchangedSessionStatusCandidates` over the binary wire.
#[napi(js_name = "filterUnchangedSessionStatusCandidatesWire")]
pub fn filter_unchanged_session_status_candidates_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_FILTER_UNCHANGED_SESSION_STATUS_CANDIDATES_0)?;
        let out = &port::filter_unchanged_session_status_candidates(input)?;
        wire::write_value(w, out, &S_FILTER_UNCHANGED_SESSION_STATUS_CANDIDATES_OUT)?;
        Ok(())
    })
}

static S_TO_AUTHORITATIVE_SESSION_STATUS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_AUTHORITATIVE_SESSION_STATUS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toAuthoritativeSessionStatus` over the binary wire.
#[napi(js_name = "toAuthoritativeSessionStatusWire")]
pub fn to_authoritative_session_status_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let status: serde_json::Value = wire::read_value(r, &S_TO_AUTHORITATIVE_SESSION_STATUS_0)?;
        let out = &port::to_authoritative_session_status(status)?;
        wire::write_value(w, out, &S_TO_AUTHORITATIVE_SESSION_STATUS_OUT)?;
        Ok(())
    })
}

static S_GET_RECONNECT_CANDIDATE_SESSION_IDS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_RECONNECT_CANDIDATE_SESSION_IDS_OUT: wire::Schema = wire::Schema::Dyn;

/// `getReconnectCandidateSessionIds` over the binary wire.
#[napi(js_name = "getReconnectCandidateSessionIdsWire")]
pub fn get_reconnect_candidate_session_ids_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: serde_json::Value = wire::read_value(r, &S_GET_RECONNECT_CANDIDATE_SESSION_IDS_0)?;
        let options: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::get_reconnect_candidate_session_ids(state, options)?;
        wire::write_value(w, out, &S_GET_RECONNECT_CANDIDATE_SESSION_IDS_OUT)?;
        Ok(())
    })
}

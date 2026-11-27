//! JS bindings for `sessionDiffStats.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `parseSessionDiffCount`.
#[napi(js_name = "parseSessionDiffCount")]
pub fn parse_session_diff_count(value: String) -> napi::Result<f64> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::parse_session_diff_count(value)?;
        Ok(out)
    })
}

/// `getSessionSummaryDiffTotals`.
#[napi(js_name = "getSessionSummaryDiffTotals")]
pub fn get_session_summary_diff_totals(summary: String) -> napi::Result<String> {
    run(move || {
        let summary = crate::js::from_json(&summary)?;
        let out = port::get_session_summary_diff_totals(summary)?;
        crate::js::to_json(&out)
    })
}

/// `resolveSessionDiffStats`.
#[napi(js_name = "resolveSessionDiffStats")]
pub fn resolve_session_diff_stats(summary: String) -> napi::Result<String> {
    run(move || {
        let summary = crate::js::from_json(&summary)?;
        let out = port::resolve_session_diff_stats(summary)?;
        crate::js::to_json(&out)
    })
}

/// `resolveTouchedFileWorkingTreeDiffStats`.
#[napi(js_name = "resolveTouchedFileWorkingTreeDiffStats")]
pub fn resolve_touched_file_working_tree_diff_stats(touched_files: String, diff_stats: String) -> napi::Result<String> {
    run(move || {
        let touched_files = crate::js::from_json(&touched_files)?;
        let diff_stats = crate::js::from_json(&diff_stats)?;
        let out = port::resolve_touched_file_working_tree_diff_stats(touched_files, diff_stats)?;
        crate::js::to_json(&out)
    })
}

/// `getScopedMessageDiffTotals`.
#[napi(js_name = "getScopedMessageDiffTotals")]
pub fn get_scoped_message_diff_totals(summary: String) -> napi::Result<String> {
    run(move || {
        let summary = crate::js::from_json(&summary)?;
        let out = port::get_scoped_message_diff_totals(summary)?;
        crate::js::to_json(&out)
    })
}

/// `stripUntrustedSessionDiffSummary`.
#[napi(js_name = "stripUntrustedSessionDiffSummary")]
pub fn strip_untrusted_session_diff_summary(target: String) -> napi::Result<String> {
    run(move || {
        let target = crate::js::from_json(&target)?;
        let out = port::strip_untrusted_session_diff_summary(target)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeChatOwnedDiffSummary`.
#[napi(js_name = "normalizeChatOwnedDiffSummary")]
pub fn normalize_chat_owned_diff_summary(target: String, messages: String) -> napi::Result<String> {
    run(move || {
        let target = crate::js::from_json(&target)?;
        let messages = crate::js::from_json(&messages)?;
        let out = port::normalize_chat_owned_diff_summary(target, messages)?;
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

static S_PARSE_SESSION_DIFF_COUNT_0: wire::Schema = wire::Schema::Dyn;

/// `parseSessionDiffCount` over the binary wire.
#[napi(js_name = "parseSessionDiffCountWire")]
pub fn parse_session_diff_count_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_PARSE_SESSION_DIFF_COUNT_0)?;
        let out = &port::parse_session_diff_count(value)?;
        w.f64(*out);
        Ok(())
    })
}

static S_GET_SESSION_SUMMARY_DIFF_TOTALS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_SESSION_SUMMARY_DIFF_TOTALS_OUT: wire::Schema = wire::Schema::Obj(&[("additions", wire::Schema::Num), ("deletions", wire::Schema::Num)]);

/// `getSessionSummaryDiffTotals` over the binary wire.
#[napi(js_name = "getSessionSummaryDiffTotalsWire")]
pub fn get_session_summary_diff_totals_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let summary: Value = wire::read_value(r, &S_GET_SESSION_SUMMARY_DIFF_TOTALS_0)?;
        let out = &port::get_session_summary_diff_totals(summary)?;
        wire::write_value(w, out, &S_GET_SESSION_SUMMARY_DIFF_TOTALS_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_SESSION_DIFF_STATS_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_SESSION_DIFF_STATS_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[("additions", wire::Schema::Num), ("deletions", wire::Schema::Num)]));

/// `resolveSessionDiffStats` over the binary wire.
#[napi(js_name = "resolveSessionDiffStatsWire")]
pub fn resolve_session_diff_stats_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let summary: Value = wire::read_value(r, &S_RESOLVE_SESSION_DIFF_STATS_0)?;
        let out = &port::resolve_session_diff_stats(summary)?;
        wire::write_value(w, out, &S_RESOLVE_SESSION_DIFF_STATS_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[("additions", wire::Schema::Num), ("deletions", wire::Schema::Num)]));

/// `resolveTouchedFileWorkingTreeDiffStats` over the binary wire.
#[napi(js_name = "resolveTouchedFileWorkingTreeDiffStatsWire")]
pub fn resolve_touched_file_working_tree_diff_stats_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let touched_files: Value = wire::read_value(r, &S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_0)?;
        let diff_stats: Value = wire::read_value(r, &S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_1)?;
        let out = &port::resolve_touched_file_working_tree_diff_stats(touched_files, diff_stats)?;
        wire::write_value(w, out, &S_RESOLVE_TOUCHED_FILE_WORKING_TREE_DIFF_STATS_OUT)?;
        Ok(())
    })
}

static S_GET_SCOPED_MESSAGE_DIFF_TOTALS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_SCOPED_MESSAGE_DIFF_TOTALS_OUT: wire::Schema = wire::Schema::Obj(&[("additions", wire::Schema::Num), ("deletions", wire::Schema::Num)]);

/// `getScopedMessageDiffTotals` over the binary wire.
#[napi(js_name = "getScopedMessageDiffTotalsWire")]
pub fn get_scoped_message_diff_totals_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let summary: Value = wire::read_value(r, &S_GET_SCOPED_MESSAGE_DIFF_TOTALS_0)?;
        let out = &port::get_scoped_message_diff_totals(summary)?;
        wire::write_value(w, out, &S_GET_SCOPED_MESSAGE_DIFF_TOTALS_OUT)?;
        Ok(())
    })
}

static S_STRIP_UNTRUSTED_SESSION_DIFF_SUMMARY_0: wire::Schema = wire::Schema::Dyn;
static S_STRIP_UNTRUSTED_SESSION_DIFF_SUMMARY_OUT: wire::Schema = wire::Schema::Dyn;

/// `stripUntrustedSessionDiffSummary` over the binary wire.
#[napi(js_name = "stripUntrustedSessionDiffSummaryWire")]
pub fn strip_untrusted_session_diff_summary_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let target: Value = wire::read_value(r, &S_STRIP_UNTRUSTED_SESSION_DIFF_SUMMARY_0)?;
        let out = &port::strip_untrusted_session_diff_summary(target)?;
        wire::write_value(w, out, &S_STRIP_UNTRUSTED_SESSION_DIFF_SUMMARY_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_1: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_OUT: wire::Schema = wire::Schema::Dyn;

/// `normalizeChatOwnedDiffSummary` over the binary wire.
#[napi(js_name = "normalizeChatOwnedDiffSummaryWire")]
pub fn normalize_chat_owned_diff_summary_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let target: Value = wire::read_value(r, &S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_0)?;
        let messages: Value = wire::read_value(r, &S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_1)?;
        let out = &port::normalize_chat_owned_diff_summary(target, messages)?;
        wire::write_value(w, out, &S_NORMALIZE_CHAT_OWNED_DIFF_SUMMARY_OUT)?;
        Ok(())
    })
}

//! JS bindings for `session-recency.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getSessionRecency`.
#[napi(js_name = "getSessionRecency")]
pub fn get_session_recency(session: String) -> napi::Result<napi::bindgen_prelude::Either<f64, ()>> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::get_session_recency(session)?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `compareSessionRecency`.
#[napi(js_name = "compareSessionRecency")]
pub fn compare_session_recency(incoming: String, current: String) -> napi::Result<String> {
    run(move || {
        let incoming = crate::js::from_json(&incoming)?;
        let current = crate::js::from_json(&current)?;
        let out = port::compare_session_recency(incoming, current)?;
        crate::js::to_json(&out)
    })
}

/// `isStrictlyOlderSession`.
#[napi(js_name = "isStrictlyOlderSession")]
pub fn is_strictly_older_session(incoming: String, current: String) -> napi::Result<bool> {
    run(move || {
        let incoming = crate::js::from_json(&incoming)?;
        let current = crate::js::from_json(&current)?;
        let out = port::is_strictly_older_session(incoming, current)?;
        Ok(out)
    })
}

/// `resolveSessionLifecycle`.
#[napi(js_name = "resolveSessionLifecycle")]
pub fn resolve_session_lifecycle(current: String, incoming: String) -> napi::Result<String> {
    run(move || {
        let current = crate::js::from_json(&current)?;
        let incoming = crate::js::from_json(&incoming)?;
        let out = port::resolve_session_lifecycle(current, incoming)?;
        crate::js::to_json(&out)
    })
}

/// `mergeSessionLifecycle`.
#[napi(js_name = "mergeSessionLifecycle")]
pub fn merge_session_lifecycle(current: String, incoming: String) -> napi::Result<String> {
    run(move || {
        let current = crate::js::from_json(&current)?;
        let incoming = crate::js::from_json(&incoming)?;
        let out = port::merge_session_lifecycle(current, incoming)?;
        crate::js::to_json(&out)
    })
}

/// `retainSessionLifecycle`.
#[napi(js_name = "retainSessionLifecycle")]
pub fn retain_session_lifecycle(retained: String, rejected: String) -> napi::Result<String> {
    run(move || {
        let retained = crate::js::from_json(&retained)?;
        let rejected = crate::js::from_json(&rejected)?;
        let out = port::retain_session_lifecycle(retained, rejected)?;
        crate::js::to_json(&out)
    })
}

/// `hasNewerSessionLifecycle`.
#[napi(js_name = "hasNewerSessionLifecycle")]
pub fn has_newer_session_lifecycle(current: String, incoming: String) -> napi::Result<bool> {
    run(move || {
        let current = crate::js::from_json(&current)?;
        let incoming = crate::js::from_json(&incoming)?;
        let out = port::has_newer_session_lifecycle(current, incoming)?;
        Ok(out)
    })
}

/// `mergeSessionListLifecycle`.
#[napi(js_name = "mergeSessionListLifecycle")]
pub fn merge_session_list_lifecycle(current: String, next: String) -> napi::Result<String> {
    run(move || {
        let current = crate::js::from_json(&current)?;
        let next = crate::js::from_json(&next)?;
        let out = port::merge_session_list_lifecycle(current, next)?;
        crate::js::to_json(&out)
    })
}

/// `areSessionRecordsEqual`.
#[napi(js_name = "areSessionRecordsEqual")]
pub fn are_session_records_equal(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::are_session_records_equal(left, right)?;
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

static S_GET_SESSION_RECENCY_0: wire::Schema = wire::Schema::Dyn;

/// `getSessionRecency` over the binary wire.
#[napi(js_name = "getSessionRecencyWire")]
pub fn get_session_recency_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: serde_json::Value = wire::read_value(r, &S_GET_SESSION_RECENCY_0)?;
        let out = &port::get_session_recency(session)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.f64(*x0);
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

static S_COMPARE_SESSION_RECENCY_0: wire::Schema = wire::Schema::Dyn;
static S_COMPARE_SESSION_RECENCY_1: wire::Schema = wire::Schema::Dyn;
static S_COMPARE_SESSION_RECENCY_OUT: wire::Schema = wire::Schema::Dyn;

/// `compareSessionRecency` over the binary wire.
#[napi(js_name = "compareSessionRecencyWire")]
pub fn compare_session_recency_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let incoming: serde_json::Value = wire::read_value(r, &S_COMPARE_SESSION_RECENCY_0)?;
        let current: serde_json::Value = wire::read_value(r, &S_COMPARE_SESSION_RECENCY_1)?;
        let out = &port::compare_session_recency(incoming, current)?;
        wire::write_value(w, out, &S_COMPARE_SESSION_RECENCY_OUT)?;
        Ok(())
    })
}

static S_IS_STRICTLY_OLDER_SESSION_0: wire::Schema = wire::Schema::Dyn;
static S_IS_STRICTLY_OLDER_SESSION_1: wire::Schema = wire::Schema::Dyn;

/// `isStrictlyOlderSession` over the binary wire.
#[napi(js_name = "isStrictlyOlderSessionWire")]
pub fn is_strictly_older_session_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let incoming: serde_json::Value = wire::read_value(r, &S_IS_STRICTLY_OLDER_SESSION_0)?;
        let current: serde_json::Value = wire::read_value(r, &S_IS_STRICTLY_OLDER_SESSION_1)?;
        let out = &port::is_strictly_older_session(incoming, current)?;
        w.bool(*out);
        Ok(())
    })
}

static S_RESOLVE_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_SESSION_LIFECYCLE_OUT: wire::Schema = wire::Schema::Obj(&[
    ("busy", wire::Schema::OptJs(&wire::Schema::Num)),
    ("idle", wire::Schema::OptJs(&wire::Schema::Num)),
    ("viewed", wire::Schema::OptJs(&wire::Schema::Num)),
    ("outcome", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "fork",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("sessionID", wire::Schema::Str16),
            (
                "boundary",
                wire::Schema::Obj(&[("type", wire::Schema::Str16), ("messageID", wire::Schema::Str16)]),
            ),
        ])),
    ),
]);

/// `resolveSessionLifecycle` over the binary wire.
#[napi(js_name = "resolveSessionLifecycleWire")]
pub fn resolve_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: serde_json::Value = wire::read_value(r, &S_RESOLVE_SESSION_LIFECYCLE_0)?;
        let incoming: serde_json::Value = wire::read_value(r, &S_RESOLVE_SESSION_LIFECYCLE_1)?;
        let out = &port::resolve_session_lifecycle(current, incoming)?;
        wire::write_value(w, out, &S_RESOLVE_SESSION_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_MERGE_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_MERGE_SESSION_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `mergeSessionLifecycle` over the binary wire.
#[napi(js_name = "mergeSessionLifecycleWire")]
pub fn merge_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let incoming: serde_json::Value = wire::read_value(r, &S_MERGE_SESSION_LIFECYCLE_1)?;
        let out = &port::merge_session_lifecycle(current, incoming)?;
        wire::write_value(w, out, &S_MERGE_SESSION_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_RETAIN_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_RETAIN_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_RETAIN_SESSION_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `retainSessionLifecycle` over the binary wire.
#[napi(js_name = "retainSessionLifecycleWire")]
pub fn retain_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let retained: serde_json::Value = wire::read_value(r, &S_RETAIN_SESSION_LIFECYCLE_0)?;
        let rejected: serde_json::Value = wire::read_value(r, &S_RETAIN_SESSION_LIFECYCLE_1)?;
        let out = &port::retain_session_lifecycle(retained, rejected)?;
        wire::write_value(w, out, &S_RETAIN_SESSION_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_HAS_NEWER_SESSION_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_HAS_NEWER_SESSION_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;

/// `hasNewerSessionLifecycle` over the binary wire.
#[napi(js_name = "hasNewerSessionLifecycleWire")]
pub fn has_newer_session_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: serde_json::Value = wire::read_value(r, &S_HAS_NEWER_SESSION_LIFECYCLE_0)?;
        let incoming: serde_json::Value = wire::read_value(r, &S_HAS_NEWER_SESSION_LIFECYCLE_1)?;
        let out = &port::has_newer_session_lifecycle(current, incoming)?;
        w.bool(*out);
        Ok(())
    })
}

static S_MERGE_SESSION_LIST_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_MERGE_SESSION_LIST_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_MERGE_SESSION_LIST_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `mergeSessionListLifecycle` over the binary wire.
#[napi(js_name = "mergeSessionListLifecycleWire")]
pub fn merge_session_list_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: Value = wire::read_value(r, &S_MERGE_SESSION_LIST_LIFECYCLE_0)?;
        let next: Value = wire::read_value(r, &S_MERGE_SESSION_LIST_LIFECYCLE_1)?;
        let out = &port::merge_session_list_lifecycle(current, next)?;
        wire::write_value(w, out, &S_MERGE_SESSION_LIST_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_ARE_SESSION_RECORDS_EQUAL_0: wire::Schema = wire::Schema::Dyn;
static S_ARE_SESSION_RECORDS_EQUAL_1: wire::Schema = wire::Schema::Dyn;

/// `areSessionRecordsEqual` over the binary wire.
#[napi(js_name = "areSessionRecordsEqualWire")]
pub fn are_session_records_equal_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: serde_json::Value = wire::read_value(r, &S_ARE_SESSION_RECORDS_EQUAL_0)?;
        let right: serde_json::Value = wire::read_value(r, &S_ARE_SESSION_RECORDS_EQUAL_1)?;
        let out = &port::are_session_records_equal(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

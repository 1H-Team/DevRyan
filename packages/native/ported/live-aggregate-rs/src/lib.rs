//! JS bindings for `live-aggregate.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `areSessionListsEquivalent`.
#[napi(js_name = "areSessionListsEquivalent")]
pub fn are_session_lists_equivalent(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::are_session_lists_equivalent(left, right)?;
        Ok(out)
    })
}

/// `areStatusMapsEquivalent`.
#[napi(js_name = "areStatusMapsEquivalent")]
pub fn are_status_maps_equivalent(left: String, right: String) -> napi::Result<bool> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::are_status_maps_equivalent(left, right)?;
        Ok(out)
    })
}

/// `aggregateLiveSessions`.
#[napi(js_name = "aggregateLiveSessions")]
pub fn aggregate_live_sessions(states: String) -> napi::Result<String> {
    run(move || {
        let states = crate::js::from_json(&states)?;
        let out = port::aggregate_live_sessions(states)?;
        crate::js::to_json(&out)
    })
}

/// `aggregateLiveSessionStatuses`.
#[napi(js_name = "aggregateLiveSessionStatuses")]
pub fn aggregate_live_session_statuses(states: String) -> napi::Result<String> {
    run(move || {
        let states = crate::js::from_json(&states)?;
        let out = port::aggregate_live_session_statuses(states)?;
        crate::js::to_json(&out)
    })
}

/// `findLiveSession`.
#[napi(js_name = "findLiveSession")]
pub fn find_live_session(states: String, session_id: Option<String>) -> napi::Result<String> {
    run(move || {
        let states = crate::js::from_json(&states)?;
        let out = port::find_live_session(states, session_id)?;
        crate::js::to_json(&out)
    })
}

/// `findLiveSessionStatus`.
#[napi(js_name = "findLiveSessionStatus")]
pub fn find_live_session_status(states: String, session_id: Option<String>) -> napi::Result<String> {
    run(move || {
        let states = crate::js::from_json(&states)?;
        let out = port::find_live_session_status(states, session_id)?;
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

static S_ARE_SESSION_LISTS_EQUIVALENT_0: wire::Schema = wire::Schema::Dyn;
static S_ARE_SESSION_LISTS_EQUIVALENT_1: wire::Schema = wire::Schema::Dyn;

/// `areSessionListsEquivalent` over the binary wire.
#[napi(js_name = "areSessionListsEquivalentWire")]
pub fn are_session_lists_equivalent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_ARE_SESSION_LISTS_EQUIVALENT_0)?;
        let right: Value = wire::read_value(r, &S_ARE_SESSION_LISTS_EQUIVALENT_1)?;
        let out = &port::are_session_lists_equivalent(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_ARE_STATUS_MAPS_EQUIVALENT_0: wire::Schema = wire::Schema::Dyn;
static S_ARE_STATUS_MAPS_EQUIVALENT_1: wire::Schema = wire::Schema::Dyn;

/// `areStatusMapsEquivalent` over the binary wire.
#[napi(js_name = "areStatusMapsEquivalentWire")]
pub fn are_status_maps_equivalent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_ARE_STATUS_MAPS_EQUIVALENT_0)?;
        let right: Value = wire::read_value(r, &S_ARE_STATUS_MAPS_EQUIVALENT_1)?;
        let out = &port::are_status_maps_equivalent(left, right)?;
        w.bool(*out);
        Ok(())
    })
}

static S_AGGREGATE_LIVE_SESSIONS_0: wire::Schema = wire::Schema::Dyn;
static S_AGGREGATE_LIVE_SESSIONS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `aggregateLiveSessions` over the binary wire.
#[napi(js_name = "aggregateLiveSessionsWire")]
pub fn aggregate_live_sessions_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let states: Value = wire::read_value(r, &S_AGGREGATE_LIVE_SESSIONS_0)?;
        let out = &port::aggregate_live_sessions(states)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_AGGREGATE_LIVE_SESSIONS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_AGGREGATE_LIVE_SESSION_STATUSES_0: wire::Schema = wire::Schema::Dyn;
static S_AGGREGATE_LIVE_SESSION_STATUSES_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Dyn);

/// `aggregateLiveSessionStatuses` over the binary wire.
#[napi(js_name = "aggregateLiveSessionStatusesWire")]
pub fn aggregate_live_session_statuses_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let states: Value = wire::read_value(r, &S_AGGREGATE_LIVE_SESSION_STATUSES_0)?;
        let out = &port::aggregate_live_session_statuses(states)?;
        wire::write_value(w, out, &S_AGGREGATE_LIVE_SESSION_STATUSES_OUT)?;
        Ok(())
    })
}

static S_FIND_LIVE_SESSION_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_LIVE_SESSION_OUT: wire::Schema = wire::Schema::Dyn;

/// `findLiveSession` over the binary wire.
#[napi(js_name = "findLiveSessionWire")]
pub fn find_live_session_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let states: Value = wire::read_value(r, &S_FIND_LIVE_SESSION_0)?;
        let session_id: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::find_live_session(states, session_id)?;
        wire::write_value(w, out, &S_FIND_LIVE_SESSION_OUT)?;
        Ok(())
    })
}

static S_FIND_LIVE_SESSION_STATUS_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_LIVE_SESSION_STATUS_OUT: wire::Schema = wire::Schema::Dyn;

/// `findLiveSessionStatus` over the binary wire.
#[napi(js_name = "findLiveSessionStatusWire")]
pub fn find_live_session_status_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let states: Value = wire::read_value(r, &S_FIND_LIVE_SESSION_STATUS_0)?;
        let session_id: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::find_live_session_status(states, session_id)?;
        wire::write_value(w, out, &S_FIND_LIVE_SESSION_STATUS_OUT)?;
        Ok(())
    })
}

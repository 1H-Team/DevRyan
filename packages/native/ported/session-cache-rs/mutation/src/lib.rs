//! JS bindings for `session-cache-mutation.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `dropSessionCachesReturningStore`.
#[napi(js_name = "dropSessionCachesReturningStore")]
pub fn drop_session_caches_returning_store(store: String, session_i_ds: String) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let session_i_ds = crate::js::from_json(&session_i_ds)?;
        let out = port::drop_session_caches_returning_store(store, session_i_ds)?;
        crate::js::to_json(&out)
    })
}

/// `pickSessionCacheEvictionsReturningSeen`.
#[napi(js_name = "pickSessionCacheEvictionsReturningSeen")]
pub fn pick_session_cache_evictions_returning_seen(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::pick_session_cache_evictions_returning_seen(input)?;
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

static S_DROP_SESSION_CACHES_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_DROP_SESSION_CACHES_RETURNING_STORE_1: wire::Schema = wire::Schema::Dyn;
static S_DROP_SESSION_CACHES_RETURNING_STORE_OUT: wire::Schema = wire::Schema::Obj(&[
    ("session_status", wire::Schema::Map16(&wire::Schema::Dyn)),
    (
        "session_diff",
        wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn))),
    ),
    ("todo", wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)))),
    ("message", wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)))),
    ("part", wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)))),
    ("permission", wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)))),
    ("question", wire::Schema::Map16(&wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)))),
]);

/// `dropSessionCachesReturningStore` over the binary wire.
#[napi(js_name = "dropSessionCachesReturningStoreWire")]
pub fn drop_session_caches_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_DROP_SESSION_CACHES_RETURNING_STORE_0)?;
        let session_i_ds: serde_json::Value = wire::read_value(r, &S_DROP_SESSION_CACHES_RETURNING_STORE_1)?;
        let out = &port::drop_session_caches_returning_store(store, session_i_ds)?;
        wire::write_value(w, out, &S_DROP_SESSION_CACHES_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_PICK_SESSION_CACHE_EVICTIONS_RETURNING_SEEN_0: wire::Schema = wire::Schema::Dyn;
static S_PICK_SESSION_CACHE_EVICTIONS_RETURNING_SEEN_OUT: wire::Schema = wire::Schema::Obj(&[
    ("result", wire::Schema::List(&wire::Schema::Str16)),
    ("seen", wire::Schema::List(&wire::Schema::Str16)),
]);

/// `pickSessionCacheEvictionsReturningSeen` over the binary wire.
#[napi(js_name = "pickSessionCacheEvictionsReturningSeenWire")]
pub fn pick_session_cache_evictions_returning_seen_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_PICK_SESSION_CACHE_EVICTIONS_RETURNING_SEEN_0)?;
        let out = &port::pick_session_cache_evictions_returning_seen(input)?;
        wire::write_value(w, out, &S_PICK_SESSION_CACHE_EVICTIONS_RETURNING_SEEN_OUT)?;
        Ok(())
    })
}

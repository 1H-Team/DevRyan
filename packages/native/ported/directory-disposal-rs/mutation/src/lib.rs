//! JS bindings for `directory-disposal-mutation.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `releaseDirectoryRoutingIndexReturningIndex`.
#[napi(js_name = "releaseDirectoryRoutingIndexReturningIndex")]
pub fn release_directory_routing_index_returning_index(index: String, directory: String, snapshot: String) -> napi::Result<String> {
    run(move || {
        let index = crate::js::from_json(&index)?;
        let snapshot = crate::js::from_json(&snapshot)?;
        let out = port::release_directory_routing_index_returning_index(index, directory, snapshot)?;
        crate::js::to_json(&out)
    })
}

/// `clearDirectoryMaterializationsReturningPending`.
#[napi(js_name = "clearDirectoryMaterializationsReturningPending")]
pub fn clear_directory_materializations_returning_pending(entries: String, directory: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::clear_directory_materializations_returning_pending(entries, directory)?;
        crate::js::to_json(&out)
    })
}

/// `clearDirectoryPrefixedMapEntriesReturningMap`.
#[napi(js_name = "clearDirectoryPrefixedMapEntriesReturningMap")]
pub fn clear_directory_prefixed_map_entries_returning_map(entries: String, directory: String, separator: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let separator = crate::js::from_json(&separator)?;
        let out = port::clear_directory_prefixed_map_entries_returning_map(entries, directory, separator)?;
        crate::js::to_json(&out)
    })
}

/// `clearDirectoryPrefixedSetEntriesReturningSet`.
#[napi(js_name = "clearDirectoryPrefixedSetEntriesReturningSet")]
pub fn clear_directory_prefixed_set_entries_returning_set(values: String, directory: String, separator: String) -> napi::Result<String> {
    run(move || {
        let values = crate::js::from_json(&values)?;
        let separator = crate::js::from_json(&separator)?;
        let out = port::clear_directory_prefixed_set_entries_returning_set(values, directory, separator)?;
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

static S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_0: wire::Schema = wire::Schema::Dyn;
static S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_2: wire::Schema = wire::Schema::Dyn;
static S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_OUT: wire::Schema = wire::Schema::Obj(&[
    ("result", wire::Schema::List(&wire::Schema::Str16)),
    (
        "index",
        wire::Schema::Obj(&[
            ("sessionDirectoryById", wire::Schema::List(&wire::Schema::Dyn)),
            ("messageSessionById", wire::Schema::List(&wire::Schema::Dyn)),
            ("sessionMessageIdsById", wire::Schema::List(&wire::Schema::Dyn)),
        ]),
    ),
]);

/// `releaseDirectoryRoutingIndexReturningIndex` over the binary wire.
#[napi(js_name = "releaseDirectoryRoutingIndexReturningIndexWire")]
pub fn release_directory_routing_index_returning_index_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let index: serde_json::Value = wire::read_value(r, &S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_0)?;
        let directory: String = r.string16()?;
        let snapshot: serde_json::Value = wire::read_value(r, &S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_2)?;
        let out = &port::release_directory_routing_index_returning_index(index, directory, snapshot)?;
        wire::write_value(w, out, &S_RELEASE_DIRECTORY_ROUTING_INDEX_RETURNING_INDEX_OUT)?;
        Ok(())
    })
}

static S_CLEAR_DIRECTORY_MATERIALIZATIONS_RETURNING_PENDING_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_DIRECTORY_MATERIALIZATIONS_RETURNING_PENDING_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::Num), ("pending", wire::Schema::List(&wire::Schema::Dyn))]);

/// `clearDirectoryMaterializationsReturningPending` over the binary wire.
#[napi(js_name = "clearDirectoryMaterializationsReturningPendingWire")]
pub fn clear_directory_materializations_returning_pending_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: serde_json::Value = wire::read_value(r, &S_CLEAR_DIRECTORY_MATERIALIZATIONS_RETURNING_PENDING_0)?;
        let directory: String = r.string16()?;
        let out = &port::clear_directory_materializations_returning_pending(entries, directory)?;
        wire::write_value(w, out, &S_CLEAR_DIRECTORY_MATERIALIZATIONS_RETURNING_PENDING_OUT)?;
        Ok(())
    })
}

static S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_2: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::Num), ("entries", wire::Schema::List(&wire::Schema::Dyn))]);

/// `clearDirectoryPrefixedMapEntriesReturningMap` over the binary wire.
#[napi(js_name = "clearDirectoryPrefixedMapEntriesReturningMapWire")]
pub fn clear_directory_prefixed_map_entries_returning_map_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: serde_json::Value = wire::read_value(r, &S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_0)?;
        let directory: String = r.string16()?;
        let separator: serde_json::Value = wire::read_value(r, &S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_2)?;
        let out = &port::clear_directory_prefixed_map_entries_returning_map(entries, directory, separator)?;
        wire::write_value(w, out, &S_CLEAR_DIRECTORY_PREFIXED_MAP_ENTRIES_RETURNING_MAP_OUT)?;
        Ok(())
    })
}

static S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_2: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::Num), ("values", wire::Schema::List(&wire::Schema::Str16))]);

/// `clearDirectoryPrefixedSetEntriesReturningSet` over the binary wire.
#[napi(js_name = "clearDirectoryPrefixedSetEntriesReturningSetWire")]
pub fn clear_directory_prefixed_set_entries_returning_set_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let values: serde_json::Value = wire::read_value(r, &S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_0)?;
        let directory: String = r.string16()?;
        let separator: serde_json::Value = wire::read_value(r, &S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_2)?;
        let out = &port::clear_directory_prefixed_set_entries_returning_set(values, directory, separator)?;
        wire::write_value(w, out, &S_CLEAR_DIRECTORY_PREFIXED_SET_ENTRIES_RETURNING_SET_OUT)?;
        Ok(())
    })
}

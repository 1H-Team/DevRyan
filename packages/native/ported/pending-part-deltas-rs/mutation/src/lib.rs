//! JS bindings for `pending-part-deltas-mutation.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `recordPartTypeHintReturningStore`.
#[napi(js_name = "recordPartTypeHintReturningStore")]
pub fn record_part_type_hint_returning_store(store: String, directory: String, event: String, now: f64) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let event = crate::js::from_json(&event)?;
        let out = port::record_part_type_hint_returning_store(store, directory, event, now)?;
        crate::js::to_json(&out)
    })
}

/// `getPartTypeHintReturningStore`.
#[napi(js_name = "getPartTypeHintReturningStore")]
pub fn get_part_type_hint_returning_store(store: String, directory: String, part_id: String, now: f64) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let out = port::get_part_type_hint_returning_store(store, directory, part_id, now)?;
        crate::js::to_json(&out)
    })
}

/// `clearPartTypeHintsReturningStore`.
#[napi(js_name = "clearPartTypeHintsReturningStore")]
pub fn clear_part_type_hints_returning_store(store: String, directory: String) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let out = port::clear_part_type_hints_returning_store(store, directory)?;
        crate::js::to_json(&out)
    })
}

/// `addPendingPartDeltaReturningStore`.
#[napi(js_name = "addPendingPartDeltaReturningStore")]
pub fn add_pending_part_delta_returning_store(store: String, directory: String, pending: String, now: f64) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let pending = crate::js::from_json(&pending)?;
        let out = port::add_pending_part_delta_returning_store(store, directory, pending, now)?;
        crate::js::to_json(&out)
    })
}

/// `consumePendingPartDeltasReturningStore`.
#[napi(js_name = "consumePendingPartDeltasReturningStore")]
pub fn consume_pending_part_deltas_returning_store(store: String, directory: String, message_id: String, part_id: String, now: f64) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let out = port::consume_pending_part_deltas_returning_store(store, directory, message_id, part_id, now)?;
        crate::js::to_json(&out)
    })
}

/// `hasPendingPartDeltasForMessageList`.
#[napi(js_name = "hasPendingPartDeltasForMessageList")]
pub fn has_pending_part_deltas_for_message_list(store: String, directory: String, message_i_ds: String) -> napi::Result<bool> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let message_i_ds = crate::js::from_json(&message_i_ds)?;
        let out = port::has_pending_part_deltas_for_message_list(store, directory, message_i_ds)?;
        Ok(out)
    })
}

/// `clearPendingPartDeltasForDirectoryReturningStore`.
#[napi(js_name = "clearPendingPartDeltasForDirectoryReturningStore")]
pub fn clear_pending_part_deltas_for_directory_returning_store(store: String, directory: String) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let out = port::clear_pending_part_deltas_for_directory_returning_store(store, directory)?;
        crate::js::to_json(&out)
    })
}

/// `clearPendingPartDeltasForMessagesReturningStore`.
#[napi(js_name = "clearPendingPartDeltasForMessagesReturningStore")]
pub fn clear_pending_part_deltas_for_messages_returning_store(store: String, directory: String, message_i_ds: String) -> napi::Result<String> {
    run(move || {
        let store = crate::js::from_json(&store)?;
        let message_i_ds = crate::js::from_json(&message_i_ds)?;
        let out = port::clear_pending_part_deltas_for_messages_returning_store(store, directory, message_i_ds)?;
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

static S_RECORD_PART_TYPE_HINT_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_RECORD_PART_TYPE_HINT_RETURNING_STORE_2: wire::Schema = wire::Schema::Dyn;
static S_RECORD_PART_TYPE_HINT_RETURNING_STORE_OUT: wire::Schema = wire::Schema::Dyn;

/// `recordPartTypeHintReturningStore` over the binary wire.
#[napi(js_name = "recordPartTypeHintReturningStoreWire")]
pub fn record_part_type_hint_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_RECORD_PART_TYPE_HINT_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let event: serde_json::Value = wire::read_value(r, &S_RECORD_PART_TYPE_HINT_RETURNING_STORE_2)?;
        let now: f64 = r.f64()?;
        let out = &port::record_part_type_hint_returning_store(store, directory, event, now)?;
        wire::write_value(w, out, &S_RECORD_PART_TYPE_HINT_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_GET_PART_TYPE_HINT_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_GET_PART_TYPE_HINT_RETURNING_STORE_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::OptJs(&wire::Schema::Str16)), ("store", wire::Schema::Dyn)]);

/// `getPartTypeHintReturningStore` over the binary wire.
#[napi(js_name = "getPartTypeHintReturningStoreWire")]
pub fn get_part_type_hint_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_GET_PART_TYPE_HINT_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let part_id: String = r.string16()?;
        let now: f64 = r.f64()?;
        let out = &port::get_part_type_hint_returning_store(store, directory, part_id, now)?;
        wire::write_value(w, out, &S_GET_PART_TYPE_HINT_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_CLEAR_PART_TYPE_HINTS_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_PART_TYPE_HINTS_RETURNING_STORE_OUT: wire::Schema = wire::Schema::Dyn;

/// `clearPartTypeHintsReturningStore` over the binary wire.
#[napi(js_name = "clearPartTypeHintsReturningStoreWire")]
pub fn clear_part_type_hints_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_CLEAR_PART_TYPE_HINTS_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let out = &port::clear_part_type_hints_returning_store(store, directory)?;
        wire::write_value(w, out, &S_CLEAR_PART_TYPE_HINTS_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_ADD_PENDING_PART_DELTA_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_ADD_PENDING_PART_DELTA_RETURNING_STORE_2: wire::Schema = wire::Schema::Dyn;
static S_ADD_PENDING_PART_DELTA_RETURNING_STORE_OUT: wire::Schema = wire::Schema::Dyn;

/// `addPendingPartDeltaReturningStore` over the binary wire.
#[napi(js_name = "addPendingPartDeltaReturningStoreWire")]
pub fn add_pending_part_delta_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_ADD_PENDING_PART_DELTA_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let pending: serde_json::Value = wire::read_value(r, &S_ADD_PENDING_PART_DELTA_RETURNING_STORE_2)?;
        let now: f64 = r.f64()?;
        let out = &port::add_pending_part_delta_returning_store(store, directory, pending, now)?;
        wire::write_value(w, out, &S_ADD_PENDING_PART_DELTA_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_CONSUME_PENDING_PART_DELTAS_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_CONSUME_PENDING_PART_DELTAS_RETURNING_STORE_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::List(&wire::Schema::Dyn)), ("store", wire::Schema::Dyn)]);

/// `consumePendingPartDeltasReturningStore` over the binary wire.
#[napi(js_name = "consumePendingPartDeltasReturningStoreWire")]
pub fn consume_pending_part_deltas_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_CONSUME_PENDING_PART_DELTAS_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let message_id: String = r.string16()?;
        let part_id: String = r.string16()?;
        let now: f64 = r.f64()?;
        let out = &port::consume_pending_part_deltas_returning_store(store, directory, message_id, part_id, now)?;
        wire::write_value(w, out, &S_CONSUME_PENDING_PART_DELTAS_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_HAS_PENDING_PART_DELTAS_FOR_MESSAGE_LIST_0: wire::Schema = wire::Schema::Dyn;
static S_HAS_PENDING_PART_DELTAS_FOR_MESSAGE_LIST_2: wire::Schema = wire::Schema::Dyn;

/// `hasPendingPartDeltasForMessageList` over the binary wire.
#[napi(js_name = "hasPendingPartDeltasForMessageListWire")]
pub fn has_pending_part_deltas_for_message_list_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_HAS_PENDING_PART_DELTAS_FOR_MESSAGE_LIST_0)?;
        let directory: String = r.string16()?;
        let message_i_ds: serde_json::Value = wire::read_value(r, &S_HAS_PENDING_PART_DELTAS_FOR_MESSAGE_LIST_2)?;
        let out = &port::has_pending_part_deltas_for_message_list(store, directory, message_i_ds)?;
        w.bool(*out);
        Ok(())
    })
}

static S_CLEAR_PENDING_PART_DELTAS_FOR_DIRECTORY_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_PENDING_PART_DELTAS_FOR_DIRECTORY_RETURNING_STORE_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::Num), ("store", wire::Schema::Dyn)]);

/// `clearPendingPartDeltasForDirectoryReturningStore` over the binary wire.
#[napi(js_name = "clearPendingPartDeltasForDirectoryReturningStoreWire")]
pub fn clear_pending_part_deltas_for_directory_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_CLEAR_PENDING_PART_DELTAS_FOR_DIRECTORY_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let out = &port::clear_pending_part_deltas_for_directory_returning_store(store, directory)?;
        wire::write_value(w, out, &S_CLEAR_PENDING_PART_DELTAS_FOR_DIRECTORY_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

static S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_0: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_2: wire::Schema = wire::Schema::Dyn;
static S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_OUT: wire::Schema =
    wire::Schema::Obj(&[("result", wire::Schema::Num), ("store", wire::Schema::Dyn)]);

/// `clearPendingPartDeltasForMessagesReturningStore` over the binary wire.
#[napi(js_name = "clearPendingPartDeltasForMessagesReturningStoreWire")]
pub fn clear_pending_part_deltas_for_messages_returning_store_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let store: serde_json::Value = wire::read_value(r, &S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_0)?;
        let directory: String = r.string16()?;
        let message_i_ds: serde_json::Value = wire::read_value(r, &S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_2)?;
        let out = &port::clear_pending_part_deltas_for_messages_returning_store(store, directory, message_i_ds)?;
        wire::write_value(w, out, &S_CLEAR_PENDING_PART_DELTAS_FOR_MESSAGES_RETURNING_STORE_OUT)?;
        Ok(())
    })
}

//! JS bindings for `message-order.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `compareMessagesChronologically`.
#[napi(js_name = "compareMessagesChronologically")]
pub fn compare_messages_chronologically(left: String, right: String) -> napi::Result<f64> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::compare_messages_chronologically(left, right)?;
        Ok(out)
    })
}

/// `sortMessagesChronologically`.
#[napi(js_name = "sortMessagesChronologically")]
pub fn sort_messages_chronologically(messages: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::sort_messages_chronologically(messages)?;
        crate::js::to_json(&out)
    })
}

/// `insertMessageChronologically`.
#[napi(js_name = "insertMessageChronologically")]
pub fn insert_message_chronologically(messages: String, message: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let message = crate::js::from_json(&message)?;
        let out = port::insert_message_chronologically(messages, message)?;
        crate::js::to_json(&out)
    })
}

/// `findMessageIndex`.
#[napi(js_name = "findMessageIndex")]
pub fn find_message_index(messages: String, message_id: String) -> napi::Result<f64> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::find_message_index(messages, message_id)?;
        Ok(out)
    })
}

/// `messagesBefore`.
#[napi(js_name = "messagesBefore")]
pub fn messages_before(messages: String, marker_id: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::messages_before(messages, marker_id)?;
        crate::js::to_json(&out)
    })
}

/// `messagesFrom`.
#[napi(js_name = "messagesFrom")]
pub fn messages_from(messages: String, marker_id: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::messages_from(messages, marker_id)?;
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

static S_COMPARE_MESSAGES_CHRONOLOGICALLY_0: wire::Schema = wire::Schema::Dyn;
static S_COMPARE_MESSAGES_CHRONOLOGICALLY_1: wire::Schema = wire::Schema::Dyn;

/// `compareMessagesChronologically` over the binary wire.
#[napi(js_name = "compareMessagesChronologicallyWire")]
pub fn compare_messages_chronologically_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_COMPARE_MESSAGES_CHRONOLOGICALLY_0)?;
        let right: Value = wire::read_value(r, &S_COMPARE_MESSAGES_CHRONOLOGICALLY_1)?;
        let out = &port::compare_messages_chronologically(left, right)?;
        w.f64(*out);
        Ok(())
    })
}

static S_SORT_MESSAGES_CHRONOLOGICALLY_0: wire::Schema = wire::Schema::Dyn;
static S_SORT_MESSAGES_CHRONOLOGICALLY_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `sortMessagesChronologically` over the binary wire.
#[napi(js_name = "sortMessagesChronologicallyWire")]
pub fn sort_messages_chronologically_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_SORT_MESSAGES_CHRONOLOGICALLY_0)?;
        let out = &port::sort_messages_chronologically(messages)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_SORT_MESSAGES_CHRONOLOGICALLY_OUT.inner())?;
        }
        Ok(())
    })
}

static S_INSERT_MESSAGE_CHRONOLOGICALLY_0: wire::Schema = wire::Schema::Dyn;
static S_INSERT_MESSAGE_CHRONOLOGICALLY_1: wire::Schema = wire::Schema::Dyn;
static S_INSERT_MESSAGE_CHRONOLOGICALLY_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `insertMessageChronologically` over the binary wire.
#[napi(js_name = "insertMessageChronologicallyWire")]
pub fn insert_message_chronologically_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_INSERT_MESSAGE_CHRONOLOGICALLY_0)?;
        let message: Value = wire::read_value(r, &S_INSERT_MESSAGE_CHRONOLOGICALLY_1)?;
        let out = &port::insert_message_chronologically(messages, message)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_INSERT_MESSAGE_CHRONOLOGICALLY_OUT.inner())?;
        }
        Ok(())
    })
}

static S_FIND_MESSAGE_INDEX_0: wire::Schema = wire::Schema::Dyn;

/// `findMessageIndex` over the binary wire.
#[napi(js_name = "findMessageIndexWire")]
pub fn find_message_index_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_FIND_MESSAGE_INDEX_0)?;
        let message_id: String = r.string16()?;
        let out = &port::find_message_index(messages, message_id)?;
        w.f64(*out);
        Ok(())
    })
}

static S_MESSAGES_BEFORE_0: wire::Schema = wire::Schema::Dyn;
static S_MESSAGES_BEFORE_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `messagesBefore` over the binary wire.
#[napi(js_name = "messagesBeforeWire")]
pub fn messages_before_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_MESSAGES_BEFORE_0)?;
        let marker_id: String = r.string16()?;
        let out = &port::messages_before(messages, marker_id)?;
        wire::write_value(w, out, &S_MESSAGES_BEFORE_OUT)?;
        Ok(())
    })
}

static S_MESSAGES_FROM_0: wire::Schema = wire::Schema::Dyn;
static S_MESSAGES_FROM_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `messagesFrom` over the binary wire.
#[napi(js_name = "messagesFromWire")]
pub fn messages_from_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_MESSAGES_FROM_0)?;
        let marker_id: String = r.string16()?;
        let out = &port::messages_from(messages, marker_id)?;
        wire::write_value(w, out, &S_MESSAGES_FROM_OUT)?;
        Ok(())
    })
}

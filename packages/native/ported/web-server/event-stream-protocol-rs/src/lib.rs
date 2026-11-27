//! JS bindings for `protocol.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `parseSseEventEnvelope`.
#[napi(js_name = "parseSseEventEnvelope")]
pub fn parse_sse_event_envelope(block: String) -> napi::Result<String> {
    run(move || {
        let block = crate::js::from_json(&block)?;
        let out = port::parse_sse_event_envelope(block)?;
        crate::js::to_json(&out)
    })
}

/// `toUpstreamV2SseEvent`.
#[napi(js_name = "toUpstreamV2SseEvent")]
pub fn to_upstream_v2_sse_event(parsed: String) -> napi::Result<String> {
    run(move || {
        let parsed = crate::js::from_json(&parsed)?;
        let out = port::to_upstream_v2_sse_event(parsed)?;
        crate::js::to_json(&out)
    })
}

/// `serializeMessageStreamWsEvent`.
#[napi(js_name = "serializeMessageStreamWsEvent")]
pub fn serialize_message_stream_ws_event(payload: String, options: String) -> napi::Result<String> {
    run(move || {
        let payload = crate::js::from_json(&payload)?;
        let options = crate::js::from_json(&options)?;
        let out = port::serialize_message_stream_ws_event(payload, options)?;
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

static S_PARSE_SSE_EVENT_ENVELOPE_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_SSE_EVENT_ENVELOPE_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseSseEventEnvelope` over the binary wire.
#[napi(js_name = "parseSseEventEnvelopeWire")]
pub fn parse_sse_event_envelope_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let block: Value = wire::read_value(r, &S_PARSE_SSE_EVENT_ENVELOPE_0)?;
        let out = &port::parse_sse_event_envelope(block)?;
        wire::write_value(w, out, &S_PARSE_SSE_EVENT_ENVELOPE_OUT)?;
        Ok(())
    })
}

static S_TO_UPSTREAM_V2_SSE_EVENT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_UPSTREAM_V2_SSE_EVENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toUpstreamV2SseEvent` over the binary wire.
#[napi(js_name = "toUpstreamV2SseEventWire")]
pub fn to_upstream_v2_sse_event_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let parsed: Value = wire::read_value(r, &S_TO_UPSTREAM_V2_SSE_EVENT_0)?;
        let out = &port::to_upstream_v2_sse_event(parsed)?;
        wire::write_value(w, out, &S_TO_UPSTREAM_V2_SSE_EVENT_OUT)?;
        Ok(())
    })
}

static S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_0: wire::Schema = wire::Schema::Dyn;
static S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_1: wire::Schema = wire::Schema::Dyn;
static S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `serializeMessageStreamWsEvent` over the binary wire.
#[napi(js_name = "serializeMessageStreamWsEventWire")]
pub fn serialize_message_stream_ws_event_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let payload: Value = wire::read_value(r, &S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_0)?;
        let options: Value = wire::read_value(r, &S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_1)?;
        let out = &port::serialize_message_stream_ws_event(payload, options)?;
        wire::write_value(w, out, &S_SERIALIZE_MESSAGE_STREAM_WS_EVENT_OUT)?;
        Ok(())
    })
}

//! JS bindings for `ids.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `assistantTextPartId`.
#[napi(js_name = "assistantTextPartId")]
pub fn assistant_text_part_id(message_id: String, ordinal: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let ordinal = crate::js::from_json(&ordinal)?;
        let out = port::assistant_text_part_id(message_id, ordinal)?;
        crate::js::to_json(&out)
    })
}

/// `assistantReasoningPartId`.
#[napi(js_name = "assistantReasoningPartId")]
pub fn assistant_reasoning_part_id(message_id: String, ordinal: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let ordinal = crate::js::from_json(&ordinal)?;
        let out = port::assistant_reasoning_part_id(message_id, ordinal)?;
        crate::js::to_json(&out)
    })
}

/// `assistantToolPartId`.
#[napi(js_name = "assistantToolPartId")]
pub fn assistant_tool_part_id(message_id: String, call_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let call_id = crate::js::from_json(&call_id)?;
        let out = port::assistant_tool_part_id(message_id, call_id)?;
        crate::js::to_json(&out)
    })
}

/// `stepStartPartId`.
#[napi(js_name = "stepStartPartId")]
pub fn step_start_part_id(message_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let out = port::step_start_part_id(message_id)?;
        crate::js::to_json(&out)
    })
}

/// `stepFinishPartId`.
#[napi(js_name = "stepFinishPartId")]
pub fn step_finish_part_id(message_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let out = port::step_finish_part_id(message_id)?;
        crate::js::to_json(&out)
    })
}

/// `userTextPartId`.
#[napi(js_name = "userTextPartId")]
pub fn user_text_part_id(message_id: String, index: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let index = crate::js::from_json(&index)?;
        let out = port::user_text_part_id(message_id, index)?;
        crate::js::to_json(&out)
    })
}

/// `userFilePartId`.
#[napi(js_name = "userFilePartId")]
pub fn user_file_part_id(message_id: String, index: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let index = crate::js::from_json(&index)?;
        let out = port::user_file_part_id(message_id, index)?;
        crate::js::to_json(&out)
    })
}

/// `userAgentPartId`.
#[napi(js_name = "userAgentPartId")]
pub fn user_agent_part_id(message_id: String, index: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let index = crate::js::from_json(&index)?;
        let out = port::user_agent_part_id(message_id, index)?;
        crate::js::to_json(&out)
    })
}

/// `toolAttachmentPartId`.
#[napi(js_name = "toolAttachmentPartId")]
pub fn tool_attachment_part_id(message_id: String, call_id: String, index: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let call_id = crate::js::from_json(&call_id)?;
        let index = crate::js::from_json(&index)?;
        let out = port::tool_attachment_part_id(message_id, call_id, index)?;
        crate::js::to_json(&out)
    })
}

/// `compactionSummaryMessageId`.
#[napi(js_name = "compactionSummaryMessageId")]
pub fn compaction_summary_message_id(message_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let out = port::compaction_summary_message_id(message_id)?;
        crate::js::to_json(&out)
    })
}

/// `assistantContentPartId`.
#[napi(js_name = "assistantContentPartId")]
pub fn assistant_content_part_id(message_id: String, item: String, ordinal: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let item = crate::js::from_json(&item)?;
        let ordinal = crate::js::from_json(&ordinal)?;
        let out = port::assistant_content_part_id(message_id, item, ordinal)?;
        crate::js::to_json(&out)
    })
}

/// `assistantContentPartIds`.
#[napi(js_name = "assistantContentPartIds")]
pub fn assistant_content_part_ids(message_id: String, content: String, metadata: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let content = crate::js::from_json(&content)?;
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::assistant_content_part_ids(message_id, content, metadata)?;
        crate::js::to_json(&out)
    })
}

/// `readDevryanPartDescriptors`.
#[napi(js_name = "readDevryanPartDescriptors")]
pub fn read_devryan_part_descriptors(metadata: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::read_devryan_part_descriptors(metadata)?;
        crate::js::to_json(&out)
    })
}

/// `userTextSegments`.
#[napi(js_name = "userTextSegments")]
pub fn user_text_segments(message_id: String, text_value: String, metadata: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let text_value = crate::js::from_json(&text_value)?;
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::user_text_segments(message_id, text_value, metadata)?;
        crate::js::to_json(&out)
    })
}

/// `userSegmentPartId`.
#[napi(js_name = "userSegmentPartId")]
pub fn user_segment_part_id(message_id: String, metadata: String, index: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let metadata = crate::js::from_json(&metadata)?;
        let index = crate::js::from_json(&index)?;
        let out = port::user_segment_part_id(message_id, metadata, index)?;
        crate::js::to_json(&out)
    })
}

/// `clampIncreasingTime`.
#[napi(js_name = "clampIncreasingTime")]
pub fn clamp_increasing_time(created: String, previous: String) -> napi::Result<String> {
    run(move || {
        let created = crate::js::from_json(&created)?;
        let previous = crate::js::from_json(&previous)?;
        let out = port::clamp_increasing_time(created, previous)?;
        crate::js::to_json(&out)
    })
}

/// `clampIncreasingTimes`.
#[napi(js_name = "clampIncreasingTimes")]
pub fn clamp_increasing_times(times: String, previous: String) -> napi::Result<String> {
    run(move || {
        let times = crate::js::from_json(&times)?;
        let previous = crate::js::from_json(&previous)?;
        let out = port::clamp_increasing_times(times, previous)?;
        crate::js::to_json(&out)
    })
}

/// `isCursorAssistant`.
#[napi(js_name = "isCursorAssistant")]
pub fn is_cursor_assistant(message: String) -> napi::Result<String> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::is_cursor_assistant(message)?;
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

static S_ASSISTANT_TEXT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_TEXT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_TEXT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `assistantTextPartId` over the binary wire.
#[napi(js_name = "assistantTextPartIdWire")]
pub fn assistant_text_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_ASSISTANT_TEXT_PART_ID_0)?;
        let ordinal: Value = wire::read_value(r, &S_ASSISTANT_TEXT_PART_ID_1)?;
        let out = &port::assistant_text_part_id(message_id, ordinal)?;
        wire::write_value(w, out, &S_ASSISTANT_TEXT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_ASSISTANT_REASONING_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_REASONING_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_REASONING_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `assistantReasoningPartId` over the binary wire.
#[napi(js_name = "assistantReasoningPartIdWire")]
pub fn assistant_reasoning_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_ASSISTANT_REASONING_PART_ID_0)?;
        let ordinal: Value = wire::read_value(r, &S_ASSISTANT_REASONING_PART_ID_1)?;
        let out = &port::assistant_reasoning_part_id(message_id, ordinal)?;
        wire::write_value(w, out, &S_ASSISTANT_REASONING_PART_ID_OUT)?;
        Ok(())
    })
}

static S_ASSISTANT_TOOL_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_TOOL_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_TOOL_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `assistantToolPartId` over the binary wire.
#[napi(js_name = "assistantToolPartIdWire")]
pub fn assistant_tool_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_ASSISTANT_TOOL_PART_ID_0)?;
        let call_id: Value = wire::read_value(r, &S_ASSISTANT_TOOL_PART_ID_1)?;
        let out = &port::assistant_tool_part_id(message_id, call_id)?;
        wire::write_value(w, out, &S_ASSISTANT_TOOL_PART_ID_OUT)?;
        Ok(())
    })
}

static S_STEP_START_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_STEP_START_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `stepStartPartId` over the binary wire.
#[napi(js_name = "stepStartPartIdWire")]
pub fn step_start_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_STEP_START_PART_ID_0)?;
        let out = &port::step_start_part_id(message_id)?;
        wire::write_value(w, out, &S_STEP_START_PART_ID_OUT)?;
        Ok(())
    })
}

static S_STEP_FINISH_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_STEP_FINISH_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `stepFinishPartId` over the binary wire.
#[napi(js_name = "stepFinishPartIdWire")]
pub fn step_finish_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_STEP_FINISH_PART_ID_0)?;
        let out = &port::step_finish_part_id(message_id)?;
        wire::write_value(w, out, &S_STEP_FINISH_PART_ID_OUT)?;
        Ok(())
    })
}

static S_USER_TEXT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_USER_TEXT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_USER_TEXT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `userTextPartId` over the binary wire.
#[napi(js_name = "userTextPartIdWire")]
pub fn user_text_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_USER_TEXT_PART_ID_0)?;
        let index: Value = wire::read_value(r, &S_USER_TEXT_PART_ID_1)?;
        let out = &port::user_text_part_id(message_id, index)?;
        wire::write_value(w, out, &S_USER_TEXT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_USER_FILE_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_USER_FILE_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_USER_FILE_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `userFilePartId` over the binary wire.
#[napi(js_name = "userFilePartIdWire")]
pub fn user_file_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_USER_FILE_PART_ID_0)?;
        let index: Value = wire::read_value(r, &S_USER_FILE_PART_ID_1)?;
        let out = &port::user_file_part_id(message_id, index)?;
        wire::write_value(w, out, &S_USER_FILE_PART_ID_OUT)?;
        Ok(())
    })
}

static S_USER_AGENT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_USER_AGENT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_USER_AGENT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `userAgentPartId` over the binary wire.
#[napi(js_name = "userAgentPartIdWire")]
pub fn user_agent_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_USER_AGENT_PART_ID_0)?;
        let index: Value = wire::read_value(r, &S_USER_AGENT_PART_ID_1)?;
        let out = &port::user_agent_part_id(message_id, index)?;
        wire::write_value(w, out, &S_USER_AGENT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_TOOL_ATTACHMENT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_TOOL_ATTACHMENT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_TOOL_ATTACHMENT_PART_ID_2: wire::Schema = wire::Schema::Dyn;
static S_TOOL_ATTACHMENT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `toolAttachmentPartId` over the binary wire.
#[napi(js_name = "toolAttachmentPartIdWire")]
pub fn tool_attachment_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_TOOL_ATTACHMENT_PART_ID_0)?;
        let call_id: Value = wire::read_value(r, &S_TOOL_ATTACHMENT_PART_ID_1)?;
        let index: Value = wire::read_value(r, &S_TOOL_ATTACHMENT_PART_ID_2)?;
        let out = &port::tool_attachment_part_id(message_id, call_id, index)?;
        wire::write_value(w, out, &S_TOOL_ATTACHMENT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_COMPACTION_SUMMARY_MESSAGE_ID_0: wire::Schema = wire::Schema::Dyn;
static S_COMPACTION_SUMMARY_MESSAGE_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `compactionSummaryMessageId` over the binary wire.
#[napi(js_name = "compactionSummaryMessageIdWire")]
pub fn compaction_summary_message_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_COMPACTION_SUMMARY_MESSAGE_ID_0)?;
        let out = &port::compaction_summary_message_id(message_id)?;
        wire::write_value(w, out, &S_COMPACTION_SUMMARY_MESSAGE_ID_OUT)?;
        Ok(())
    })
}

static S_ASSISTANT_CONTENT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_ID_2: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Str16);

/// `assistantContentPartId` over the binary wire.
#[napi(js_name = "assistantContentPartIdWire")]
pub fn assistant_content_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_ID_0)?;
        let item: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_ID_1)?;
        let ordinal: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_ID_2)?;
        let out = &port::assistant_content_part_id(message_id, item, ordinal)?;
        wire::write_value(w, out, &S_ASSISTANT_CONTENT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_ASSISTANT_CONTENT_PART_IDS_0: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_IDS_1: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_IDS_2: wire::Schema = wire::Schema::Dyn;
static S_ASSISTANT_CONTENT_PART_IDS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::OptJs(&wire::Schema::Str16));

/// `assistantContentPartIds` over the binary wire.
#[napi(js_name = "assistantContentPartIdsWire")]
pub fn assistant_content_part_ids_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_IDS_0)?;
        let content: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_IDS_1)?;
        let metadata: Value = wire::read_value(r, &S_ASSISTANT_CONTENT_PART_IDS_2)?;
        let out = &port::assistant_content_part_ids(message_id, content, metadata)?;
        wire::write_value(w, out, &S_ASSISTANT_CONTENT_PART_IDS_OUT)?;
        Ok(())
    })
}

static S_READ_DEVRYAN_PART_DESCRIPTORS_0: wire::Schema = wire::Schema::Dyn;
static S_READ_DEVRYAN_PART_DESCRIPTORS_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn));

/// `readDevryanPartDescriptors` over the binary wire.
#[napi(js_name = "readDevryanPartDescriptorsWire")]
pub fn read_devryan_part_descriptors_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_READ_DEVRYAN_PART_DESCRIPTORS_0)?;
        let out = &port::read_devryan_part_descriptors(metadata)?;
        wire::write_value(w, out, &S_READ_DEVRYAN_PART_DESCRIPTORS_OUT)?;
        Ok(())
    })
}

static S_USER_TEXT_SEGMENTS_0: wire::Schema = wire::Schema::Dyn;
static S_USER_TEXT_SEGMENTS_1: wire::Schema = wire::Schema::Dyn;
static S_USER_TEXT_SEGMENTS_2: wire::Schema = wire::Schema::Dyn;
static S_USER_TEXT_SEGMENTS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `userTextSegments` over the binary wire.
#[napi(js_name = "userTextSegmentsWire")]
pub fn user_text_segments_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_USER_TEXT_SEGMENTS_0)?;
        let text_value: Value = wire::read_value(r, &S_USER_TEXT_SEGMENTS_1)?;
        let metadata: Value = wire::read_value(r, &S_USER_TEXT_SEGMENTS_2)?;
        let out = &port::user_text_segments(message_id, text_value, metadata)?;
        wire::write_value(w, out, &S_USER_TEXT_SEGMENTS_OUT)?;
        Ok(())
    })
}

static S_USER_SEGMENT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_USER_SEGMENT_PART_ID_1: wire::Schema = wire::Schema::Dyn;
static S_USER_SEGMENT_PART_ID_2: wire::Schema = wire::Schema::Dyn;
static S_USER_SEGMENT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `userSegmentPartId` over the binary wire.
#[napi(js_name = "userSegmentPartIdWire")]
pub fn user_segment_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_USER_SEGMENT_PART_ID_0)?;
        let metadata: Value = wire::read_value(r, &S_USER_SEGMENT_PART_ID_1)?;
        let index: Value = wire::read_value(r, &S_USER_SEGMENT_PART_ID_2)?;
        let out = &port::user_segment_part_id(message_id, metadata, index)?;
        wire::write_value(w, out, &S_USER_SEGMENT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_CLAMP_INCREASING_TIME_0: wire::Schema = wire::Schema::Dyn;
static S_CLAMP_INCREASING_TIME_1: wire::Schema = wire::Schema::Dyn;
static S_CLAMP_INCREASING_TIME_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Num);

/// `clampIncreasingTime` over the binary wire.
#[napi(js_name = "clampIncreasingTimeWire")]
pub fn clamp_increasing_time_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let created: Value = wire::read_value(r, &S_CLAMP_INCREASING_TIME_0)?;
        let previous: Value = wire::read_value(r, &S_CLAMP_INCREASING_TIME_1)?;
        let out = &port::clamp_increasing_time(created, previous)?;
        wire::write_value(w, out, &S_CLAMP_INCREASING_TIME_OUT)?;
        Ok(())
    })
}

static S_CLAMP_INCREASING_TIMES_0: wire::Schema = wire::Schema::Dyn;
static S_CLAMP_INCREASING_TIMES_1: wire::Schema = wire::Schema::Dyn;
static S_CLAMP_INCREASING_TIMES_OUT: wire::Schema = wire::Schema::List(&wire::Schema::OptJs(&wire::Schema::Num));

/// `clampIncreasingTimes` over the binary wire.
#[napi(js_name = "clampIncreasingTimesWire")]
pub fn clamp_increasing_times_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let times: Value = wire::read_value(r, &S_CLAMP_INCREASING_TIMES_0)?;
        let previous: Value = wire::read_value(r, &S_CLAMP_INCREASING_TIMES_1)?;
        let out = &port::clamp_increasing_times(times, previous)?;
        wire::write_value(w, out, &S_CLAMP_INCREASING_TIMES_OUT)?;
        Ok(())
    })
}

static S_IS_CURSOR_ASSISTANT_0: wire::Schema = wire::Schema::Dyn;
static S_IS_CURSOR_ASSISTANT_OUT: wire::Schema = wire::Schema::Dyn;

/// `isCursorAssistant` over the binary wire.
#[napi(js_name = "isCursorAssistantWire")]
pub fn is_cursor_assistant_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Value = wire::read_value(r, &S_IS_CURSOR_ASSISTANT_0)?;
        let out = &port::is_cursor_assistant(message)?;
        wire::write_value(w, out, &S_IS_CURSOR_ASSISTANT_OUT)?;
        Ok(())
    })
}

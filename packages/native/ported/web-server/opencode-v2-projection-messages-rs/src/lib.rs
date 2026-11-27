//! JS bindings for `messages.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `compactionPartId`.
#[napi(js_name = "compactionPartId")]
pub fn compaction_part_id(message_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let out = port::compaction_part_id(message_id)?;
        crate::js::to_json(&out)
    })
}

/// `compactionSummaryTextPartId`.
#[napi(js_name = "compactionSummaryTextPartId")]
pub fn compaction_summary_text_part_id(message_id: String) -> napi::Result<String> {
    run(move || {
        let message_id = crate::js::from_json(&message_id)?;
        let out = port::compaction_summary_text_part_id(message_id)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Tokens`.
#[napi(js_name = "toV1Tokens")]
pub fn to_v1_tokens(tokens: String) -> napi::Result<String> {
    run(move || {
        let tokens = crate::js::from_json(&tokens)?;
        let out = port::to_v1_tokens(tokens)?;
        crate::js::to_json(&out)
    })
}

/// `toV1PathInfo`.
#[napi(js_name = "toV1PathInfo")]
pub fn to_v1_path_info(directory: String, subpath: String) -> napi::Result<String> {
    run(move || {
        let directory = crate::js::from_json(&directory)?;
        let subpath = crate::js::from_json(&subpath)?;
        let out = port::to_v1_path_info(directory, subpath)?;
        crate::js::to_json(&out)
    })
}

/// `readDevryanPromptSelection`.
#[napi(js_name = "readDevryanPromptSelection")]
pub fn read_devryan_prompt_selection(metadata: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::read_devryan_prompt_selection(metadata)?;
        crate::js::to_json(&out)
    })
}

/// `toV1UserMetadata`.
#[napi(js_name = "toV1UserMetadata")]
pub fn to_v1_user_metadata(metadata: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::to_v1_user_metadata(metadata)?;
        crate::js::to_json(&out)
    })
}

/// `toV1UserParts`.
#[napi(js_name = "toV1UserParts")]
pub fn to_v1_user_parts(message: String, session_id: String) -> napi::Result<String> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let session_id = crate::js::from_json(&session_id)?;
        let out = port::to_v1_user_parts(message, session_id)?;
        crate::js::to_json(&out)
    })
}

/// `buildUserIndex`.
#[napi(js_name = "buildUserIndex")]
pub fn build_user_index(messages: String) -> napi::Result<String> {
    run(move || {
        let messages = crate::js::from_json(&messages)?;
        let out = port::build_user_index(messages)?;
        crate::js::to_json(&out)
    })
}

/// `addUserIndexEntry`.
#[napi(js_name = "addUserIndexEntry")]
pub fn add_user_index_entry(index: String, entry: String) -> napi::Result<String> {
    run(move || {
        let index = crate::js::from_json(&index)?;
        let entry = crate::js::from_json(&entry)?;
        let out = port::add_user_index_entry(index, entry)?;
        crate::js::to_json(&out)
    })
}

/// `findIndexedParentID`.
#[napi(js_name = "findIndexedParentID")]
pub fn find_indexed_parent_id(index: String, created_at: String) -> napi::Result<String> {
    run(move || {
        let index = crate::js::from_json(&index)?;
        let created_at = crate::js::from_json(&created_at)?;
        let out = port::find_indexed_parent_id(index, created_at)?;
        crate::js::to_json(&out)
    })
}

/// `encodeMessageCursor`.
#[napi(js_name = "encodeMessageCursor")]
pub fn encode_message_cursor(cursor: String) -> napi::Result<String> {
    run(move || {
        let cursor = crate::js::from_json(&cursor)?;
        let out = port::encode_message_cursor(cursor)?;
        crate::js::to_json(&out)
    })
}

/// `decodeMessageCursor`.
#[napi(js_name = "decodeMessageCursor")]
pub fn decode_message_cursor(before: String) -> napi::Result<String> {
    run(move || {
        let before = crate::js::from_json(&before)?;
        let out = port::decode_message_cursor(before)?;
        crate::js::to_json(&out)
    })
}

/// `isDroppedMessageType`.
#[napi(js_name = "isDroppedMessageType")]
pub fn is_dropped_message_type(message: String) -> napi::Result<String> {
    run(move || {
        let message = crate::js::from_json(&message)?;
        let out = port::is_dropped_message_type(message)?;
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

static S_COMPACTION_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_COMPACTION_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `compactionPartId` over the binary wire.
#[napi(js_name = "compactionPartIdWire")]
pub fn compaction_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_COMPACTION_PART_ID_0)?;
        let out = &port::compaction_part_id(message_id)?;
        wire::write_value(w, out, &S_COMPACTION_PART_ID_OUT)?;
        Ok(())
    })
}

static S_COMPACTION_SUMMARY_TEXT_PART_ID_0: wire::Schema = wire::Schema::Dyn;
static S_COMPACTION_SUMMARY_TEXT_PART_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `compactionSummaryTextPartId` over the binary wire.
#[napi(js_name = "compactionSummaryTextPartIdWire")]
pub fn compaction_summary_text_part_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message_id: Value = wire::read_value(r, &S_COMPACTION_SUMMARY_TEXT_PART_ID_0)?;
        let out = &port::compaction_summary_text_part_id(message_id)?;
        wire::write_value(w, out, &S_COMPACTION_SUMMARY_TEXT_PART_ID_OUT)?;
        Ok(())
    })
}

static S_TO_V1_TOKENS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_TOKENS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Tokens` over the binary wire.
#[napi(js_name = "toV1TokensWire")]
pub fn to_v1_tokens_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tokens: Value = wire::read_value(r, &S_TO_V1_TOKENS_0)?;
        let out = &port::to_v1_tokens(tokens)?;
        wire::write_value(w, out, &S_TO_V1_TOKENS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PATH_INFO_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PATH_INFO_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PATH_INFO_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1PathInfo` over the binary wire.
#[napi(js_name = "toV1PathInfoWire")]
pub fn to_v1_path_info_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let directory: Value = wire::read_value(r, &S_TO_V1_PATH_INFO_0)?;
        let subpath: Value = wire::read_value(r, &S_TO_V1_PATH_INFO_1)?;
        let out = &port::to_v1_path_info(directory, subpath)?;
        wire::write_value(w, out, &S_TO_V1_PATH_INFO_OUT)?;
        Ok(())
    })
}

static S_READ_DEVRYAN_PROMPT_SELECTION_0: wire::Schema = wire::Schema::Dyn;
static S_READ_DEVRYAN_PROMPT_SELECTION_OUT: wire::Schema = wire::Schema::Dyn;

/// `readDevryanPromptSelection` over the binary wire.
#[napi(js_name = "readDevryanPromptSelectionWire")]
pub fn read_devryan_prompt_selection_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_READ_DEVRYAN_PROMPT_SELECTION_0)?;
        let out = &port::read_devryan_prompt_selection(metadata)?;
        wire::write_value(w, out, &S_READ_DEVRYAN_PROMPT_SELECTION_OUT)?;
        Ok(())
    })
}

static S_TO_V1_USER_METADATA_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_USER_METADATA_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1UserMetadata` over the binary wire.
#[napi(js_name = "toV1UserMetadataWire")]
pub fn to_v1_user_metadata_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_TO_V1_USER_METADATA_0)?;
        let out = &port::to_v1_user_metadata(metadata)?;
        wire::write_value(w, out, &S_TO_V1_USER_METADATA_OUT)?;
        Ok(())
    })
}

static S_TO_V1_USER_PARTS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_USER_PARTS_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_USER_PARTS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1UserParts` over the binary wire.
#[napi(js_name = "toV1UserPartsWire")]
pub fn to_v1_user_parts_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Value = wire::read_value(r, &S_TO_V1_USER_PARTS_0)?;
        let session_id: Value = wire::read_value(r, &S_TO_V1_USER_PARTS_1)?;
        let out = &port::to_v1_user_parts(message, session_id)?;
        wire::write_value(w, out, &S_TO_V1_USER_PARTS_OUT)?;
        Ok(())
    })
}

static S_BUILD_USER_INDEX_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_USER_INDEX_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildUserIndex` over the binary wire.
#[napi(js_name = "buildUserIndexWire")]
pub fn build_user_index_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let messages: Value = wire::read_value(r, &S_BUILD_USER_INDEX_0)?;
        let out = &port::build_user_index(messages)?;
        wire::write_value(w, out, &S_BUILD_USER_INDEX_OUT)?;
        Ok(())
    })
}

static S_ADD_USER_INDEX_ENTRY_0: wire::Schema = wire::Schema::Dyn;
static S_ADD_USER_INDEX_ENTRY_1: wire::Schema = wire::Schema::Dyn;
static S_ADD_USER_INDEX_ENTRY_OUT: wire::Schema = wire::Schema::Dyn;

/// `addUserIndexEntry` over the binary wire.
#[napi(js_name = "addUserIndexEntryWire")]
pub fn add_user_index_entry_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let index: Value = wire::read_value(r, &S_ADD_USER_INDEX_ENTRY_0)?;
        let entry: Value = wire::read_value(r, &S_ADD_USER_INDEX_ENTRY_1)?;
        let out = &port::add_user_index_entry(index, entry)?;
        wire::write_value(w, out, &S_ADD_USER_INDEX_ENTRY_OUT)?;
        Ok(())
    })
}

static S_FIND_INDEXED_PARENT_ID_0: wire::Schema = wire::Schema::Dyn;
static S_FIND_INDEXED_PARENT_ID_1: wire::Schema = wire::Schema::Dyn;
static S_FIND_INDEXED_PARENT_ID_OUT: wire::Schema = wire::Schema::Dyn;

/// `findIndexedParentID` over the binary wire.
#[napi(js_name = "findIndexedParentIDWire")]
pub fn find_indexed_parent_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let index: Value = wire::read_value(r, &S_FIND_INDEXED_PARENT_ID_0)?;
        let created_at: Value = wire::read_value(r, &S_FIND_INDEXED_PARENT_ID_1)?;
        let out = &port::find_indexed_parent_id(index, created_at)?;
        wire::write_value(w, out, &S_FIND_INDEXED_PARENT_ID_OUT)?;
        Ok(())
    })
}

static S_ENCODE_MESSAGE_CURSOR_0: wire::Schema = wire::Schema::Dyn;
static S_ENCODE_MESSAGE_CURSOR_OUT: wire::Schema = wire::Schema::Dyn;

/// `encodeMessageCursor` over the binary wire.
#[napi(js_name = "encodeMessageCursorWire")]
pub fn encode_message_cursor_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let cursor: Value = wire::read_value(r, &S_ENCODE_MESSAGE_CURSOR_0)?;
        let out = &port::encode_message_cursor(cursor)?;
        wire::write_value(w, out, &S_ENCODE_MESSAGE_CURSOR_OUT)?;
        Ok(())
    })
}

static S_DECODE_MESSAGE_CURSOR_0: wire::Schema = wire::Schema::Dyn;
static S_DECODE_MESSAGE_CURSOR_OUT: wire::Schema = wire::Schema::Dyn;

/// `decodeMessageCursor` over the binary wire.
#[napi(js_name = "decodeMessageCursorWire")]
pub fn decode_message_cursor_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let before: Value = wire::read_value(r, &S_DECODE_MESSAGE_CURSOR_0)?;
        let out = &port::decode_message_cursor(before)?;
        wire::write_value(w, out, &S_DECODE_MESSAGE_CURSOR_OUT)?;
        Ok(())
    })
}

static S_IS_DROPPED_MESSAGE_TYPE_0: wire::Schema = wire::Schema::Dyn;
static S_IS_DROPPED_MESSAGE_TYPE_OUT: wire::Schema = wire::Schema::Dyn;

/// `isDroppedMessageType` over the binary wire.
#[napi(js_name = "isDroppedMessageTypeWire")]
pub fn is_dropped_message_type_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let message: Value = wire::read_value(r, &S_IS_DROPPED_MESSAGE_TYPE_0)?;
        let out = &port::is_dropped_message_type(message)?;
        wire::write_value(w, out, &S_IS_DROPPED_MESSAGE_TYPE_OUT)?;
        Ok(())
    })
}

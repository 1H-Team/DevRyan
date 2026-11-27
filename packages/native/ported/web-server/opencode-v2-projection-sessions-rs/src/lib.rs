//! JS bindings for `sessions.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `readOwnedDevryanEntry`.
#[napi(js_name = "readOwnedDevryanEntry")]
pub fn read_owned_devryan_entry(metadata: String, key: String, session_id: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let key = crate::js::from_json(&key)?;
        let session_id = crate::js::from_json(&session_id)?;
        let out = port::read_owned_devryan_entry(metadata, key, session_id)?;
        crate::js::to_json(&out)
    })
}

/// `readArchiveOverride`.
#[napi(js_name = "readArchiveOverride")]
pub fn read_archive_override(metadata: String, session_id: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let session_id = crate::js::from_json(&session_id)?;
        let out = port::read_archive_override(metadata, session_id)?;
        crate::js::to_json(&out)
    })
}

/// `isArchiveOverrideArchived`.
#[napi(js_name = "isArchiveOverrideArchived")]
pub fn is_archive_override_archived(r#override: String) -> napi::Result<String> {
    run(move || {
        let r#override = crate::js::from_json(&r#override)?;
        let out = port::is_archive_override_archived(r#override)?;
        crate::js::to_json(&out)
    })
}

/// `readSessionTodo`.
#[napi(js_name = "readSessionTodo")]
pub fn read_session_todo(metadata: String, session_id: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let session_id = crate::js::from_json(&session_id)?;
        let out = port::read_session_todo(metadata, session_id)?;
        crate::js::to_json(&out)
    })
}

/// `toV1SessionTodos`.
#[napi(js_name = "toV1SessionTodos")]
pub fn to_v1_session_todos(session: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::to_v1_session_todos(session)?;
        crate::js::to_json(&out)
    })
}

/// `stripDevryanMetadata`.
#[napi(js_name = "stripDevryanMetadata")]
pub fn strip_devryan_metadata(metadata: String) -> napi::Result<String> {
    run(move || {
        let metadata = crate::js::from_json(&metadata)?;
        let out = port::strip_devryan_metadata(metadata)?;
        crate::js::to_json(&out)
    })
}

/// `toV1PermissionRuleset`.
#[napi(js_name = "toV1PermissionRuleset")]
pub fn to_v1_permission_ruleset(rules: String) -> napi::Result<String> {
    run(move || {
        let rules = crate::js::from_json(&rules)?;
        let out = port::to_v1_permission_ruleset(rules)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Revert`.
#[napi(js_name = "toV1Revert")]
pub fn to_v1_revert(revert: String) -> napi::Result<String> {
    run(move || {
        let revert = crate::js::from_json(&revert)?;
        let out = port::to_v1_revert(revert)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Fork`.
#[napi(js_name = "toV1Fork")]
pub fn to_v1_fork(fork: String) -> napi::Result<String> {
    run(move || {
        let fork = crate::js::from_json(&fork)?;
        let out = port::to_v1_fork(fork)?;
        crate::js::to_json(&out)
    })
}

/// `sessionDirectory`.
#[napi(js_name = "sessionDirectory")]
pub fn session_directory(session: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::session_directory(session)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Session`.
#[napi(js_name = "toV1Session")]
pub fn to_v1_session(info: String, options: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let options = crate::js::from_json(&options)?;
        let out = port::to_v1_session(info, options)?;
        crate::js::to_json(&out)
    })
}

/// `toV1SessionFromCreated`.
#[napi(js_name = "toV1SessionFromCreated")]
pub fn to_v1_session_from_created(data: String, created: String) -> napi::Result<String> {
    run(move || {
        let data = crate::js::from_json(&data)?;
        let created = crate::js::from_json(&created)?;
        let out = port::to_v1_session_from_created(data, created)?;
        crate::js::to_json(&out)
    })
}

/// `isV1SessionArchived`.
#[napi(js_name = "isV1SessionArchived")]
pub fn is_v1_session_archived(session: String) -> napi::Result<String> {
    run(move || {
        let session = crate::js::from_json(&session)?;
        let out = port::is_v1_session_archived(session)?;
        crate::js::to_json(&out)
    })
}

/// `sessionMessageContext`.
#[napi(js_name = "sessionMessageContext")]
pub fn session_message_context(info: String) -> napi::Result<String> {
    run(move || {
        let info = crate::js::from_json(&info)?;
        let out = port::session_message_context(info)?;
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

static S_READ_OWNED_DEVRYAN_ENTRY_0: wire::Schema = wire::Schema::Dyn;
static S_READ_OWNED_DEVRYAN_ENTRY_1: wire::Schema = wire::Schema::Dyn;
static S_READ_OWNED_DEVRYAN_ENTRY_2: wire::Schema = wire::Schema::Dyn;
static S_READ_OWNED_DEVRYAN_ENTRY_OUT: wire::Schema = wire::Schema::Dyn;

/// `readOwnedDevryanEntry` over the binary wire.
#[napi(js_name = "readOwnedDevryanEntryWire")]
pub fn read_owned_devryan_entry_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_READ_OWNED_DEVRYAN_ENTRY_0)?;
        let key: Value = wire::read_value(r, &S_READ_OWNED_DEVRYAN_ENTRY_1)?;
        let session_id: Value = wire::read_value(r, &S_READ_OWNED_DEVRYAN_ENTRY_2)?;
        let out = &port::read_owned_devryan_entry(metadata, key, session_id)?;
        wire::write_value(w, out, &S_READ_OWNED_DEVRYAN_ENTRY_OUT)?;
        Ok(())
    })
}

static S_READ_ARCHIVE_OVERRIDE_0: wire::Schema = wire::Schema::Dyn;
static S_READ_ARCHIVE_OVERRIDE_1: wire::Schema = wire::Schema::Dyn;
static S_READ_ARCHIVE_OVERRIDE_OUT: wire::Schema = wire::Schema::Dyn;

/// `readArchiveOverride` over the binary wire.
#[napi(js_name = "readArchiveOverrideWire")]
pub fn read_archive_override_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_READ_ARCHIVE_OVERRIDE_0)?;
        let session_id: Value = wire::read_value(r, &S_READ_ARCHIVE_OVERRIDE_1)?;
        let out = &port::read_archive_override(metadata, session_id)?;
        wire::write_value(w, out, &S_READ_ARCHIVE_OVERRIDE_OUT)?;
        Ok(())
    })
}

static S_IS_ARCHIVE_OVERRIDE_ARCHIVED_0: wire::Schema = wire::Schema::Dyn;
static S_IS_ARCHIVE_OVERRIDE_ARCHIVED_OUT: wire::Schema = wire::Schema::Dyn;

/// `isArchiveOverrideArchived` over the binary wire.
#[napi(js_name = "isArchiveOverrideArchivedWire")]
pub fn is_archive_override_archived_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let r#override: Value = wire::read_value(r, &S_IS_ARCHIVE_OVERRIDE_ARCHIVED_0)?;
        let out = &port::is_archive_override_archived(r#override)?;
        wire::write_value(w, out, &S_IS_ARCHIVE_OVERRIDE_ARCHIVED_OUT)?;
        Ok(())
    })
}

static S_READ_SESSION_TODO_0: wire::Schema = wire::Schema::Dyn;
static S_READ_SESSION_TODO_1: wire::Schema = wire::Schema::Dyn;
static S_READ_SESSION_TODO_OUT: wire::Schema = wire::Schema::Dyn;

/// `readSessionTodo` over the binary wire.
#[napi(js_name = "readSessionTodoWire")]
pub fn read_session_todo_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_READ_SESSION_TODO_0)?;
        let session_id: Value = wire::read_value(r, &S_READ_SESSION_TODO_1)?;
        let out = &port::read_session_todo(metadata, session_id)?;
        wire::write_value(w, out, &S_READ_SESSION_TODO_OUT)?;
        Ok(())
    })
}

static S_TO_V1_SESSION_TODOS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SESSION_TODOS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1SessionTodos` over the binary wire.
#[napi(js_name = "toV1SessionTodosWire")]
pub fn to_v1_session_todos_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Value = wire::read_value(r, &S_TO_V1_SESSION_TODOS_0)?;
        let out = &port::to_v1_session_todos(session)?;
        wire::write_value(w, out, &S_TO_V1_SESSION_TODOS_OUT)?;
        Ok(())
    })
}

static S_STRIP_DEVRYAN_METADATA_0: wire::Schema = wire::Schema::Dyn;
static S_STRIP_DEVRYAN_METADATA_OUT: wire::Schema = wire::Schema::Dyn;

/// `stripDevryanMetadata` over the binary wire.
#[napi(js_name = "stripDevryanMetadataWire")]
pub fn strip_devryan_metadata_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let metadata: Value = wire::read_value(r, &S_STRIP_DEVRYAN_METADATA_0)?;
        let out = &port::strip_devryan_metadata(metadata)?;
        wire::write_value(w, out, &S_STRIP_DEVRYAN_METADATA_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PERMISSION_RULESET_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PERMISSION_RULESET_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1PermissionRuleset` over the binary wire.
#[napi(js_name = "toV1PermissionRulesetWire")]
pub fn to_v1_permission_ruleset_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let rules: Value = wire::read_value(r, &S_TO_V1_PERMISSION_RULESET_0)?;
        let out = &port::to_v1_permission_ruleset(rules)?;
        wire::write_value(w, out, &S_TO_V1_PERMISSION_RULESET_OUT)?;
        Ok(())
    })
}

static S_TO_V1_REVERT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_REVERT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Revert` over the binary wire.
#[napi(js_name = "toV1RevertWire")]
pub fn to_v1_revert_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let revert: Value = wire::read_value(r, &S_TO_V1_REVERT_0)?;
        let out = &port::to_v1_revert(revert)?;
        wire::write_value(w, out, &S_TO_V1_REVERT_OUT)?;
        Ok(())
    })
}

static S_TO_V1_FORK_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_FORK_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Fork` over the binary wire.
#[napi(js_name = "toV1ForkWire")]
pub fn to_v1_fork_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let fork: Value = wire::read_value(r, &S_TO_V1_FORK_0)?;
        let out = &port::to_v1_fork(fork)?;
        wire::write_value(w, out, &S_TO_V1_FORK_OUT)?;
        Ok(())
    })
}

static S_SESSION_DIRECTORY_0: wire::Schema = wire::Schema::Dyn;
static S_SESSION_DIRECTORY_OUT: wire::Schema = wire::Schema::Dyn;

/// `sessionDirectory` over the binary wire.
#[napi(js_name = "sessionDirectoryWire")]
pub fn session_directory_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Value = wire::read_value(r, &S_SESSION_DIRECTORY_0)?;
        let out = &port::session_directory(session)?;
        wire::write_value(w, out, &S_SESSION_DIRECTORY_OUT)?;
        Ok(())
    })
}

static S_TO_V1_SESSION_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SESSION_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SESSION_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Session` over the binary wire.
#[napi(js_name = "toV1SessionWire")]
pub fn to_v1_session_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_TO_V1_SESSION_0)?;
        let options: Value = wire::read_value(r, &S_TO_V1_SESSION_1)?;
        let out = &port::to_v1_session(info, options)?;
        wire::write_value(w, out, &S_TO_V1_SESSION_OUT)?;
        Ok(())
    })
}

static S_TO_V1_SESSION_FROM_CREATED_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SESSION_FROM_CREATED_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SESSION_FROM_CREATED_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1SessionFromCreated` over the binary wire.
#[napi(js_name = "toV1SessionFromCreatedWire")]
pub fn to_v1_session_from_created_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let data: Value = wire::read_value(r, &S_TO_V1_SESSION_FROM_CREATED_0)?;
        let created: Value = wire::read_value(r, &S_TO_V1_SESSION_FROM_CREATED_1)?;
        let out = &port::to_v1_session_from_created(data, created)?;
        wire::write_value(w, out, &S_TO_V1_SESSION_FROM_CREATED_OUT)?;
        Ok(())
    })
}

static S_IS_V1_SESSION_ARCHIVED_0: wire::Schema = wire::Schema::Dyn;
static S_IS_V1_SESSION_ARCHIVED_OUT: wire::Schema = wire::Schema::Dyn;

/// `isV1SessionArchived` over the binary wire.
#[napi(js_name = "isV1SessionArchivedWire")]
pub fn is_v1_session_archived_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let session: Value = wire::read_value(r, &S_IS_V1_SESSION_ARCHIVED_0)?;
        let out = &port::is_v1_session_archived(session)?;
        wire::write_value(w, out, &S_IS_V1_SESSION_ARCHIVED_OUT)?;
        Ok(())
    })
}

static S_SESSION_MESSAGE_CONTEXT_0: wire::Schema = wire::Schema::Dyn;
static S_SESSION_MESSAGE_CONTEXT_OUT: wire::Schema = wire::Schema::Dyn;

/// `sessionMessageContext` over the binary wire.
#[napi(js_name = "sessionMessageContextWire")]
pub fn session_message_context_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let info: Value = wire::read_value(r, &S_SESSION_MESSAGE_CONTEXT_0)?;
        let out = &port::session_message_context(info)?;
        wire::write_value(w, out, &S_SESSION_MESSAGE_CONTEXT_OUT)?;
        Ok(())
    })
}

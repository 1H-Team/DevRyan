//! JS bindings for `session-worktree-contract.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `isWithinWorktreeRoot`.
#[napi(js_name = "isWithinWorktreeRoot")]
pub fn is_within_worktree_root(candidate: Option<String>, worktree_root: Option<String>) -> napi::Result<bool> {
    run(move || {
        let out = port::is_within_worktree_root(candidate, worktree_root)?;
        Ok(out)
    })
}

/// `getAttachedSessionDirectory`.
#[napi(js_name = "getAttachedSessionDirectory")]
pub fn get_attached_session_directory(attachment: String, fallback_directory: Option<String>) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let attachment = crate::js::from_json(&attachment)?;
        let out = port::get_attached_session_directory(attachment, fallback_directory)?;
        Ok(out.map_or(napi::bindgen_prelude::Either::B(()), napi::bindgen_prelude::Either::A))
    })
}

/// `buildAttachmentFromCanonicalization`.
#[napi(js_name = "buildAttachmentFromCanonicalization")]
pub fn build_attachment_from_canonicalization(canonical: String, options: String) -> napi::Result<String> {
    run(move || {
        let canonical = crate::js::from_json(&canonical)?;
        let options = crate::js::from_json(&options)?;
        let out = port::build_attachment_from_canonicalization(canonical, options)?;
        crate::js::to_json(&out)
    })
}

/// `resolveSessionWorktreeState`.
#[napi(js_name = "resolveSessionWorktreeState")]
pub fn resolve_session_worktree_state(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::resolve_session_worktree_state(input)?;
        crate::js::to_json(&out)
    })
}

/// `formatSessionWorktreeBadge`.
#[napi(js_name = "formatSessionWorktreeBadge")]
pub fn format_session_worktree_badge(attachment: String) -> napi::Result<String> {
    run(move || {
        let attachment = crate::js::from_json(&attachment)?;
        let out = port::format_session_worktree_badge(attachment)?;
        Ok(out)
    })
}

/// `getSessionWorktreeRepairActions`.
#[napi(js_name = "getSessionWorktreeRepairActions")]
pub fn get_session_worktree_repair_actions(attachment: String) -> napi::Result<Vec<String>> {
    run(move || {
        let attachment = crate::js::from_json(&attachment)?;
        let out = port::get_session_worktree_repair_actions(attachment)?;
        Ok(out)
    })
}

/// `getMutationBlockingReasons`.
#[napi(js_name = "getMutationBlockingReasons")]
pub fn get_mutation_blocking_reasons(attachment: String, git_status: String) -> napi::Result<String> {
    run(move || {
        let attachment = crate::js::from_json(&attachment)?;
        let git_status = crate::js::from_json(&git_status)?;
        let out = port::get_mutation_blocking_reasons(attachment, git_status)?;
        crate::js::to_json(&out)
    })
}

/// `buildSessionTargetOptions`.
#[napi(js_name = "buildSessionTargetOptions")]
pub fn build_session_target_options(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::build_session_target_options(input)?;
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

/// `isWithinWorktreeRoot` over the binary wire.
#[napi(js_name = "isWithinWorktreeRootWire")]
pub fn is_within_worktree_root_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let candidate: Option<String> = r.opt_js(|r| r.string16())?;
        let worktree_root: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::is_within_worktree_root(candidate, worktree_root)?;
        w.bool(*out);
        Ok(())
    })
}

/// `getAttachedSessionDirectory` over the binary wire.
#[napi(js_name = "getAttachedSessionDirectoryWire")]
pub fn get_attached_session_directory_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let attachment: Option<Value> = wire::read_dyn_opt(r)?;
        let fallback_directory: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::get_attached_session_directory(attachment, fallback_directory)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.string16(x0);
            }
            None => w.tag(2),
        }
        Ok(())
    })
}

static S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_1: wire::Schema = wire::Schema::Dyn;
static S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildAttachmentFromCanonicalization` over the binary wire.
#[napi(js_name = "buildAttachmentFromCanonicalizationWire")]
pub fn build_attachment_from_canonicalization_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let canonical: Value = wire::read_value(r, &S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_0)?;
        let options: Value = wire::read_value(r, &S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_1)?;
        let out = &port::build_attachment_from_canonicalization(canonical, options)?;
        wire::write_value(w, out, &S_BUILD_ATTACHMENT_FROM_CANONICALIZATION_OUT)?;
        Ok(())
    })
}

static S_RESOLVE_SESSION_WORKTREE_STATE_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_SESSION_WORKTREE_STATE_OUT: wire::Schema = wire::Schema::Dyn;

/// `resolveSessionWorktreeState` over the binary wire.
#[napi(js_name = "resolveSessionWorktreeStateWire")]
pub fn resolve_session_worktree_state_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: Value = wire::read_value(r, &S_RESOLVE_SESSION_WORKTREE_STATE_0)?;
        let out = &port::resolve_session_worktree_state(input)?;
        wire::write_value(w, out, &S_RESOLVE_SESSION_WORKTREE_STATE_OUT)?;
        Ok(())
    })
}

static S_FORMAT_SESSION_WORKTREE_BADGE_0: wire::Schema = wire::Schema::Dyn;

/// `formatSessionWorktreeBadge` over the binary wire.
#[napi(js_name = "formatSessionWorktreeBadgeWire")]
pub fn format_session_worktree_badge_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let attachment: Value = wire::read_value(r, &S_FORMAT_SESSION_WORKTREE_BADGE_0)?;
        let out = &port::format_session_worktree_badge(attachment)?;
        w.string16(out);
        Ok(())
    })
}

static S_GET_SESSION_WORKTREE_REPAIR_ACTIONS_0: wire::Schema = wire::Schema::Dyn;

/// `getSessionWorktreeRepairActions` over the binary wire.
#[napi(js_name = "getSessionWorktreeRepairActionsWire")]
pub fn get_session_worktree_repair_actions_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let attachment: Value = wire::read_value(r, &S_GET_SESSION_WORKTREE_REPAIR_ACTIONS_0)?;
        let out = &port::get_session_worktree_repair_actions(attachment)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.string16(x0);
        }
        Ok(())
    })
}

static S_GET_MUTATION_BLOCKING_REASONS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `getMutationBlockingReasons` over the binary wire.
#[napi(js_name = "getMutationBlockingReasonsWire")]
pub fn get_mutation_blocking_reasons_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let attachment: Option<Value> = wire::read_dyn_opt(r)?;
        let git_status: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::get_mutation_blocking_reasons(attachment, git_status)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_GET_MUTATION_BLOCKING_REASONS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_BUILD_SESSION_TARGET_OPTIONS_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_SESSION_TARGET_OPTIONS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("value", wire::Schema::Str16),
    ("label", wire::Schema::Str16),
    ("kind", wire::Schema::Str16),
    ("pending", wire::Schema::OptJs(&wire::Schema::Bool)),
]));

/// `buildSessionTargetOptions` over the binary wire.
#[napi(js_name = "buildSessionTargetOptionsWire")]
pub fn build_session_target_options_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: Value = wire::read_value(r, &S_BUILD_SESSION_TARGET_OPTIONS_0)?;
        let out = &port::build_session_target_options(input)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_BUILD_SESSION_TARGET_OPTIONS_OUT.inner())?;
        }
        Ok(())
    })
}

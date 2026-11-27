//! JS bindings for `native-claude-lifecycle.js`: generated from the signatures in `port.rs` by rust-anything.
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

/// `sameClaudeEnrollment`.
#[napi(js_name = "sameClaudeEnrollment")]
pub fn same_claude_enrollment(left: String, right: String) -> napi::Result<String> {
    run(move || {
        let left = crate::js::from_json(&left)?;
        let right = crate::js::from_json(&right)?;
        let out = port::same_claude_enrollment(left, right)?;
        crate::js::to_json(&out)
    })
}

/// `emptyClaudeLifecycle`.
#[napi(js_name = "emptyClaudeLifecycle")]
pub fn empty_claude_lifecycle() -> napi::Result<String> {
    run(move || {
        let out = port::empty_claude_lifecycle()?;
        crate::js::to_json(&out)
    })
}

/// `assertClaudeEnrollmentCapacity`.
#[napi(js_name = "assertClaudeEnrollmentCapacity")]
pub fn assert_claude_enrollment_capacity(value: String, selected: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let selected = crate::js::from_json(&selected)?;
        let out = port::assert_claude_enrollment_capacity(value, selected)?;
        crate::js::to_json(&out)
    })
}

/// `parseClaudeLifecycle`.
#[napi(js_name = "parseClaudeLifecycle")]
pub fn parse_claude_lifecycle(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::parse_claude_lifecycle(value)?;
        crate::js::to_json(&out)
    })
}

/// `parseClaudeLifecycleOperation`.
#[napi(js_name = "parseClaudeLifecycleOperation")]
pub fn parse_claude_lifecycle_operation(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::parse_claude_lifecycle_operation(value)?;
        crate::js::to_json(&out)
    })
}

/// `transitionClaudeLifecycle`.
#[napi(js_name = "transitionClaudeLifecycle")]
pub fn transition_claude_lifecycle(value: String, expected_revision: String, operation: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let expected_revision = crate::js::from_json(&expected_revision)?;
        let operation = crate::js::from_json(&operation)?;
        let out = port::transition_claude_lifecycle(value, expected_revision, operation)?;
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

static S_SAME_CLAUDE_ENROLLMENT_0: wire::Schema = wire::Schema::Dyn;
static S_SAME_CLAUDE_ENROLLMENT_1: wire::Schema = wire::Schema::Dyn;
static S_SAME_CLAUDE_ENROLLMENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `sameClaudeEnrollment` over the binary wire.
#[napi(js_name = "sameClaudeEnrollmentWire")]
pub fn same_claude_enrollment_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let left: Value = wire::read_value(r, &S_SAME_CLAUDE_ENROLLMENT_0)?;
        let right: Value = wire::read_value(r, &S_SAME_CLAUDE_ENROLLMENT_1)?;
        let out = &port::same_claude_enrollment(left, right)?;
        wire::write_value(w, out, &S_SAME_CLAUDE_ENROLLMENT_OUT)?;
        Ok(())
    })
}

static S_EMPTY_CLAUDE_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `emptyClaudeLifecycle` over the binary wire.
#[napi(js_name = "emptyClaudeLifecycleWire")]
pub fn empty_claude_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::empty_claude_lifecycle()?;
        wire::write_value(w, out, &S_EMPTY_CLAUDE_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_0: wire::Schema = wire::Schema::Dyn;
static S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_1: wire::Schema = wire::Schema::Dyn;
static S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_OUT: wire::Schema = wire::Schema::Dyn;

/// `assertClaudeEnrollmentCapacity` over the binary wire.
#[napi(js_name = "assertClaudeEnrollmentCapacityWire")]
pub fn assert_claude_enrollment_capacity_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_0)?;
        let selected: Value = wire::read_value(r, &S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_1)?;
        let out = &port::assert_claude_enrollment_capacity(value, selected)?;
        wire::write_value(w, out, &S_ASSERT_CLAUDE_ENROLLMENT_CAPACITY_OUT)?;
        Ok(())
    })
}

static S_PARSE_CLAUDE_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_CLAUDE_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseClaudeLifecycle` over the binary wire.
#[napi(js_name = "parseClaudeLifecycleWire")]
pub fn parse_claude_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_PARSE_CLAUDE_LIFECYCLE_0)?;
        let out = &port::parse_claude_lifecycle(value)?;
        wire::write_value(w, out, &S_PARSE_CLAUDE_LIFECYCLE_OUT)?;
        Ok(())
    })
}

static S_PARSE_CLAUDE_LIFECYCLE_OPERATION_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_CLAUDE_LIFECYCLE_OPERATION_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseClaudeLifecycleOperation` over the binary wire.
#[napi(js_name = "parseClaudeLifecycleOperationWire")]
pub fn parse_claude_lifecycle_operation_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_PARSE_CLAUDE_LIFECYCLE_OPERATION_0)?;
        let out = &port::parse_claude_lifecycle_operation(value)?;
        wire::write_value(w, out, &S_PARSE_CLAUDE_LIFECYCLE_OPERATION_OUT)?;
        Ok(())
    })
}

static S_TRANSITION_CLAUDE_LIFECYCLE_0: wire::Schema = wire::Schema::Dyn;
static S_TRANSITION_CLAUDE_LIFECYCLE_1: wire::Schema = wire::Schema::Dyn;
static S_TRANSITION_CLAUDE_LIFECYCLE_2: wire::Schema = wire::Schema::Dyn;
static S_TRANSITION_CLAUDE_LIFECYCLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `transitionClaudeLifecycle` over the binary wire.
#[napi(js_name = "transitionClaudeLifecycleWire")]
pub fn transition_claude_lifecycle_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_TRANSITION_CLAUDE_LIFECYCLE_0)?;
        let expected_revision: Value = wire::read_value(r, &S_TRANSITION_CLAUDE_LIFECYCLE_1)?;
        let operation: Value = wire::read_value(r, &S_TRANSITION_CLAUDE_LIFECYCLE_2)?;
        let out = &port::transition_claude_lifecycle(value, expected_revision, operation)?;
        wire::write_value(w, out, &S_TRANSITION_CLAUDE_LIFECYCLE_OUT)?;
        Ok(())
    })
}

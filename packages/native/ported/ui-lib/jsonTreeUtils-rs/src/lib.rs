//! JS bindings for `jsonTreeUtils.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `getNodePath`.
#[napi(js_name = "getNodePath")]
pub fn get_node_path(path_segments: Vec<String>) -> napi::Result<String> {
    run(move || {
        let out = port::get_node_path(path_segments)?;
        Ok(out)
    })
}

/// `parseJsonToTree`.
#[napi(js_name = "parseJsonToTree")]
pub fn parse_json_to_tree(text: String, options: String) -> napi::Result<String> {
    run(move || {
        let options = crate::js::from_json(&options)?;
        let out = port::parse_json_to_tree(text, options)?;
        crate::js::to_json(&out)
    })
}

/// `flattenTree`.
#[napi(js_name = "flattenTree")]
pub fn flatten_tree(root: String, collapsed_paths: String) -> napi::Result<String> {
    run(move || {
        let root = crate::js::from_json(&root)?;
        let collapsed_paths = crate::js::from_json(&collapsed_paths)?;
        let out = port::flatten_tree(root, collapsed_paths)?;
        crate::js::to_json(&out)
    })
}

/// `getAllExpandableIds`.
#[napi(js_name = "getAllExpandableIds")]
pub fn get_all_expandable_ids(root: String) -> napi::Result<String> {
    run(move || {
        let root = crate::js::from_json(&root)?;
        let out = port::get_all_expandable_ids(root)?;
        crate::js::to_json(&out)
    })
}

/// `getExpandableIdsAboveDepth`.
#[napi(js_name = "getExpandableIdsAboveDepth")]
pub fn get_expandable_ids_above_depth(root: String, max_depth: f64) -> napi::Result<String> {
    run(move || {
        let root = crate::js::from_json(&root)?;
        let out = port::get_expandable_ids_above_depth(root, max_depth)?;
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

/// `getNodePath` over the binary wire.
#[napi(js_name = "getNodePathWire")]
pub fn get_node_path_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let path_segments: Vec<String> = r.list(|r| r.string16())?;
        let out = &port::get_node_path(path_segments)?;
        w.string16(out);
        Ok(())
    })
}

static S_PARSE_JSON_TO_TREE_1: wire::Schema = wire::Schema::Dyn;
static S_PARSE_JSON_TO_TREE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("id", wire::Schema::Str16),
    ("key", wire::Schema::Str16),
    ("value", wire::Schema::Dyn),
    ("type", wire::Schema::Str16),
    ("depth", wire::Schema::Num),
    (
        "children",
        wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Obj(&[
            ("id", wire::Schema::Str16),
            ("key", wire::Schema::Str16),
            ("value", wire::Schema::Dyn),
            ("type", wire::Schema::Dyn),
            ("depth", wire::Schema::Num),
            ("children", wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn))),
            ("path", wire::Schema::List(&wire::Schema::Dyn)),
            ("isExpandable", wire::Schema::Bool),
            ("childCount", wire::Schema::OptJs(&wire::Schema::Num)),
        ]))),
    ),
    ("path", wire::Schema::List(&wire::Schema::Str16)),
    ("isExpandable", wire::Schema::Bool),
    ("childCount", wire::Schema::OptJs(&wire::Schema::Num)),
]));

/// `parseJsonToTree` over the binary wire.
#[napi(js_name = "parseJsonToTreeWire")]
pub fn parse_json_to_tree_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: String = r.string16()?;
        let options: Value = wire::read_value(r, &S_PARSE_JSON_TO_TREE_1)?;
        let out = &port::parse_json_to_tree(text, options)?;
        wire::write_value(w, out, &S_PARSE_JSON_TO_TREE_OUT)?;
        Ok(())
    })
}

static S_FLATTEN_TREE_0: wire::Schema = wire::Schema::Dyn;
static S_FLATTEN_TREE_1: wire::Schema = wire::Schema::Dyn;
static S_FLATTEN_TREE_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    (
        "node",
        wire::Schema::Obj(&[
            ("id", wire::Schema::Str16),
            ("key", wire::Schema::Str16),
            ("value", wire::Schema::Dyn),
            ("type", wire::Schema::Str16),
            ("depth", wire::Schema::Num),
            ("children", wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn))),
            ("path", wire::Schema::List(&wire::Schema::Str16)),
            ("isExpandable", wire::Schema::Bool),
            ("childCount", wire::Schema::OptJs(&wire::Schema::Num)),
        ]),
    ),
    ("isExpanded", wire::Schema::Bool),
]));

/// `flattenTree` over the binary wire.
#[napi(js_name = "flattenTreeWire")]
pub fn flatten_tree_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let root: Value = wire::read_value(r, &S_FLATTEN_TREE_0)?;
        let collapsed_paths: Value = wire::read_value(r, &S_FLATTEN_TREE_1)?;
        let out = &port::flatten_tree(root, collapsed_paths)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_FLATTEN_TREE_OUT.inner())?;
        }
        Ok(())
    })
}

static S_GET_ALL_EXPANDABLE_IDS_0: wire::Schema = wire::Schema::Dyn;
static S_GET_ALL_EXPANDABLE_IDS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Str16);

/// `getAllExpandableIds` over the binary wire.
#[napi(js_name = "getAllExpandableIdsWire")]
pub fn get_all_expandable_ids_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let root: Value = wire::read_value(r, &S_GET_ALL_EXPANDABLE_IDS_0)?;
        let out = &port::get_all_expandable_ids(root)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_GET_ALL_EXPANDABLE_IDS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_GET_EXPANDABLE_IDS_ABOVE_DEPTH_0: wire::Schema = wire::Schema::Dyn;
static S_GET_EXPANDABLE_IDS_ABOVE_DEPTH_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Str16);

/// `getExpandableIdsAboveDepth` over the binary wire.
#[napi(js_name = "getExpandableIdsAboveDepthWire")]
pub fn get_expandable_ids_above_depth_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let root: Value = wire::read_value(r, &S_GET_EXPANDABLE_IDS_ABOVE_DEPTH_0)?;
        let max_depth: f64 = r.f64()?;
        let out = &port::get_expandable_ids_above_depth(root, max_depth)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_GET_EXPANDABLE_IDS_ABOVE_DEPTH_OUT.inner())?;
        }
        Ok(())
    })
}

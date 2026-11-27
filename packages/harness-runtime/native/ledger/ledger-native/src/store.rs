//! The ledger's change store, `lib/session-changes-store.js` ported (plan
//! package L3b) on the job layer and the Git runner (`crate::git`), with
//! `commitTreeChanges` of `lib/session-changes-trees.js` (the direct tree
//! commit) beside it. Nothing in the product calls it yet.
//!
//! The same calls in the same order: the loose-ref read, `for-each-ref`
//! and `rev-parse --show-object-format` at open; whole listings with
//! `ls-tree -r -l -z` (cached, two per process, past `listingLimitBytes`
//! paged for the rest of the process); paged listings tree by tree through
//! the persistent reader, as `listDirectPrefix` and `listTreeRows` read them
//! (`DEVRYAN_LEDGER_DIRECT_LISTINGS`, read per use), or with `ls-tree`;
//! reads through the persistent object reader (`git::read_git_object`,
//! `DEVRYAN_LEDGER_PERSISTENT_READER` read at open) or with `cat-file`
//! processes; commits as direct trees (`DEVRYAN_LEDGER_DIRECT_TREES`, read
//! per use) or through Git's index (`read-tree`, `hash-object`,
//! `update-index`, `write-tree`; `DEVRYAN_LEDGER_PERSISTENT_INDEX`); every
//! ref move an `update-ref` compare-and-swap, a guard revoked after it
//! undone by a second `update-ref`; `syncObjects(cwd)` before every commit.
//! The process-wide blob cache (8 MiB, 4,096 values), listing cache (2)
//! and the set of oversized stores are thread-locals of the loop thread.
//!
//! Where it differs, on purpose: staged keys are sorted by code unit, where
//! the JavaScript calls `localeCompare` (decision D25: the host refuses the
//! native ledger when its own `localeCompare` disagrees on the key sample);
//! a `JSON.parse` failure is a `SyntaxError` with its own message; a custom
//! `gitRunner` is not taken (only an inline JavaScript ledger has one).
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use ledger_core::js::{JsObject, JsStr, Value, number_to_string};
use ledger_core::keys;
use ledger_core::tree::{TreeEntry, parse_tree, serialize_tree};

use crate::agen::{self, Abrupt, AsyncGen, Co};
use crate::ctx::{Ctx, type_error};
use crate::durability::sync_pending_object_directory;
use crate::git::{
    self, GitOptions, Input, change_error, from_core, git_tokens, json_parse,
    persistent_git_readers, read_git_object,
};
use crate::host;
use crate::js::{Promise, Resolution, async_fn};
use crate::node::fs::{self as nfs, Data, Flags, RmOptions, WriteOptions};
use crate::node::{code_of, odb};
use crate::value::{JsError, Obj, W, string_to_number, to_js_string};
use crate::{Ret, WPromise};

pub const STATE_REF: &str = "refs/devryan/state";
const LISTING_LIMIT_BYTES: f64 = 1024.0 * 1024.0;
const BLOB_MODE: &str = "100644";
const TREE_MODE: &str = "40000";

fn invalid() -> W {
    change_error("invalid_change_record", 409.0)
}

fn invalid_503() -> W {
    change_error("invalid_change_record", 503.0)
}

/// `changeKey(value)`: the SHA-256 of the string's UTF-8, hex.
pub fn change_key(value: &JsStr) -> String {
    odb::sha256_hex(&value.to_utf8())
}

fn js(text: &str) -> JsStr {
    JsStr::from(text)
}

fn concat(parts: &[&[u16]]) -> JsStr {
    let mut out = JsStr::new();
    for part in parts {
        out.push_units(part);
    }
    out
}

fn starts_with(text: &JsStr, prefix: &JsStr) -> bool {
    text.units().starts_with(prefix.units())
}

/// `Buffer.byteLength(text)`.
fn byte_length(text: &JsStr) -> usize {
    text.to_utf8().len()
}

// --- JSON: `JSON.stringify` and `JSON.parse` over seam values ------------

/// A seam value as JSON's value model (`undefined`, functions and the
/// rest are what `JSON.stringify` leaves out). Own `__proto__` keys are
/// kept, as `JSON.stringify` prints them.
pub fn to_core(value: &W) -> Value {
    match value {
        W::Null => Value::Null,
        W::Bool(flag) => Value::Bool(*flag),
        W::Number(number) => Value::Number(*number),
        W::String(text) => Value::String(text.clone()),
        W::Array(items) => Value::Array(items.iter().map(to_core).collect()),
        W::Object(object) => {
            let mut out = JsObject::new();
            for (key, value) in object.iter() {
                out.insert(key.clone(), to_core(value));
            }
            Value::Object(out)
        }
        W::Bytes(bytes) => {
            let mut out = JsObject::new();
            out.set("type", Value::string("Buffer"));
            out.set(
                "data",
                Value::Array(
                    bytes
                        .iter()
                        .map(|byte| Value::Number(f64::from(*byte)))
                        .collect(),
                ),
            );
            Value::Object(out)
        }
        _ => Value::Undefined,
    }
}

/// `JSON.stringify(value)`: `None` for `undefined`. A value nested deeper
/// than 512 containers is refused with `ledger_record_too_deep` (503), where
/// V8 writes it (up to its own stack's depth).
fn stringify(value: &W) -> Result<Option<JsStr>, W> {
    ledger_core::js::stringify(&to_core(value))
        .map_err(|_| change_error("ledger_record_too_deep", 503.0))
}

/// `Buffer.byteLength(JSON.stringify(value))`: `undefined` throws.
fn json_text(value: &W) -> Result<JsStr, W> {
    match stringify(value)? {
        Some(text) => Ok(text),
        None => {
            let mut error = JsError::new(
                "TypeError",
                "The \"string\" argument must be of type string or an instance of Buffer or ArrayBuffer. Received undefined",
            );
            error.set_field("code", W::string("ERR_INVALID_ARG_TYPE"));
            Err(W::Error(Rc::new(error)))
        }
    }
}

// --- JavaScript string helpers -------------------------------------------

/// WhiteSpace and LineTerminator, as `trim` and `\s` read them.
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `text.trim()`.
fn trim(text: &JsStr) -> JsStr {
    let units = text.units();
    let start = units
        .iter()
        .position(|unit| !js_space(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !js_space(*unit))
        .map_or(start, |at| at + 1);
    JsStr::from_units(units[start..end.max(start)].to_vec())
}

/// `text.split(/\s+/)`.
fn split_space(text: &JsStr) -> Vec<JsStr> {
    let mut out = Vec::new();
    let mut current = Vec::new();
    let mut in_space = false;
    for unit in text.units() {
        if js_space(*unit) {
            if !in_space {
                out.push(JsStr::from_units(std::mem::take(&mut current)));
            }
            in_space = true;
        } else {
            in_space = false;
            current.push(*unit);
        }
    }
    out.push(JsStr::from_units(current));
    out
}

/// `text.indexOf(unit)`.
fn index_of(text: &JsStr, unit: u16) -> Option<usize> {
    text.units().iter().position(|known| *known == unit)
}

/// `/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)`.
fn object_id_text(text: &JsStr) -> bool {
    keys::valid_object_id(text.units())
}

/// `String(index).padStart(10, '0')`.
fn page_number(index: f64) -> JsStr {
    let digits = number_to_string(index);
    let mut text = "0".repeat(10usize.saturating_sub(JsStr::from(digits.as_str()).len()));
    text.push_str(&digits);
    js(&text)
}

/// `${prefix}/${String(index).padStart(10, '0')}.json`.
fn page_name(prefix: &JsStr, index: f64) -> JsStr {
    concat(&[
        prefix.units(),
        &[u16::from(b'/')],
        page_number(index).units(),
        js(".json").units(),
    ])
}

fn valid_key(key: &JsStr) -> bool {
    keys::valid_key(key.units())
}

/// `validKey(`${prefix}/page.json`)`.
fn valid_prefix(prefix: &JsStr) -> bool {
    keys::valid_prefix(prefix.units())
}

fn text_of(value: &W) -> JsStr {
    to_js_string(value)
}

fn key_of(value: &W) -> Option<JsStr> {
    match value {
        W::String(text) => Some(text.clone()),
        _ => None,
    }
}

// --- Process-wide caches -------------------------------------------------

/// A JavaScript `Map` in insertion order (setting a key again keeps its
/// place; deleting and setting it moves it last).
struct Ordered<V> {
    slots: Vec<Option<(JsStr, V)>>,
    at: HashMap<JsStr, usize>,
}

impl<V: Clone> Ordered<V> {
    fn new() -> Ordered<V> {
        Ordered {
            slots: Vec::new(),
            at: HashMap::new(),
        }
    }

    fn get(&self, key: &JsStr) -> Option<&V> {
        self.at
            .get(key)
            .and_then(|index| self.slots[*index].as_ref().map(|(_, value)| value))
    }

    fn has(&self, key: &JsStr) -> bool {
        self.at.contains_key(key)
    }

    fn set(&mut self, key: JsStr, value: V) {
        if let Some(index) = self.at.get(&key) {
            if let Some(slot) = self.slots[*index].as_mut() {
                slot.1 = value;
            }
            return;
        }
        self.at.insert(key.clone(), self.slots.len());
        self.slots.push(Some((key, value)));
    }

    fn delete(&mut self, key: &JsStr) {
        if let Some(index) = self.at.remove(key) {
            self.slots[index] = None;
        }
        if self.at.is_empty() {
            self.slots.clear();
        }
    }

    fn len(&self) -> usize {
        self.at.len()
    }

    fn clear(&mut self) {
        self.slots.clear();
        self.at.clear();
    }

    fn entries(&self) -> Vec<(JsStr, V)> {
        self.slots.iter().flatten().cloned().collect()
    }

    /// The entry at slot `index` (`None` past the end), for an iteration
    /// that sees entries added meanwhile, as a `Map`'s does.
    fn slot(&self, index: usize) -> Option<Option<(JsStr, V)>> {
        self.slots.get(index).cloned()
    }

    fn first_key(&self) -> Option<JsStr> {
        self.slots
            .iter()
            .flatten()
            .next()
            .map(|(key, _)| key.clone())
    }
}

struct Blobs {
    map: Ordered<JsStr>,
    bytes: usize,
}

type Listing = Promise<Option<Rc<Vec<W>>>, W>;

thread_local! {
    static BLOBS: RefCell<Blobs> = RefCell::new(Blobs { map: Ordered::new(), bytes: 0 });
    static LISTINGS: RefCell<Ordered<Listing>> = RefCell::new(Ordered::new());
    static OVERSIZED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// `remember(key, data)`.
fn remember(key: &JsStr, data: &JsStr) {
    BLOBS.with(|blobs| {
        let mut blobs = blobs.borrow_mut();
        if blobs.map.has(key) {
            return;
        }
        blobs.map.set(key.clone(), data.clone());
        blobs.bytes += byte_length(data);
        while blobs.bytes > 8 * 1024 * 1024 || blobs.map.len() > 4096 {
            let Some(oldest) = blobs.map.first_key() else {
                break;
            };
            let size = blobs.map.get(&oldest).map_or(0, byte_length);
            blobs.bytes -= size;
            blobs.map.delete(&oldest);
        }
    });
}

fn blob(key: &JsStr) -> Option<JsStr> {
    BLOBS.with(|blobs| blobs.borrow().map.get(key).cloned())
}

/// `${gitDir}:${object}`.
fn named(git_dir: &JsStr, object: &JsStr) -> JsStr {
    concat(&[git_dir.units(), &[u16::from(b':')], object.units()])
}

// --- Rows -----------------------------------------------------------------

/// `{ key, oid, size }`.
fn row_object(key: JsStr, oid: W, size: f64) -> W {
    W::object(vec![
        ("key", W::String(key)),
        ("oid", oid),
        ("size", W::Number(size)),
    ])
}

/// `parseRow(row)`: a `ls-tree -l` row.
fn parse_row(row: &JsStr) -> W {
    let units = row.units();
    let (head, key) = match index_of(row, u16::from(b'\t')) {
        Some(tab) => (units[..tab].to_vec(), units[tab + 1..].to_vec()),
        // `slice(0, -1)` and `slice(0)`.
        None => (
            units[..units.len().saturating_sub(1)].to_vec(),
            units.to_vec(),
        ),
    };
    let fields = split_space(&trim(&JsStr::from_units(head)));
    let oid = fields
        .get(2)
        .map_or(W::Undefined, |field| W::String(field.clone()));
    let size = fields
        .get(3)
        .map_or(f64::NAN, |field| string_to_number(field.units()));
    row_object(JsStr::from_units(key), oid, size)
}

fn row_key(row: &W) -> JsStr {
    text_of(&row.get("key"))
}

/// `lowerBound(rows, key)`: code-unit order.
fn lower_bound(rows: &[W], key: &JsStr) -> usize {
    let (mut low, mut high) = (0, rows.len());
    while low < high {
        let middle = (low + high) >> 1;
        if row_key(&rows[middle]).units() < key.units() {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

/// A staged change: a value's JSON, an existing object (`{ oid }`), or a
/// removal (`null`).
#[derive(Clone, Debug, PartialEq)]
pub enum Staged {
    Data(JsStr),
    Oid(JsStr),
    Null,
}

/// `pending.get(key)?.oid`.
fn staged_oid(staged: Option<&Staged>) -> Option<JsStr> {
    match staged {
        Some(Staged::Oid(oid)) => Some(oid.clone()),
        _ => None,
    }
}

/// What a store iterates: an array or an async iterable (`for await`).
#[derive(Clone)]
pub enum Values {
    Array(Vec<W>),
    Gen(AsyncGen<W, W>),
}

fn for_values(values: Values) -> agen::ForAwait<W, W> {
    match values {
        Values::Array(items) => agen::for_await(agen::from_sync(agen::array(
            items.into_iter().map(Resolution::Value).collect(),
        ))),
        Values::Gen(rows) => agen::for_await(rows),
    }
}

/// An array as `yield*` takes it.
fn array_source(items: Vec<W>) -> Rc<dyn agen::AsyncIterator<W, W>> {
    agen::from_sync(agen::array(
        items.into_iter().map(Resolution::Value).collect(),
    ))
}

/// `assertCurrent`: called, its value or promise awaited; `None` is
/// `undefined` (`await undefined` still takes its job).
pub type Guard = Rc<dyn Fn() -> Ret>;

/// `await assertCurrent?.()`.
// port: inline await (one JavaScript `await` of a call that may throw first)
async fn await_guard(guard: &Option<Guard>) -> Result<W, W> {
    let called = match guard {
        Some(guard) => guard(),
        None => Ok(Resolution::Value(W::Undefined)),
    };
    match called {
        Ok(resolution) => Promise::resolve(resolution).await,
        Err(reason) => Err(reason),
    }
}

/// `syncObjects(cwd)`.
pub type SyncObjects = Rc<dyn Fn(&str) -> WPromise>;

/// `include(key)` of `records`.
pub type Include = Rc<dyn Fn(&JsStr) -> bool>;

/// `collect(data, rows)` of `setList`.
pub type Collect = Rc<dyn Fn(&JsStr, usize)>;

/// `openChangeStore`'s options; `None` is `undefined`.
#[derive(Clone, Default)]
pub struct StoreOptions {
    pub ref_: Option<W>,
    pub sync_objects: Option<SyncObjects>,
    pub listing_limit_bytes: Option<W>,
    pub persistent_index: bool,
    pub at: Option<W>,
}

struct Inner {
    cwd: String,
    git_dir: JsStr,
    git_dir_text: String,
    args: Vec<String>,
    ref_: JsStr,
    sync_objects: SyncObjects,
    listing_limit_bytes: f64,
    persistent_index: bool,
    at: Option<JsStr>,
    reader: bool,
    tree: RefCell<Option<JsStr>>,
    oid_length: usize,
    pending: RefCell<Ordered<Staged>>,
    staging: Cell<bool>,
    baseline: RefCell<HashMap<JsStr, Option<JsStr>>>,
}

/// The store `openChangeStore` resolves. Clones are the same store.
#[derive(Clone)]
pub struct ChangeStore(Rc<Inner>);

fn git_args(base: &[String], extra: &[&str]) -> Vec<String> {
    base.iter()
        .cloned()
        .chain(extra.iter().map(|text| (*text).to_owned()))
        .collect()
}

fn text_args(base: &[String], extra: &[JsStr]) -> Vec<String> {
    base.iter()
        .cloned()
        .chain(extra.iter().map(JsStr::to_string_lossy))
        .collect()
}

fn bytes_of(value: &W) -> Rc<Vec<u8>> {
    match value {
        W::Bytes(bytes) => bytes.clone(),
        _ => Rc::new(Vec::new()),
    }
}

/// `openChangeStore(cwd, gitDir, options)`: an async function.
pub fn open_change_store(
    ctx: &Ctx,
    cwd: &str,
    git_dir: &str,
    options: StoreOptions,
) -> Promise<ChangeStore, W> {
    let (ctx, cwd, git_dir) = (ctx.clone(), cwd.to_owned(), git_dir.to_owned());
    async_fn(async move {
        let limit = options
            .listing_limit_bytes
            .clone()
            .unwrap_or(W::Number(LISTING_LIMIT_BYTES));
        let limit = match limit {
            W::Number(number)
                if number.fract() == 0.0
                    && number.abs() <= 9_007_199_254_740_991.0
                    && number > 0.0 =>
            {
                number
            }
            _ => return Err(invalid()),
        };
        let at = match &options.at {
            None | Some(W::Undefined) => None,
            Some(value) => {
                let text = text_of(value);
                if !object_id_text(&text) {
                    return Err(invalid());
                }
                Some(text)
            }
        };
        let ref_ = match &options.ref_ {
            None | Some(W::Undefined) => js(STATE_REF),
            Some(value) => text_of(value),
        };
        if !keys::valid_store_ref(ref_.units()) {
            return Err(invalid());
        }
        let args = vec![String::from("--git-dir"), git_dir.clone()];
        let reader = persistent_git_readers();
        let objects_dir = odb::resolve(&cwd, &git_dir);
        let loose_ref = match &at {
            Some(at) => Some(at.clone()),
            None if reader => {
                let file = odb::resolve(&objects_dir, &ref_.to_string_lossy());
                nfs::read_file_utf8(&file)
                    .then(
                        |value| Ok(Resolution::Value(Some(trim(&value)))),
                        |cause| {
                            if ["ENOENT", "ENOTDIR"].contains(&code_of(&cause).as_str()) {
                                Ok(Resolution::Value(None))
                            } else {
                                Err(cause)
                            }
                        },
                    )
                    .await?
            }
            None => None,
        };
        let refs = match loose_ref.filter(object_id_text) {
            Some(loose) => loose,
            None => {
                let listed = git::git(
                    &ctx,
                    &cwd,
                    &text_args(
                        &args,
                        &[
                            js("for-each-ref"),
                            js("--format=%(objectname)"),
                            ref_.clone(),
                        ],
                    ),
                    &GitOptions::default(),
                )
                .await?;
                trim(&JsStr::from_utf8_lossy(&bytes_of(&listed)))
            }
        };
        let tree = (!refs.is_empty()).then_some(refs);
        let oid_length = match &tree {
            Some(tree) => tree.len(),
            None => {
                let format = git::git(
                    &ctx,
                    &cwd,
                    &git_args(&args, &["rev-parse", "--show-object-format"]),
                    &GitOptions::default(),
                )
                .await?;
                if trim(&JsStr::from_utf8_lossy(&bytes_of(&format))) == js("sha256") {
                    64
                } else {
                    40
                }
            }
        };
        let sync_objects = options
            .sync_objects
            .clone()
            .unwrap_or_else(|| Rc::new(|root: &str| sync_pending_object_directory(root)));
        Ok(Resolution::Value(ChangeStore(Rc::new(Inner {
            cwd: cwd.clone(),
            git_dir: js(&git_dir),
            git_dir_text: git_dir.clone(),
            args,
            ref_,
            sync_objects,
            listing_limit_bytes: limit,
            persistent_index: options.persistent_index,
            at,
            reader,
            tree: RefCell::new(tree),
            oid_length,
            pending: RefCell::new(Ordered::new()),
            staging: Cell::new(false),
            baseline: RefCell::new(HashMap::new()),
        }))))
    })
}

impl ChangeStore {
    fn inner(&self) -> &Inner {
        &self.0
    }

    /// `store.tree`.
    pub fn tree(&self) -> Option<JsStr> {
        self.0.tree.borrow().clone()
    }

    /// `store.exists`.
    pub fn exists(&self) -> bool {
        self.0.tree.borrow().is_some()
    }

    /// `store.pendingCount`.
    pub fn pending_count(&self) -> usize {
        self.0.pending.borrow().len()
    }

    /// `run(command, extra)`.
    fn run(&self, ctx: &Ctx, command: &[JsStr], extra: &GitOptions) -> WPromise {
        git::git(ctx, &self.0.cwd, &text_args(&self.0.args, command), extra)
    }

    fn run_tokens(&self, ctx: &Ctx, command: &[JsStr]) -> AsyncGen<W, W> {
        git_tokens(
            ctx,
            &self.0.cwd,
            &text_args(&self.0.args, command),
            &GitOptions::default(),
        )
    }

    /// `readObject(name, options)`.
    fn read_object(&self, ctx: &Ctx, name: &W, check: bool) -> Ret {
        read_git_object(ctx, &self.0.cwd, &self.0.args, name, check)
    }

    /// `await readObject(name)`.
    // port: inline await (one JavaScript `await` of a call that may throw first)
    async fn await_read(&self, ctx: &Ctx, name: &W, check: bool) -> Result<W, W> {
        Promise::resolve(self.read_object(ctx, name, check)?).await
    }

    /// `stage(action)`: an async function.
    pub fn stage(&self, action: Box<dyn FnOnce() -> Ret>) -> WPromise {
        let store = self.clone();
        async_fn(async move {
            let inner = store.inner();
            if inner.staging.get() {
                return Err(invalid());
            }
            let saved = inner.pending.borrow().entries();
            inner.staging.set(true);
            let outcome = match action() {
                Ok(resolution) => Promise::resolve(resolution).await,
                Err(reason) => Err(reason),
            };
            if outcome.is_err() {
                let mut pending = inner.pending.borrow_mut();
                pending.clear();
                for (key, value) in saved {
                    pending.set(key, value);
                }
            }
            // `finally`
            inner.staging.set(false);
            Ok(Resolution::Value(outcome?))
        })
    }

    fn directs_listings(&self) -> bool {
        self.0.reader && host::env("DEVRYAN_LEDGER_DIRECT_LISTINGS").as_deref() != Some("0")
    }

    fn direct_trees(&self) -> bool {
        self.0.reader && host::env("DEVRYAN_LEDGER_DIRECT_TREES").as_deref() != Some("0")
    }

    /// `readListedTree(oid)`: an async function: the tree's content through
    /// the reader, else `null`.
    fn read_listed_tree(&self, ctx: &Ctx, oid: &JsStr) -> WPromise {
        let (store, ctx, oid) = (self.clone(), ctx.clone(), oid.clone());
        async_fn(async move {
            let found = store.await_read(&ctx, &W::String(oid), false).await?;
            Ok(Resolution::Value(
                if matches!(found.get("type"), W::String(kind) if kind == js("tree")) {
                    found.get("data")
                } else {
                    W::Null
                },
            ))
        })
    }

    /// `sizeOf(oid)` of `listDirect`: an async function: the blob's size
    /// through the checking reader, else `null`.
    fn size_of(&self, ctx: &Ctx, oid: &JsStr) -> WPromise {
        let (store, ctx, oid) = (self.clone(), ctx.clone(), oid.clone());
        async_fn(async move {
            let found = store.await_read(&ctx, &W::String(oid), true).await?;
            Ok(Resolution::Value(
                if matches!(found.get("type"), W::String(kind) if kind == js("blob")) {
                    found.get("size")
                } else {
                    W::Null
                },
            ))
        })
    }

    /// `listDirectPrefix(snapshot, prefix)`: an async function resolving the
    /// rows, `[]` for an absent component, or `null` where Git must answer;
    /// every tree read through the persistent reader, as the JavaScript's.
    fn list_direct_prefix(&self, ctx: &Ctx, snapshot: &JsStr, prefix: &JsStr) -> WPromise {
        let (store, ctx, snapshot, prefix) =
            (self.clone(), ctx.clone(), snapshot.clone(), prefix.clone());
        async_fn(async move {
            let simple = !prefix.is_empty()
                && prefix
                    .units()
                    .split(|unit| *unit == u16::from(b'/'))
                    .all(|part| {
                        !part.is_empty()
                            && part.iter().all(|unit| {
                                matches!(*unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
                                    || *unit == u16::from(b'_')
                                    || *unit == u16::from(b'-')
                            })
                    });
            if !simple {
                return Ok(Resolution::Value(W::Null));
            }
            let oid_length = store.inner().oid_length;
            let mut oid = snapshot.clone();
            for part in prefix.units().split(|unit| *unit == u16::from(b'/')) {
                let data = store.read_listed_tree(&ctx, &oid).await?;
                let W::Bytes(data) = data else {
                    return Ok(Resolution::Value(W::Null));
                };
                let Ok(entries) = parse_tree(&data, oid_length) else {
                    return Ok(Resolution::Value(W::Null));
                };
                if !in_git_order(&entries) {
                    return Ok(Resolution::Value(W::Null));
                }
                let Some(entry) = entries.iter().find(|entry| entry.name.units() == part) else {
                    return Ok(Resolution::Value(W::Array(Vec::new())));
                };
                if entry.mode != js(TREE_MODE) {
                    return Ok(Resolution::Value(W::Null));
                }
                oid = entry.oid.clone();
            }
            let path = concat(&[prefix.units(), &[u16::from(b'/')]]);
            Ok(Resolution::Promise(list_tree_rows(&store, &ctx, oid, path)))
        })
    }

    /// `indexed(snapshot)`: an async function.
    fn indexed(&self, ctx: &Ctx, snapshot: &JsStr) -> Listing {
        let (store, ctx, snapshot) = (self.clone(), ctx.clone(), snapshot.clone());
        async_fn(async move {
            let inner = store.inner();
            if OVERSIZED.with(|set| set.borrow().contains(&inner.git_dir_text)) {
                return Ok(Resolution::Value(None));
            }
            let identity = named(&inner.git_dir, &snapshot);
            if !LISTINGS.with(|listings| listings.borrow().has(&identity)) {
                let work: Listing = {
                    let (store, ctx, snapshot) = (store.clone(), ctx.clone(), snapshot.clone());
                    async_fn(async move {
                        let inner = store.inner();
                        let mut rows: Vec<W> = Vec::new();
                        let mut bytes = 0usize;
                        let tokens = agen::for_await(store.run_tokens(
                            &ctx,
                            &[
                                js("ls-tree"),
                                js("-r"),
                                js("-l"),
                                js("-z"),
                                snapshot.clone(),
                            ],
                        ));
                        while let Some(row) = tokens.next().await? {
                            let row = text_of(&row);
                            bytes += byte_length(&row);
                            if bytes as f64 > inner.listing_limit_bytes {
                                OVERSIZED.with(|set| {
                                    set.borrow_mut().insert(inner.git_dir_text.clone())
                                });
                                tokens.close().await?;
                                return Ok(Resolution::Value(None));
                            }
                            rows.push(parse_row(&row));
                        }
                        rows.sort_by(|a, b| row_key(a).units().cmp(row_key(b).units()));
                        Ok(Resolution::Value(Some(Rc::new(rows))))
                    })
                };
                LISTINGS.with(|listings| {
                    let mut listings = listings.borrow_mut();
                    listings.set(identity.clone(), work.clone());
                    while listings.len() > 2 {
                        let Some(oldest) = listings.first_key() else {
                            break;
                        };
                        listings.delete(&oldest);
                    }
                });
                let (watched, identity) = (work.clone(), identity.clone());
                let _ = work.catch(move |_| {
                    LISTINGS.with(|listings| {
                        let mut listings = listings.borrow_mut();
                        if listings
                            .get(&identity)
                            .is_some_and(|known| known.same(&watched))
                        {
                            listings.delete(&identity);
                        }
                    });
                    Ok(Resolution::Value(None))
                });
            }
            let listing = LISTINGS
                .with(|listings| listings.borrow().get(&identity).cloned())
                .map_or(Resolution::Value(None), Resolution::Promise);
            Ok(listing)
        })
    }

    /// `values(rows)`: an async generator.
    fn values(&self, ctx: &Ctx, rows: Values) -> AsyncGen<W, W> {
        let (store, ctx) = (self.clone(), ctx.clone());
        agen::async_gen(move |co: Co<W, W>| async move {
            let inner = store.inner();
            if !inner.reader {
                let rows = match rows {
                    Values::Gen(rows) => git::Rows::Gen(rows),
                    Values::Array(rows) => git::Rows::Array(rows),
                };
                let records =
                    git::git_records(&ctx, &inner.cwd, &inner.args, rows, &GitOptions::default());
                co.delegate(records).await?;
                return Err(Abrupt::Return(W::Undefined));
            }
            let batch: RefCell<Vec<W>> = RefCell::new(Vec::new());
            let flush = || {
                let (store, ctx) = (store.clone(), ctx.clone());
                let taken = batch.borrow().clone();
                let batch = &batch;
                let reads: Result<Vec<Resolution<W, W>>, W> = taken
                    .iter()
                    .map(|row| store.read_object(&ctx, &row.get("oid"), false))
                    .collect();
                let found = reads.map(Promise::all);
                let started = async_fn(async move {
                    let found = found?.await?;
                    let mut result = Vec::new();
                    for (row, found) in taken.iter().zip(found.iter()) {
                        if !matches!(found.get("type"), W::String(kind) if kind == js("blob")) {
                            return Err(invalid_503());
                        }
                        let value =
                            json_parse(&JsStr::from_utf8_lossy(&bytes_of(&found.get("data"))))?;
                        result.push(W::object(vec![
                            ("key", row.get("key")),
                            ("oid", row.get("oid")),
                            ("value", value),
                        ]));
                    }
                    Ok(Resolution::Value(W::Array(result)))
                });
                batch.borrow_mut().clear();
                started
            };
            let source = for_values(rows);
            while let Some(row) = source.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    let size = row.get("size");
                    let number = match size {
                        W::Number(number) => number,
                        _ => f64::NAN,
                    };
                    let safe = number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0;
                    if !safe || number < 0.0 || number > 512.0 * 1024.0 {
                        return Err(Abrupt::Throw(invalid_503()));
                    }
                    batch.borrow_mut().push(row.clone());
                    if batch.borrow().len() >= 256 {
                        let records = flush().await?;
                        co.delegate(array_source(items(records))).await?;
                    }
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(source.exit(abrupt).await);
                }
            }
            if !batch.borrow().is_empty() {
                let records = flush().await?;
                co.delegate(array_source(items(records))).await?;
            }
            Ok(())
        })
    }

    /// `treeRows(snapshot, prefix)`: an async generator.
    fn tree_rows(&self, ctx: &Ctx, snapshot: JsStr, prefix: JsStr) -> AsyncGen<W, W> {
        let (store, ctx) = (self.clone(), ctx.clone());
        agen::async_gen(move |co: Co<W, W>| async move {
            let rows = store.indexed(&ctx, &snapshot).await?;
            let start = concat(&[prefix.units(), &[u16::from(b'/')]]);
            if let Some(rows) = rows {
                let mut at = lower_bound(&rows, &start);
                while at < rows.len() && starts_with(&row_key(&rows[at]), &start) {
                    co.yield_(Resolution::Value(rows[at].clone())).await?;
                    at += 1;
                }
                return Err(Abrupt::Return(W::Undefined));
            }
            let direct = if store.directs_listings() {
                store
                    .list_direct_prefix(&ctx, &snapshot, &prefix)
                    .catch(|_| Ok(Resolution::Value(W::Null)))
                    .await?
            } else {
                W::Null
            };
            if let W::Array(direct) = direct {
                // port: for-of over an awaited value (`for (const row of direct)`)
                for row in direct.iter() {
                    let size = to_number_of(&row.get("size"));
                    co.yield_(Resolution::Value(row_object(
                        row_key(row),
                        row.get("oid"),
                        size,
                    )))
                    .await?;
                }
                return Err(Abrupt::Return(W::Undefined));
            }
            let tokens = agen::for_await(store.run_tokens(
                &ctx,
                &[
                    js("--literal-pathspecs"),
                    js("ls-tree"),
                    js("-r"),
                    js("-l"),
                    js("-z"),
                    snapshot.clone(),
                    js("--"),
                    start.clone(),
                ],
            ));
            while let Some(row) = tokens.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    co.yield_(Resolution::Value(parse_row(&text_of(&row))))
                        .await?;
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(tokens.exit(abrupt).await);
                }
            }
            Ok(())
        })
    }

    /// `get(key)`: an async function.
    pub fn get(&self, ctx: &Ctx, key: &W) -> WPromise {
        let (store, ctx, key) = (self.clone(), ctx.clone(), key.clone());
        async_fn(async move {
            let inner = store.inner();
            let Some(key) = key_of(&key).filter(valid_key) else {
                return Err(invalid());
            };
            let staged = inner.pending.borrow().get(&key).cloned();
            if let Some(Staged::Data(data)) = &staged {
                return Ok(Resolution::Value(json_parse(data)?));
            }
            if staged == Some(Staged::Null) {
                return Ok(Resolution::Value(W::Null));
            }
            let from_tree = staged.is_none();
            let observed = |value: Option<JsStr>| -> Ret {
                if from_tree {
                    inner
                        .baseline
                        .borrow_mut()
                        .insert(key.clone(), value.clone());
                }
                Ok(Resolution::Value(match value {
                    None => W::Null,
                    Some(value) => json_parse(&value)?,
                }))
            };
            let Some(tree) = inner.tree.borrow().clone() else {
                return observed(None);
            };
            if inner.reader {
                let object = staged_oid(staged.as_ref())
                    .unwrap_or_else(|| concat(&[tree.units(), &[u16::from(b':')], key.units()]));
                let name = named(&inner.git_dir, &object);
                if let Some(value) = blob(&name) {
                    return observed(Some(value));
                }
                let found = store.await_read(&ctx, &W::String(object), false).await?;
                if matches!(found, W::Null) {
                    return observed(None);
                }
                if !matches!(found.get("type"), W::String(kind) if kind == js("blob")) {
                    return Err(invalid());
                }
                let value = JsStr::from_utf8_lossy(&bytes_of(&found.get("data")));
                remember(&name, &value);
                remember(&named(&inner.git_dir, &text_of(&found.get("oid"))), &value);
                return observed(Some(value));
            }
            let rows = if inner.pending.borrow().has(&key) {
                None
            } else {
                store.indexed(&ctx, &tree).await?
            };
            let row = rows
                .as_ref()
                .and_then(|rows| rows.get(lower_bound(rows, &key)).cloned());
            if rows.is_some() && row.as_ref().map(row_key) != Some(key.clone()) {
                return observed(None);
            }
            // Read after the await, as the JavaScript reads them there.
            let now_staged = inner.pending.borrow().get(&key).cloned();
            let tree = inner.tree.borrow().clone().unwrap_or(tree);
            let object = staged_oid(now_staged.as_ref())
                .or_else(|| row.as_ref().and_then(|row| key_of(&row.get("oid"))))
                .unwrap_or_else(|| concat(&[tree.units(), &[u16::from(b':')], key.units()]));
            let cache_key = named(&inner.git_dir, &object);
            if let Some(value) = blob(&cache_key) {
                return observed(Some(value));
            }
            let mut line = object.clone();
            line.push_str("\n");
            let data = bytes_of(
                &store
                    .run(
                        &ctx,
                        &[js("cat-file"), js("--batch")],
                        &GitOptions {
                            input: Input::Text(line),
                            ..GitOptions::default()
                        },
                    )
                    .await?,
            );
            let end = data
                .iter()
                .position(|byte| *byte == 10)
                .map_or(-1isize, |at| at as isize);
            let header_bytes = slice(&data, 0, end);
            let header = JsStr::from_utf8_lossy(&header_bytes).to_string_lossy();
            let header: Vec<&str> = header.split(' ').collect();
            if header.last() == Some(&"missing") {
                return observed(None);
            }
            let size = header
                .get(2)
                .map_or(f64::NAN, |text| string_to_number(js(text).units()));
            if header.get(1) != Some(&"blob") || size != (data.len() as isize - end - 2) as f64 {
                return Err(invalid());
            }
            let value = JsStr::from_utf8_lossy(&slice(&data, end + 1, data.len() as isize - 1));
            remember(&cache_key, &value);
            observed(Some(value))
        })
    }

    /// `set(key, value)`.
    pub fn set(&self, key: &W, value: &W) -> Result<(), W> {
        let Some(key) = key_of(key).filter(valid_key) else {
            return Err(invalid());
        };
        let data = json_text(value)?;
        self.set_data(&key, data)
    }

    /// `setData(key, data)`.
    fn set_data(&self, key: &JsStr, data: JsStr) -> Result<(), W> {
        let inner = self.inner();
        if byte_length(&data) > 512 * 1024 {
            return Err(change_error("change_record_too_large", 503.0));
        }
        let unchanged = !inner.pending.borrow().has(key)
            && inner.baseline.borrow().get(key) == Some(&Some(data.clone()));
        if unchanged {
            return Ok(());
        }
        inner
            .pending
            .borrow_mut()
            .set(key.clone(), Staged::Data(data));
        Ok(())
    }

    /// `remove(key)`.
    pub fn remove(&self, key: &W) -> Result<(), W> {
        let inner = self.inner();
        let Some(key) = key_of(key).filter(valid_key) else {
            return Err(invalid());
        };
        let unchanged =
            !inner.pending.borrow().has(&key) && inner.baseline.borrow().get(&key) == Some(&None);
        if unchanged {
            return Ok(());
        }
        inner.pending.borrow_mut().set(key, Staged::Null);
        Ok(())
    }

    /// `pendingUnder(prefix).sort(byKey)`: code-unit order (D25).
    fn pending_under_sorted(&self, prefix: &JsStr) -> Vec<(JsStr, Staged)> {
        let start = concat(&[prefix.units(), &[u16::from(b'/')]]);
        let mut selected: Vec<(JsStr, Staged)> = self
            .inner()
            .pending
            .borrow()
            .entries()
            .into_iter()
            .filter(|(key, _)| starts_with(key, &start))
            .collect();
        selected.sort_by(|(a, _), (b, _)| a.units().cmp(b.units()));
        selected
    }

    /// `entries(prefix)`: an async generator.
    pub fn entries(&self, ctx: &Ctx, prefix: &W) -> AsyncGen<W, W> {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), text_of(prefix));
        agen::async_gen(move |co: Co<W, W>| async move {
            let inner = store.inner();
            let tree = inner.tree.borrow().clone();
            if tree.is_some() {
                let rows = {
                    let (store, ctx, prefix) = (store.clone(), ctx.clone(), prefix.clone());
                    agen::async_gen(move |co: Co<W, W>| async move {
                        let tree = store.inner().tree.borrow().clone().unwrap_or_default();
                        let source = agen::for_await(store.tree_rows(&ctx, tree, prefix));
                        while let Some(row) = source.next().await? {
                            let step: Result<(), Abrupt<W, W>> = async {
                                if !store.inner().pending.borrow().has(&row_key(&row)) {
                                    co.yield_(Resolution::Value(row)).await?;
                                }
                                Ok(())
                            }
                            .await;
                            if let Err(abrupt) = step {
                                return Err(source.exit(abrupt).await);
                            }
                        }
                        Ok(())
                    })
                };
                let values = agen::for_await(store.values(&ctx, Values::Gen(rows)));
                while let Some(row) = values.next().await? {
                    let step: Result<(), Abrupt<W, W>> = async {
                        let text = json_text(&row.get("value"))?;
                        remember(&named(&inner.git_dir, &text_of(&row.get("oid"))), &text);
                        co.yield_(Resolution::Value(row)).await?;
                        Ok(())
                    }
                    .await;
                    if let Err(abrupt) = step {
                        return Err(values.exit(abrupt).await);
                    }
                }
            }
            for (key, data) in store.pending_under_sorted(&prefix) {
                match data {
                    Staged::Null => {}
                    Staged::Oid(_) => {
                        let value = store.get(&ctx, &W::String(key.clone())).await?;
                        co.yield_(Resolution::Value(W::object(vec![
                            ("key", W::String(key)),
                            ("value", value),
                        ])))
                        .await?;
                    }
                    Staged::Data(data) => {
                        let value = json_parse(&data)?;
                        co.yield_(Resolution::Value(W::object(vec![
                            ("key", W::String(key)),
                            ("value", value),
                        ])))
                        .await?;
                    }
                }
            }
            Ok(())
        })
    }

    /// `records(snapshot = tree, { include })`: an async generator.
    pub fn records(
        &self,
        ctx: &Ctx,
        snapshot: Option<JsStr>,
        include: Option<Include>,
    ) -> AsyncGen<W, W> {
        let (store, ctx) = (self.clone(), ctx.clone());
        // `snapshot = tree`: a default parameter, bound at the call (an async
        // generator's parameters are bound when it is created).
        let snapshot = snapshot.or_else(|| self.inner().tree.borrow().clone());
        agen::async_gen(move |co: Co<W, W>| async move {
            let inner = store.inner();
            let Some(snapshot) = snapshot.filter(|text| !text.is_empty()) else {
                return Ok(());
            };
            let mut rows = Vec::new();
            let tokens = agen::for_await(store.run_tokens(
                &ctx,
                &[
                    js("ls-tree"),
                    js("-r"),
                    js("-l"),
                    js("-z"),
                    snapshot.clone(),
                ],
            ));
            while let Some(row) = tokens.next().await? {
                let parsed = parse_row(&text_of(&row));
                if include
                    .as_ref()
                    .is_none_or(|include| include(&row_key(&parsed)))
                {
                    rows.push(parsed);
                }
            }
            let values = agen::for_await(store.values(&ctx, Values::Array(rows)));
            while let Some(row) = values.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    let data = json_text(&row.get("value"))?;
                    remember(&named(&inner.git_dir, &text_of(&row.get("oid"))), &data);
                    let current = inner.tree.borrow().clone();
                    if current.as_ref() == Some(&snapshot)
                        && !inner.pending.borrow().has(&row_key(&row))
                    {
                        inner
                            .baseline
                            .borrow_mut()
                            .insert(row_key(&row), Some(data));
                    }
                    co.yield_(Resolution::Value(row)).await?;
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(values.exit(abrupt).await);
                }
            }
            Ok(())
        })
    }

    /// `list(prefix)`: an async generator.
    pub fn list(&self, ctx: &Ctx, prefix: &W) -> AsyncGen<W, W> {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), prefix.clone());
        agen::async_gen(move |co: Co<W, W>| async move {
            let entries = agen::for_await(store.entries(&ctx, &prefix));
            while let Some(entry) = entries.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    let W::Array(value) = entry.get("value") else {
                        return Err(Abrupt::Throw(invalid()));
                    };
                    co.delegate(array_source(value)).await?;
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(entries.exit(abrupt).await);
                }
            }
            Ok(())
        })
    }

    /// `pagesOf(values, totals)`: an async generator; `totals.bytes` grows.
    fn pages_of(values: Values, totals: Rc<Cell<f64>>) -> AsyncGen<W, W> {
        agen::async_gen(move |co: Co<W, W>| async move {
            let mut page: Vec<W> = Vec::new();
            let mut bytes = 0.0f64;
            let source = for_values(values);
            while let Some(value) = source.next().await? {
                let step: Result<(), Abrupt<W, W>> = async {
                    let size = byte_length(&json_text(&value)?) as f64;
                    if !page.is_empty() && (page.len() >= 128 || bytes + size > 256.0 * 1024.0) {
                        co.yield_(Resolution::Value(W::Array(std::mem::take(&mut page))))
                            .await?;
                        bytes = 0.0;
                    }
                    page.push(value.clone());
                    bytes += size;
                    totals.set(totals.get() + size);
                    Ok(())
                }
                .await;
                if let Err(abrupt) = step {
                    return Err(source.exit(abrupt).await);
                }
            }
            if !page.is_empty() {
                co.yield_(Resolution::Value(W::Array(page))).await?;
            }
            Ok(())
        })
    }

    /// `setList(prefix, values, { absent, firstPage, collect })`: an async
    /// function resolving the values' JSON bytes.
    pub fn set_list(
        &self,
        ctx: &Ctx,
        prefix: &W,
        values: Values,
        absent: bool,
        first_page: f64,
        collect: Option<Collect>,
    ) -> WPromise {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), prefix.clone());
        async_fn(async move {
            if !absent {
                let entries = agen::for_await(store.entries(&ctx, &prefix));
                while let Some(entry) = entries.next().await? {
                    if let Err(error) = store.remove(&entry.get("key")) {
                        return Err(entries.close_throw(error).await);
                    }
                }
            }
            let prefix = text_of(&prefix);
            let mut index = first_page;
            let totals = Rc::new(Cell::new(0.0));
            let pages = agen::for_await(ChangeStore::pages_of(values, totals.clone()));
            while let Some(page) = pages.next().await? {
                let name = page_name(&prefix, index);
                index += 1.0;
                let staged: Result<(), W> = match &collect {
                    None => store.set(&W::String(name), &page),
                    Some(collect) => {
                        if !valid_key(&name) {
                            Err(invalid())
                        } else {
                            json_text(&page).and_then(|data| {
                                store.set_data(&name, data.clone())?;
                                let count = match &page {
                                    W::Array(items) => items.len(),
                                    _ => 0,
                                };
                                collect(&data, count);
                                Ok(())
                            })
                        }
                    }
                };
                if let Err(error) = staged {
                    return Err(pages.close_throw(error).await);
                }
            }
            Ok(Resolution::Value(W::Number(totals.get())))
        })
    }

    /// `writeList(values)`: `{ objects, bytes }`.
    pub fn write_list(&self, values: Values) -> WPromise {
        let store = self.clone();
        async_fn(async move {
            let inner = store.inner();
            let objects_dir = odb::resolve(&inner.cwd, &inner.git_dir_text);
            let mut objects = Vec::new();
            let totals = Rc::new(Cell::new(0.0));
            let pages = agen::for_await(ChangeStore::pages_of(values, totals.clone()));
            while let Some(page) = pages.next().await? {
                let data = match json_text(&page) {
                    Ok(data) => data,
                    Err(error) => return Err(pages.close_throw(error).await),
                };
                if byte_length(&data) > 512 * 1024 {
                    return Err(pages
                        .close_throw(change_error("change_record_too_large", 503.0))
                        .await);
                }
                let written = odb::write_loose_object(
                    &objects_dir,
                    "blob",
                    Rc::new(data.to_utf8()),
                    inner.oid_length,
                )
                .await;
                match written {
                    Ok(oid) => objects.push(oid),
                    Err(error) => return Err(pages.close_throw(error).await),
                }
            }
            Ok(Resolution::Value(W::object(vec![
                ("objects", W::Array(objects)),
                ("bytes", W::Number(totals.get())),
            ])))
        })
    }

    /// `setListObjects(prefix, oids, { firstPage })`.
    pub fn set_list_objects(&self, prefix: &W, oids: &[W], first_page: f64) -> Result<(), W> {
        let inner = self.inner();
        let prefix = text_of(prefix);
        let valid = valid_prefix(&prefix)
            && oids.iter().all(|oid| {
                matches!(oid, W::String(text) if keys::valid_list_object(text.units(), inner.oid_length))
            });
        if !valid {
            return Err(invalid());
        }
        for (index, oid) in oids.iter().enumerate() {
            inner.pending.borrow_mut().set(
                page_name(&prefix, first_page + index as f64),
                Staged::Oid(text_of(oid)),
            );
        }
        Ok(())
    }

    /// `publish(next, assertCurrent)`: an async function.
    fn publish(&self, ctx: &Ctx, next: JsStr, guard: Option<Guard>) -> WPromise {
        let (store, ctx) = (self.clone(), ctx.clone());
        async_fn(async move {
            let inner = store.inner();
            await_guard(&guard).await?;
            let tree = inner.tree.borrow().clone();
            let old = tree
                .clone()
                .unwrap_or_else(|| js(&"0".repeat(inner.oid_length)));
            store
                .run(
                    &ctx,
                    &[js("update-ref"), inner.ref_.clone(), next.clone(), old],
                    &GitOptions::default(),
                )
                .await?;
            if let Err(cause) = await_guard(&guard).await {
                let tree = inner.tree.borrow().clone();
                let back = match &tree {
                    Some(tree) => vec![
                        js("update-ref"),
                        inner.ref_.clone(),
                        tree.clone(),
                        next.clone(),
                    ],
                    None => vec![js("update-ref"), js("-d"), inner.ref_.clone(), next.clone()],
                };
                if let Err(rollback) = store.run(&ctx, &back, &GitOptions::default()).await {
                    let mut error =
                        JsError::new("AggregateError", "Guarded ledger commit rollback failed");
                    error.errors = Some(vec![cause, rollback]);
                    error.set_field("code", W::string("ledger_guard_rollback_failed"));
                    error.set_field("committed", W::Bool(true));
                    error.set_field("rollbackFailed", W::Bool(true));
                    return Err(W::Error(Rc::new(error)));
                }
                return Err(cause);
            }
            store.settle(next);
            Ok(Resolution::Value(W::Undefined))
        })
    }

    /// `settle(next)`.
    fn settle(&self, next: JsStr) {
        let inner = self.inner();
        *inner.tree.borrow_mut() = Some(next);
        let entries = inner.pending.borrow().entries();
        {
            let mut baseline = inner.baseline.borrow_mut();
            for (key, data) in entries {
                match data {
                    Staged::Data(data) => {
                        baseline.insert(key, Some(data));
                    }
                    Staged::Null => {
                        baseline.insert(key, None);
                    }
                    Staged::Oid(_) => {
                        baseline.remove(&key);
                    }
                }
            }
        }
        inner.pending.borrow_mut().clear();
    }

    /// `commitDirect(assertCurrent)`: an async function.
    fn commit_direct(&self, ctx: &Ctx, guard: Option<Guard>) -> WPromise {
        let (store, ctx) = (self.clone(), ctx.clone());
        async_fn(async move {
            let inner = store.inner();
            if inner.persistent_index && inner.ref_ == js(STATE_REF) {
                let record = odb::join(&[
                    &odb::dirname(&inner.git_dir_text),
                    "state.metadata-index.tree",
                ]);
                nfs::rm(
                    &record,
                    RmOptions {
                        recursive: false,
                        force: true,
                    },
                )
                .await?;
            }
            let objects_dir = odb::resolve(&inner.cwd, &inner.git_dir_text);
            let changes = inner.pending.borrow().entries();
            let tree = inner.tree.borrow().clone();
            let next = text_of(
                &commit_tree_changes(
                    store_tree_io(&store, &ctx, &objects_dir),
                    tree.clone(),
                    changes,
                )
                .await?,
            );
            if Some(&next) == tree.as_ref() {
                store.settle(next);
                return Ok(Resolution::Value(W::Undefined));
            }
            store.publish(&ctx, next, guard).await?;
            Ok(Resolution::Value(W::Undefined))
        })
    }

    /// `commit({ assertCurrent })`: an async function.
    pub fn commit(&self, ctx: &Ctx, guard: Option<Guard>) -> WPromise {
        let (store, ctx) = (self.clone(), ctx.clone());
        async_fn(async move {
            let inner = store.inner();
            await_guard(&guard).await?;
            if inner.staging.get() || inner.at.is_some() {
                return Err(invalid());
            }
            if inner.pending.borrow().len() == 0 {
                return Ok(Resolution::Value(W::Undefined));
            }
            (inner.sync_objects)(&inner.cwd).await?;
            if store.direct_trees() {
                return Ok(Resolution::Promise(store.commit_direct(&ctx, guard)));
            }
            store.commit_index(&ctx, guard).await?;
            Ok(Resolution::Value(W::Undefined))
        })
    }

    /// The rest of `commit` on Git's index (`DEVRYAN_LEDGER_DIRECT_TREES=0`
    /// or no reader): written inline in `commit` in the JavaScript, so it is
    /// one inline await here.
    // port: inline await (the rest of `commit`'s body, its awaits in order)
    async fn commit_index(&self, ctx: &Ctx, guard: Option<Guard>) -> Result<(), W> {
        let inner = self.inner();
        let kept = inner.persistent_index
            && inner.ref_ == js(STATE_REF)
            && host::env("DEVRYAN_LEDGER_PERSISTENT_INDEX").as_deref() != Some("0");
        let parent = odb::dirname(&inner.git_dir_text);
        let index = if kept {
            odb::join(&[&parent, "state.metadata-index"])
        } else {
            odb::join(&[&parent, &format!("{}.metadata-index", odb::random_uuid())])
        };
        let env = vec![(String::from("GIT_INDEX_FILE"), Some(index.clone()))];
        let record = format!("{index}.tree");
        let body: Result<(), W> = async {
            let indexed = if kept {
                nfs::read_file_utf8(&record)
                    .then(
                        |value| Ok(Resolution::Value(Some(trim(&value)))),
                        |cause| {
                            if code_of(&cause) == "ENOENT" {
                                Ok(Resolution::Value(None))
                            } else {
                                Err(cause)
                            }
                        },
                    )
                    .await?
            } else {
                None
            };
            if kept {
                nfs::rm(
                    &record,
                    RmOptions {
                        recursive: false,
                        force: true,
                    },
                )
                .await?;
                nfs::rm(
                    &format!("{index}.lock"),
                    RmOptions {
                        recursive: false,
                        force: true,
                    },
                )
                .await?;
            }
            let tree = inner.tree.borrow().clone();
            let expected = tree.clone().unwrap_or_else(|| js("empty"));
            if !kept || indexed.as_ref() != Some(&expected) {
                let command = match &tree {
                    Some(tree) => vec![js("read-tree"), tree.clone()],
                    None => vec![js("read-tree"), js("--empty")],
                };
                self.run(
                    ctx,
                    &command,
                    &GitOptions {
                        env: env.clone(),
                        ..GitOptions::default()
                    },
                )
                .await?;
            }
            let staged = format!("{index}.blobs");
            self.run(
                ctx,
                &[js("update-index"), js("-z"), js("--index-info")],
                &GitOptions {
                    env: env.clone(),
                    input: Input::Rows(self.updates(ctx, staged)),
                    timeout_ms: Some(120_000.0),
                    ..GitOptions::default()
                },
            )
            .await?;
            let written = self
                .run(
                    ctx,
                    &[js("write-tree")],
                    &GitOptions {
                        env: env.clone(),
                        ..GitOptions::default()
                    },
                )
                .await?;
            let next = trim(&JsStr::from_utf8_lossy(&bytes_of(&written)));
            self.publish(ctx, next.clone(), guard.clone()).await?;
            if kept {
                nfs::write_file(
                    &record,
                    &Data::Text(next),
                    WriteOptions {
                        mode: 0o600,
                        flag: Flags::Str("w"),
                    },
                )
                .catch(|_| Ok(Resolution::Value(())))
                .await?;
            }
            Ok(())
        }
        .await;
        // `finally`
        if !kept {
            nfs::rm(
                &index,
                RmOptions {
                    recursive: false,
                    force: true,
                },
            )
            .await?;
        }
        nfs::rm(
            &format!("{index}.lock"),
            RmOptions {
                recursive: false,
                force: true,
            },
        )
        .await?;
        body
    }

    /// `updates()` of the index path: an async generator of
    /// `update-index -z --index-info` rows.
    fn updates(&self, ctx: &Ctx, staged: String) -> AsyncGen<W, W> {
        let (store, ctx) = (self.clone(), ctx.clone());
        agen::async_gen(move |co: Co<W, W>| async move {
            let inner = store.inner();
            let flush = |entries: Vec<(JsStr, JsStr)>| {
                let (store, ctx, staged) = (store.clone(), ctx.clone(), staged.clone());
                async_fn::<W, W>(async move {
                    nfs::mkdir(
                        &staged,
                        nfs::MkdirOptions {
                            recursive: true,
                            mode: 0o700,
                        },
                    )
                    .await?;
                    let files: Vec<String> = (0..entries.len())
                        .map(|index| odb::join(&[&staged, &index.to_string()]))
                        .collect();
                    let mut start = 0;
                    while start < entries.len() {
                        let writes: Vec<Resolution<(), W>> = entries
                            [start..(start + 16).min(entries.len())]
                            .iter()
                            .enumerate()
                            .map(|(offset, (_, data))| {
                                Resolution::Promise(nfs::write_file(
                                    &files[start + offset],
                                    &Data::Text(data.clone()),
                                    WriteOptions {
                                        mode: 0o600,
                                        flag: Flags::Str("w"),
                                    },
                                ))
                            })
                            .collect();
                        Promise::all(writes).await?;
                        start += 16;
                    }
                    let mut input = files
                        .iter()
                        .map(|file| {
                            json_text(&W::string(file))
                                .map(|text| text.to_string_lossy())
                                .unwrap_or_default()
                        })
                        .collect::<Vec<String>>()
                        .join("\n");
                    input.push('\n');
                    let hashed = store
                        .run(
                            &ctx,
                            &[
                                js("hash-object"),
                                js("-w"),
                                js("--no-filters"),
                                js("--stdin-paths"),
                            ],
                            &GitOptions {
                                input: Input::Text(js(&input)),
                                ..GitOptions::default()
                            },
                        )
                        .await?;
                    let text = trim(&JsStr::from_utf8_lossy(&bytes_of(&hashed))).to_string_lossy();
                    let oids: Vec<&str> = text.split('\n').collect();
                    let rows = entries
                        .iter()
                        .enumerate()
                        .map(|(index, (key, _))| {
                            W::String(concat(&[
                                js("100644 ").units(),
                                js(oids.get(index).copied().unwrap_or("undefined")).units(),
                                &[u16::from(b'\t')],
                                key.units(),
                                &[0],
                            ]))
                        })
                        .collect();
                    Ok(Resolution::Value(W::Array(rows)))
                })
            };
            let body: Result<(), Abrupt<W, W>> = async {
                let mut batch: Vec<(JsStr, JsStr)> = Vec::new();
                let mut index = 0;
                loop {
                    let Some(slot) = inner.pending.borrow().slot(index) else {
                        break;
                    };
                    index += 1;
                    let Some((key, data)) = slot else { continue };
                    match data {
                        Staged::Null => {
                            let row = concat(&[
                                js("0 ").units(),
                                js(&"0".repeat(inner.oid_length)).units(),
                                &[u16::from(b'\t')],
                                key.units(),
                                &[0],
                            ]);
                            co.yield_(Resolution::Value(W::String(row))).await?;
                        }
                        Staged::Oid(oid) => {
                            let row = concat(&[
                                js("100644 ").units(),
                                oid.units(),
                                &[u16::from(b'\t')],
                                key.units(),
                                &[0],
                            ]);
                            co.yield_(Resolution::Value(W::String(row))).await?;
                        }
                        Staged::Data(data) => {
                            batch.push((key, data));
                            if batch.len() == 128 {
                                let rows = flush(std::mem::take(&mut batch)).await?;
                                co.delegate(array_source(items(rows))).await?;
                            }
                        }
                    }
                }
                if !batch.is_empty() {
                    let rows = flush(batch).await?;
                    co.delegate(array_source(items(rows))).await?;
                }
                Ok(())
            }
            .await;
            // `finally`
            nfs::rm(
                &staged,
                RmOptions {
                    recursive: true,
                    force: true,
                },
            )
            .await?;
            body
        })
    }

    /// `leaseRef(token)`.
    pub fn lease_ref(token: &W) -> Result<JsStr, W> {
        key_of(token)
            .and_then(|token| keys::lease_ref(token.units()))
            .ok_or_else(invalid)
    }

    /// `pin(token)`: an async function.
    pub fn pin(&self, ctx: &Ctx, token: &W) -> WPromise {
        let (store, ctx, token) = (self.clone(), ctx.clone(), token.clone());
        async_fn(async move {
            let inner = store.inner();
            store.commit(&ctx, None).await?;
            let lease = ChangeStore::lease_ref(&token)?;
            let tree = inner.tree.borrow().clone().unwrap_or_else(|| js("null"));
            store
                .run(
                    &ctx,
                    &[
                        js("update-ref"),
                        lease,
                        tree,
                        js(&"0".repeat(inner.oid_length)),
                    ],
                    &GitOptions::default(),
                )
                .await?;
            Ok(Resolution::Value(W::String(ChangeStore::lease_ref(
                &token,
            )?)))
        })
    }

    /// `release(token)`: not an async function (an invalid token throws at once).
    pub fn release(&self, ctx: &Ctx, token: &W) -> Result<WPromise, W> {
        let lease = ChangeStore::lease_ref(token)?;
        Ok(self.run(
            ctx,
            &[js("update-ref"), js("-d"), lease],
            &GitOptions::default(),
        ))
    }

    /// `importPrefix(source, prefix, destination = prefix)`: an async function.
    pub fn import_prefix(
        &self,
        ctx: &Ctx,
        source: &W,
        prefix: &W,
        destination: Option<&W>,
    ) -> WPromise {
        let (store, ctx) = (self.clone(), ctx.clone());
        let (source, prefix) = (source.clone(), prefix.clone());
        let destination = destination.cloned().unwrap_or_else(|| prefix.clone());
        async_fn(async move {
            let inner = store.inner();
            let source = match source {
                W::Undefined | W::Null => JsStr::new(),
                other => text_of(&other),
            };
            let (prefix, destination) = (text_of(&prefix), text_of(&destination));
            if !keys::valid_import_source(source.units())
                || !valid_prefix(&prefix)
                || !valid_prefix(&destination)
            {
                return Err(invalid());
            }
            let rows = agen::for_await(store.tree_rows(&ctx, source, prefix.clone()));
            while let Some(row) = rows.next().await? {
                let key = row_key(&row);
                let rest = &key.units()[prefix.len().min(key.len())..];
                inner.pending.borrow_mut().set(
                    concat(&[destination.units(), rest]),
                    Staged::Oid(text_of(&row.get("oid"))),
                );
            }
            Ok(Resolution::Value(W::Undefined))
        })
    }

    /// `committedIdentity(prefix)`: an async function.
    pub fn committed_identity(&self, ctx: &Ctx, prefix: &W) -> WPromise {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), text_of(prefix));
        async_fn(async move {
            let inner = store.inner();
            if !valid_prefix(&prefix) {
                return Err(invalid());
            }
            let Some(tree) = inner.tree.borrow().clone() else {
                return Ok(Resolution::Value(W::Null));
            };
            let name = concat(&[tree.units(), &[u16::from(b':')], prefix.units()]);
            if inner.reader {
                let found = store.await_read(&ctx, &W::String(name), true).await?;
                let is_tree = matches!(found.get("type"), W::String(kind) if kind == js("tree"));
                return Ok(Resolution::Value(if is_tree {
                    found.get("oid")
                } else {
                    W::Null
                }));
            }
            let verified = store
                .run(
                    &ctx,
                    &[js("rev-parse"), js("--verify"), name],
                    &GitOptions::default(),
                )
                .then(
                    |value| {
                        Ok(Resolution::Value(W::String(trim(&JsStr::from_utf8_lossy(
                            &bytes_of(&value),
                        )))))
                    },
                    |_| Ok(Resolution::Value(W::Null)),
                );
            Ok(Resolution::Promise(verified))
        })
    }

    /// `prefixIdentity(prefix)`: an async function.
    pub fn prefix_identity(&self, ctx: &Ctx, prefix: &W) -> WPromise {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), prefix.clone());
        async_fn(async move {
            if store.pending_count() > 0 {
                return Err(invalid());
            }
            Ok(Resolution::Promise(store.committed_identity(&ctx, &prefix)))
        })
    }

    /// `staged(prefix)`: an async function resolving `[key, value]` pairs
    /// (the JavaScript's `Map`, in its order).
    pub fn staged(&self, ctx: &Ctx, prefix: &W) -> WPromise {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), text_of(prefix));
        async_fn(async move {
            if !valid_prefix(&prefix) {
                return Err(invalid());
            }
            let mut result = Vec::new();
            for (key, data) in store.pending_under_sorted(&prefix) {
                let value = match data {
                    Staged::Null => W::Null,
                    Staged::Oid(_) => store.get(&ctx, &W::String(key.clone())).await?,
                    Staged::Data(data) => json_parse(&data)?,
                };
                result.push(W::Array(vec![W::String(key), value]));
            }
            Ok(Resolution::Value(W::Array(result)))
        })
    }

    /// `prefixIdentities(prefixes)`: an async function resolving
    /// `[prefix, oid | null]` pairs (the JavaScript's `Map`, in its order).
    pub fn prefix_identities(&self, ctx: &Ctx, prefixes: Vec<W>) -> WPromise {
        let (store, ctx) = (self.clone(), ctx.clone());
        async_fn(async move {
            let inner = store.inner();
            if store.pending_count() > 0
                || prefixes
                    .iter()
                    .any(|prefix| !valid_prefix(&text_of(prefix)))
            {
                return Err(invalid());
            }
            let mut result: Ordered<W> = Ordered::new();
            for prefix in &prefixes {
                result.set(text_of(prefix), W::Null);
            }
            let pairs = |result: &Ordered<W>| {
                W::Array(
                    result
                        .entries()
                        .into_iter()
                        .map(|(key, value)| W::Array(vec![W::String(key), value]))
                        .collect(),
                )
            };
            let Some(tree) = inner.tree.borrow().clone() else {
                return Ok(Resolution::Value(pairs(&result)));
            };
            if inner.reader {
                let mut start = 0;
                while start < prefixes.len() {
                    let slice = &prefixes[start..(start + 256).min(prefixes.len())];
                    let mut reads = Vec::new();
                    for prefix in slice {
                        let name =
                            concat(&[tree.units(), &[u16::from(b':')], text_of(prefix).units()]);
                        reads.push(store.read_object(&ctx, &W::String(name), true)?);
                    }
                    let found = Promise::all(reads).await?;
                    for (prefix, found) in slice.iter().zip(found.iter()) {
                        if matches!(found.get("type"), W::String(kind) if kind == js("tree")) {
                            result.set(text_of(prefix), found.get("oid"));
                        }
                    }
                    start += 256;
                }
                return Ok(Resolution::Value(pairs(&result)));
            }
            let mut start = 0;
            while start < prefixes.len() {
                let mut command = vec![
                    js("--literal-pathspecs"),
                    js("ls-tree"),
                    js("-z"),
                    tree.clone(),
                    js("--"),
                ];
                command.extend(
                    prefixes[start..(start + 128).min(prefixes.len())]
                        .iter()
                        .map(text_of),
                );
                let tokens = agen::for_await(store.run_tokens(&ctx, &command));
                while let Some(row) = tokens.next().await? {
                    let row = text_of(&row);
                    let units = row.units();
                    let (head, prefix) = match index_of(&row, u16::from(b'\t')) {
                        Some(tab) => (units[..tab].to_vec(), units[tab + 1..].to_vec()),
                        None => (
                            units[..units.len().saturating_sub(1)].to_vec(),
                            units.to_vec(),
                        ),
                    };
                    let fields = split_space(&trim(&JsStr::from_units(head)));
                    let prefix = JsStr::from_units(prefix);
                    if fields.get(1) == Some(&js("tree")) && result.has(&prefix) {
                        result.set(
                            prefix,
                            fields
                                .get(2)
                                .map_or(W::Undefined, |oid| W::String(oid.clone())),
                        );
                    }
                }
                start += 128;
            }
            Ok(Resolution::Value(pairs(&result)))
        })
    }

    /// `committedRows(prefix)`: an async generator.
    pub fn committed_rows(&self, ctx: &Ctx, prefix: &W) -> AsyncGen<W, W> {
        let (store, ctx, prefix) = (self.clone(), ctx.clone(), text_of(prefix));
        agen::async_gen(move |co: Co<W, W>| async move {
            let tree = store.inner().tree.borrow().clone();
            if let Some(tree) = tree {
                co.delegate(store.tree_rows(&ctx, tree, prefix)).await?;
            }
            Ok(())
        })
    }

    /// `readRows(rows)`.
    pub fn read_rows(&self, ctx: &Ctx, rows: Values) -> AsyncGen<W, W> {
        self.values(ctx, rows)
    }
}

fn items(value: W) -> Vec<W> {
    match value {
        W::Array(items) => items,
        _ => Vec::new(),
    }
}

fn to_number_of(value: &W) -> f64 {
    crate::value::to_number(value)
}

/// `data.subarray(start, end)` with JavaScript's negative indices.
fn slice(data: &[u8], start: isize, end: isize) -> Vec<u8> {
    let length = data.len() as isize;
    let clamp = |index: isize| {
        if index < 0 {
            (length + index).max(0)
        } else {
            index.min(length)
        }
    };
    let (start, end) = (clamp(start), clamp(end));
    if start >= end {
        return Vec::new();
    }
    data[start as usize..end as usize].to_vec()
}

// --- listTreeRows (session-changes-trees.js) ----------------------------------

/// `sortName(entry)`: a subtree's name as if it ended in `/`.
fn sort_name(entry: &TreeEntry) -> JsStr {
    if entry.mode == js(TREE_MODE) {
        concat(&[entry.name.units(), &[u16::from(b'/')]])
    } else {
        entry.name.clone()
    }
}

/// `inGitOrder(entries)`: strictly in Git's order, no name twice (latin1
/// strings compared by code unit, which is by byte).
fn in_git_order(entries: &[TreeEntry]) -> bool {
    let mut names: HashSet<JsStr> = HashSet::new();
    let mut last: Option<JsStr> = None;
    for entry in entries {
        let key = sort_name(entry);
        if last
            .as_ref()
            .is_some_and(|last| last.units() >= key.units())
            || names.contains(&entry.name)
        {
            return false;
        }
        names.insert(entry.name.clone());
        last = Some(key);
    }
    true
}

/// `LISTED_MODES.get(mode)`.
fn listed_type(mode: &JsStr) -> Option<&'static str> {
    match mode.to_string_lossy().as_str() {
        "100644" | "100755" | "120000" => Some("blob"),
        "160000" => Some("commit"),
        _ => None,
    }
}

/// `decodeName(name)`: an ASCII latin1 name as it is, else its bytes as UTF-8.
fn decode_name(name: &JsStr) -> JsStr {
    if name.units().iter().all(|unit| *unit < 0x80) {
        return name.clone();
    }
    let bytes: Vec<u8> = ledger_core::tree::latin1_bytes(name.units()).collect();
    JsStr::from_utf8_lossy(&bytes)
}

/// `inBatches(items, read)` of `listTreeRows`: an async function, the reads
/// `batch` (256) at a time, each batch `await Promise.all(slice.map(read))`.
fn in_batches(items: Vec<JsStr>, read: Rc<dyn Fn(&JsStr) -> WPromise>) -> WPromise {
    async_fn(async move {
        let mut results: Vec<W> = Vec::new();
        let mut at = 0;
        while at < items.len() {
            let started: Vec<Resolution<W, W>> = items[at..(at + 256).min(items.len())]
                .iter()
                .map(|item| Resolution::Promise(read(item)))
                .collect();
            let settled = Promise::all(started).await?;
            results.extend(settled);
            at += 256;
        }
        Ok(Resolution::Value(W::Array(results)))
    })
}

/// `listTreeRows({ tree, oidLength, readTree: readListedTree, sizeOf, prefix })`
/// as `listDirect` calls it: an async function resolving the rows
/// `{ mode, type, oid, size, key }` (`size` `'-'` for a submodule) in Git's
/// order, or `null` where Git must answer.
fn list_tree_rows(store: &ChangeStore, ctx: &Ctx, tree: JsStr, prefix: JsStr) -> WPromise {
    let (store, ctx) = (store.clone(), ctx.clone());
    async_fn(async move {
        let oid_length = store.inner().oid_length;
        let read_tree: Rc<dyn Fn(&JsStr) -> WPromise> = {
            let (store, ctx) = (store.clone(), ctx.clone());
            Rc::new(move |oid: &JsStr| store.read_listed_tree(&ctx, oid))
        };
        let size_of: Rc<dyn Fn(&JsStr) -> WPromise> = {
            let (store, ctx) = (store.clone(), ctx.clone());
            Rc::new(move |oid: &JsStr| store.size_of(&ctx, oid))
        };
        let mut parsed: HashMap<JsStr, Vec<TreeEntry>> = HashMap::new();
        let mut sizes: Ordered<W> = Ordered::new();
        let mut frontier: Vec<(JsStr, JsStr)> = vec![(tree.clone(), prefix.clone())];
        while !frontier.is_empty() {
            let mut unread: Vec<JsStr> = Vec::new();
            for (oid, _) in &frontier {
                if !unread.contains(oid) && !parsed.contains_key(oid) {
                    unread.push(oid.clone());
                }
            }
            let contents = in_batches(unread.clone(), read_tree.clone()).await?;
            // port: for-of over an awaited value (`for (const [index, data] of contents.entries())`)
            for (index, data) in items(contents).into_iter().enumerate() {
                let W::Bytes(data) = data else {
                    return Ok(Resolution::Value(W::Null));
                };
                let Ok(entries) = parse_tree(&data, oid_length) else {
                    return Ok(Resolution::Value(W::Null));
                };
                if !in_git_order(&entries) {
                    return Ok(Resolution::Value(W::Null));
                }
                parsed.insert(unread[index].clone(), entries);
            }
            let mut next = Vec::new();
            for (oid, path) in &frontier {
                for entry in parsed.get(oid).map(Vec::as_slice).unwrap_or_default() {
                    let name = concat(&[path.units(), entry.name.units()]);
                    if entry.mode == js(TREE_MODE) {
                        next.push((
                            entry.oid.clone(),
                            concat(&[name.units(), &[u16::from(b'/')]]),
                        ));
                        continue;
                    }
                    let Some(kind) = listed_type(&entry.mode) else {
                        return Ok(Resolution::Value(W::Null));
                    };
                    if kind == "blob" {
                        sizes.set(entry.oid.clone(), W::Null);
                    }
                }
            }
            frontier = next;
        }
        let blobs: Vec<JsStr> = sizes.entries().into_iter().map(|(oid, _)| oid).collect();
        let found = in_batches(blobs.clone(), size_of).await?;
        // port: for-of over an awaited value (`for (const [index, size] of (await inBatches(…)).entries())`)
        for (index, size) in items(found).into_iter().enumerate() {
            if matches!(size, W::Null) {
                return Ok(Resolution::Value(W::Null));
            }
            sizes.set(blobs[index].clone(), size);
        }
        // `emit(tree, prefix)`: depth first, each tree's entries in order
        // (a stack here, where the JavaScript recurses).
        let mut rows = Vec::new();
        let mut stack: Vec<(JsStr, JsStr, usize)> = vec![(tree, prefix, 0)];
        while let Some((oid, path, at)) = stack.pop() {
            let entries = parsed.get(&oid).map(Vec::as_slice).unwrap_or_default();
            let Some(entry) = entries.get(at) else {
                continue;
            };
            stack.push((oid.clone(), path.clone(), at + 1));
            let name = concat(&[path.units(), entry.name.units()]);
            if entry.mode == js(TREE_MODE) {
                stack.push((
                    entry.oid.clone(),
                    concat(&[name.units(), &[u16::from(b'/')]]),
                    0,
                ));
                continue;
            }
            let kind = listed_type(&entry.mode).unwrap_or("blob");
            let size = if kind == "blob" {
                sizes.get(&entry.oid).cloned().unwrap_or(W::Undefined)
            } else {
                W::string("-")
            };
            rows.push(W::object(vec![
                ("mode", W::String(entry.mode.clone())),
                ("type", W::string(kind)),
                ("oid", W::String(entry.oid.clone())),
                ("size", size),
                ("key", W::String(decode_name(&name))),
            ]));
        }
        Ok(Resolution::Value(W::Array(rows)))
    })
}

// --- commitTreeChanges ---------------------------------------------------

/// A node of the change tree: a directory (a `Map` of further nodes) or
/// a change (`{ value }`).
#[derive(Clone)]
enum Node {
    Directory(Rc<RefCell<Ordered<Node>>>),
    Change(Staged),
}

/// `writeObject(type, content)`: a promise of the object's id.
pub type WriteObject = Rc<dyn Fn(&str, Rc<Vec<u8>>) -> WPromise>;

/// What `commitTreeChanges` is given besides the tree and the changes:
/// `readTree` (an async function: a tree's content, else it throws) and
/// `writeObject` (`(type, content) => promise of the id`).
#[derive(Clone)]
pub struct TreeIo {
    pub oid_length: usize,
    pub read_tree: Rc<dyn Fn(&JsStr) -> WPromise>,
    pub write_object: WriteObject,
}

/// The store's `TreeIo` of `commitDirect`: `readTree` is its async arrow
/// over the reader (one task of its own, [`tree_reader`]), `writeObject`
/// `writeLooseObject(objectsDir, …)`.
fn store_tree_io(store: &ChangeStore, ctx: &Ctx, objects_dir: &str) -> TreeIo {
    let oid_length = store.inner().oid_length;
    let (reading, ctx, objects_dir) = (store.clone(), ctx.clone(), objects_dir.to_owned());
    TreeIo {
        oid_length,
        read_tree: tree_reader(Rc::new(move |name: &W| {
            reading.read_object(&ctx, name, false)
        })),
        write_object: Rc::new(move |kind: &str, content: Rc<Vec<u8>>| {
            odb::write_loose_object(&objects_dir, kind, content, oid_length)
        }),
    }
}

/// `commitTreeChanges({ tree, changes, oidLength, readTree, writeObject })`:
/// an async function resolving the new root tree's id.
pub fn commit_tree_changes(
    io: TreeIo,
    tree: Option<JsStr>,
    changes: Vec<(JsStr, Staged)>,
) -> WPromise {
    async_fn(async move {
        let root = Rc::new(RefCell::new(Ordered::<Node>::new()));
        for (key, value) in &changes {
            let parts: Vec<JsStr> = key
                .units()
                .split(|unit| *unit == u16::from(b'/'))
                .map(|part| JsStr::from_units(part.to_vec()))
                .collect();
            let mut node = root.clone();
            let Some((name, directories)) = parts.split_last() else {
                return Err(invalid());
            };
            for part in directories {
                let child = node.borrow().get(part).cloned();
                let child = match child {
                    None => {
                        let made = Rc::new(RefCell::new(Ordered::new()));
                        node.borrow_mut()
                            .set(part.clone(), Node::Directory(made.clone()));
                        made
                    }
                    Some(Node::Directory(directory)) => directory,
                    Some(Node::Change(_)) => return Err(invalid()),
                };
                node = child;
            }
            if matches!(node.borrow().get(name), Some(Node::Directory(_))) {
                return Err(invalid());
            }
            node.borrow_mut()
                .set(name.clone(), Node::Change(value.clone()));
        }
        let blobs: Rc<RefCell<Ordered<WPromise>>> = Rc::new(RefCell::new(Ordered::new()));
        for (_, value) in &changes {
            if let Staged::Data(data) = value
                && !blobs.borrow().has(data)
            {
                let writing = (io.write_object)("blob", Rc::new(data.to_utf8()));
                writing.clone().react(|_| {});
                blobs.borrow_mut().set(data.clone(), writing);
            }
        }
        Ok(Resolution::Promise(rewrite(
            io,
            tree,
            Node::Directory(root),
            true,
            blobs,
        )))
    })
}

/// `readTree` of `commitDirect` over `readObject`: its async arrow
/// (`async (oid) => { const found = await readObject(oid); if (found?.type
/// !== 'tree') throw changeError('invalid_change_record', 503); return
/// found.data; }`), one task of its own per read.
pub fn tree_reader(read_object: Rc<dyn Fn(&W) -> Ret>) -> Rc<dyn Fn(&JsStr) -> WPromise> {
    Rc::new(move |oid: &JsStr| {
        let (read_object, oid) = (read_object.clone(), oid.clone());
        async_fn(async move {
            let found = Promise::resolve(read_object(&W::String(oid))?).await?;
            if !matches!(found.get("type"), W::String(kind) if kind == js("tree")) {
                return Err(invalid_503());
            }
            Ok(Resolution::Value(found.get("data")))
        })
    })
}

/// `rewrite(oid, node, isRoot)`: an async function.
fn rewrite(
    io: TreeIo,
    oid: Option<JsStr>,
    node: Node,
    is_root: bool,
    blobs: Rc<RefCell<Ordered<WPromise>>>,
) -> WPromise {
    async_fn(async move {
        let entries: Rc<RefCell<Ordered<TreeEntry>>> = Rc::new(RefCell::new(Ordered::new()));
        if let Some(oid) = &oid {
            let data = bytes_of(&(io.read_tree)(oid).await?);
            let parsed = parse_tree(&data, io.oid_length).map_err(|_| invalid_503())?;
            for entry in parsed {
                entries.borrow_mut().set(entry.name.clone(), entry);
            }
        }
        let Node::Directory(children) = node else {
            return Err(type_error("a change is not a directory"));
        };
        let children = children.borrow().entries();
        let mut started = Vec::new();
        for (name, change) in children {
            let (io, entries, blobs) = (io.clone(), entries.clone(), blobs.clone());
            started.push(Resolution::Promise(async_fn::<W, W>(async move {
                let existing = entries.borrow().get(&name).cloned();
                if let Node::Directory(_) = &change {
                    if existing
                        .as_ref()
                        .is_some_and(|entry| entry.mode != js(TREE_MODE))
                    {
                        return Err(invalid());
                    }
                    let child = rewrite(
                        io,
                        existing.as_ref().map(|entry| entry.oid.clone()),
                        change,
                        false,
                        blobs,
                    )
                    .await?;
                    match child {
                        W::String(child) => entries
                            .borrow_mut()
                            .set(name.clone(), TreeEntry::new(TREE_MODE, name.clone(), child)),
                        _ => entries.borrow_mut().delete(&name),
                    }
                    return Ok(Resolution::Value(W::Undefined));
                }
                if existing
                    .as_ref()
                    .is_some_and(|entry| entry.mode == js(TREE_MODE))
                {
                    return Err(invalid());
                }
                let Node::Change(value) = change else {
                    return Ok(Resolution::Value(W::Undefined));
                };
                match value {
                    Staged::Null => entries.borrow_mut().delete(&name),
                    Staged::Data(data) => {
                        // `await blobs.get(value)`: every new blob's write was started.
                        let writing = blobs.borrow().get(&data).cloned();
                        let oid = match writing {
                            Some(writing) => writing.await?,
                            None => W::Undefined,
                        };
                        entries.borrow_mut().set(
                            name.clone(),
                            TreeEntry::new(BLOB_MODE, name.clone(), text_of(&oid)),
                        );
                    }
                    Staged::Oid(oid) => entries
                        .borrow_mut()
                        .set(name.clone(), TreeEntry::new(BLOB_MODE, name.clone(), oid)),
                }
                Ok(Resolution::Value(W::Undefined))
            })));
        }
        Promise::all(started).await?;
        if entries.borrow().len() == 0 && !is_root {
            return Ok(Resolution::Value(W::Null));
        }
        let listed: Vec<TreeEntry> = entries
            .borrow()
            .entries()
            .into_iter()
            .map(|(_, entry)| entry)
            .collect();
        Ok(Resolution::Promise((io.write_object)(
            "tree",
            Rc::new(serialize_tree(&listed)),
        )))
    })
}

/// Unused by the product yet; kept so a reader of a stored blob can turn it
/// back into a seam value.
pub fn parse_record(text: &JsStr) -> Result<W, W> {
    json_parse(text)
}

/// `Obj` of `[key, value]` pairs, for callers that need an object.
pub fn object_of_pairs(pairs: &[(JsStr, W)]) -> W {
    let mut out = Obj::new();
    for (key, value) in pairs {
        out.set(key.clone(), value.clone());
    }
    W::Object(out)
}

/// The first value of `from_core` for a stored JSON text (tests).
pub fn core_value(text: &JsStr) -> Option<W> {
    ledger_core::js::parse(text.units())
        .ok()
        .map(|value| from_core(&value))
}

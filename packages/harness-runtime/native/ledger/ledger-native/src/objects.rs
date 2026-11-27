//! The ledger's content object store, `lib/session-mutation-files.js`
//! ported (plan package L3c) on the job layer, with `hasDirectoryAncestors`
//! of `lib/session-changes-snapshot.js` and `bytesFor` of
//! `lib/session-mutations.js` beside it. Nothing in the product calls it yet.
//!
//! Content objects are `<root>/objects/<sha256>` (raw bytes, 0o600). A new
//! one is written to `.pending-<uuid>` (`wx`, 0o600) from a stable
//! observation of the project file (its stamp checked before and after the
//! read, and again by path), synced, `link`ed into place (`EEXIST` means
//! present), and the temporary unlinked; the directory is marked pending
//! (`durability`) and the identity recorded in `verified-objects.v1`.
//! Content already present (by name and size) is reused, its directory
//! marked pending when the object may be younger than the last directory
//! sync. Views copy objects with `copyFile` (`COPYFILE_EXCL |
//! COPYFILE_FICLONE`: libuv's copy, which clones only on Linux), once each
//! object's bytes are verified per file identity, in memory and in
//! `verified-objects.v1`.
//!
//! One JavaScript async function is one `async_fn`, one `await` one
//! `.await`; a JavaScript function that returns a promise chain
//! (`removeTemporaryFile`, `observed`, `persistVerified`, `ensure`) returns
//! the same chain. The module state (`verifiedObjects`, `persistedRoots`) is
//! the loop thread's, as the JavaScript module's is the worker's.
//!
//! Not ported: the Windows branches (`removeTemporaryFile`'s `fs.rm`), and
//! `putBytes` of `session-mutations.js` (it writes through
//! `writeFileAtomic`, whose asynchronous form is not on the job layer).
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use ledger_core::js::JsStr;
use ledger_core::paths::safe_change_path;

use crate::agen;
use crate::ctx::{Ctx, check_execution_admission, execution_progress, execution_step, js_error};
use crate::durability::{mark_object_directory_pending, mark_object_if_unsynced};
use crate::git::change_error;
use crate::host;
use crate::js::{self, Promise, Resolution, async_fn};
use crate::node::fs::{
    self as nfs, COPYFILE_EXCL, COPYFILE_FICLONE, Data, FileHandle, Flags, MkdirOptions, Stats,
    WriteOptions, constants,
};
use crate::node::stream::{ReadStreamOptions, create_read_stream};
use crate::node::{code_of, odb};
use crate::value::{Obj, W, to_js_string};

/// `GRANULAR_TEXT_BYTES`: past this size a file is kept whole, not as text.
pub const GRANULAR_TEXT_BYTES: i64 = 8 * 1024 * 1024;
/// `Buffer.allocUnsafe(128 * 1024)`: the observation's and the copy's reads.
const CHUNK: usize = 128 * 1024;
const MAX_VERIFIED_OBJECTS: usize = 100_000;
const VERIFIED_OBJECTS_FILE: &str = "verified-objects.v1";

/// What the functions take of `repo`: its `root` (the ledger's directory)
/// and `directory` (the project's).
#[derive(Clone, Debug)]
pub struct Repo {
    pub root: String,
    pub directory: String,
}

fn unsupported_path() -> W {
    change_error("unsupported_path", 409.0)
}

fn observation_changed() -> W {
    change_error("observation_changed", 409.0)
}

fn invalid_change_record() -> W {
    change_error("invalid_change_record", 409.0)
}

fn storage_unavailable() -> W {
    change_error("storage_unavailable", 503.0)
}

fn full(code: &str) -> bool {
    code == "ENOSPC" || code == "EDQUOT"
}

/// `/^[a-f0-9]{64}$/.test(value)` of a string (no `m` flag: `$` is the end).
fn object_name(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `stamp(stat)` of a bigint stat: `dev:ino:size:mtimeNs:ctimeNs:mode`.
pub fn stamp(stat: &Stats) -> String {
    stat.big().stamp(true)
}

/// `mutationStatStamp`: [`stamp`] of an lstat the caller holds.
pub fn mutation_stat_stamp(stat: &Stats) -> String {
    stamp(stat)
}

/// `objectIdentity(stat)`: the stamp without the mode.
fn object_identity(stat: &Stats) -> String {
    stat.big().stamp(false)
}

/// `absent(cause)`: `ENOENT` and `ENOTDIR` are `null`; anything else throws.
fn absent<T: Clone + 'static>(cause: W) -> Result<Resolution<Option<T>, W>, W> {
    if ["ENOENT", "ENOTDIR"].contains(&code_of(&cause).as_str()) {
        Ok(Resolution::Value(None))
    } else {
        Err(cause)
    }
}

/// `fs.lstat(path, { bigint }).catch(absent)`.
fn lstat_or_absent(path: &str, bigint: bool) -> Promise<Option<Stats>, W> {
    nfs::lstat(path, bigint).then(|stat| Ok(Resolution::Value(Some(stat))), absent)
}

/// The directories a walk already confirmed (`verified` of
/// `hasDirectoryAncestors`).
pub type Verified = Rc<RefCell<HashSet<String>>>;

/// `hasDirectoryAncestors(directory, file, verified)`: an async function.
pub fn has_directory_ancestors(
    directory: &str,
    file: &str,
    verified: Option<Verified>,
) -> Promise<bool, W> {
    let (directory, file) = (directory.to_owned(), file.to_owned());
    async_fn(async move {
        if !safe_change_path(JsStr::from(file.as_str()).units()) {
            return Err(unsupported_path());
        }
        let mut parent = odb::dirname(&odb::join(&[&directory, &file]));
        let mut confirmed = Vec::new();
        let mut complete = true;
        while parent != directory {
            if verified
                .as_ref()
                .is_some_and(|known| known.borrow().contains(&parent))
            {
                break;
            }
            let stat = lstat_or_absent(&parent, false).await?;
            if let Some(stat) = &stat
                && (!stat.is_directory() || stat.is_symbolic_link())
            {
                return Ok(Resolution::Value(false));
            }
            if stat.is_some() {
                confirmed.push(parent.clone());
            } else {
                complete = false;
            }
            parent = odb::dirname(&parent);
        }
        if let Some(known) = &verified
            && complete
        {
            known.borrow_mut().extend(confirmed);
        }
        Ok(Resolution::Value(true))
    })
}

/// `mutationFileStamp(directory, file, verifiedAncestors)`: an async
/// function; `null` (`None`) for a path that is not there.
pub fn mutation_file_stamp(
    directory: &str,
    file: &str,
    verified: Option<Verified>,
) -> Promise<Option<String>, W> {
    let (directory, file) = (directory.to_owned(), file.to_owned());
    async_fn(async move {
        if !has_directory_ancestors(&directory, &file, verified).await? {
            return Ok(Resolution::Value(None));
        }
        let stat = lstat_or_absent(&odb::join(&[&directory, &file]), true).await?;
        Ok(Resolution::Value(stat.as_ref().map(stamp)))
    })
}

/// `requireMutationSpace(directory, bytes)`: an async function.
pub fn require_mutation_space(directory: &str, bytes: i128) -> Promise<(), W> {
    let directory = directory.to_owned();
    async_fn(async move {
        let space = nfs::statfs(&directory, true).await?;
        let available = i128::from(space.raw.bavail) * i128::from(space.raw.bsize);
        if available < bytes + 1024 * 1024 {
            return Err(storage_unavailable());
        }
        Ok(Resolution::Value(()))
    })
}

/// `describe(stat, digest, whole)`.
fn describe(stat: &Stats, digest: &str, whole: bool) -> W {
    let raw = stat.big();
    let mode = raw.mode;
    let mut out = Obj::new();
    out.put("hash", W::string(digest));
    out.put(
        "mode",
        W::string(if stat.is_symbolic_link() {
            "120000"
        } else if mode & 0o111 != 0 {
            "100755"
        } else {
            "100644"
        }),
    );
    if stat.is_file() {
        out.put("permissions", W::Number((mode & 0o7777) as f64));
    }
    out.put("identity", W::string(&format!("{}:{}", raw.dev, raw.ino)));
    out.put("observation", W::string(&stamp(stat)));
    out.put("size", W::Number(raw.size as f64));
    out.put("whole", W::Bool(whole));
    W::Object(out)
}

/// `observed(action)`: a path that vanished or changed type since its lstat
/// is a changed observation (`action().catch(…)`).
fn observed<T: Clone + 'static>(started: Promise<T, W>) -> Promise<T, W> {
    started.catch(|cause| {
        if ["ENOENT", "ELOOP", "ENOTDIR", "EINVAL"].contains(&code_of(&cause).as_str()) {
            return Err(observation_changed());
        }
        Err(cause)
    })
}

/// What `readObservation` hands each piece of the file to: an async
/// function of the bytes.
type Accept = Rc<dyn Fn(Rc<Vec<u8>>) -> Promise<(), W>>;

/// `readObservation(directory, file, target, stat, accept)`: an async
/// function. A link's target is read as raw bytes; a file through a handle
/// opened `O_RDONLY | O_NOFOLLOW`, its stamp checked before and after the
/// reads.
fn read_observation(target: &str, stat: Stats, accept: Accept) -> Promise<(), W> {
    let target = target.to_owned();
    async_fn(async move {
        if stat.is_symbolic_link() {
            let bytes = observed(nfs::readlink_bytes(&target)).await?;
            accept(bytes).await?;
            return Ok(Resolution::Value(()));
        }
        let input = observed(nfs::open(
            &target,
            Flags::Bits(constants::O_RDONLY | constants::O_NOFOLLOW),
            None,
        ))
        .await?;
        // The tests' change hook (nothing, in the product).
        crate::seams::observation("open", &target);
        let body: Result<(), W> = async {
            if stamp(&input.stat(true).await?) != stamp(&stat) {
                return Err(observation_changed());
            }
            loop {
                let read = input.read(CHUNK, None).await?;
                if read.bytes_read == 0 {
                    crate::seams::observation("eof", &target);
                    break;
                }
                crate::seams::observation("read", &target);
                accept(read.bytes).await?;
            }
            if stamp(&input.stat(true).await?) != stamp(&stat) {
                return Err(observation_changed());
            }
            Ok(())
        }
        .await;
        // `finally { await input.close(); }`
        input.close().await?;
        crate::seams::observation("close", &target);
        body?;
        Ok(Resolution::Value(()))
    })
}

/// `classifier(stat)`: whether the content is kept whole (a link, past 8
/// MiB, a NUL byte, or not UTF-8 by a fatal streaming `TextDecoder`).
struct Classifier {
    whole: Cell<bool>,
    /// The bytes of a sequence a piece ended inside of (at most three).
    pending: RefCell<Vec<u8>>,
}

impl Classifier {
    fn new(stat: &Stats) -> Rc<Classifier> {
        Rc::new(Classifier {
            whole: Cell::new(stat.is_symbolic_link() || stat.big().size > GRANULAR_TEXT_BYTES),
            pending: RefCell::new(Vec::new()),
        })
    }

    /// `update(bytes)`: a piece with a NUL makes the content whole without
    /// decoding; otherwise `decoder.decode(bytes, { stream: true })`.
    fn update(&self, bytes: &[u8]) {
        if self.whole.get() {
            return;
        }
        if bytes.contains(&0) {
            self.whole.set(true);
            return;
        }
        let mut pending = self.pending.borrow_mut();
        let mut joined = std::mem::take(&mut *pending);
        joined.extend_from_slice(bytes);
        match std::str::from_utf8(&joined) {
            Ok(_) => {}
            Err(error) if error.error_len().is_none() => {
                *pending = joined[error.valid_up_to()..].to_vec();
            }
            Err(_) => self.whole.set(true),
        }
    }

    /// The `whole` getter: a sequence left open at the end fails
    /// `decoder.decode()`, which also resets the decoder.
    fn whole(&self) -> bool {
        if !self.whole.get() && !std::mem::take(&mut *self.pending.borrow_mut()).is_empty() {
            self.whole.set(true);
        }
        self.whole.get()
    }
}

/// `removeTemporaryFile(file)` off Windows: `fs.unlink(file).catch(…)`, a
/// missing file fine.
pub fn remove_temporary_file(file: &str) -> Promise<(), W> {
    nfs::unlink(file).catch(|cause| {
        if code_of(&cause) != "ENOENT" {
            return Err(cause);
        }
        Ok(Resolution::Value(()))
    })
}

/// `inspectMutationFile(repo, file, directory = repo.directory, { preview })`:
/// an async function. Resolves to the file's description or `null`.
pub fn inspect_mutation_file(
    ctx: &Ctx,
    repo: &Repo,
    file: &str,
    directory: Option<&str>,
    preview: bool,
) -> Promise<W, W> {
    let ctx = ctx.clone();
    let root = repo.root.clone();
    let directory = directory.unwrap_or(&repo.directory).to_owned();
    let file = file.to_owned();
    async_fn(async move {
        check_execution_admission(&ctx)?;
        if !has_directory_ancestors(&directory, &file, None).await? {
            return Ok(Resolution::Value(W::Null));
        }
        let target = odb::join(&[&directory, &file]);
        let Some(stat) = lstat_or_absent(&target, true).await? else {
            return Ok(Resolution::Value(W::Null));
        };
        if !stat.is_file() && !stat.is_symbolic_link() {
            return Err(change_error("unsupported_file_type", 409.0));
        }
        let objects = odb::join(&[&root, "objects"]);
        // Hash before copying: content already in the object store is
        // neither copied nor synced again.
        {
            let hash = Rc::new(RefCell::new(odb::Sha256::new()));
            let kind = Classifier::new(&stat);
            let size = Rc::new(Cell::new(0usize));
            let accept: Accept = {
                let (ctx, hash, kind, size) =
                    (ctx.clone(), hash.clone(), kind.clone(), size.clone());
                Rc::new(move |bytes: Rc<Vec<u8>>| {
                    let (ctx, hash, kind, size) =
                        (ctx.clone(), hash.clone(), kind.clone(), size.clone());
                    async_fn(async move {
                        check_execution_admission(&ctx)?;
                        hash.borrow_mut().update(&bytes);
                        kind.update(&bytes);
                        size.set(size.get() + bytes.len());
                        execution_progress(&ctx);
                        Ok(Resolution::Value(()))
                    })
                })
            };
            read_observation(&target, stat, accept).await?;
            if mutation_file_stamp(&directory, &file, None).await? != Some(stamp(&stat)) {
                return Err(observation_changed());
            }
            let digest = hash.borrow().clone().digest_hex();
            if preview {
                return Ok(Resolution::Value(describe(&stat, &digest, kind.whole())));
            }
            let existing = nfs::lstat(&odb::join(&[&objects, &digest]), false)
                .then(
                    |stat| Ok(Resolution::Value(Some(stat))),
                    |cause| {
                        if code_of(&cause) == "ENOENT" {
                            return Ok(Resolution::Value(None));
                        }
                        Err(cause)
                    },
                )
                .await?;
            if let Some(existing) = existing
                && existing.is_file()
                && existing.size() == size.get() as f64
            {
                mark_object_if_unsynced(&objects, existing.ctime_ms());
                return Ok(Resolution::Value(describe(&stat, &digest, kind.whole())));
            }
        }
        nfs::mkdir(
            &objects,
            MkdirOptions {
                recursive: true,
                mode: 0o700,
            },
        )
        .await?;
        require_mutation_space(&objects, i128::from(stat.big().size)).await?;
        let temporary = odb::join(&[&objects, &format!(".pending-{}", odb::random_uuid())]);
        let hash = Rc::new(RefCell::new(odb::Sha256::new()));
        let kind = Classifier::new(&stat);
        let output: Rc<RefCell<Option<FileHandle>>> = Rc::new(RefCell::new(None));
        let body: Result<W, W> = async {
            let opened = nfs::open(&temporary, Flags::Str("wx"), Some(0o600)).await?;
            crate::seams::content_opened(&temporary);
            *output.borrow_mut() = Some(opened);
            let accept: Accept = {
                let (ctx, hash, kind, output) =
                    (ctx.clone(), hash.clone(), kind.clone(), output.clone());
                Rc::new(move |bytes: Rc<Vec<u8>>| {
                    let (ctx, hash, kind, output) =
                        (ctx.clone(), hash.clone(), kind.clone(), output.clone());
                    async_fn(async move {
                        check_execution_admission(&ctx)?;
                        hash.borrow_mut().update(&bytes);
                        kind.update(&bytes);
                        let handle = output.borrow().clone().expect("the temporary is open");
                        let mut offset = 0usize;
                        while offset < bytes.len() {
                            offset += handle
                                .write(&bytes, offset, bytes.len() - offset, None)
                                .await?;
                        }
                        execution_progress(&ctx);
                        Ok(Resolution::Value(()))
                    })
                })
            };
            read_observation(&target, stat, accept).await?;
            if mutation_file_stamp(&directory, &file, None).await? != Some(stamp(&stat)) {
                return Err(observation_changed());
            }
            let handle = output.borrow().clone().expect("the temporary is open");
            let synced = handle.sync().await;
            crate::seams::content_outcome("sync", &temporary, synced)?;
            let closed = handle.close().await;
            crate::seams::content_outcome("close", &temporary, closed)?;
            *output.borrow_mut() = None;
            let digest = hash.borrow().clone().digest_hex();
            // Objects are immutable: a hard link installs once without
            // replacing an existing reader's inode.
            crate::seams::crash_point("content-object-link:before");
            let (linked, refused) = (temporary.clone(), temporary.clone());
            let installed = nfs::link(&temporary, &odb::join(&[&objects, &digest]))
                .then(
                    move |()| {
                        crate::seams::content_linked(&linked, "ok");
                        crate::seams::crash_point("content-object-link:after");
                        Ok(Resolution::Value(true))
                    },
                    move |cause| {
                        crate::seams::content_linked(&refused, &code_of(&cause));
                        if code_of(&cause) != "EEXIST" {
                            return Err(cause);
                        }
                        Ok(Resolution::Value(false))
                    },
                )
                .await?;
            // The ledger commit that references this object syncs the
            // directory first.
            mark_object_directory_pending(&objects);
            // Unlinking the temporary changes the object's change time:
            // record the identity only after it is gone.
            if installed {
                remove_temporary_file(&temporary).await?;
                record_installed_object(&objects, &digest).await?;
            }
            Ok(describe(&stat, &digest, kind.whole()))
        }
        .await;
        // `catch (cause)`
        let body = body.map_err(|cause| {
            if full(&code_of(&cause)) {
                storage_unavailable()
            } else {
                cause
            }
        });
        // `finally { await output?.close(); await removeTemporaryFile(temporary); }`
        let open = output.borrow_mut().take();
        match open {
            Some(handle) => {
                let closed = handle.close().await;
                crate::seams::content_outcome("close", &temporary, closed)?;
            }
            None => js::value::<W, W>(W::Undefined).await.map(|_| ())?,
        }
        remove_temporary_file(&temporary).await?;
        Ok(Resolution::Value(body?))
    })
}

/// A JavaScript `Map` of strings in insertion order: `get`, `has`, `set`
/// (an existing key keeps its place), `delete`, the first key, iteration.
#[derive(Default)]
struct OrderedMap {
    next: u64,
    values: HashMap<String, (u64, String)>,
    order: BTreeMap<u64, String>,
}

impl OrderedMap {
    fn get(&self, key: &str) -> Option<&String> {
        self.values.get(key).map(|(_, value)| value)
    }

    fn has(&self, key: &str) -> bool {
        self.values.contains_key(key)
    }

    fn set(&mut self, key: &str, value: &str) {
        if let Some(entry) = self.values.get_mut(key) {
            entry.1 = value.to_owned();
            return;
        }
        self.next += 1;
        self.order.insert(self.next, key.to_owned());
        self.values
            .insert(key.to_owned(), (self.next, value.to_owned()));
    }

    fn delete(&mut self, key: &str) {
        if let Some((at, _)) = self.values.remove(key) {
            self.order.remove(&at);
        }
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn first_key(&self) -> Option<String> {
        self.order.values().next().cloned()
    }

    fn entries(&self) -> Vec<(String, String)> {
        self.order
            .values()
            .map(|key| (key.clone(), self.values[key].1.clone()))
            .collect()
    }

    fn clear(&mut self) {
        self.values.clear();
        self.order.clear();
    }
}

thread_local! {
    /// `verifiedObjects`: hash → the identity its bytes were verified at.
    static VERIFIED: RefCell<OrderedMap> = RefCell::new(OrderedMap::default());
    /// `persistedRoots`: each root's load of `verified-objects.v1`, once.
    static PERSISTED_ROOTS: RefCell<HashMap<String, Promise<(), W>>> = RefCell::new(HashMap::new());
}

/// `persistentVerify()`: read per use.
fn persistent_verify() -> bool {
    host::env("DEVRYAN_PERSISTENT_OBJECT_VERIFY").as_deref() != Some("0")
}

fn verified_identity(hash: &str) -> Option<String> {
    VERIFIED.with(|verified| verified.borrow().get(hash).cloned())
}

/// `rememberVerified(expected, identity)`.
fn remember_verified(expected: &str, identity: &str) {
    VERIFIED.with(|verified| {
        let mut verified = verified.borrow_mut();
        verified.delete(expected);
        verified.set(expected, identity);
        while verified.len() > MAX_VERIFIED_OBJECTS {
            if let Some(first) = verified.first_key() {
                verified.delete(&first);
            }
        }
    });
}

/// `VERIFIED_LINE.exec(line)`: `^([a-f0-9]{64}) (\d+:\d+:\d+:\d+:\d+)$`.
fn verified_line(line: &str) -> Option<(&str, &str)> {
    let (hash, identity) = line.split_at_checked(64)?;
    let identity = identity.strip_prefix(' ')?;
    if !object_name(hash) {
        return None;
    }
    let parts: Vec<&str> = identity.split(':').collect();
    if parts.len() != 5
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some((hash, identity))
}

/// `loadVerifiedObjects(root)`: one load per root and process, its failure
/// swallowed (rehashing is always correct).
fn load_verified_objects(root: &str) -> Promise<(), W> {
    if let Some(pending) = PERSISTED_ROOTS.with(|roots| roots.borrow().get(root).cloned()) {
        return pending;
    }
    let owned = root.to_owned();
    let pending = async_fn(async move {
        let file = odb::join(&[&owned, VERIFIED_OBJECTS_FILE]);
        let text = nfs::read_file_utf8(&file)
            .then(
                |text| Ok(Resolution::Value(text)),
                |cause| {
                    if code_of(&cause) == "ENOENT" {
                        return Ok(Resolution::Value(JsStr::new()));
                    }
                    Err(cause)
                },
            )
            .await?;
        let mut latest = OrderedMap::default();
        let mut lines = 0usize;
        let text = text.to_string_lossy();
        for line in text.split('\n') {
            let Some((hash, identity)) = verified_line(line) else {
                continue;
            };
            lines += 1;
            latest.delete(hash);
            latest.set(hash, identity);
        }
        for (hash, identity) in latest.entries() {
            if !VERIFIED.with(|verified| verified.borrow().has(&hash)) {
                remember_verified(&hash, &identity);
            }
        }
        // Appends repeat an object whose identity changed; compact once the
        // file holds twice as many lines as live objects.
        if lines > 1_024 && lines > latest.len() * 2 {
            let temporary = odb::join(&[
                &owned,
                &format!(".{VERIFIED_OBJECTS_FILE}-{}", odb::random_uuid()),
            ]);
            let text: String = latest
                .entries()
                .iter()
                .map(|(hash, identity)| format!("{hash} {identity}\n"))
                .collect();
            let body: Result<(), W> = async {
                nfs::write_file(
                    &temporary,
                    &Data::Text(JsStr::from(text.as_str())),
                    WriteOptions {
                        mode: 0o600,
                        flag: Flags::Str("wx"),
                    },
                )
                .await?;
                nfs::rename(&temporary, &file).await?;
                Ok(())
            }
            .await;
            // `finally`
            remove_temporary_file(&temporary).await?;
            body?;
        }
        Ok(Resolution::Value(()))
    })
    .catch(|_| Ok(Resolution::Value(())));
    PERSISTED_ROOTS.with(|roots| roots.borrow_mut().insert(root.to_owned(), pending.clone()));
    pending
}

/// `persistVerified(root, expected, identity)`: an append, its failure
/// swallowed.
fn persist_verified(root: &str, expected: &str, identity: &str) -> Promise<(), W> {
    nfs::append_file(
        &odb::join(&[root, VERIFIED_OBJECTS_FILE]),
        &Data::Text(JsStr::from(format!("{expected} {identity}\n").as_str())),
        WriteOptions {
            mode: 0o600,
            flag: Flags::Str("a"),
        },
    )
    .catch(|_| Ok(Resolution::Value(())))
}

/// `resetVerifiedMutationObjects()` (tests only): forget what this process
/// verified.
pub fn reset_verified_mutation_objects() {
    VERIFIED.with(|verified| verified.borrow_mut().clear());
    PERSISTED_ROOTS.with(|roots| roots.borrow_mut().clear());
}

/// `verifyMutationObject(file, expected)`: an async function. Hashes the
/// object unless its identity was verified before.
fn verify_mutation_object(ctx: &Ctx, file: &str, expected: &str) -> Promise<(), W> {
    let ctx = ctx.clone();
    let (file, expected) = (file.to_owned(), expected.to_owned());
    async_fn(async move {
        let root = odb::dirname(&odb::dirname(&file));
        if persistent_verify() {
            load_verified_objects(&root).await?;
        }
        let stat = nfs::stat(&file, true).await?;
        let identity = object_identity(&stat);
        if verified_identity(&expected).as_deref() == Some(identity.as_str()) {
            return Ok(Resolution::Value(()));
        }
        let mut hash = odb::Sha256::new();
        let chunks = agen::for_await(create_read_stream(&file, ReadStreamOptions::DEFAULT));
        while let Some(chunk) = chunks.next().await? {
            if let Err(reason) = check_execution_admission(&ctx) {
                return Err(chunks.close_throw(reason).await);
            }
            if let W::Bytes(bytes) = &chunk {
                hash.update(bytes);
            }
            execution_progress(&ctx);
        }
        if hash.digest_hex() != expected {
            return Err(invalid_change_record());
        }
        execution_step(&ctx, &JsStr::from("object_verify_hashed"), 0.0, None);
        remember_verified(&expected, &identity);
        if persistent_verify() {
            persist_verified(&root, &expected, &identity).await?;
        }
        Ok(Resolution::Value(()))
    })
}

/// `recordInstalledObject(objects, digest)`: an async function. The
/// installer just hashed these bytes, so the new object is verified.
fn record_installed_object(objects: &str, digest: &str) -> Promise<(), W> {
    let (objects, digest) = (objects.to_owned(), digest.to_owned());
    async_fn(async move {
        if !persistent_verify() {
            return Ok(Resolution::Value(()));
        }
        let stat = nfs::stat(&odb::join(&[&objects, &digest]), true)
            .then(
                |stat| Ok(Resolution::Value(Some(stat))),
                |_| Ok(Resolution::Value(None)),
            )
            .await?;
        let Some(stat) = stat.filter(Stats::is_file) else {
            return Ok(Resolution::Value(()));
        };
        let identity = object_identity(&stat);
        if verified_identity(&digest).as_deref() == Some(identity.as_str()) {
            return Ok(Resolution::Value(()));
        }
        remember_verified(&digest, &identity);
        persist_verified(&odb::dirname(&objects), &digest, &identity).await?;
        Ok(Resolution::Value(()))
    })
}

/// What a view materializer runs its I/O through (`io`, by default
/// `(action) => action()`; the product passes the execution I/O pool).
pub type Io = Rc<dyn Fn(Box<dyn FnOnce() -> Promise<W, W>>) -> Promise<W, W>>;

struct MaterializerState {
    root: String,
    view: String,
    directories: RefCell<HashMap<String, Promise<Option<String>, W>>>,
    io: Io,
}

/// `createViewMaterializer(repo, view, { io })`'s function.
#[derive(Clone)]
pub struct ViewMaterializer(Rc<MaterializerState>);

/// `createViewMaterializer(repo, view, { io })`.
pub fn create_view_materializer(repo: &Repo, view: &str, io: Option<Io>) -> ViewMaterializer {
    let mut directories = HashMap::new();
    directories.insert(view.to_owned(), js::value(None));
    ViewMaterializer(Rc::new(MaterializerState {
        root: repo.root.clone(),
        view: view.to_owned(),
        directories: RefCell::new(directories),
        io: io.unwrap_or_else(|| Rc::new(|action| action())),
    }))
}

/// `ensure(directory)`: each directory created and checked once per
/// materializer, its chain kept (a failure stays the answer). A directory
/// whose parent is itself (`/`, reached only from a view that is not a
/// normalized path) recurses until the stack ends, as the JavaScript's does:
/// a `RangeError` thrown at the call.
fn ensure(state: &Rc<MaterializerState>, directory: &str) -> Result<Promise<Option<String>, W>, W> {
    let known = state.directories.borrow().get(directory).cloned();
    if let Some(pending) = known {
        return Ok(pending);
    }
    let parent = odb::dirname(directory);
    if parent == directory {
        return Err(js_error("RangeError", "Maximum call stack size exceeded"));
    }
    let made = directory.to_owned();
    let checked = directory.to_owned();
    let pending = ensure(state, &parent)?
        .then_ok(move |_| {
            Ok(Resolution::Promise(nfs::mkdir(
                &made,
                MkdirOptions::default(),
            )))
        })
        .catch(move |cause| {
            Ok(Resolution::Promise(async_fn(async move {
                if code_of(&cause) != "EEXIST" {
                    return Err(cause);
                }
                let stat = nfs::lstat(&checked, false).await?;
                if !stat.is_directory() || stat.is_symbolic_link() {
                    return Err(unsupported_path());
                }
                Ok(Resolution::Value(None))
            })))
        });
    state
        .directories
        .borrow_mut()
        .insert(directory.to_owned(), pending.clone());
    Ok(pending)
}

/// `entry?.hash ?? ''`, or `entry.hash ?? ''` (`optional` false: a missing
/// entry throws V8's `TypeError`).
fn hash_of(entry: &W, optional: bool) -> Result<JsStr, W> {
    if matches!(entry, W::Null | W::Undefined) {
        if optional {
            return Ok(JsStr::new());
        }
        let shown = if matches!(entry, W::Null) {
            "null"
        } else {
            "undefined"
        };
        return Err(js_error(
            "TypeError",
            &format!("Cannot read properties of {shown} (reading 'hash')"),
        ));
    }
    Ok(match entry.get("hash") {
        W::Null | W::Undefined => JsStr::new(),
        hash => to_js_string(&hash),
    })
}

impl ViewMaterializer {
    /// The materializer's async function `(file, entry, mode)`: the file's
    /// bigint lstat once its object is copied into place, or `null` for a
    /// link or an existing entry (the caller's general writer then).
    pub fn materialize(
        &self,
        ctx: &Ctx,
        file: &W,
        entry: &W,
        mode: u32,
    ) -> Promise<Option<Stats>, W> {
        let state = self.0.clone();
        let ctx = ctx.clone();
        let (file, entry) = (file.clone(), entry.clone());
        async_fn(async move {
            let file = match &file {
                W::String(file) if safe_change_path(file.units()) => file.to_string_lossy(),
                _ => return Err(unsupported_path()),
            };
            let hash = hash_of(&entry, true)?.to_string_lossy();
            if !object_name(&hash) {
                return Err(invalid_change_record());
            }
            if matches!(entry.get("mode"), W::String(mode) if mode.to_string_lossy() == "120000") {
                return Ok(Resolution::Value(None));
            }
            let target = odb::join(&[&state.view, &file]);
            ensure(&state, &odb::dirname(&target))?.await?;
            let object = odb::join(&[&state.root, "objects", &hash]);
            let copied = {
                let (ctx, object, target, hash) =
                    (ctx.clone(), object.clone(), target.clone(), hash.clone());
                (state.io)(Box::new(move || {
                    async_fn(async move {
                        verify_mutation_object(&ctx, &object, &hash).await?;
                        check_execution_admission(&ctx)?;
                        nfs::copy_file(&object, &target, COPYFILE_EXCL | COPYFILE_FICLONE).await?;
                        Ok(Resolution::Value(W::Undefined))
                    })
                }))
                .await
            };
            if let Err(cause) = copied {
                let code = code_of(&cause);
                if code == "EEXIST" {
                    return Ok(Resolution::Value(None));
                }
                if full(&code) {
                    return Err(storage_unavailable());
                }
                return Err(cause);
            }
            nfs::chmod(&target, mode).await?;
            execution_progress(&ctx);
            Ok(Resolution::Promise(nfs::lstat_into(&target, true, Some)))
        })
    }
}

/// `copyMutationObject(repo, entry, target, mode, { durable })`: an async
/// function. `durable: false` (disposable execution views) copies with
/// `copyFile` unless `DEVRYAN_VIEW_CLONE` is `0`; otherwise the bytes are
/// read, hashed and written to `<target>.devryan-<uuid>`, then renamed.
pub fn copy_mutation_object(
    ctx: &Ctx,
    repo: &Repo,
    entry: &W,
    target: &str,
    mode: u32,
    durable: bool,
) -> Promise<(), W> {
    let ctx = ctx.clone();
    let root = repo.root.clone();
    let entry = entry.clone();
    let target = target.to_owned();
    async_fn(async move {
        let hash = hash_of(&entry, false)?.to_string_lossy();
        if !object_name(&hash) {
            return Err(invalid_change_record());
        }
        let object = odb::join(&[&root, "objects", &hash]);
        if !durable && host::env("DEVRYAN_VIEW_CLONE").as_deref() != Some("0") {
            verify_mutation_object(&ctx, &object, &hash).await?;
            let temporary = format!("{target}.devryan-{}", odb::random_uuid());
            let body: Result<(), W> = async {
                nfs::mkdir(
                    &odb::dirname(&target),
                    MkdirOptions {
                        recursive: true,
                        mode: 0o777,
                    },
                )
                .await?;
                check_execution_admission(&ctx)?;
                nfs::copy_file(&object, &temporary, COPYFILE_FICLONE).await?;
                nfs::chmod(&temporary, mode).await?;
                nfs::rename(&temporary, &target).await?;
                execution_progress(&ctx);
                Ok(())
            }
            .await;
            let body = body.map_err(|cause| {
                if full(&code_of(&cause)) {
                    storage_unavailable()
                } else {
                    cause
                }
            });
            // `finally`
            remove_temporary_file(&temporary).await?;
            body?;
            return Ok(Resolution::Value(()));
        }
        let source = nfs::open(&object, Flags::Str("r"), None).await?;
        let temporary = format!("{target}.devryan-{}", odb::random_uuid());
        let output: Rc<RefCell<Option<FileHandle>>> = Rc::new(RefCell::new(None));
        let object_hex = hash.clone();
        let body: Result<(), W> = async {
            nfs::mkdir(
                &odb::dirname(&target),
                MkdirOptions {
                    recursive: true,
                    mode: 0o777,
                },
            )
            .await?;
            if durable {
                let size = source.stat(false).await?.size();
                require_mutation_space(&odb::dirname(&target), size as i128).await?;
            }
            let opened = nfs::open(&temporary, Flags::Str("wx"), Some(mode)).await?;
            crate::seams::content_opened(&temporary);
            *output.borrow_mut() = Some(opened.clone());
            let mut hash = odb::Sha256::new();
            loop {
                check_execution_admission(&ctx)?;
                let read = source.read(CHUNK, None).await?;
                if read.bytes_read == 0 {
                    break;
                }
                hash.update(&read.bytes);
                let mut offset = 0usize;
                while offset < read.bytes_read {
                    offset += opened
                        .write(&read.bytes, offset, read.bytes_read - offset, None)
                        .await?;
                }
                execution_progress(&ctx);
            }
            if hash.digest_hex() != object_hex {
                return Err(invalid_change_record());
            }
            opened.chmod(mode).await?;
            if durable {
                let synced = opened.sync().await;
                crate::seams::content_outcome("sync", &temporary, synced)?;
            }
            let closed = opened.close().await;
            crate::seams::content_outcome("close", &temporary, closed)?;
            *output.borrow_mut() = None;
            nfs::rename(&temporary, &target).await?;
            Ok(())
        }
        .await;
        let body = body.map_err(|cause| {
            if full(&code_of(&cause)) {
                storage_unavailable()
            } else {
                cause
            }
        });
        // `finally { await source.close(); await output?.close(); await removeTemporaryFile(temporary); }`
        source.close().await?;
        let open = output.borrow_mut().take();
        match open {
            Some(handle) => {
                let closed = handle.close().await;
                crate::seams::content_outcome("close", &temporary, closed)?;
            }
            None => js::value::<W, W>(W::Undefined).await.map(|_| ())?,
        }
        remove_temporary_file(&temporary).await?;
        body?;
        Ok(Resolution::Value(()))
    })
}

/// `bytesFor(repo, hash)` of `session-mutations.js`: an async function. The
/// object's bytes, re-hashed: a name that is not a hash, or bytes that do
/// not hash to it, fail `invalid_change_record`.
pub fn bytes_for(repo: &Repo, hash: &W) -> Promise<Rc<Vec<u8>>, W> {
    let root = repo.root.clone();
    let hash = hash.clone();
    async_fn(async move {
        let hash = match &hash {
            W::String(hash) if object_name(&hash.to_string_lossy()) => hash.to_string_lossy(),
            _ => return Err(invalid_change_record()),
        };
        let bytes = nfs::read_file(&odb::join(&[&root, "objects", &hash])).await?;
        if odb::sha256_hex(&bytes) != hash {
            return Err(invalid_change_record());
        }
        Ok(Resolution::Value(bytes))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The classifier's verdict for content cut into `pieces`.
    fn whole(pieces: &[&[u8]]) -> bool {
        let kind = Classifier {
            whole: Cell::new(false),
            pending: RefCell::new(Vec::new()),
        };
        for piece in pieces {
            kind.update(piece);
        }
        kind.whole()
    }

    #[test]
    fn the_classifier_is_a_fatal_streaming_utf8_decoder_with_a_nul_rule() {
        assert!(!whole(&[b"", b"plain text\n"]));
        // A character split across pieces is still text; left open at the end it is not.
        assert!(!whole(&[&[0x61, 0xe2], &[0x82, 0xac], b"!"]));
        assert!(whole(&[&[0x61, 0xe2, 0x82]]));
        assert!(whole(&[b"a\0b"]));
        assert!(whole(&[&[0xff]]));
        // Surrogates, overlong forms and code points past U+10FFFF are refused.
        assert!(whole(&[&[0xed, 0xa0, 0x80]]));
        assert!(whole(&[&[0xc0, 0xaf]]));
        assert!(whole(&[&[0xf4, 0x90, 0x80, 0x80]]));
        // Once whole, always whole (a later piece is not decoded).
        assert!(whole(&[&[0xff], b"text"]));
    }

    #[test]
    fn verified_lines_follow_the_javascript_pattern() {
        let hash = "a".repeat(64);
        assert_eq!(
            verified_line(&format!("{hash} 1:2:3:4:5")),
            Some((hash.as_str(), "1:2:3:4:5"))
        );
        for refused in [
            format!("{hash} -1:2:3:4:5"),
            format!("{hash} 1:2:3:4"),
            format!("{hash} 1:2:3:4:5:6"),
            format!("{hash} 1::3:4:5"),
            format!("{hash}  1:2:3:4:5"),
            format!("{hash} 1:2:3:4:5\r"),
            format!("{} 1:2:3:4:5", "A".repeat(64)),
            format!("{} 1:2:3:4:5", "a".repeat(63)),
            String::from("short"),
        ] {
            assert_eq!(verified_line(&refused), None, "{refused}");
        }
        assert!(object_name(&"0123456789abcdef".repeat(4)));
        assert!(!object_name(&"0123456789abcdeF".repeat(4)) && !object_name(""));
    }

    #[test]
    fn the_ordered_map_keeps_insertion_order_as_a_javascript_map() {
        let mut map = OrderedMap::default();
        map.set("b", "1");
        map.set("a", "2");
        map.set("b", "3");
        assert_eq!(
            map.entries(),
            [("b".into(), "3".into()), ("a".into(), "2".into())]
        );
        map.delete("b");
        map.set("b", "4");
        assert_eq!(map.first_key().as_deref(), Some("a"));
        assert_eq!(map.len(), 2);
        assert!(map.has("b") && !map.has("c"));
        map.clear();
        assert_eq!(map.len(), 0);
    }
}

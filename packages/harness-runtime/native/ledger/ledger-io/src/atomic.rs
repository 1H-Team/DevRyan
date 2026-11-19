//! `writeFileAtomic`, `withCrossProcessFileLock` and `cleanupStaleAtomicFiles`
//! of `packages/harness-runtime/lib/atomic-file.js` (Unix paths only), step
//! for step: the same file-system calls in the same order, the same names,
//! modes, retry gaps, timeouts, error codes and lock bytes.
//!
//! The lock is a cross-process contract: the server, the ledger worker, the
//! bundle tools and the installed desktop updater all take it with the
//! JavaScript. `scripts/ledger-native/` runs every scenario of the shared
//! specification against both and compares results, codes and traces.
//!
//! Everything the JavaScript lets a caller inject is injectable here too:
//! the file system (`Fs`), the clock, the wait, the liveness check, the
//! random token and identifier, the abort signal and the progress observer
//! (`Env`). What the JavaScript does not let a caller inject (`process.pid`,
//! `crypto.randomUUID` for the lock's temporary name) has a method with the
//! real default, so a recording can name it.
//!
//! The functions block. The JavaScript awaits each call; a caller that needs
//! concurrency runs these on a blocking thread, as libuv runs file-system
//! calls on its pool.
#![forbid(unsafe_code)]

use ledger_core::js::{
    JsObject, JsStr, ParseErrorKind, Value, number_to_string, parse, stringify_utf8,
};

use crate::fs::{self, DirEntry, Error, OpenFlags, Result, Stat};
use crate::path;

/// `DEFAULT_STALE_TMP_AGE_MS`: 24 hours.
pub const DEFAULT_STALE_TMP_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `DEFAULT_LOCK_TIMEOUT_MS`.
pub const DEFAULT_LOCK_TIMEOUT_MS: f64 = 5_000.0;
/// `DEFAULT_LOCK_RETRY_MS`.
pub const DEFAULT_LOCK_RETRY_MS: f64 = 25.0;
/// `DEFAULT_MALFORMED_LOCK_STALE_MS`.
pub const DEFAULT_MALFORMED_LOCK_STALE_MS: f64 = 30_000.0;
/// The message of a `LOCK_TIMEOUT`.
pub const LOCK_TIMEOUT_MESSAGE: &str = "Timed out acquiring cross-process file lock";
/// Link errors after which the lock is published with an exclusive create.
const UNSUPPORTED_LINK: [&str; 3] = ["ENOSYS", "ENOTSUP", "EOPNOTSUPP"];

/// An open file as `fs.promises.open` returns it (`FileHandle`).
pub trait FileHandle {
    fn write_file(&mut self, data: &[u8]) -> Result<()>;
    fn sync(&mut self) -> Result<()>;
    fn close(&mut self) -> Result<()>;
}

/// The calls of `node:fs/promises` this module makes, with Node's semantics.
pub trait Fs {
    /// `mkdir(path, { recursive: true, mode })`.
    fn mkdir_recursive(&self, path: &str, mode: u32) -> Result<()>;
    /// `readdir(path, { withFileTypes: true })`.
    fn readdir(&self, path: &str) -> Result<Vec<DirEntry>>;
    /// `stat(path)`.
    fn stat(&self, path: &str) -> Result<Stat>;
    /// `rm(path, { force: true })`.
    fn rm_force(&self, path: &str) -> Result<()>;
    /// `open(path, flags, mode)`.
    fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> Result<Box<dyn FileHandle + '_>>;
    fn rename(&self, from: &str, to: &str) -> Result<()>;
    fn chmod(&self, path: &str, mode: u32) -> Result<()>;
    fn link(&self, from: &str, to: &str) -> Result<()>;
    fn unlink(&self, path: &str) -> Result<()>;
    /// `readFile(path, 'utf8')`.
    fn read_file_utf8(&self, path: &str) -> Result<JsStr>;
}

/// The real file system, through `crate::fs`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealFs;

impl FileHandle for fs::File {
    fn write_file(&mut self, data: &[u8]) -> Result<()> {
        fs::File::write_file(self, data)
    }
    fn sync(&mut self) -> Result<()> {
        fs::File::sync(self)
    }
    fn close(&mut self) -> Result<()> {
        fs::File::close(self)
    }
}

impl Fs for RealFs {
    fn mkdir_recursive(&self, path: &str, mode: u32) -> Result<()> {
        fs::mkdir_recursive(path, mode)
    }
    fn readdir(&self, path: &str) -> Result<Vec<DirEntry>> {
        fs::readdir(path)
    }
    fn stat(&self, path: &str) -> Result<Stat> {
        fs::stat(path)
    }
    fn rm_force(&self, path: &str) -> Result<()> {
        rm_force(path)
    }
    fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> Result<Box<dyn FileHandle + '_>> {
        Ok(Box::new(fs::File::open(path, flags, mode)?))
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        fs::rename(from, to)
    }
    fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        fs::chmod(path, mode)
    }
    fn link(&self, from: &str, to: &str) -> Result<()> {
        fs::link(from, to)
    }
    fn unlink(&self, path: &str) -> Result<()> {
        fs::unlink(path)
    }
    fn read_file_utf8(&self, path: &str) -> Result<JsStr> {
        Ok(JsStr::from_utf8_lossy(&fs::read_file(path)?))
    }
}

/// `fs.promises.rm(path, { force: true })` in Node 24: `validateRmOptions`
/// `lstat`s (a missing path is fine, a directory is `ERR_FS_EISDIR`), then
/// the bundled rimraf `lstat`s again and unlinks, removing a directory that
/// appeared in between with its children. No retries (`maxRetries: 0`).
pub fn rm_force(target: &str) -> Result<()> {
    match fs::lstat(target) {
        Err(error) if error.is_not_found() => {}
        Err(error) => return Err(error),
        Ok(stat) if stat.is_directory() => {
            let mut error = Error::coded(
                "ERR_FS_EISDIR",
                &format!("Path is a directory: rm returned EISDIR (is a directory) {target}"),
            );
            // Node's SystemError carries the positive errno (`os.constants.errno.EISDIR`).
            error.errno = Some(fs::EISDIR);
            error.path = Some(target.to_owned());
            error.syscall = Some("rm");
            return Err(error);
        }
        Ok(_) => {}
    }
    match rimraf(target) {
        Err(error) if error.is_not_found() => Ok(()),
        other => other,
    }
}

/// rimraf's `_rimraf`, without Windows' branches.
fn rimraf(target: &str) -> Result<()> {
    match fs::lstat(target) {
        Err(error) if error.is_not_found() => return Ok(()),
        Ok(stat) if stat.is_directory() => return rimraf_dir(target, None),
        // Any other lstat failure still tries the unlink, as rimraf does.
        _ => {}
    }
    match fs::unlink(target) {
        Ok(()) => Ok(()),
        Err(error) if error.is_not_found() => Ok(()),
        Err(error) if error.code == "EISDIR" || error.code == "EPERM" => {
            rimraf_dir(target, Some(error))
        }
        Err(error) => Err(error),
    }
}

/// rimraf's `_rmdir`: a directory that is not empty (or EPERM / EEXIST)
/// loses its children first; `ENOTDIR` reports the original error.
fn rimraf_dir(target: &str, original: Option<Error>) -> Result<()> {
    match fs::rmdir(target) {
        Ok(()) => Ok(()),
        Err(error) if matches!(error.code.as_str(), "ENOTEMPTY" | "EEXIST" | "EPERM") => {
            // `_rmchildren`: the children (in parallel in JavaScript), then the directory.
            for entry in fs::readdir(target)? {
                match rimraf(&format!("{target}/{}", entry.name)) {
                    Err(child) if !child.is_not_found() => return Err(child),
                    _ => {}
                }
            }
            fs::rmdir(target)
        }
        Err(error) if error.code == "ENOTDIR" => match original {
            Some(original) => Err(original),
            None => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// What the JavaScript reads from `options` and its process.
pub trait Env {
    /// `options.now ?? Date.now`.
    fn now(&mut self) -> f64 {
        date_now()
    }
    /// `options.wait ?? (ms => new Promise(r => setTimeout(r, ms)))`.
    fn wait(&mut self, milliseconds: f64) {
        set_timeout_sleep(milliseconds);
    }
    /// `options.isProcessAlive ?? isProcessAlive`.
    fn is_process_alive(&mut self, pid: f64) -> bool {
        is_process_alive(pid)
    }
    /// `options.randomToken ?? (() => crypto.randomUUID().replaceAll('-', ''))`.
    fn random_token(&mut self) -> Result<JsStr> {
        Ok(JsStr::from(random_hex_id()?.as_str()))
    }
    /// `options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''))`.
    fn random_id(&mut self) -> Result<String> {
        random_hex_id()
    }
    /// `crypto.randomUUID()` (the lock's temporary name; not injectable in JavaScript).
    fn random_uuid(&mut self) -> Result<String> {
        random_uuid()
    }
    /// `process.pid` (not injectable in JavaScript).
    fn pid(&mut self) -> i64 {
        fs::getpid()
    }
    /// `options.signal?.throwIfAborted()`: `Err(reason)` once aborted.
    fn throw_if_aborted(&mut self) -> Result<()> {
        Ok(())
    }
    /// `options.onProgress?.({ phase, state })`; whatever it does is ignored.
    fn on_progress(&mut self, _phase: &str, _state: &str) {}
}

/// The defaults of every `Env` method.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemEnv;

impl Env for SystemEnv {}

/// `Date.now()`: whole milliseconds since the epoch.
pub fn date_now() -> f64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis() as f64,
        Err(before) => -(before.duration().as_millis() as f64),
    }
}

/// `setTimeout(resolve, ms)`: a delay outside 1 ..= 2^31 - 1 (or NaN) is 1 ms;
/// libuv's timer counts whole milliseconds.
pub fn set_timeout_sleep(milliseconds: f64) {
    let after = if (1.0..=2_147_483_647.0).contains(&milliseconds) {
        milliseconds.trunc()
    } else {
        1.0
    };
    std::thread::sleep(std::time::Duration::from_millis(after as u64));
}

/// `isProcessAlive(pid)`: `process.kill(pid, 0)` succeeds, or fails with
/// `EPERM`. `process.kill` refuses a pid that is not a 32-bit integer with
/// `ERR_INVALID_ARG_TYPE`, which counts as dead.
pub fn is_process_alive(pid: f64) -> bool {
    if pid != to_int32(pid) as f64 {
        return false;
    }
    match fs::kill_zero(to_int32(pid)) {
        Ok(()) => true,
        Err(code) => code == "EPERM",
    }
}

/// ECMAScript `ToInt32`.
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    let modulo = value.trunc().rem_euclid(4_294_967_296.0);
    (if modulo >= 2_147_483_648.0 {
        modulo - 4_294_967_296.0
    } else {
        modulo
    }) as i32
}

/// `crypto.randomUUID()`: version 4, variant 10, lowercase.
pub fn random_uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    fs::random_bytes(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// `crypto.randomUUID().replaceAll('-', '')`.
pub fn random_hex_id() -> Result<String> {
    Ok(random_uuid()?.replace('-', ""))
}

/// `Math.max(a, b)` and `Math.min(a, b)`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `cleanupStaleAtomicFiles(filePath, { fs, now, staleAfterMs })`: removes
/// `<name>.tmp-*` regular files beside `file_path` whose `mtimeMs` is at
/// least `stale_after_ms` (default 24 h) old, and returns how many.
pub fn cleanup_stale_atomic_files(
    file_path: &str,
    stale_after_ms: Option<f64>,
    fs: &dyn Fs,
    env: &mut dyn Env,
) -> Result<u32> {
    let stale_after_ms = stale_after_ms.unwrap_or(DEFAULT_STALE_TMP_AGE_MS);
    let directory = path::dirname(file_path);
    let prefix = format!("{}.tmp-", path::basename(file_path));
    let entries = match fs.readdir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.is_not_found() => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries {
        if !entry.is_file || !entry.name.starts_with(&prefix) {
            continue;
        }
        let candidate = path::join(&[&directory, &entry.name]);
        let outcome = (|| -> Result<bool> {
            let stat = fs.stat(&candidate)?;
            if env.now() - stat.mtime_ms() < stale_after_ms {
                return Ok(false);
            }
            fs.rm_force(&candidate)?;
            Ok(true)
        })();
        match outcome {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) if error.is_not_found() => {}
            Err(error) => return Err(error),
        }
    }
    Ok(removed)
}

/// The options `writeFileAtomic` reads (besides those in `Env`).
#[derive(Clone, Copy, Debug, Default)]
pub struct WriteOptions {
    /// `options.mode ?? 0o600`.
    pub mode: Option<u32>,
    /// `options.directoryMode ?? 0o700`.
    pub directory_mode: Option<u32>,
    /// `options.staleTmpAgeMs` (the cleanup's default when absent).
    pub stale_tmp_age_ms: Option<f64>,
}

/// `writeFileAtomic(filePath, data, options)`: create the directory, clean
/// stale temporaries, write `<file>.tmp-<pid>-<now>-<id>` (`wx`, the mode),
/// sync, close, rename over the file, chmod, sync the directory. On failure
/// the temporary is closed and removed (both failures ignored) and the
/// original error returned. Each phase reports `started` and, if it did not
/// fail, `completed`.
pub fn write_file_atomic(
    file_path: &str,
    data: &[u8],
    options: &WriteOptions,
    fs: &dyn Fs,
    env: &mut dyn Env,
) -> Result<()> {
    let mode = options.mode.unwrap_or(0o600);
    let directory_mode = options.directory_mode.unwrap_or(0o700);
    let directory = path::dirname(file_path);
    let pid = env.pid();
    let now = env.now();
    let id = env.random_id()?;
    let temporary = format!("{file_path}.tmp-{pid}-{}-{id}", number_to_string(now));

    env.on_progress("directory_create", "started");
    fs.mkdir_recursive(&directory, directory_mode)?;
    env.on_progress("directory_create", "completed");
    env.on_progress("temporary_cleanup", "started");
    cleanup_stale_atomic_files(file_path, options.stale_tmp_age_ms, fs, env)?;
    env.on_progress("temporary_cleanup", "completed");

    let mut handle: Option<Box<dyn FileHandle + '_>> = None;
    let outcome = (|| -> Result<()> {
        env.on_progress("temporary_open", "started");
        handle = Some(fs.open(&temporary, OpenFlags::WriteExclusive, mode)?);
        env.on_progress("temporary_open", "completed");
        let open = handle.as_mut().expect("opened above");
        env.on_progress("write", "started");
        open.write_file(data)?;
        env.on_progress("write", "completed");
        env.on_progress("file_sync", "started");
        open.sync()?;
        env.on_progress("file_sync", "completed");
        env.on_progress("file_close", "started");
        open.close()?;
        env.on_progress("file_close", "completed");
        handle = None;
        env.on_progress("rename", "started");
        fs.rename(&temporary, file_path)?;
        env.on_progress("rename", "completed");
        env.on_progress("permissions", "started");
        fs.chmod(file_path, mode)?;
        env.on_progress("permissions", "completed");
        env.on_progress("directory_sync", "started");
        sync_directory(fs, &directory)?;
        env.on_progress("directory_sync", "completed");
        Ok(())
    })();
    if let Err(error) = outcome {
        if let Some(mut open) = handle.take() {
            let _ = open.close();
        }
        let _ = fs.rm_force(&temporary);
        return Err(error);
    }
    Ok(())
}

/// `syncDirectory(fsApi, directory)`: open `'r'`, sync, and close even when
/// the sync failed (a close failure then replaces the sync's).
pub fn sync_directory(fs: &dyn Fs, directory: &str) -> Result<()> {
    let mut handle = fs.open(directory, OpenFlags::Read, 0o666)?;
    let synced = handle.sync();
    let closed = handle.close();
    match (synced, closed) {
        (_, Err(error)) => Err(error),
        (result, Ok(())) => result,
    }
}

/// A parsed lock owner (`parseLockOwner`).
#[derive(Clone, Debug, PartialEq)]
pub struct LockOwner {
    pub owner_token: JsStr,
    pub pid: f64,
    pub created_at: f64,
}

/// `parseLockOwner(raw)`: an object whose `ownerToken` is a non-empty
/// string, `pid` a positive integer and `createdAt` a finite number of at
/// least 0; anything else, or a text `JSON.parse` refuses, is `None`.
///
/// One difference from V8, failing closed: a text nested deeper than
/// `ledger_core::js::MAX_DEPTH` (512) is an error here (`ERR_LEDGER_LOCK_TOO_DEEP`),
/// where V8 would parse it. No implementation ever writes such a lock.
pub fn parse_lock_owner(raw: &JsStr) -> Result<Option<LockOwner>> {
    let value = match parse(raw.units()) {
        Ok(value) => value,
        Err(error) if error.kind == ParseErrorKind::TooDeep => {
            return Err(Error::coded(
                "ERR_LEDGER_LOCK_TOO_DEEP",
                "lock file nests deeper than the native JSON reader allows",
            ));
        }
        Err(_) => return Ok(None),
    };
    let Value::Object(ref object) = value else {
        return Ok(None);
    };
    let Some(Value::String(owner_token)) = object.get_str("ownerToken") else {
        return Ok(None);
    };
    if owner_token.is_empty() {
        return Ok(None);
    }
    let Some(Value::Number(pid)) = object.get_str("pid") else {
        return Ok(None);
    };
    if !(pid.is_finite() && pid.trunc() == *pid) || *pid <= 0.0 {
        return Ok(None);
    }
    let Some(Value::Number(created_at)) = object.get_str("createdAt") else {
        return Ok(None);
    };
    if !created_at.is_finite() || *created_at < 0.0 {
        return Ok(None);
    }
    Ok(Some(LockOwner {
        owner_token: owner_token.clone(),
        pid: *pid,
        created_at: *created_at,
    }))
}

/// The lock file's bytes: `` `${JSON.stringify({ ownerToken, pid, createdAt })}\n` ``.
pub fn lock_bytes(owner_token: &JsStr, pid: i64, created_at: f64) -> Vec<u8> {
    let mut object = JsObject::new();
    object.insert(
        JsStr::from("ownerToken"),
        Value::String(owner_token.clone()),
    );
    object.insert(JsStr::from("pid"), Value::Number(pid as f64));
    object.insert(JsStr::from("createdAt"), Value::Number(created_at));
    let mut bytes = stringify_utf8(&Value::Object(object))
        .ok()
        .flatten()
        .unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

fn is_unsupported_link(error: &Error) -> bool {
    UNSUPPORTED_LINK.contains(&error.code.as_str())
}

/// `removeObservedLock`: reread the lock; remove it only if it is still the
/// one observed (same token when there is one, same text otherwise). A lock
/// already gone counts as removed.
fn remove_observed_lock(
    fs: &dyn Fs,
    lock_path: &str,
    observed_raw: &JsStr,
    observed_token: Option<&JsStr>,
) -> Result<bool> {
    let outcome = (|| -> Result<bool> {
        let latest_raw = fs.read_file_utf8(lock_path)?;
        let matches = match observed_token {
            Some(token) if !token.is_empty() => {
                parse_lock_owner(&latest_raw)?.is_some_and(|owner| &owner.owner_token == token)
            }
            _ => &latest_raw == observed_raw,
        };
        if !matches {
            return Ok(false);
        }
        fs.unlink(lock_path)?;
        Ok(true)
    })();
    match outcome {
        Err(error) if error.is_not_found() => Ok(true),
        other => other,
    }
}

/// `publishLock`: write the owner to `<lock>.tmp-<pid>-<uuid>` (`wx`, 0o600),
/// sync, close, hard-link it to the lock. A link refused as unsupported
/// publishes with an exclusive create of the lock instead. The open handle
/// is closed and the temporary removed whatever happened; a failure there
/// replaces the earlier one, as JavaScript's `finally` does.
fn publish_lock(fs: &dyn Fs, env: &mut dyn Env, lock_path: &str, raw: &[u8]) -> Result<()> {
    let temporary = format!("{lock_path}.tmp-{}-{}", env.pid(), env.random_uuid()?);
    let mut handle: Option<Box<dyn FileHandle + '_>> = None;
    let outcome = (|| -> Result<()> {
        handle = Some(fs.open(&temporary, OpenFlags::WriteExclusive, 0o600)?);
        let open = handle.as_mut().expect("opened above");
        open.write_file(raw)?;
        open.sync()?;
        open.close()?;
        handle = None;
        if let Err(error) = fs.link(&temporary, lock_path) {
            if !is_unsupported_link(&error) {
                return Err(error);
            }
            handle = Some(fs.open(lock_path, OpenFlags::WriteExclusive, 0o600)?);
            let open = handle.as_mut().expect("opened above");
            open.write_file(raw)?;
            open.sync()?;
        }
        Ok(())
    })();
    let closed = match handle.as_mut() {
        Some(open) => open.close(),
        None => Ok(()),
    };
    drop(handle);
    fs.rm_force(&temporary)?;
    closed?;
    outcome
}

/// The options `withCrossProcessFileLock` reads (besides those in `Env`).
#[derive(Clone, Copy, Debug, Default)]
pub struct LockOptions {
    /// `Math.max(0, options.timeoutMs ?? 5000)`.
    pub timeout_ms: Option<f64>,
    /// `Math.max(1, options.retryMs ?? 25)`.
    pub retry_ms: Option<f64>,
    /// `Math.max(0, options.malformedStaleMs ?? 30000)`.
    pub malformed_stale_ms: Option<f64>,
}

/// `withCrossProcessFileLock(lockPath, callback, options)`.
///
/// Publishes `{"ownerToken":…,"pid":…,"createdAt":…}\n` at `lock_path`. While
/// another lock is there: an owner whose pid is dead is removed if its token
/// still matches and the attempt repeats at once; an unparseable lock whose
/// mtime is at least `malformed_stale_ms` old is removed if its text still
/// matches; a lock that disappears while being read is retried at once;
/// otherwise, after `timeout_ms` since the start, `LOCK_TIMEOUT`, else a
/// wait of `min(retry_ms, max(1, timeout_ms - elapsed))` ms. A live pid is
/// never stolen. The lock is released (only if it still carries this
/// token) whether `callback` succeeds or fails; a release failure replaces
/// the callback's outcome.
pub fn with_cross_process_file_lock<T>(
    lock_path: &str,
    options: &LockOptions,
    fs: &dyn Fs,
    env: &mut dyn Env,
    callback: impl FnOnce(&mut dyn Env) -> Result<T>,
) -> Result<T> {
    let timeout_ms = js_max(0.0, options.timeout_ms.unwrap_or(DEFAULT_LOCK_TIMEOUT_MS));
    let retry_ms = js_max(1.0, options.retry_ms.unwrap_or(DEFAULT_LOCK_RETRY_MS));
    let malformed_stale_ms = js_max(
        0.0,
        options
            .malformed_stale_ms
            .unwrap_or(DEFAULT_MALFORMED_LOCK_STALE_MS),
    );
    let owner_token = env.random_token()?;
    let started_at = env.now();
    let directory = path::dirname(lock_path);
    let pid = env.pid();
    let raw = lock_bytes(&owner_token, pid, started_at);

    fs.mkdir_recursive(&directory, 0o700)?;
    loop {
        env.throw_if_aborted()?;
        let error = match publish_lock(fs, env, lock_path, &raw) {
            Ok(()) => break,
            Err(error) => error,
        };
        if error.code != "EEXIST" {
            return Err(error);
        }
        let inspected = (|| -> Result<bool> {
            let observed_raw = fs.read_file_utf8(lock_path)?;
            match parse_lock_owner(&observed_raw)? {
                Some(owner) => {
                    if !env.is_process_alive(owner.pid) {
                        remove_observed_lock(
                            fs,
                            lock_path,
                            &observed_raw,
                            Some(&owner.owner_token),
                        )?;
                        return Ok(true);
                    }
                }
                None => {
                    let stat = fs.stat(lock_path)?;
                    if env.now() - stat.mtime_ms() >= malformed_stale_ms {
                        remove_observed_lock(fs, lock_path, &observed_raw, None)?;
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })();
        match inspected {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) if error.is_not_found() => continue,
            Err(error) => return Err(error),
        }
        if env.now() - started_at >= timeout_ms {
            return Err(Error::coded("LOCK_TIMEOUT", LOCK_TIMEOUT_MESSAGE));
        }
        let elapsed = env.now() - started_at;
        env.wait(js_min(retry_ms, js_max(1.0, timeout_ms - elapsed)));
    }

    let outcome = env.throw_if_aborted().and_then(|()| callback(env));
    let own_raw = JsStr::from_utf8_lossy(&raw);
    remove_observed_lock(fs, lock_path, &own_raw, Some(&owner_token))?;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_bytes_follow_the_documented_format() {
        let bytes = lock_bytes(
            &JsStr::from("0123456789abcdef0123456789abcdef"),
            4242,
            1_731_000_000_123.0,
        );
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "{\"ownerToken\":\"0123456789abcdef0123456789abcdef\",\"pid\":4242,\"createdAt\":1731000000123}\n"
        );
        let odd = lock_bytes(&JsStr::from("a\"b\u{1}"), 1, 0.5);
        assert_eq!(
            String::from_utf8(odd).unwrap(),
            "{\"ownerToken\":\"a\\\"b\\u0001\",\"pid\":1,\"createdAt\":0.5}\n"
        );
    }

    #[test]
    fn parses_owners_as_the_javascript_does() {
        let parse = |text: &str| parse_lock_owner(&JsStr::from(text)).unwrap();
        assert!(parse("{\"ownerToken\":\"t\",\"pid\":1,\"createdAt\":0}").is_some());
        assert!(parse("{\"ownerToken\":\"t\",\"pid\":1.0,\"createdAt\":-0}").is_some());
        for refused in [
            "{",
            "null",
            "[]",
            "{\"ownerToken\":\"\",\"pid\":1,\"createdAt\":0}",
            "{\"ownerToken\":\"t\",\"pid\":0,\"createdAt\":0}",
            "{\"ownerToken\":\"t\",\"pid\":1.5,\"createdAt\":0}",
            "{\"ownerToken\":\"t\",\"pid\":\"1\",\"createdAt\":0}",
            "{\"ownerToken\":\"t\",\"pid\":1,\"createdAt\":-1}",
            "{\"ownerToken\":\"t\",\"pid\":1,\"createdAt\":1e400}",
            "{\"ownerToken\":\"t\",\"pid\":1e400,\"createdAt\":0}",
        ] {
            assert!(parse(refused).is_none(), "{refused}");
        }
        // Duplicate keys keep the last value, as JSON.parse does.
        assert_eq!(
            parse("{\"ownerToken\":\"a\",\"ownerToken\":\"b\",\"pid\":2,\"createdAt\":3}")
                .unwrap()
                .owner_token,
            JsStr::from("b")
        );
    }

    #[test]
    fn liveness_follows_process_kill() {
        assert!(is_process_alive(fs::getpid() as f64));
        assert!(!is_process_alive(2_147_483_648.0));
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(-1.0), -1);
    }

    #[test]
    fn uuids_have_version_and_variant() {
        let uuid = random_uuid().unwrap();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"));
    }
}

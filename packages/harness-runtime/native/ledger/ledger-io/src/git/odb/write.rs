//! `writeLooseObject(gitDir, type, content, oidLength)` of
//! `lib/session-changes-trees.js`, call for call:
//!
//! 1. `utimes(target, now, now)`: an existing object is freshened, as Git
//!    does, so a concurrent prune keeps it; any failure means "write it".
//! 2. Up to five attempts of: `mkdir(directory, { recursive: true })`,
//!    `stat(directory)` (a failure is `null`), then `writeFile(
//!    tmp_obj_<uuid>, deflated, { mode: 0o444, flag: 'wx' })` and
//!    `link(temporary, target)` (`EEXIST` is success), and always
//!    `unlink(temporary)` (`ENOENT` ignored; any other failure is thrown,
//!    even after a successful link). `ENOENT`, or `EINVAL` when `stat` of
//!    the directory now fails or names another inode or device (as doubles,
//!    the JavaScript's `Number` stats), retries; anything else is thrown.
//!
//! Never synced, as Git's default and the JavaScript. The zlib stream is
//! `miniz_oxide` at level 6 (Node's default); its bytes differ from Node's
//! zlib, so objects are compared by content and id, never as files.
#![forbid(unsafe_code)]

use crate::fs::{self, OpenFlags, Result, Stat};
use crate::path;

use super::{Kind, ObjectFormat, Oid};

/// Node's default zlib level (`Z_DEFAULT_COMPRESSION`).
const LEVEL: u8 = 6;
/// Attempts of the create-and-link loop.
const ATTEMPTS: u32 = 5;

/// The `node:fs/promises` calls `writeLooseObject` makes, with Node's semantics.
pub trait LooseFs {
    /// `utimes(path, atime, mtime)`, times in seconds (`toUnixTimestamp`).
    fn utimes(&self, path: &str, atime: f64, mtime: f64) -> Result<()>;
    /// `mkdir(path, { recursive: true })`.
    fn mkdir_recursive(&self, path: &str) -> Result<()>;
    /// `stat(path)`.
    fn stat(&self, path: &str) -> Result<Stat>;
    /// `writeFile(path, data, { mode, flag: 'wx' })`.
    fn write_file_exclusive(&self, path: &str, data: &[u8], mode: u32) -> Result<()>;
    fn link(&self, from: &str, to: &str) -> Result<()>;
    fn unlink(&self, path: &str) -> Result<()>;
}

/// The real file system, through `crate::fs`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealLooseFs;

impl LooseFs for RealLooseFs {
    fn utimes(&self, path: &str, atime: f64, mtime: f64) -> Result<()> {
        fs::utimes(path, atime, mtime)
    }
    fn mkdir_recursive(&self, path: &str) -> Result<()> {
        fs::mkdir_recursive(path, 0o777)
    }
    fn stat(&self, path: &str) -> Result<Stat> {
        fs::stat(path)
    }
    fn write_file_exclusive(&self, path: &str, data: &[u8], mode: u32) -> Result<()> {
        let mut file = fs::File::open(path, OpenFlags::WriteExclusive, mode)?;
        if let Err(error) = file.write_file(data) {
            let _ = file.close();
            return Err(error);
        }
        file.close()
    }
    fn link(&self, from: &str, to: &str) -> Result<()> {
        fs::link(from, to)
    }
    fn unlink(&self, path: &str) -> Result<()> {
        fs::unlink(path)
    }
}

/// What the JavaScript takes from its process: the clock and `randomUUID`.
pub trait LooseEnv {
    /// `Date.now()`.
    fn now(&mut self) -> f64 {
        crate::atomic::date_now()
    }
    /// `crypto.randomUUID()`.
    fn random_uuid(&mut self) -> Result<String> {
        crate::atomic::random_uuid()
    }
}

/// The process's clock and randomness.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemLooseEnv;

impl LooseEnv for SystemLooseEnv {}

/// `removeTemporaryFile(file)` off Windows: `unlink`, a missing file fine.
fn remove_temporary(fs: &dyn LooseFs, file: &str) -> Result<()> {
    match fs.unlink(file) {
        Err(error) if error.code != "ENOENT" => Err(error),
        _ => Ok(()),
    }
}

fn same_directory(created: Option<&Stat>, current: Option<&Stat>) -> bool {
    match (created, current) {
        // `current.ino !== created.ino || current.dev !== created.dev` on Numbers.
        (Some(created), Some(current)) => {
            created.ino as f64 == current.ino as f64 && created.dev as f64 == current.dev as f64
        }
        _ => false,
    }
}

/// Writes one loose object unless it already exists; returns its id.
pub fn write_loose_object(
    fs: &dyn LooseFs,
    env: &mut dyn LooseEnv,
    git_dir: &str,
    kind: Kind,
    content: &[u8],
    format: ObjectFormat,
) -> Result<Oid> {
    let oid = format.object_id(kind, content);
    let hex = oid.hex();
    let directory = path::join(&[git_dir, "objects", &hex[..2]]);
    let target = path::join(&[&directory, &hex[2..]]);
    let now = env.now() / 1000.0;
    if fs.utimes(&target, now, now).is_ok() {
        return Ok(oid);
    }
    let mut raw = format!("{} {}\0", kind.name(), content.len()).into_bytes();
    raw.extend_from_slice(content);
    let bytes = miniz_oxide::deflate::compress_to_vec_zlib(&raw, LEVEL);
    drop(raw);
    let mut attempt = 1;
    loop {
        fs.mkdir_recursive(&directory)?;
        let created = fs.stat(&directory).ok();
        let temporary = path::join(&[&directory, &format!("tmp_obj_{}", env.random_uuid()?)]);
        let outcome = fs
            .write_file_exclusive(&temporary, &bytes, 0o444)
            .and_then(|()| match fs.link(&temporary, &target) {
                Err(error) if error.code != "EEXIST" => Err(error),
                _ => Ok(()),
            });
        let retry = match &outcome {
            Ok(()) => false,
            Err(cause) => {
                let current = if cause.code == "EINVAL" {
                    fs.stat(&directory).ok()
                } else {
                    None
                };
                let removed = cause.code == "ENOENT"
                    || (cause.code == "EINVAL"
                        && !same_directory(created.as_ref(), current.as_ref()));
                removed && attempt < ATTEMPTS
            }
        };
        // `finally`: a failed removal replaces the outcome, success included.
        remove_temporary(fs, &temporary)?;
        match outcome {
            Ok(()) => return Ok(oid),
            Err(cause) if !retry => return Err(cause),
            Err(_) => attempt += 1,
        }
    }
}

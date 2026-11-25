//! `fs.promises` as the ledger's worker calls it (Node 24.22's
//! `lib/internal/fs/promises.js`, Electron's), over `ledger-io`'s system
//! calls: one function per call the worker's files make, with the options
//! they pass. Every call that does I/O settles in a unit of its own
//! (`node::io`); results are typed, failures are Node's error objects
//! (`node::error_value`: `errno`, `code`, `syscall`, `path`, `dest`,
//! `message`).
//!
//! Built (the census of `session-mutation-worker.js`'s import closure,
//! reachable on darwin and Linux): `access`, `appendFile`, `chmod`,
//! `copyFile`, `link`, `lstat`, `mkdir`, `open` and the `FileHandle`'s
//! `read`, `write`, `writeFile`, `stat`, `chmod`, `sync`, `close`,
//! `readFile` (bytes and `'utf8'`), `readdir` (names and `withFileTypes`),
//! `readlink` (`'utf8'` and `{ encoding: 'buffer' }`), `realpath`,
//! `rename`, `rm`, `rmdir`, `stat`, `statfs`, `symlink` (a string target
//! and a `Buffer` one), `unlink`, `utimes`, `writeFile`. Not built because no
//! reachable site calls them: `mkdtemp` (only `session-execution.js`'s
//! provider setup, which the worker never runs), `opendir`, `truncate`,
//! `cp`, `readv`/`writev`, `lchmod`/`lutimes`/`chown`, `watch`, a
//! `FileHandle`'s `readFile`, `truncate`, `utimes`, `datasync`, `readLines`
//! and streams made from a handle. Of the synchronous calls the worker's
//! files make outside `atomic-file.js` (whose port is `ledger_io::atomic`),
//! `lstatSync` and `readdirSync(withFileTypes)` are here too (`lstat_sync`,
//! `readdir_with_file_types_sync`): inline, as the JavaScript makes them.
//!
//! Each composite call (`readFile`, `writeFile`, `appendFile`, `rm`, a
//! recursive `mkdir`, `readdir` with types) runs its system calls in one
//! piece of pool work and settles once: Node 24.22 spends several loop round
//! trips on them, which no ledger output can see (design file 33, V5). The
//! system calls and their order are Node's.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ledger_core::js::JsStr;
use ledger_io::fs as lio;

pub use ledger_io::fs::DirentKind;
pub use ledger_io::fs::constants;

use super::{IoError, fulfilled, io, io_with, rejected};
use crate::js::{Promise, Resolvers};
use crate::value::{JsError, W};

/// `kReadFileBufferLength`: `readFile` reads a large file 512 KiB at a time.
const READ_FILE_BUFFER: usize = 512 * 1024;
/// `kReadFileUnknownBufferLength`: a file of unknown size, 64 KiB at a time.
const READ_FILE_UNKNOWN: usize = 64 * 1024;
/// `kIoMaxLength`: the largest file `readFile` reads (2 GiB - 1).
const IO_MAX_LENGTH: i64 = (1 << 31) - 1;
/// `kWriteFileMaxChunkSize`: `writeFile` writes at most 512 KiB at a time.
const WRITE_FILE_CHUNK: usize = 512 * 1024;

/// A `Stats` (`bigint: false`, Node's `Float64Array` view) or `BigIntStats`
/// (`bigint: true`, the `BigInt64Array` view). `birthtime` is not kept: no
/// site reads it.
#[derive(Clone, Copy, Debug)]
pub struct Stats {
    raw: lio::Stat,
    bigint: bool,
}

impl Stats {
    fn kind(&self) -> i64 {
        self.raw.mode & constants::S_IFMT
    }
    pub fn is_file(&self) -> bool {
        self.kind() == constants::S_IFREG
    }
    pub fn is_directory(&self) -> bool {
        self.kind() == constants::S_IFDIR
    }
    pub fn is_symbolic_link(&self) -> bool {
        self.kind() == constants::S_IFLNK
    }
    pub fn is_fifo(&self) -> bool {
        self.kind() == constants::S_IFIFO
    }
    pub fn is_socket(&self) -> bool {
        self.kind() == constants::S_IFSOCK
    }
    pub fn is_character_device(&self) -> bool {
        self.kind() == constants::S_IFCHR
    }
    pub fn is_block_device(&self) -> bool {
        self.kind() == constants::S_IFBLK
    }
    /// Whether it was asked with `{ bigint: true }`.
    pub fn bigint(&self) -> bool {
        self.bigint
    }
    /// The fields as `BigIntStats` holds them (signed 64-bit).
    pub fn big(&self) -> &lio::Stat {
        &self.raw
    }
    /// A field of the `Float64Array` view: libuv's `uint64_t` as a double.
    fn number(value: i64) -> f64 {
        value as u64 as f64
    }
    pub fn dev(&self) -> f64 {
        Stats::number(self.raw.dev)
    }
    pub fn ino(&self) -> f64 {
        Stats::number(self.raw.ino)
    }
    pub fn mode(&self) -> f64 {
        Stats::number(self.raw.mode)
    }
    pub fn nlink(&self) -> f64 {
        Stats::number(self.raw.nlink)
    }
    pub fn uid(&self) -> f64 {
        Stats::number(self.raw.uid)
    }
    pub fn gid(&self) -> f64 {
        Stats::number(self.raw.gid)
    }
    pub fn rdev(&self) -> f64 {
        Stats::number(self.raw.rdev)
    }
    pub fn size(&self) -> f64 {
        Stats::number(self.raw.size)
    }
    pub fn blksize(&self) -> f64 {
        Stats::number(self.raw.blksize)
    }
    pub fn blocks(&self) -> f64 {
        Stats::number(self.raw.blocks)
    }
    /// `msFromTimeSpec(sec, nsec)`: `sec * 1e3 + nsec / 1e6` in doubles.
    fn ms(time: (i64, i64)) -> f64 {
        time.0 as f64 * 1e3 + time.1 as f64 / 1e6
    }
    pub fn atime_ms(&self) -> f64 {
        Stats::ms(self.raw.atime)
    }
    pub fn mtime_ms(&self) -> f64 {
        Stats::ms(self.raw.mtime)
    }
    pub fn ctime_ms(&self) -> f64 {
        Stats::ms(self.raw.ctime)
    }
    /// `BigIntStats`' `*Ns`: `sec * 10n ** 9n + nsec`.
    fn ns(time: (i64, i64)) -> i128 {
        time.0 as i128 * 1_000_000_000 + time.1 as i128
    }
    pub fn atime_ns(&self) -> i128 {
        Stats::ns(self.raw.atime)
    }
    pub fn mtime_ns(&self) -> i128 {
        Stats::ns(self.raw.mtime)
    }
    pub fn ctime_ns(&self) -> i128 {
        Stats::ns(self.raw.ctime)
    }
    /// `BigIntStats`' `*Ms`: `sec * 1000n + nsec / 1000000n`.
    fn big_ms(time: (i64, i64)) -> i128 {
        time.0 as i128 * 1000 + (time.1 / 1_000_000) as i128
    }
    pub fn atime_ms_big(&self) -> i128 {
        Stats::big_ms(self.raw.atime)
    }
    pub fn mtime_ms_big(&self) -> i128 {
        Stats::big_ms(self.raw.mtime)
    }
    pub fn ctime_ms_big(&self) -> i128 {
        Stats::big_ms(self.raw.ctime)
    }
}

/// A `Dirent` of `readdir(path, { withFileTypes: true })`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dirent {
    pub name: String,
    /// `dirent.parentPath`: the path `readdir` was given.
    pub parent_path: String,
    pub kind: DirentKind,
}

impl Dirent {
    pub fn is_file(&self) -> bool {
        self.kind == DirentKind::File
    }
    pub fn is_directory(&self) -> bool {
        self.kind == DirentKind::Directory
    }
    pub fn is_symbolic_link(&self) -> bool {
        self.kind == DirentKind::SymbolicLink
    }
}

/// A `StatFs` of `statfs(path, { bigint })`.
#[derive(Clone, Copy, Debug)]
pub struct StatFs {
    pub raw: lio::StatFs,
    pub bigint: bool,
}

/// What `writeFile` and `appendFile` write: a `Buffer`, or a string written
/// as UTF-8 (`Buffer.from(data, 'utf8')`, a lone surrogate as U+FFFD).
#[derive(Clone)]
pub enum Data {
    Bytes(Rc<Vec<u8>>),
    Text(JsStr),
}

impl Data {
    fn bytes(&self) -> Vec<u8> {
        match self {
            Data::Bytes(bytes) => bytes.as_ref().clone(),
            Data::Text(text) => text.to_utf8(),
        }
    }
}

/// `open`'s and `writeFile`'s flags: one of Node's strings (`'r'`, `'wx'`,
/// `'a'`, …) or `fs.constants` bits (`O_RDONLY | O_NOFOLLOW`).
#[derive(Clone, Copy, Debug)]
pub enum Flags {
    Str(&'static str),
    Bits(i32),
}

impl Flags {
    /// `stringToFlags`; a string Node does not know is a porting mistake.
    fn bits(self) -> i32 {
        match self {
            Flags::Bits(bits) => bits,
            Flags::Str(text) => lio::string_to_flags(text)
                .unwrap_or_else(|| panic!("an open flag Node does not know: {text:?}")),
        }
    }
}

/// `writeFile`'s and `appendFile`'s options: `{ mode, flag }` (`encoding`
/// is always `'utf8'` at the sites).
#[derive(Clone, Copy, Debug)]
pub struct WriteOptions {
    pub mode: u32,
    pub flag: Flags,
}

impl WriteOptions {
    /// `writeFile`'s defaults: `{ mode: 0o666, flag: 'w' }`.
    pub const WRITE: WriteOptions = WriteOptions {
        mode: 0o666,
        flag: Flags::Str("w"),
    };
    /// `appendFile`'s defaults: `{ mode: 0o666, flag: 'a' }`.
    pub const APPEND: WriteOptions = WriteOptions {
        mode: 0o666,
        flag: Flags::Str("a"),
    };
}

/// `mkdir`'s options: `{ recursive, mode }` (`mode` defaults to `0o777`).
#[derive(Clone, Copy, Debug)]
pub struct MkdirOptions {
    pub recursive: bool,
    pub mode: u32,
}

impl Default for MkdirOptions {
    fn default() -> MkdirOptions {
        MkdirOptions {
            recursive: false,
            mode: 0o777,
        }
    }
}

/// `rm`'s options: `{ recursive, force }` (both default to `false`).
#[derive(Clone, Copy, Debug, Default)]
pub struct RmOptions {
    pub recursive: bool,
    pub force: bool,
}

/// A time `utimes` takes: a `Date` (its `getTime()`, milliseconds) or a
/// number of seconds.
#[derive(Clone, Copy, Debug)]
pub enum Time {
    Date(f64),
    Seconds(f64),
}

impl Time {
    /// `toUnixTimestamp`: a `Date` is `getTime() / 1000`; a finite negative
    /// number is `Date.now() / 1000`; a number that is not finite (NaN,
    /// ±Infinity) is refused with `ERR_INVALID_ARG_TYPE`, as Node 24 refuses
    /// it.
    fn seconds(self) -> Result<f64, W> {
        match self {
            Time::Date(ms) => Ok(ms / 1000.0),
            Time::Seconds(seconds) if !seconds.is_finite() => {
                let mut error = JsError::new(
                    "TypeError",
                    &format!(
                        "The \"time\" argument must be an instance of Date or an Time in seconds. Received type number ({})",
                        ledger_core::js::number_to_string(seconds)
                    ),
                );
                error.set_field("code", W::String(JsStr::from("ERR_INVALID_ARG_TYPE")));
                Err(W::Error(Rc::new(error)))
            }
            Time::Seconds(seconds) if seconds < 0.0 => Ok(crate::host::now() / 1000.0),
            Time::Seconds(seconds) => Ok(seconds),
        }
    }
}

/// Node's path validation (`getValidatedPath`): a path with a NUL byte is
/// refused before any I/O, as the async function's first throw.
fn validated(name: &str, path: &str) -> Result<(), W> {
    if !path.contains('\0') {
        return Ok(());
    }
    Err(null_bytes(name, &inspect_string(path)))
}

/// [`validated`] for a `Buffer` path (`symlink(<Buffer>, …)`'s target).
fn validated_bytes(name: &str, bytes: &[u8]) -> Result<(), W> {
    if !bytes.contains(&0) {
        return Ok(());
    }
    Err(null_bytes(name, &inspect_buffer(bytes)))
}

/// `ERR_INVALID_ARG_VALUE(name, value, 'must be … without null bytes')`:
/// its message cuts `inspect(value)` at 128 characters (and adds `...`).
fn null_bytes(name: &str, inspected: &str) -> W {
    let units: Vec<u16> = inspected.encode_utf16().collect();
    let shown = if units.len() > 128 {
        format!("{}...", String::from_utf16_lossy(&units[..128]))
    } else {
        inspected.to_owned()
    };
    let mut error = JsError::new(
        "TypeError",
        &format!(
            "The argument '{name}' must be a string, Uint8Array, or URL without null bytes. Received {shown}"
        ),
    );
    error.set_field("code", W::String(JsStr::from("ERR_INVALID_ARG_VALUE")));
    W::Error(Rc::new(error))
}

/// `util.inspect` of a string (`formatPrimitive`, `strEscape`): a string
/// longer than 124 characters is shown line by line (`'a\n' +\n  'b'`);
/// each piece is quoted on its own.
fn inspect_string(value: &str) -> String {
    let length = value.encode_utf16().count();
    // `value.length > kMinLineWidth (16) && value.length > breakLength (128) - 4`.
    if length > 128 - 4 {
        return value
            .split_inclusive('\n')
            .map(quoted)
            .collect::<Vec<_>>()
            .join(" +\n  ");
    }
    quoted(value)
}

/// `strEscape(str)`: single quotes; double quotes for a string with a `'`
/// and no `"`; backticks for one with both and no `` ` `` or `${`. The
/// chosen single quote, `\` and the control characters (U+0000 to U+001F,
/// U+007F to U+009F) are escaped (`\n`, `\x00`, `\x7F`).
fn quoted(value: &str) -> String {
    let quote = if !value.contains('\'') {
        '\''
    } else if !value.contains('"') {
        '"'
    } else if !value.contains('`') && !value.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut out = String::with_capacity(value.len() + 2);
    out.push(quote);
    for character in value.chars() {
        let code = u32::from(character);
        match character {
            '\'' if quote == '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            _ if code < 0x20 || (0x7f..=0x9f).contains(&code) => {
                out.push_str(&format!("\\x{code:02X}"));
            }
            _ => out.push(character),
        }
    }
    out.push(quote);
    out
}

/// `util.inspect` of a `Buffer`: `<Buffer 61 00 62>`, at most 50 bytes
/// (`INSPECT_MAX_BYTES`), then ` ... <n> more bytes`.
fn inspect_buffer(bytes: &[u8]) -> String {
    let shown: Vec<String> = bytes
        .iter()
        .take(50)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let more = if bytes.len() > 50 {
        format!(" ... {} more bytes", bytes.len() - 50)
    } else {
        String::new()
    };
    format!("<Buffer {}{more}>", shown.join(" "))
}

/// The first path that Node's validation refuses, as its rejection.
fn refused(paths: &[(&str, &str)]) -> Option<W> {
    paths
        .iter()
        .find_map(|(name, path)| validated(name, path).err())
}

/// `checked!([("path", &path)], || call)`: `call` when every path is valid,
/// else the validation's rejection (returned from the calling function).
/// Rule 1's guard on every call: a promise already settled when the call
/// returns was answered inline, which Node never does for a call that
/// passed its validation.
macro_rules! checked {
    ([$(($name:expr, $path:expr)),* $(,)?], || $body:expr) => {{
        if let Some(reason) = refused(&[$(($name, $path.as_str())),*]) {
            return rejected(reason);
        }
        not_inline($body)
    }};
}

/// Rule 1's guard where a call returns: its promise must still be pending.
fn not_inline<T: Clone + 'static>(promise: Promise<T, W>) -> Promise<T, W> {
    assert!(
        !promise.is_settled(),
        "a file call settled in the checkpoint that started it (node::fs, rule 1)"
    );
    promise
}

/// `fs.promises.access(path, mode)` (`mode` is `constants::F_OK` by default).
pub fn access(path: &str, mode: i32) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || io(move || lio::access(&path, mode)))
}

/// `fs.promises.chmod(path, mode)`.
pub fn chmod(path: &str, mode: u32) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || io(move || lio::chmod(&path, mode)))
}

/// `fs.promises.copyFile(src, dest, mode)` (libuv's `copyfile`: the flags
/// `COPYFILE_EXCL`, `COPYFILE_FICLONE`, `COPYFILE_FICLONE_FORCE`).
pub fn copy_file(src: &str, dest: &str, mode: u32) -> Promise<(), W> {
    let (src, dest) = (src.to_owned(), dest.to_owned());
    checked!([("src", &src), ("dest", &dest)], || {
        io(move || lio::copyfile(&src, &dest, mode))
    })
}

/// `fs.promises.link(existingPath, newPath)`.
pub fn link(existing: &str, new_path: &str) -> Promise<(), W> {
    let (from, to) = (existing.to_owned(), new_path.to_owned());
    checked!([("existingPath", &from), ("newPath", &to)], || {
        io(move || lio::link(&from, &to))
    })
}

/// `fs.promises.lstat(path, { bigint })`.
pub fn lstat(path: &str, bigint: bool) -> Promise<Stats, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || lio::lstat(&path).map(|raw| Stats { raw, bigint }))
    })
}

/// `fs.promises.stat(path, { bigint })`.
pub fn stat(path: &str, bigint: bool) -> Promise<Stats, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || lio::stat(&path).map(|raw| Stats { raw, bigint }))
    })
}

/// `fs.promises.statfs(path, { bigint })`.
pub fn statfs(path: &str, bigint: bool) -> Promise<StatFs, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || lio::statfs(&path).map(|raw| StatFs { raw, bigint }))
    })
}

/// `fs.promises.mkdir(path, { recursive, mode })`: a recursive one resolves
/// to the first directory it created, or `undefined` (`None`); a plain one
/// to `undefined`.
pub fn mkdir(path: &str, options: MkdirOptions) -> Promise<Option<String>, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || {
            if options.recursive {
                lio::mkdir_recursive_first(&path, options.mode)
            } else {
                lio::mkdir(&path, options.mode).map(|()| None)
            }
        })
    })
}

/// `fs.promises.readdir(path)`: the names, in libuv's order.
pub fn readdir(path: &str) -> Promise<Vec<String>, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || {
            lio::readdir_entries(&path)
                .map(|entries| entries.into_iter().map(|(name, _)| name).collect())
        })
    })
}

/// `fs.promises.readdir(path, { withFileTypes: true })`.
pub fn readdir_with_file_types(path: &str) -> Promise<Vec<Dirent>, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || {
            lio::readdir_entries(&path).map(|entries| {
                entries
                    .into_iter()
                    .map(|(name, kind)| Dirent {
                        name,
                        parent_path: path.clone(),
                        kind,
                    })
                    .collect()
            })
        })
    })
}

/// `fs.promises.readlink(path)` (`'utf8'`: an ill-formed target as U+FFFD).
pub fn readlink(path: &str) -> Promise<String, W> {
    let path = path.to_owned();
    checked!([("oldPath", &path)], || io(move || lio::readlink(&path)))
}

/// `fs.promises.readlink(path, { encoding: 'buffer' })`: the target's bytes
/// as they are (`session-mutation-files.js`'s observation of a link, whose
/// non-UTF-8 target must round-trip).
pub fn readlink_bytes(path: &str) -> Promise<Rc<Vec<u8>>, W> {
    let path = path.to_owned();
    checked!([("oldPath", &path)], || {
        io_with(
            move || lio::readlink_bytes(&path),
            |bytes| Ok(Rc::new(bytes)),
        )
    })
}

/// `fs.promises.realpath(path)` (`'utf8'`).
pub fn realpath(path: &str) -> Promise<String, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || io(move || lio::realpath(&path)))
}

/// `fs.promises.rename(oldPath, newPath)`.
pub fn rename(old_path: &str, new_path: &str) -> Promise<(), W> {
    let (from, to) = (old_path.to_owned(), new_path.to_owned());
    checked!([("oldPath", &from), ("newPath", &to)], || {
        io(move || lio::rename(&from, &to))
    })
}

/// `fs.promises.rm(path, { recursive, force })`: `validateRmOptions`'
/// `lstat`, then rimraf (`ledger_io::atomic::rm`).
pub fn rm(path: &str, options: RmOptions) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || ledger_io::atomic::rm(&path, options.recursive, options.force))
    })
}

/// `fs.promises.rmdir(path)`.
pub fn rmdir(path: &str) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || io(move || lio::rmdir(&path)))
}

/// `fs.promises.symlink(target, path, type)`: `type` (`'dir'`, `'file'`,
/// `'junction'`) matters only on Windows.
pub fn symlink(target: &str, path: &str, _kind: Option<&str>) -> Promise<(), W> {
    let (target, path) = (target.to_owned(), path.to_owned());
    checked!([("target", &target), ("path", &path)], || {
        io(move || lio::symlink(&target, &path))
    })
}

/// `fs.promises.symlink(<Buffer>, path, type)`: a target of raw bytes
/// (`session-mutations.js` writes a Git blob's bytes as a link's target).
/// A failure shows the target decoded as V8 decodes a C string.
pub fn symlink_bytes(target: &[u8], path: &str, _kind: Option<&str>) -> Promise<(), W> {
    if let Err(reason) = validated_bytes("target", target) {
        return rejected(reason);
    }
    let (target, path) = (target.to_vec(), path.to_owned());
    checked!([("path", &path)], || {
        io(move || lio::symlink_bytes(&target, &path))
    })
}

/// `fs.promises.unlink(path)`.
pub fn unlink(path: &str) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || io(move || lio::unlink(&path)))
}

/// `fs.promises.utimes(path, atime, mtime)`: the path is validated first,
/// then `atime`, then `mtime`.
pub fn utimes(path: &str, atime: Time, mtime: Time) -> Promise<(), W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        let atime = match atime.seconds() {
            Ok(seconds) => seconds,
            Err(reason) => return rejected(reason),
        };
        let mtime = match mtime.seconds() {
            Ok(seconds) => seconds,
            Err(reason) => return rejected(reason),
        };
        io(move || lio::utimes(&path, atime, mtime))
    })
}

/// `handleFdClose`'s close after the operation: an operation's failure
/// wins over the close's (Node aggregates the two when both fail; a close
/// failing after a failed operation is not reproduced), a close's failure
/// fails a successful operation.
fn closing<T>(fd: i32, outcome: Result<T, IoError>) -> Result<T, IoError> {
    let closed = lio::close(fd);
    let value = outcome?;
    closed?;
    Ok(value)
}

/// `readFileHandle` of Node 24.22 on an open descriptor: `fstat`; a regular
/// file of known size is read in one `read` of its size (512 KiB reads above
/// that size, and 512 KiB reads with an encoding), stopping at the size, at
/// a read of nothing or (unless chunked) at a short read; anything else
/// (size 0, not regular) 64 KiB at a time until a read of nothing.
fn read_whole(fd: i32, utf8: bool) -> Result<Vec<u8>, IoError> {
    let stat = lio::fstat(fd)?;
    let regular = stat.mode & constants::S_IFMT == constants::S_IFREG;
    let size = if regular { stat.size } else { 0 };
    if size > IO_MAX_LENGTH {
        let mut error = IoError::coded(
            "ERR_FS_FILE_TOO_LARGE",
            &format!("File size ({size}) is greater than 2 GiB"),
        );
        error.errno = None;
        return Err(error);
    }
    let size = size as usize;
    let mut length = if utf8 {
        size.min(READ_FILE_BUFFER)
    } else {
        size
    };
    if length == 0 {
        length = READ_FILE_UNKNOWN;
    }
    let no_size = size == 0;
    let chunked = length > READ_FILE_BUFFER;
    let mut out: Vec<u8> = Vec::new();
    let mut total = 0usize;
    loop {
        if chunked {
            length = (size - total).min(READ_FILE_BUFFER);
        }
        let read = lio::read(fd, length, None)?;
        let got = read.len();
        total += got;
        out.extend_from_slice(&read);
        if got == 0 || total == size || (got != length && !chunked && !no_size) {
            return Ok(out);
        }
    }
}

/// `fs.promises.readFile(path)`: the bytes.
pub fn read_file(path: &str) -> Promise<Rc<Vec<u8>>, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io_with(
            move || {
                let fd = lio::open_raw(&path, constants::O_RDONLY, 0o666)?;
                closing(fd, read_whole(fd, false))
            },
            |bytes| Ok(Rc::new(bytes)),
        )
    })
}

/// `fs.promises.readFile(path, 'utf8')`: the text, decoded as Node decodes
/// it (an ill-formed sequence as U+FFFD).
pub fn read_file_utf8(path: &str) -> Promise<JsStr, W> {
    let path = path.to_owned();
    checked!([("path", &path)], || {
        io(move || {
            let fd = lio::open_raw(&path, constants::O_RDONLY, 0o666)?;
            closing(fd, read_whole(fd, true)).map(|bytes| JsStr::from_utf8_lossy(&bytes))
        })
    })
}

/// `writeFileHandle`: nothing for no bytes, else `write`s of at most 512 KiB
/// at the descriptor's offset until every byte is written.
fn write_whole(fd: i32, bytes: &[u8]) -> Result<(), IoError> {
    let mut rest = bytes;
    while !rest.is_empty() {
        let written = lio::write_at(fd, &rest[..rest.len().min(WRITE_FILE_CHUNK)], None)?;
        rest = &rest[written..];
    }
    Ok(())
}

/// `fs.promises.writeFile(path, data, { mode, flag })`: open, write, close.
pub fn write_file(path: &str, data: &Data, options: WriteOptions) -> Promise<(), W> {
    let path = path.to_owned();
    let bytes = data.bytes();
    let flags = options.flag.bits();
    checked!([("path", &path)], || {
        io(move || {
            let fd = lio::open_raw(&path, flags, options.mode)?;
            closing(fd, write_whole(fd, &bytes))
        })
    })
}

/// `fs.promises.appendFile(path, data, { mode, flag })` (`flag` `'a'`).
pub fn append_file(path: &str, data: &Data, options: WriteOptions) -> Promise<(), W> {
    write_file(path, data, options)
}

/// `fs.promises.open(path, flags, mode)` (`mode` `0o666` by default).
pub fn open(path: &str, flags: Flags, mode: Option<u32>) -> Promise<FileHandle, W> {
    let path = path.to_owned();
    let bits = flags.bits();
    let mode = mode.unwrap_or(0o666);
    checked!([("path", &path)], || {
        io_with(
            move || lio::open_raw(&path, bits, mode),
            |fd| Ok(FileHandle::new(fd)),
        )
    })
}

/// `fs.lstatSync(path, { bigint })`: the system call inline, as the
/// JavaScript makes it (no promise, no unit); a failure is Node's error
/// object, thrown (`Err`).
pub fn lstat_sync(path: &str, bigint: bool) -> Result<Stats, W> {
    if let Some(reason) = refused(&[("path", path)]) {
        return Err(reason);
    }
    lio::lstat(path)
        .map(|raw| Stats { raw, bigint })
        .map_err(|error| super::error_value(&error))
}

/// `fs.readdirSync(path, { withFileTypes: true })`, inline.
pub fn readdir_with_file_types_sync(path: &str) -> Result<Vec<Dirent>, W> {
    if let Some(reason) = refused(&[("path", path)]) {
        return Err(reason);
    }
    lio::readdir_entries(path)
        .map(|entries| {
            entries
                .into_iter()
                .map(|(name, kind)| Dirent {
                    name,
                    parent_path: path.to_owned(),
                    kind,
                })
                .collect()
        })
        .map_err(|error| super::error_value(&error))
}

/// How many descriptors this process has open (tests check that a handle
/// or a stream left early was closed).
pub fn open_descriptor_count() -> usize {
    lio::open_descriptor_count()
}

/// What `filehandle.read` resolves to: `{ bytesRead, buffer }` (the bytes
/// read are the first `bytes_read` of the caller's buffer in Node).
#[derive(Clone, Debug)]
pub struct ReadResult {
    pub bytes_read: usize,
    pub bytes: Rc<Vec<u8>>,
}

/// What a `FileHandle` method starts: its I/O, or its value at once (only
/// Node's own paths without I/O: a read or write of no bytes).
enum Answer<T: 'static> {
    Io(Promise<T, W>),
    Now(T),
}

struct HandleState {
    /// `this[kFd]`: -1 once closing has begun (or the deferred close ran).
    fd: Cell<i32>,
    /// The descriptor itself, kept for the deferred close.
    raw: i32,
    /// `this[kRefs]`: 1 for the handle, one more per operation in flight.
    refs: Cell<u32>,
    /// `this[kClosePromise]` while a close is pending.
    closing: RefCell<Option<Promise<(), W>>>,
    /// `this[kCloseResolve]`/`kCloseReject` of a close deferred behind
    /// operations in flight.
    deferred: RefCell<Option<Resolvers<(), W>>>,
    /// Whether the descriptor was closed (or handed to a close).
    released: Cell<bool>,
}

/// A `FileHandle` of `fs.promises.open`. Clones are the same handle.
#[derive(Clone)]
pub struct FileHandle(Rc<HandleState>);

impl Drop for HandleState {
    /// A handle nobody closed is closed when the last reference goes, as
    /// Node's collector closes a forgotten `FileHandle` (and warns). No job
    /// runs and nothing settles.
    fn drop(&mut self) {
        if !self.released.get() {
            let _ = lio::close(self.raw);
        }
    }
}

/// `fsCall`'s error for a closed handle: `Error('file closed')` with
/// `code: 'EBADF'` and the operation's name as `syscall` (no `errno`).
fn closed_handle(syscall: &str) -> W {
    let mut error = JsError::new("Error", "file closed");
    error.set_field("code", W::String(JsStr::from("EBADF")));
    error.set_field("syscall", W::String(JsStr::from(syscall)));
    W::Error(Rc::new(error))
}

impl FileHandle {
    fn new(fd: i32) -> FileHandle {
        FileHandle(Rc::new(HandleState {
            fd: Cell::new(fd),
            raw: fd,
            refs: Cell::new(1),
            closing: RefCell::new(None),
            deferred: RefCell::new(None),
            released: Cell::new(false),
        }))
    }

    /// `filehandle.fd` (-1 once closed).
    pub fn fd(&self) -> i32 {
        self.0.fd.get()
    }

    /// `fsCall(fn, handle, ...)`: a closed handle refuses with `EBADF`;
    /// otherwise the operation runs with a reference held until it settles.
    /// Rule 1's guard for every method: an operation that does I/O must not
    /// be settled when it returns, nor complete in the checkpoint that
    /// started it; only [`Answer::Now`] (Node's own paths without I/O)
    /// settles at once.
    fn call<T: Clone + 'static>(
        &self,
        syscall: &'static str,
        start: impl FnOnce(i32) -> Answer<T>,
    ) -> Promise<T, W> {
        let fd = self.0.fd.get();
        if fd == -1 {
            return rejected(closed_handle(syscall));
        }
        self.0.refs.set(self.0.refs.get() + 1);
        let state = self.0.clone();
        match start(fd) {
            Answer::Now(value) => follow(fulfilled(value), move || FileHandle::unref(&state)),
            Answer::Io(promise) => {
                let started = crate::js::checkpoint_epoch();
                follow(not_inline(promise), move || {
                    super::settled_in_a_later_checkpoint(started);
                    FileHandle::unref(&state);
                })
            }
        }
    }

    /// `this[kUnref]()`: the last reference gone runs the deferred close.
    fn unref(state: &Rc<HandleState>) {
        state.refs.set(state.refs.get() - 1);
        if state.refs.get() == 0 {
            state.fd.set(-1);
            state.released.set(true);
            let resolvers = state.deferred.borrow_mut().take();
            let raw = state.raw;
            let close = io(move || lio::close(raw));
            match resolvers {
                Some(resolvers) => close.react(move |outcome| match outcome {
                    Ok(()) => resolvers.fulfill(()),
                    Err(reason) => resolvers.reject(reason),
                }),
                // No close was asked for (the handle went unreferenced some
                // other way): nothing waits for this one.
                None => close.react(|_| {}),
            }
        }
    }

    /// `filehandle.read(buffer, 0, length, position)`: `length` bytes at
    /// `position`, or at the descriptor's offset for `None` (`null`). A read
    /// of no bytes resolves without I/O, as Node's does.
    pub fn read(&self, length: usize, position: Option<i64>) -> Promise<ReadResult, W> {
        self.call("read", |fd| {
            if length == 0 {
                return Answer::Now(ReadResult {
                    bytes_read: 0,
                    bytes: Rc::new(Vec::new()),
                });
            }
            Answer::Io(io_with(
                move || lio::read(fd, length, position),
                |bytes| {
                    Ok(ReadResult {
                        bytes_read: bytes.len(),
                        bytes: Rc::new(bytes),
                    })
                },
            ))
        })
    }

    /// `filehandle.write(buffer, offset, length, position)`: resolves to
    /// `bytesWritten`. An empty buffer resolves to 0 without I/O.
    pub fn write(
        &self,
        buffer: &Rc<Vec<u8>>,
        offset: usize,
        length: usize,
        position: Option<i64>,
    ) -> Promise<usize, W> {
        assert!(
            offset
                .checked_add(length)
                .is_some_and(|end| end <= buffer.len()),
            "a FileHandle write outside its buffer (Node: ERR_OUT_OF_RANGE), an unported argument"
        );
        let empty = buffer.is_empty();
        let bytes = buffer[offset..offset + length].to_vec();
        self.call("write", move |fd| {
            if empty {
                return Answer::Now(0);
            }
            Answer::Io(io(move || lio::write_at(fd, &bytes, position)))
        })
    }

    /// `filehandle.writeFile(data)`: nothing for no bytes (no I/O), else
    /// 512 KiB writes at the descriptor's offset.
    pub fn write_file(&self, data: &Data) -> Promise<(), W> {
        let bytes = data.bytes();
        self.call("writeFile", move |fd| {
            if bytes.is_empty() {
                return Answer::Now(());
            }
            Answer::Io(io(move || write_whole(fd, &bytes)))
        })
    }

    /// `filehandle.stat({ bigint })`.
    pub fn stat(&self, bigint: bool) -> Promise<Stats, W> {
        self.call("fstat", move |fd| {
            Answer::Io(io(move || lio::fstat(fd).map(|raw| Stats { raw, bigint })))
        })
    }

    /// `filehandle.chmod(mode)`.
    pub fn chmod(&self, mode: u32) -> Promise<(), W> {
        self.call("fchmod", move |fd| {
            Answer::Io(io(move || lio::fchmod(fd, mode)))
        })
    }

    /// `filehandle.sync()` (`F_FULLFSYNC`'s chain on macOS).
    pub fn sync(&self) -> Promise<(), W> {
        self.call("fsync", move |fd| Answer::Io(io(move || lio::fsync(fd))))
    }

    /// `filehandle.close()`, as Node 24.22's: a handle already closed, or
    /// whose close is under way (`kFd` is -1), resolves at once, without I/O;
    /// during a close deferred behind operations in flight (`kFd` still
    /// set), a second call gets the pending close's promise; otherwise the
    /// close waits for the operations in flight, then closes.
    pub fn close(&self) -> Promise<(), W> {
        let state = &self.0;
        if state.fd.get() == -1 {
            return fulfilled(());
        }
        if let Some(pending) = state.closing.borrow().clone() {
            return pending;
        }
        state.refs.set(state.refs.get() - 1);
        let promise = if state.refs.get() == 0 {
            state.fd.set(-1);
            state.released.set(true);
            let raw = state.raw;
            not_inline(io(move || lio::close(raw)))
        } else {
            let (promise, resolvers) = Promise::with_resolvers();
            *state.deferred.borrow_mut() = Some(resolvers);
            promise
        };
        let kept = self.0.clone();
        let promise = follow(promise, move || {
            kept.closing.borrow_mut().take();
        });
        *state.closing.borrow_mut() = Some(promise.clone());
        promise
    }
}

/// A promise that settles as `inner` does, after `first` runs (an async
/// function's `try { return await inner } finally { first }`, or
/// `inner.finally(first)`): `inner` is the facade's own, so reacting to it
/// leaves the caller's promise unhandled until the caller handles it.
fn follow<T: Clone + 'static>(
    inner: Promise<T, W>,
    first: impl FnOnce() + 'static,
) -> Promise<T, W> {
    let (outer, resolvers) = Promise::with_resolvers();
    inner.react(move |outcome| {
        first();
        match outcome {
            Ok(value) => resolvers.fulfill(value),
            Err(reason) => resolvers.reject(reason),
        }
    });
    outer
}

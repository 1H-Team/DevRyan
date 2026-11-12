//! File-system primitives exactly as libuv makes them for Node, and the
//! crate's only unsafe code.
//!
//! The reference is the libuv inside Electron's Node (1.52.1 at the time of
//! writing; `process.versions.uv`), `src/unix/fs.c` and `src/unix/core.c`,
//! with Node 24's `lib/internal/fs/*.js` and `src/node_file.cc` on top. Each
//! function names the libuv or Node routine it reproduces. The differences
//! that reach disk or change an error are none; the ones that do not are
//! listed where they occur (the buggy-CephFS kernel check, and directory
//! listing through `std::fs::read_dir`, which reads the same entries and
//! types with other system calls).
//!
//! Errors carry libuv's names and texts (`uv_err_name`, `uv_strerror`) in
//! Node's layout (`UVException`: `<code>: <text>, <syscall> '<path>' -> '<dest>'`):
//! an errno libuv does not know becomes `Unknown system error -<n>` in both,
//! as Node's `error.code` and `error.message` do.

use std::ffi::{CStr, CString};
use std::fmt;

use libc::{c_int, c_void};

/// A failed file-system call as Node reports it: `error.code`,
/// `error.errno`, `error.syscall`, `error.path`, `error.dest` and
/// `error.message`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub code: String,
    /// Node's `error.errno`: the negated system errno of a libuv error
    /// (`-2` for `ENOENT`), the positive one of Node's own system errors
    /// (`ERR_FS_EISDIR` has `21`), none for an error without one.
    pub errno: Option<i32>,
    pub syscall: Option<&'static str>,
    pub path: Option<String>,
    pub dest: Option<String>,
    pub message: String,
}

impl Error {
    /// An error from a failed system call, as libuv and Node report it.
    pub fn os(errno: i32, syscall: &'static str, path: Option<&str>) -> Error {
        Error::os_with_dest(errno, syscall, path, None)
    }

    /// `Error::os` for a call with two paths (`rename`, `link`, `copyfile`).
    pub fn os_with_dest(
        errno: i32,
        syscall: &'static str,
        path: Option<&str>,
        dest: Option<&str>,
    ) -> Error {
        let code = error_name(errno);
        let mut message = format!("{code}: {}, {syscall}", error_message(errno));
        if let Some(path) = path {
            message.push_str(&format!(" '{path}'"));
        }
        if let Some(dest) = dest {
            message.push_str(&format!(" -> '{dest}'"));
        }
        Error {
            code,
            errno: Some(-errno),
            syscall: Some(syscall),
            path: path.map(str::to_owned),
            dest: dest.map(str::to_owned),
            message,
        }
    }

    /// The system errno of a libuv error (`ENOENT` for `errno == Some(-2)`).
    pub fn system_errno(&self) -> Option<i32> {
        self.errno.filter(|errno| *errno < 0).map(|errno| -errno)
    }

    /// An error that only has a code, such as `LOCK_TIMEOUT` or a code a test injects.
    pub fn coded(code: &str, message: &str) -> Error {
        Error {
            code: code.to_owned(),
            errno: None,
            syscall: None,
            path: None,
            dest: None,
            message: message.to_owned(),
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.code == "ENOENT"
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// The entries of libuv's `UV_ERRNO_MAP` that are system errnos on this
/// platform, as `(errno, uv_err_name, uv_strerror)`. Node's
/// `util.getSystemErrorMap()` is the same map; the differential tests
/// compare the two entry by entry. Where two errnos share a value (Linux
/// `ENOTSUP` and `EOPNOTSUPP`, `EAGAIN` and `EWOULDBLOCK`) libuv names it
/// once, by the name in its map; macOS `EOPNOTSUPP` (102) and `ENODATA` are
/// not in it, so libuv calls them unknown.
pub fn system_errors() -> Vec<(i32, &'static str, &'static str)> {
    let common: &[(c_int, &str, &str)] = &[
        (libc::E2BIG, "E2BIG", "argument list too long"),
        (libc::EACCES, "EACCES", "permission denied"),
        (libc::EADDRINUSE, "EADDRINUSE", "address already in use"),
        (
            libc::EADDRNOTAVAIL,
            "EADDRNOTAVAIL",
            "address not available",
        ),
        (
            libc::EAFNOSUPPORT,
            "EAFNOSUPPORT",
            "address family not supported",
        ),
        (libc::EAGAIN, "EAGAIN", "resource temporarily unavailable"),
        (libc::EALREADY, "EALREADY", "connection already in progress"),
        (libc::EBADF, "EBADF", "bad file descriptor"),
        (libc::EBUSY, "EBUSY", "resource busy or locked"),
        (libc::ECANCELED, "ECANCELED", "operation canceled"),
        (
            libc::ECONNABORTED,
            "ECONNABORTED",
            "software caused connection abort",
        ),
        (libc::ECONNREFUSED, "ECONNREFUSED", "connection refused"),
        (libc::ECONNRESET, "ECONNRESET", "connection reset by peer"),
        (
            libc::EDESTADDRREQ,
            "EDESTADDRREQ",
            "destination address required",
        ),
        (libc::EEXIST, "EEXIST", "file already exists"),
        (
            libc::EFAULT,
            "EFAULT",
            "bad address in system call argument",
        ),
        (libc::EFBIG, "EFBIG", "file too large"),
        (libc::EHOSTUNREACH, "EHOSTUNREACH", "host is unreachable"),
        (libc::EINTR, "EINTR", "interrupted system call"),
        (libc::EINVAL, "EINVAL", "invalid argument"),
        (libc::EIO, "EIO", "i/o error"),
        (libc::EISCONN, "EISCONN", "socket is already connected"),
        (libc::EISDIR, "EISDIR", "illegal operation on a directory"),
        (libc::ELOOP, "ELOOP", "too many symbolic links encountered"),
        (libc::EMFILE, "EMFILE", "too many open files"),
        (libc::EMSGSIZE, "EMSGSIZE", "message too long"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG", "name too long"),
        (libc::ENETDOWN, "ENETDOWN", "network is down"),
        (libc::ENETUNREACH, "ENETUNREACH", "network is unreachable"),
        (libc::ENFILE, "ENFILE", "file table overflow"),
        (libc::ENOBUFS, "ENOBUFS", "no buffer space available"),
        (libc::ENODEV, "ENODEV", "no such device"),
        (libc::ENOENT, "ENOENT", "no such file or directory"),
        (libc::ENOMEM, "ENOMEM", "not enough memory"),
        (libc::ENOPROTOOPT, "ENOPROTOOPT", "protocol not available"),
        (libc::ENOSPC, "ENOSPC", "no space left on device"),
        (libc::ENOSYS, "ENOSYS", "function not implemented"),
        (libc::ENOTCONN, "ENOTCONN", "socket is not connected"),
        (libc::ENOTDIR, "ENOTDIR", "not a directory"),
        (libc::ENOTEMPTY, "ENOTEMPTY", "directory not empty"),
        (libc::ENOTSOCK, "ENOTSOCK", "socket operation on non-socket"),
        (
            libc::ENOTSUP,
            "ENOTSUP",
            "operation not supported on socket",
        ),
        (
            libc::EOVERFLOW,
            "EOVERFLOW",
            "value too large for defined data type",
        ),
        (libc::EPERM, "EPERM", "operation not permitted"),
        (libc::EPIPE, "EPIPE", "broken pipe"),
        (libc::EPROTO, "EPROTO", "protocol error"),
        (
            libc::EPROTONOSUPPORT,
            "EPROTONOSUPPORT",
            "protocol not supported",
        ),
        (
            libc::EPROTOTYPE,
            "EPROTOTYPE",
            "protocol wrong type for socket",
        ),
        (libc::ERANGE, "ERANGE", "result too large"),
        (libc::EROFS, "EROFS", "read-only file system"),
        (
            libc::ESHUTDOWN,
            "ESHUTDOWN",
            "cannot send after transport endpoint shutdown",
        ),
        (libc::ESPIPE, "ESPIPE", "invalid seek"),
        (libc::ESRCH, "ESRCH", "no such process"),
        (libc::ETIMEDOUT, "ETIMEDOUT", "connection timed out"),
        (libc::ETXTBSY, "ETXTBSY", "text file is busy"),
        (libc::EXDEV, "EXDEV", "cross-device link not permitted"),
        (libc::ENXIO, "ENXIO", "no such device or address"),
        (libc::EMLINK, "EMLINK", "too many links"),
        (libc::EHOSTDOWN, "EHOSTDOWN", "host is down"),
        (libc::ENOTTY, "ENOTTY", "inappropriate ioctl for device"),
        (libc::EILSEQ, "EILSEQ", "illegal byte sequence"),
        (
            libc::ESOCKTNOSUPPORT,
            "ESOCKTNOSUPPORT",
            "socket type not supported",
        ),
        (libc::ENOEXEC, "ENOEXEC", "exec format error"),
    ];
    #[cfg(target_os = "macos")]
    let platform: &[(c_int, &str, &str)] =
        &[(libc::EFTYPE, "EFTYPE", "inappropriate file type or format")];
    #[cfg(target_os = "linux")]
    let platform: &[(c_int, &str, &str)] = &[
        (libc::ENONET, "ENONET", "machine is not on the network"),
        (libc::EREMOTEIO, "EREMOTEIO", "remote I/O error"),
        (libc::EUNATCH, "EUNATCH", "protocol driver not attached"),
    ];
    common.iter().chain(platform).copied().collect()
}

fn known(errno: i32) -> Option<(&'static str, &'static str)> {
    system_errors()
        .into_iter()
        .find(|(value, _, _)| *value == errno)
        .map(|(_, name, message)| (name, message))
}

/// `uv_err_name(-errno)`: Node's `error.code` of a system error.
pub fn error_name(errno: i32) -> String {
    known(errno)
        .map(|(name, _)| name.to_owned())
        .unwrap_or_else(|| format!("Unknown system error -{errno}"))
}

/// `uv_strerror(-errno)`: the text in Node's `error.message`.
pub fn error_message(errno: i32) -> String {
    known(errno)
        .map(|(_, message)| message.to_owned())
        .unwrap_or_else(|| format!("Unknown system error -{errno}"))
}

/// A path as a C string. A NUL inside fails as Node's path validation does.
fn c_path(path: &str) -> Result<CString> {
    CString::new(path).map_err(|_| {
        Error::coded(
            "ERR_INVALID_ARG_VALUE",
            "The argument 'path' must be a string, Uint8Array, or URL without null bytes.",
        )
    })
}

/// `uv__fs_work`'s loop: every call except close and read is retried on EINTR.
fn retry(mut call: impl FnMut() -> isize) -> isize {
    loop {
        let result = call();
        if result == -1 && last_errno() == libc::EINTR {
            continue;
        }
        return result;
    }
}

fn check(result: isize, syscall: &'static str, path: Option<&str>) -> Result<isize> {
    if result == -1 {
        Err(Error::os(last_errno(), syscall, path))
    } else {
        Ok(result)
    }
}

/// The fields of a `uv_stat_t` that Node exposes, as Node's `BigInt64Array`
/// holds them: libuv widens every field to `uint64_t` (macOS `st_dev`, an
/// `int32_t`, is sign-extended), and Node stores those 64 bits as signed
/// integers. Times are `(seconds, nanoseconds)` as `long`s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub dev: i64,
    pub ino: i64,
    pub mode: i64,
    pub nlink: i64,
    pub uid: i64,
    pub gid: i64,
    pub rdev: i64,
    pub size: i64,
    pub blksize: i64,
    pub blocks: i64,
    pub atime: (i64, i64),
    pub mtime: (i64, i64),
    pub ctime: (i64, i64),
}

impl Stat {
    #[allow(clippy::unnecessary_cast)] // The field types differ by platform.
    fn from_raw(raw: &libc::stat) -> Stat {
        Stat {
            dev: raw.st_dev as i64,
            ino: raw.st_ino as i64,
            mode: raw.st_mode as i64,
            nlink: raw.st_nlink as i64,
            uid: raw.st_uid as i64,
            gid: raw.st_gid as i64,
            rdev: raw.st_rdev as i64,
            size: raw.st_size as i64,
            blksize: raw.st_blksize as i64,
            blocks: raw.st_blocks as i64,
            atime: (raw.st_atime as i64, raw.st_atime_nsec as i64),
            mtime: (raw.st_mtime as i64, raw.st_mtime_nsec as i64),
            ctime: (raw.st_ctime as i64, raw.st_ctime_nsec as i64),
        }
    }

    /// `stats.mtimeNs` of a bigint stat: `sec * 10n ** 9n + nsec`.
    pub fn mtime_ns(&self) -> i128 {
        self.mtime.0 as i128 * 1_000_000_000 + self.mtime.1 as i128
    }

    /// `stats.ctimeNs` of a bigint stat.
    pub fn ctime_ns(&self) -> i128 {
        self.ctime.0 as i128 * 1_000_000_000 + self.ctime.1 as i128
    }

    /// `stats.mtimeMs` of a number stat: `sec * 1e3 + nsec / 1e6` in doubles.
    pub fn mtime_ms(&self) -> f64 {
        self.mtime.0 as f64 * 1e3 + self.mtime.1 as f64 / 1e6
    }

    /// Whether the file-type bits of `mode` are `kind` (one of `libc::S_IF*`).
    // `mode_t` is 16 bits on macOS and 32 on Linux: the cast is needed on
    // one and redundant on the other, and `u32::from` is redundant on Linux too.
    #[allow(clippy::unnecessary_cast)]
    fn has_type(&self, kind: libc::mode_t) -> bool {
        (self.mode as u32 & libc::S_IFMT as u32) == kind as u32
    }

    pub fn is_file(&self) -> bool {
        self.has_type(libc::S_IFREG)
    }

    pub fn is_directory(&self) -> bool {
        self.has_type(libc::S_IFDIR)
    }

    pub fn is_symbolic_link(&self) -> bool {
        self.has_type(libc::S_IFLNK)
    }

    /// The ledger's file stamp, `dev:ino:size:mtimeNs:ctimeNs` and `:mode`
    /// when asked, as `[stat.dev, ...].join(':')` prints a bigint stat.
    pub fn stamp(&self, with_mode: bool) -> String {
        let mut out = format!(
            "{}:{}:{}:{}:{}",
            self.dev,
            self.ino,
            self.size,
            self.mtime_ns(),
            self.ctime_ns()
        );
        if with_mode {
            out.push_str(&format!(":{}", self.mode));
        }
        out
    }
}

fn stat_call(path: &str, syscall: &'static str, follow: bool) -> Result<Stat> {
    let c = c_path(path)?;
    // SAFETY: `libc::stat` is plain old data; an all-zero value is valid.
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    let result = retry(|| {
        // SAFETY: `c` is a NUL-terminated string that outlives the call and
        // `raw` is a valid, writable `struct stat`.
        (unsafe {
            if follow {
                libc::stat(c.as_ptr(), &mut raw)
            } else {
                libc::lstat(c.as_ptr(), &mut raw)
            }
        }) as isize
    });
    check(result, syscall, Some(path))?;
    Ok(Stat::from_raw(&raw))
}

/// `fs.lstat` (`uv__fs_lstat`; on Linux libuv asks `statx`, whose fields are the same).
pub fn lstat(path: &str) -> Result<Stat> {
    stat_call(path, "lstat", false)
}

/// `fs.stat` (`uv__fs_stat`).
pub fn stat(path: &str) -> Result<Stat> {
    stat_call(path, "stat", true)
}

/// `fstat(2)` on an open descriptor.
pub fn fstat(fd: c_int) -> Result<Stat> {
    // SAFETY: as in `stat_call`.
    let mut raw: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `raw` is a valid, writable `struct stat`; a bad descriptor fails with EBADF.
    let result = retry(|| (unsafe { libc::fstat(fd, &mut raw) }) as isize);
    check(result, "fstat", None)?;
    Ok(Stat::from_raw(&raw))
}

/// Node's open flags strings the ledger uses (`stringToFlags`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFlags {
    /// `'r'`: `O_RDONLY`.
    Read,
    /// `'wx'`: `O_TRUNC | O_CREAT | O_WRONLY | O_EXCL`.
    WriteExclusive,
}

impl OpenFlags {
    pub fn bits(self) -> c_int {
        match self {
            OpenFlags::Read => libc::O_RDONLY,
            OpenFlags::WriteExclusive => {
                libc::O_TRUNC | libc::O_CREAT | libc::O_WRONLY | libc::O_EXCL
            }
        }
    }

    pub fn as_node(self) -> &'static str {
        match self {
            OpenFlags::Read => "r",
            OpenFlags::WriteExclusive => "wx",
        }
    }
}

/// `uv__fs_open`: `open(path, flags | O_CLOEXEC, mode)`.
pub fn open_raw(path: &str, flags: c_int, mode: u32) -> Result<c_int> {
    let c = c_path(path)?;
    let result = retry(|| {
        // SAFETY: `c` is NUL-terminated and outlives the call; the mode is
        // passed as the variadic `unsigned int` open(2) reads.
        (unsafe { libc::open(c.as_ptr(), flags | libc::O_CLOEXEC, mode as libc::c_uint) }) as isize
    });
    Ok(check(result, "open", Some(path))? as c_int)
}

/// An open descriptor with Node `FileHandle` close semantics: after the
/// first close (failed or not) the descriptor is gone and closing again does
/// nothing. A handle dropped while open is closed, as Node's garbage
/// collector closes a forgotten `FileHandle`.
#[derive(Debug)]
pub struct File {
    fd: c_int,
    path: String,
}

impl File {
    pub fn open(path: &str, flags: OpenFlags, mode: u32) -> Result<File> {
        Ok(File {
            fd: open_raw(path, flags.bits(), mode)?,
            path: path.to_owned(),
        })
    }

    pub fn fd(&self) -> c_int {
        self.fd
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// `filehandle.writeFile(data)` (`writeFileHandle`): nothing for empty
    /// data, otherwise `write(2)` of at most 512 KiB (`kWriteFileMaxChunkSize`)
    /// at a time until every byte is written.
    pub fn write_file(&mut self, data: &[u8]) -> Result<()> {
        const MAX_CHUNK: usize = 512 * 1024;
        let mut rest = data;
        if rest.is_empty() {
            return Ok(());
        }
        loop {
            let chunk = &rest[..rest.len().min(MAX_CHUNK)];
            let written = write(self.fd, chunk)?;
            rest = &rest[written..];
            if rest.is_empty() {
                return Ok(());
            }
        }
    }

    /// `filehandle.sync()` (`uv__fs_fsync`).
    pub fn sync(&mut self) -> Result<()> {
        fsync(self.fd)
    }

    /// `filehandle.close()` (`uv__fs_close`).
    pub fn close(&mut self) -> Result<()> {
        if self.fd < 0 {
            return Ok(());
        }
        let fd = self.fd;
        self.fd = -1;
        close(fd)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// `uv__fs_write` with no position: `write(2)`, retried on EINTR.
pub fn write(fd: c_int, bytes: &[u8]) -> Result<usize> {
    // SAFETY: the pointer and length describe the live slice `bytes`.
    let result = retry(|| unsafe { libc::write(fd, bytes.as_ptr().cast::<c_void>(), bytes.len()) });
    Ok(check(result, "write", None)? as usize)
}

/// `uv__fs_fsync`. On macOS `fcntl(F_FULLFSYNC)`; if that does not return 0,
/// `fcntl(F_BARRIERFSYNC)` (85); if that does not either, `fsync(2)`. The
/// whole chain is retried on EINTR (`uv__fs_work`). Elsewhere `fsync(2)`.
pub fn fsync(fd: c_int) -> Result<()> {
    let result = retry(|| {
        #[cfg(target_os = "macos")]
        {
            // SAFETY: fcntl with an integer command and no argument, and
            // fsync, on a caller-provided descriptor; a bad one fails with EBADF.
            let mut r = unsafe { libc::fcntl(fd, libc::F_FULLFSYNC) };
            if r != 0 {
                r = unsafe { libc::fcntl(fd, F_BARRIERFSYNC) };
            }
            if r != 0 {
                r = unsafe { libc::fsync(fd) };
            }
            r as isize
        }
        #[cfg(not(target_os = "macos"))]
        {
            // SAFETY: fsync on a caller-provided descriptor.
            (unsafe { libc::fsync(fd) }) as isize
        }
    });
    check(result, "fsync", None).map(|_| ())
}

/// `F_BARRIERFSYNC`, which libuv spells as the number 85.
#[cfg(target_os = "macos")]
pub const F_BARRIERFSYNC: c_int = 85;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    #[link_name = "close$NOCANCEL"]
    fn close_nocancel(fd: c_int) -> c_int;
}

/// `uv__close_nocancel`: `close$NOCANCEL` on macOS, the raw `close` system
/// call on Linux.
fn close_raw(fd: c_int) -> c_int {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: closes a descriptor this crate opened and owns.
        unsafe { close_nocancel(fd) }
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: as above; `syscall(SYS_close, fd)` is what libuv calls.
        (unsafe { libc::syscall(libc::SYS_close, fd as libc::c_long) }) as c_int
    }
}

/// `uv__fs_close`: not retried; EINTR and EINPROGRESS count as closed.
pub fn close(fd: c_int) -> Result<()> {
    if close_raw(fd) == -1 {
        let errno = last_errno();
        if errno != libc::EINTR && errno != libc::EINPROGRESS {
            return Err(Error::os(errno, "close", None));
        }
    }
    Ok(())
}

fn path_call(path: &str, syscall: &'static str, call: impl Fn(&CStr) -> c_int) -> Result<()> {
    let c = c_path(path)?;
    let result = retry(|| call(&c) as isize);
    check(result, syscall, Some(path)).map(|_| ())
}

fn two_path_call(
    from: &str,
    to: &str,
    syscall: &'static str,
    call: impl Fn(&CStr, &CStr) -> c_int,
) -> Result<()> {
    let a = c_path(from)?;
    let b = c_path(to)?;
    let result = retry(|| call(&a, &b) as isize);
    if result == -1 {
        return Err(Error::os_with_dest(
            last_errno(),
            syscall,
            Some(from),
            Some(to),
        ));
    }
    Ok(())
}

/// `rename(2)`.
pub fn rename(from: &str, to: &str) -> Result<()> {
    // SAFETY: both arguments are NUL-terminated strings that outlive the call.
    two_path_call(from, to, "rename", |a, b| unsafe {
        libc::rename(a.as_ptr(), b.as_ptr())
    })
}

/// `link(2)`.
pub fn link(from: &str, to: &str) -> Result<()> {
    // SAFETY: as for `rename`.
    two_path_call(from, to, "link", |a, b| unsafe {
        libc::link(a.as_ptr(), b.as_ptr())
    })
}

/// `unlink(2)`.
pub fn unlink(path: &str) -> Result<()> {
    // SAFETY: a NUL-terminated string that outlives the call.
    path_call(path, "unlink", |c| unsafe { libc::unlink(c.as_ptr()) })
}

/// `rmdir(2)`.
pub fn rmdir(path: &str) -> Result<()> {
    // SAFETY: as for `unlink`.
    path_call(path, "rmdir", |c| unsafe { libc::rmdir(c.as_ptr()) })
}

/// `chmod(2)`.
pub fn chmod(path: &str, mode: u32) -> Result<()> {
    // SAFETY: as for `unlink`; the mode is a `mode_t`.
    path_call(path, "chmod", |c| unsafe {
        libc::chmod(c.as_ptr(), mode as libc::mode_t)
    })
}

/// `mkdir(2)` of one directory (`uv__fs_mkdir`).
pub fn mkdir(path: &str, mode: u32) -> Result<()> {
    // SAFETY: as for `unlink`; the mode is a `mode_t`.
    path_call(path, "mkdir", |c| unsafe {
        libc::mkdir(c.as_ptr(), mode as libc::mode_t)
    })
}

/// `fs.promises.mkdir(path, { recursive: true, mode })`: Node's
/// `MKDirpAsync` (`src/node_file.cc`), a stack of paths:
/// - `mkdir` the top; success pops the next one, or ends when none is left;
/// - `EACCES`, `ENOSPC`, `ENOTDIR`, `EPERM` end with that error;
/// - `ENOENT` pushes the path back and its parent (everything before the last
///   `/`) on top; a path with no parent and nothing below it becomes `EEXIST`;
/// - anything else (`EEXIST` above all) `stat`s the path: after an `EEXIST`
///   with paths still below, an existing directory continues and anything
///   else (a stat error too) is `ENOTDIR`; otherwise the stat's own result
///   ends it, a non-directory being `EEXIST`.
///
/// Every error names `mkdir` and the path being made when it happened (the
/// stat's errno too), as Node's request reports it.
pub fn mkdir_recursive(path: &str, mode: u32) -> Result<()> {
    let mut stack: Vec<String> = vec![path.to_owned()];
    while let Some(next) = stack.pop() {
        let mut outcome = mkdir(&next, mode);
        loop {
            match outcome {
                Ok(()) => break,
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "EACCES" | "ENOSPC" | "ENOTDIR" | "EPERM"
                    ) =>
                {
                    return Err(error);
                }
                Err(error) if error.code == "ENOENT" => {
                    // `substr(0, find_last_of('/'))`: the whole path when it has no `/`.
                    let parent = match next.rfind('/') {
                        Some(index) => next[..index].to_owned(),
                        None => next.clone(),
                    };
                    if parent != next {
                        stack.push(next.clone());
                        stack.push(parent);
                    } else if stack.is_empty() {
                        outcome = Err(Error::os(libc::EEXIST, "mkdir", Some(&next)));
                        continue;
                    }
                    break;
                }
                Err(error) => {
                    let was_exist = error.code == "EEXIST";
                    let checked = stat(&next);
                    if was_exist && !stack.is_empty() {
                        match checked {
                            Ok(stat) if stat.is_directory() => break,
                            _ => return Err(Error::os(libc::ENOTDIR, "mkdir", Some(&next))),
                        }
                    }
                    return match checked {
                        Ok(stat) if stat.is_directory() => Ok(()),
                        Ok(_) => Err(Error::os(libc::EEXIST, "mkdir", Some(&next))),
                        Err(stat_error) => Err(match stat_error.system_errno() {
                            Some(errno) => Error::os(errno, "mkdir", Some(&next)),
                            None => stat_error,
                        }),
                    };
                }
            }
        }
    }
    Ok(())
}

/// `uv__fs_utime`: `utimensat(AT_FDCWD, path, times, 0)` with each time in
/// seconds converted by `uv__fs_to_timespec` (infinite: `UTIME_NOW`, NaN:
/// `UTIME_OMIT`, otherwise whole seconds and the fraction in nanoseconds).
pub fn utimes(path: &str, atime: f64, mtime: f64) -> Result<()> {
    fn timespec(time: f64) -> libc::timespec {
        if time.is_infinite() {
            return libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_NOW,
            };
        }
        if time.is_nan() {
            return libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_OMIT,
            };
        }
        let mut sec = time as libc::time_t;
        let mut nsec = ((time - sec as f64) * 1e9) as libc::c_long;
        if nsec < 0 {
            nsec += 1_000_000_000;
            sec -= 1;
        }
        libc::timespec {
            tv_sec: sec,
            tv_nsec: nsec,
        }
    }
    let times = [timespec(atime), timespec(mtime)];
    // SAFETY: a NUL-terminated path and a two-element timespec array, as utimensat requires.
    path_call(path, "utime", |c| unsafe {
        libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), 0)
    })
}

/// `uv__fs_realpath`: `realpath(path, NULL)`.
pub fn realpath(path: &str) -> Result<String> {
    let c = c_path(path)?;
    // A null result is the failure that `uv__fs_work` retries on EINTR.
    let resolved = retry(|| {
        // SAFETY: `c` is NUL-terminated; a null buffer asks realpath to allocate.
        let pointer = unsafe { libc::realpath(c.as_ptr(), std::ptr::null_mut()) };
        if pointer.is_null() {
            -1
        } else {
            pointer as isize
        }
    });
    if resolved == -1 {
        return Err(Error::os(last_errno(), "realpath", Some(path)));
    }
    let pointer = resolved as *mut libc::c_char;
    // SAFETY: realpath returned a NUL-terminated string it allocated with malloc.
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    // SAFETY: the buffer came from realpath's malloc and is freed once.
    unsafe { libc::free(pointer.cast::<c_void>()) };
    Ok(text)
}

/// What `fs.statfs` returns (`uv__fs_statfs`; `frsize` is `f_bsize` outside Linux).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatFs {
    pub kind: i64,
    pub bsize: i64,
    pub blocks: i64,
    pub bfree: i64,
    pub bavail: i64,
    pub files: i64,
    pub ffree: i64,
    pub frsize: i64,
}

/// `statfs(2)`.
#[allow(clippy::unnecessary_cast)] // The field types differ by platform.
pub fn statfs(path: &str) -> Result<StatFs> {
    let c = c_path(path)?;
    // SAFETY: `libc::statfs` is plain old data; zero is a valid value.
    let mut raw: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a writable `struct statfs`.
    let result = retry(|| (unsafe { libc::statfs(c.as_ptr(), &mut raw) }) as isize);
    check(result, "statfs", Some(path))?;
    #[cfg(target_os = "linux")]
    let frsize = raw.f_frsize as i64;
    #[cfg(not(target_os = "linux"))]
    let frsize = raw.f_bsize as i64;
    Ok(StatFs {
        kind: raw.f_type as i64,
        bsize: raw.f_bsize as i64,
        blocks: raw.f_blocks as i64,
        bfree: raw.f_bfree as i64,
        bavail: raw.f_bavail as i64,
        files: raw.f_files as i64,
        ffree: raw.f_ffree as i64,
        frsize,
    })
}

/// `fs.promises.readFile(path)`: open `'r'`, read to the end, close. A read
/// error closes first and reports the read's error.
pub fn read_file(path: &str) -> Result<Vec<u8>> {
    let mut file = File::open(path, OpenFlags::Read, 0o666)?;
    let mut out = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        // SAFETY: the pointer and length describe the live, writable `buffer`.
        let read =
            unsafe { libc::read(file.fd, buffer.as_mut_ptr().cast::<c_void>(), buffer.len()) };
        if read == -1 {
            let error = Error::os(last_errno(), "read", None);
            let _ = file.close();
            return Err(error);
        }
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..read as usize]);
    }
    file.close()?;
    Ok(out)
}

/// A directory entry as `readdir(dir, { withFileTypes: true })` gives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    /// The name decoded as Node decodes it (UTF-8, ill-formed bytes to U+FFFD).
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
}

/// `fs.promises.readdir(dir, { withFileTypes: true })`: libuv's
/// `uv__fs_scandir` lists every entry but `.` and `..`, sorted by `strcmp`
/// of the raw names; the type comes from `d_type`, and Node `lstat`s an
/// entry whose type is unknown. `std::fs::read_dir` reads the same entries
/// and types the same way (`d_type`, then `lstat`).
pub fn readdir(dir: &str) -> Result<Vec<DirEntry>> {
    use std::os::unix::ffi::OsStrExt;
    let map = |error: std::io::Error| {
        Error::os(
            error.raw_os_error().unwrap_or(libc::EIO),
            "scandir",
            Some(dir),
        )
    };
    let mut raw = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(map)? {
        let entry = entry.map_err(map)?;
        let kind = entry.file_type().map_err(map)?;
        raw.push((
            entry.file_name().as_bytes().to_vec(),
            kind.is_file(),
            kind.is_dir(),
        ));
    }
    raw.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(raw
        .into_iter()
        .map(|(name, is_file, is_directory)| DirEntry {
            name: String::from_utf8_lossy(&name).into_owned(),
            is_file,
            is_directory,
        })
        .collect())
}

/// Opens a directory `'r'`, syncs it (`uv__fs_fsync`) and closes it, as
/// `syncDirectory` in `atomic-file.js` does. A failed sync still closes.
pub fn sync_directory(path: &str) -> Result<()> {
    let mut file = File::open(path, OpenFlags::Read, 0o666)?;
    let synced = file.sync();
    let closed = file.close();
    synced.and(closed)
}

/// `process.pid`.
pub fn getpid() -> i64 {
    // SAFETY: getpid has no preconditions.
    (unsafe { libc::getpid() }) as i64
}

/// The process's peak resident memory in bytes (`getrusage`'s `ru_maxrss`:
/// bytes on macOS, KiB on Linux), for the test probes' memory bounds.
pub fn peak_resident_bytes() -> u64 {
    // SAFETY: an all-zero `rusage` is valid; getrusage writes the whole struct.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `usage` is a valid, writable `struct rusage`.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return 0;
    }
    let peak = usage.ru_maxrss.max(0) as u64;
    if cfg!(target_os = "macos") {
        peak
    } else {
        peak * 1024
    }
}

/// `process.kill(pid, 0)` for a pid JavaScript accepts (a 32-bit integer):
/// `Ok(())` when the signal could be sent, or the error's code.
pub fn kill_zero(pid: i32) -> std::result::Result<(), String> {
    // SAFETY: signal 0 checks for existence and permission; nothing is delivered.
    if unsafe { libc::kill(pid, 0) } == 0 {
        Ok(())
    } else {
        Err(error_name(last_errno()))
    }
}

/// Cryptographically random bytes from the kernel (`getentropy` on macOS,
/// `getrandom` on Linux), as Node's `crypto.randomUUID` draws them through OpenSSL.
pub fn random_bytes(out: &mut [u8]) -> Result<()> {
    for chunk in out.chunks_mut(256) {
        #[cfg(target_os = "macos")]
        {
            // SAFETY: at most 256 writable bytes, getentropy's limit.
            if unsafe { libc::getentropy(chunk.as_mut_ptr().cast::<c_void>(), chunk.len()) } != 0 {
                return Err(Error::os(last_errno(), "getentropy", None));
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut filled = 0;
            while filled < chunk.len() {
                // SAFETY: the pointer and length describe the unfilled tail of `chunk`.
                let got = unsafe {
                    libc::getrandom(
                        chunk[filled..].as_mut_ptr().cast::<c_void>(),
                        chunk.len() - filled,
                        0,
                    )
                };
                if got == -1 {
                    if last_errno() == libc::EINTR {
                        continue;
                    }
                    return Err(Error::os(last_errno(), "getrandom", None));
                }
                filled += got as usize;
            }
        }
    }
    Ok(())
}

/// `EISDIR`, for errors Node raises itself (`ERR_FS_EISDIR`).
pub const EISDIR: i32 = libc::EISDIR;

/// `fs.constants.COPYFILE_EXCL`.
pub const COPYFILE_EXCL: u32 = 1;
/// `fs.constants.COPYFILE_FICLONE`.
pub const COPYFILE_FICLONE: u32 = 2;
/// `fs.constants.COPYFILE_FICLONE_FORCE`.
pub const COPYFILE_FICLONE_FORCE: u32 = 4;

/// `uv__fs_copyfile` in libuv 1.52.1. There is **no** macOS `copyfile(3)`
/// or `clonefile(2)` in it: on every Unix it opens the source `O_RDONLY`,
/// `fstat`s it, opens the destination `O_WRONLY | O_CREAT` (`| O_EXCL` with
/// `COPYFILE_EXCL`) with the source's mode; without `EXCL` it `fstat`s the
/// destination, stops (successfully) when both are the same file, and
/// truncates it (an `EACCES` on an empty file is ignored); it copies the
/// access and modification times with `futimens`, the owner with `fchown`
/// (errors ignored) and the mode with `fchmod`. On Linux `COPYFILE_FICLONE`
/// tries `ioctl(FICLONE)` and `FICLONE_FORCE` requires it; elsewhere
/// `FICLONE` is ignored and `FICLONE_FORCE` fails with `ENOSYS`. The bytes
/// then go through `uv_fs_sendfile` (macOS: `sendfile(2)`, which refuses a
/// file target with `ENOTSOCK`, then 8 KiB `pread`/`write` rounds; Linux:
/// `copy_file_range`, then `sendfile`, then the same rounds). Both
/// descriptors are closed, and a failed copy unlinks the destination.
pub fn copyfile(src: &str, dst: &str, flags: u32) -> Result<()> {
    if flags & !(COPYFILE_EXCL | COPYFILE_FICLONE | COPYFILE_FICLONE_FORCE) != 0 {
        return Err(Error::os_with_dest(
            libc::EINVAL,
            "copyfile",
            Some(src),
            Some(dst),
        ));
    }
    let src_fd = match open_raw(src, libc::O_RDONLY, 0) {
        Ok(fd) => fd,
        Err(error) => {
            return Err(match error.system_errno() {
                Some(errno) => Error::os_with_dest(errno, "copyfile", Some(src), Some(dst)),
                None => error,
            });
        }
    };
    let mut dst_fd: c_int = -1;
    let outcome = copy_open(src_fd, &mut dst_fd, dst, flags);
    let mut result = outcome;
    if let Err(error) = close(src_fd)
        && result.is_ok()
    {
        result = Err(error);
    }
    if dst_fd >= 0 {
        if let Err(error) = close(dst_fd)
            && result.is_ok()
        {
            result = Err(error);
        }
        if result.is_err() {
            let _ = unlink(dst);
        }
    }
    // libuv reports every failure of the copy as the request's: `copyfile`, both paths.
    result.map_err(|error| match error.system_errno() {
        Some(errno) => Error::os_with_dest(errno, "copyfile", Some(src), Some(dst)),
        None => error,
    })
}

fn copy_open(src_fd: c_int, dst_fd: &mut c_int, dst: &str, flags: u32) -> Result<()> {
    let source = fstat(src_fd)?;
    let mut dst_flags = libc::O_WRONLY | libc::O_CREAT;
    if flags & COPYFILE_EXCL != 0 {
        dst_flags |= libc::O_EXCL;
    }
    *dst_fd = open_raw(dst, dst_flags, source.mode as u32)?;
    let fd = *dst_fd;
    if flags & COPYFILE_EXCL == 0 {
        let target = fstat(fd)?;
        if source.dev == target.dev && source.ino == target.ino {
            return Ok(());
        }
        // SAFETY: truncates the descriptor opened above.
        if unsafe { libc::ftruncate(fd, 0) } != 0 {
            let errno = last_errno();
            if errno != libc::EACCES || target.size > 0 {
                return Err(Error::os(errno, "ftruncate", None));
            }
        }
    }
    let times = [
        libc::timespec {
            tv_sec: source.atime.0 as libc::time_t,
            tv_nsec: source.atime.1 as libc::c_long,
        },
        libc::timespec {
            tv_sec: source.mtime.0 as libc::time_t,
            tv_nsec: source.mtime.1 as libc::c_long,
        },
    ];
    // SAFETY: a two-element timespec array for the descriptor opened above.
    if unsafe { libc::futimens(fd, times.as_ptr()) } == -1 {
        return Err(Error::os(last_errno(), "futimens", None));
    }
    // SAFETY: ownership change of the descriptor opened above; errors are ignored, as libuv does.
    let _ = unsafe { libc::fchown(fd, source.uid as libc::uid_t, source.gid as libc::gid_t) };
    // SAFETY: mode change of the descriptor opened above.
    if unsafe { libc::fchmod(fd, source.mode as libc::mode_t) } == -1 {
        let errno = last_errno();
        #[cfg(target_os = "linux")]
        let ignored = errno == libc::EPERM && linux::is_cifs_or_smb(fd);
        #[cfg(not(target_os = "linux"))]
        let ignored = false;
        if !ignored {
            return Err(Error::os(errno, "fchmod", None));
        }
    }
    #[cfg(target_os = "linux")]
    if flags & (COPYFILE_FICLONE | COPYFILE_FICLONE_FORCE) != 0 {
        // SAFETY: FICLONE takes the source descriptor as its argument.
        if unsafe { libc::ioctl(fd, linux::FICLONE, src_fd) } == 0 {
            return Ok(());
        }
        if flags & COPYFILE_FICLONE_FORCE != 0 {
            return Err(Error::os(last_errno(), "ioctl", None));
        }
    }
    #[cfg(not(target_os = "linux"))]
    if flags & COPYFILE_FICLONE_FORCE != 0 {
        return Err(Error::os(libc::ENOSYS, "copyfile", None));
    }
    let mut remaining = source.size;
    let mut offset: i64 = 0;
    while remaining != 0 {
        let chunk = remaining.min(isize::MAX as i64) as usize;
        let sent = sendfile(fd, src_fd, &mut offset, chunk)?;
        remaining -= sent as i64;
    }
    Ok(())
}

/// `uv__fs_sendfile` (as `uv_fs_sendfile` without a loop: retried on EINTR).
fn sendfile(out_fd: c_int, in_fd: c_int, offset: &mut i64, len: usize) -> Result<usize> {
    loop {
        match sendfile_once(out_fd, in_fd, offset, len) {
            Err(errno) if errno == libc::EINTR => continue,
            Err(errno) => return Err(Error::os(errno, "sendfile", None)),
            Ok(sent) => return Ok(sent),
        }
    }
}

#[cfg(target_os = "macos")]
fn sendfile_once(
    out_fd: c_int,
    in_fd: c_int,
    offset: &mut i64,
    len: usize,
) -> std::result::Result<usize, i32> {
    let mut sent = len as libc::off_t;
    // SAFETY: Darwin's sendfile(fd, socket, offset, &len, hdtr, flags) with no header vector.
    let r = unsafe { libc::sendfile(in_fd, out_fd, *offset, &mut sent, std::ptr::null_mut(), 0) };
    let errno = if r == 0 { 0 } else { last_errno() };
    if r == 0 || ((errno == libc::EAGAIN || errno == libc::EINTR) && sent != 0) {
        *offset += sent;
        return Ok(sent as usize);
    }
    if matches!(
        errno,
        libc::EINVAL | libc::EIO | libc::ENOTSOCK | libc::EXDEV
    ) {
        return sendfile_emulated(out_fd, in_fd, offset, len);
    }
    Err(errno)
}

#[cfg(target_os = "linux")]
fn sendfile_once(
    out_fd: c_int,
    in_fd: c_int,
    offset: &mut i64,
    len: usize,
) -> std::result::Result<usize, i32> {
    let start = *offset;
    let mut off: libc::off_t = start;
    let mut r = linux::try_copy_file_range(in_fd, &mut off, out_fd, len);
    let try_sendfile = r == -1 && last_errno() == libc::ENOSYS;
    if try_sendfile {
        // SAFETY: Linux sendfile(out, in, &offset, count) between two open descriptors.
        r = unsafe { libc::sendfile(out_fd, in_fd, &mut off, len) };
    }
    if r != -1 || off > start {
        *offset = off;
        return Ok((off - start) as usize);
    }
    let errno = last_errno();
    if matches!(
        errno,
        libc::EINVAL | libc::EIO | libc::ENOTSOCK | libc::EXDEV
    ) {
        return sendfile_emulated(out_fd, in_fd, offset, len);
    }
    Err(errno)
}

/// `uv__fs_sendfile_emul`: 8 KiB rounds of `pread` (falling back to `read`
/// on `EIO` or `ESPIPE` before anything was sent) and `write`, polling for
/// writability on `EAGAIN`. A read error after some bytes reports the bytes.
fn sendfile_emulated(
    out_fd: c_int,
    in_fd: c_int,
    offset: &mut i64,
    len: usize,
) -> std::result::Result<usize, i32> {
    let mut buffer = [0u8; 8192];
    let mut use_pread = true;
    let mut position = *offset;
    let mut sent: usize = 0;
    let mut failed: Option<i32> = None;
    while sent < len {
        let want = (len - sent).min(buffer.len());
        let read = loop {
            // SAFETY: reads at most `want` bytes into the live stack buffer.
            let n = unsafe {
                if use_pread {
                    libc::pread(
                        in_fd,
                        buffer.as_mut_ptr().cast::<c_void>(),
                        want,
                        position as libc::off_t,
                    )
                } else {
                    libc::read(in_fd, buffer.as_mut_ptr().cast::<c_void>(), want)
                }
            };
            if n == -1 && last_errno() == libc::EINTR {
                continue;
            }
            break n;
        };
        if read == 0 {
            break;
        }
        if read == -1 {
            let errno = last_errno();
            if use_pread && sent == 0 && (errno == libc::EIO || errno == libc::ESPIPE) {
                use_pread = false;
                continue;
            }
            if sent == 0 {
                failed = Some(errno);
            }
            break;
        }
        let read = read as usize;
        let mut written = 0;
        while written < read {
            // SAFETY: writes the initialised prefix of the stack buffer.
            let n = unsafe {
                libc::write(
                    out_fd,
                    buffer[written..read].as_ptr().cast::<c_void>(),
                    read - written,
                )
            };
            if n != -1 {
                written += n as usize;
                continue;
            }
            let errno = last_errno();
            if errno == libc::EINTR {
                continue;
            }
            if errno != libc::EAGAIN && errno != libc::EWOULDBLOCK {
                return Err(errno);
            }
            let mut poll = libc::pollfd {
                fd: out_fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            let polled = loop {
                // SAFETY: one pollfd, no timeout.
                let n = unsafe { libc::poll(&mut poll, 1, -1) };
                if n == -1 && last_errno() == libc::EINTR {
                    continue;
                }
                break n;
            };
            if polled == -1 || (poll.revents & !libc::POLLOUT) != 0 {
                return Err(libc::EIO);
            }
        }
        position += read as i64;
        sent += read;
    }
    if let Some(errno) = failed {
        return Err(errno);
    }
    *offset = position;
    Ok(sent)
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{c_int, last_errno};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// `FICLONE`, `_IOW(0x94, 9, int)`.
    pub const FICLONE: libc::Ioctl = 0x4004_9409;

    static NO_COPY_FILE_RANGE: AtomicBool = AtomicBool::new(false);

    fn fs_type(fd: c_int) -> Option<u64> {
        // SAFETY: plain old data, then fstatfs on an open descriptor.
        let mut raw: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(fd, &mut raw) } == -1 {
            return None;
        }
        Some(raw.f_type as u64)
    }

    pub fn is_cifs_or_smb(fd: c_int) -> bool {
        matches!(
            fs_type(fd).map(|kind| kind as u32),
            Some(0x0000_517B | 0xFE53_4D42 | 0xFF53_4D42)
        )
    }

    /// `uv__fs_try_copy_file_range`. libuv's CephFS case also checks for a
    /// kernel before 4.20; this treats every CephFS `EACCES` as one (the
    /// copy then falls back, with the same bytes).
    pub fn try_copy_file_range(
        in_fd: c_int,
        off: &mut libc::off_t,
        out_fd: c_int,
        len: usize,
    ) -> isize {
        if NO_COPY_FILE_RANGE.load(Ordering::Relaxed) {
            set_errno(libc::ENOSYS);
            return -1;
        }
        // SAFETY: copy_file_range between two open descriptors with an input offset.
        let r = unsafe { libc::copy_file_range(in_fd, off, out_fd, std::ptr::null_mut(), len, 0) };
        if r != -1 {
            return r;
        }
        match last_errno() {
            libc::EACCES if fs_type(in_fd) == Some(0x00C3_6400) => set_errno(libc::ENOSYS),
            libc::ENOSYS => NO_COPY_FILE_RANGE.store(true, Ordering::Relaxed),
            libc::EPERM if is_cifs_or_smb(out_fd) => set_errno(libc::ENOSYS),
            libc::ENOTSUP | libc::EXDEV => set_errno(libc::ENOSYS),
            _ => {}
        }
        -1
    }

    fn set_errno(value: c_int) {
        // SAFETY: __errno_location returns this thread's errno.
        unsafe { *libc::__errno_location() = value };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> String {
        let mut bytes = [0u8; 8];
        random_bytes(&mut bytes).unwrap();
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("ledger-io-{name}-{hex}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn names_errors_as_libuv() {
        assert_eq!(error_name(libc::ENOENT), "ENOENT");
        assert_eq!(error_name(libc::ENOTSUP), "ENOTSUP");
        #[cfg(target_os = "macos")]
        assert_eq!(error_name(libc::EOPNOTSUPP), "Unknown system error -102");
        #[cfg(target_os = "linux")]
        assert_eq!(error_name(libc::EOPNOTSUPP), "ENOTSUP");
        assert_eq!(error_name(9999), "Unknown system error -9999");
        assert_eq!(error_message(9999), "Unknown system error -9999");
    }

    #[test]
    fn messages_follow_node_layout() {
        let error = Error::os_with_dest(libc::EISDIR, "rename", Some("/a"), Some("/b"));
        assert_eq!(
            error.message,
            "EISDIR: illegal operation on a directory, rename '/a' -> '/b'"
        );
        assert_eq!(error.errno, Some(-libc::EISDIR));
        assert_eq!(error.system_errno(), Some(libc::EISDIR));
        assert_eq!(error.dest.as_deref(), Some("/b"));
        assert_eq!(
            Error::os(libc::EIO, "fsync", None).message,
            "EIO: i/o error, fsync"
        );
    }

    #[test]
    fn exclusive_open_write_sync_link_and_stamp() {
        let dir = scratch("open");
        let file = format!("{dir}/a");
        let mut handle = File::open(&file, OpenFlags::WriteExclusive, 0o600).unwrap();
        handle.write_file(b"hello").unwrap();
        handle.sync().unwrap();
        handle.close().unwrap();
        handle.close().unwrap();
        assert_eq!(
            File::open(&file, OpenFlags::WriteExclusive, 0o600)
                .unwrap_err()
                .code,
            "EEXIST"
        );
        link(&file, &format!("{dir}/b")).unwrap();
        assert_eq!(link(&file, &format!("{dir}/b")).unwrap_err().code, "EEXIST");
        let stat = lstat(&file).unwrap();
        assert_eq!(stat.mode & 0o777, 0o600);
        assert_eq!(stat.nlink, 2);
        assert!(stat.stamp(true).ends_with(&format!(":{}", stat.mode)));
        assert_eq!(read_file(&format!("{dir}/b")).unwrap(), b"hello");
        sync_directory(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recursive_mkdir_follows_node() {
        let dir = scratch("mkdir");
        mkdir_recursive(&format!("{dir}/x/y/z"), 0o700).unwrap();
        mkdir_recursive(&format!("{dir}/x/y/z"), 0o700).unwrap();
        std::fs::write(format!("{dir}/file"), b"").unwrap();
        assert_eq!(
            mkdir_recursive(&format!("{dir}/file"), 0o700)
                .unwrap_err()
                .code,
            "EEXIST"
        );
        assert_eq!(
            mkdir_recursive(&format!("{dir}/file/sub"), 0o700)
                .unwrap_err()
                .code,
            "ENOTDIR"
        );
        // A dangling link in the middle: ENOENT, then EEXIST on the link, whose
        // stat fails, so ENOTDIR naming the link, as Node reports it.
        std::os::unix::fs::symlink("nowhere", format!("{dir}/dangling")).unwrap();
        let error = mkdir_recursive(&format!("{dir}/dangling/x"), 0o700).unwrap_err();
        assert_eq!(
            error.message,
            format!("ENOTDIR: not a directory, mkdir '{dir}/dangling'")
        );
        // A path without a slash has itself as its parent.
        assert_eq!(
            mkdir_recursive("", 0o700).unwrap_err().message,
            "ENOENT: no such file or directory, mkdir ''"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copyfile_copies_bytes_mode_and_times_and_honours_excl() {
        let dir = scratch("copy");
        let source = format!("{dir}/s");
        std::fs::write(&source, vec![7u8; 20_000]).unwrap();
        // A mode the umask clips, so only fchmod can give it to the copy. The
        // other tests create 0o600 and 0o700 entries, which 0o022 leaves alone.
        // SAFETY: umask has no preconditions.
        unsafe { libc::umask(0o022) };
        chmod(&source, 0o777).unwrap();
        utimes(&source, 1_000.25, 2_000.5).unwrap();
        copyfile(&source, &format!("{dir}/d"), COPYFILE_FICLONE).unwrap();
        let copied = stat(&format!("{dir}/d")).unwrap();
        assert_eq!(
            std::fs::read(format!("{dir}/d")).unwrap(),
            vec![7u8; 20_000]
        );
        assert_eq!(copied.mode & 0o777, 0o777);
        assert_eq!(copied.atime, (1_000, 250_000_000));
        // libuv sets the times before it copies the bytes, so on macOS the
        // writes move the modification time on (measured on Electron's Node
        // too); an empty source keeps it everywhere.
        #[cfg(target_os = "macos")]
        assert_ne!(copied.mtime, (2_000, 500_000_000));
        let empty = format!("{dir}/empty");
        std::fs::write(&empty, b"").unwrap();
        utimes(&empty, 1_000.25, 2_000.5).unwrap();
        copyfile(&empty, &format!("{dir}/empty-copy"), 0).unwrap();
        assert_eq!(
            stat(&format!("{dir}/empty-copy")).unwrap().mtime,
            (2_000, 500_000_000)
        );
        assert_eq!(
            copyfile(&source, &format!("{dir}/d"), COPYFILE_EXCL)
                .unwrap_err()
                .code,
            "EEXIST"
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            copyfile(&source, &format!("{dir}/e"), COPYFILE_FICLONE_FORCE)
                .unwrap_err()
                .code,
            "ENOSYS"
        );
        assert!(lstat(&format!("{dir}/e")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn realpath_statfs_kill_and_random() {
        let dir = scratch("misc");
        assert!(
            realpath(&dir)
                .unwrap()
                .ends_with(&dir[dir.rfind('/').unwrap()..])
        );
        assert!(statfs(&dir).unwrap().bsize > 0);
        assert!(kill_zero(getpid() as i32).is_ok());
        let mut a = [0u8; 300];
        random_bytes(&mut a).unwrap();
        assert!(a.iter().any(|&b| b != 0));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

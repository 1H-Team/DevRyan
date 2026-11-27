//! The few operating-system calls std does not offer: signals to a process
//! group, a reset (SO_LINGER 0) close, a SIGTERM/SIGINT flag, and raising the
//! open-file limit.

use std::io;
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};

pub const SIGTERM: i32 = libc::SIGTERM;
pub const SIGKILL: i32 = libc::SIGKILL;

/// Sends `signal` to the process group `pgid`. Refuses group 0 and 1, which
/// would mean "my own group" and "every process".
pub fn kill_group(pgid: i32, signal: i32) -> io::Result<()> {
    if pgid <= 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to signal process group 0 or 1"));
    }
    // SAFETY: killpg has no memory-safety preconditions; the group id was checked above.
    let result = unsafe { libc::killpg(pgid, signal) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Sends `signal` to one process.
pub fn kill_pid(pid: i32, signal: i32) -> io::Result<()> {
    if pid <= 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "refusing to signal pid 0 or 1"));
    }
    // SAFETY: kill has no memory-safety preconditions; the pid was checked above.
    let result = unsafe { libc::kill(pid, signal) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// True while any process of group `pgid` exists (signal 0 probes without delivering).
pub fn group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: as in kill_group; signal 0 only checks existence and permission.
    let result = unsafe { libc::killpg(pgid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// True while the process `pid` exists.
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    // SAFETY: as in kill_pid; signal 0 only checks existence and permission.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Closes `stream` with a reset instead of a FIN, as a refused or reset
/// connection looks to a client.
pub fn reset(stream: &TcpStream) {
    let linger = libc::linger { l_onoff: 1, l_linger: 0 };
    // SAFETY: the descriptor is owned by `stream` and open for this call; the
    // option value points at a live `linger` of the size passed.
    unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_LINGER,
            (&linger as *const libc::linger).cast(),
            std::mem::size_of::<libc::linger>() as libc::socklen_t,
        );
    }
}

/// Raises the soft limit on open files as far as the kernel allows, the way
/// Node does at start (its `node.cc`): to the hard limit, or, when the kernel
/// refuses that (macOS caps it at `kern.maxfilesperproc` even when the hard
/// limit is unlimited), to the highest value it accepts, found by halving.
/// Returns the soft limit in force afterwards. Processes started later inherit
/// it, as children of Node inherit Node's.
pub fn raise_open_file_limit() -> io::Result<libc::rlim_t> {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit writes one `rlimit` through a pointer to a live value.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if limit.rlim_cur == libc::RLIM_INFINITY || limit.rlim_cur >= limit.rlim_max {
        return Ok(limit.rlim_cur);
    }
    let hard = limit.rlim_max;
    let set = |value: libc::rlim_t| {
        let attempt = libc::rlimit {
            rlim_cur: value,
            rlim_max: hard,
        };
        // SAFETY: setrlimit reads one `rlimit` through a pointer to a live value.
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &attempt) == 0 }
    };
    let ceiling: libc::rlim_t = if hard == libc::RLIM_INFINITY { 1 << 20 } else { hard };
    if set(ceiling) {
        return Ok(ceiling);
    }
    // `low` is in force (or the original value), `high` was refused. A refused
    // call changes nothing, so the last accepted value is the one in force.
    let (mut low, mut high) = (limit.rlim_cur, ceiling);
    while low + 1 < high {
        let middle = low + (high - low) / 2;
        if set(middle) {
            low = middle;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_stop_signal(_signal: libc::c_int) {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

/// Routes SIGTERM and SIGINT to a flag that `stop_requested` reads.
pub fn install_stop_handler() {
    let handler = on_stop_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }
}

pub fn stop_requested() -> bool {
    STOP_REQUESTED.load(Ordering::SeqCst)
}

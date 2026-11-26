//! Spawning a child as libuv's `uv_spawn` does for Node's
//! `child_process.spawn` (libuv 1.52, `src/unix/process.c`): the program
//! found on the child's own `PATH`, each candidate tried with
//! `posix_spawn` (an `ENOENT` or `ENOTDIR` tries the next, an `EACCES` is
//! remembered and reported if nothing else is found), the environment and
//! arguments in the order given, the working directory set in the child.
//! The system calls are [`crate::fs::sys`]; this module has no unsafe code.
#![forbid(unsafe_code)]

use std::ffi::CString;

use crate::fs::sys;

/// `_PATH_DEFPATH` (`<paths.h>`, macOS and glibc alike): the search path
/// when the child's environment has none.
const DEFAULT_PATH: &str = "/usr/bin:/bin";

/// `NAME_MAX` and `PATH_MAX` as libuv's search bounds them.
const NAME_MAX: usize = 255;
const PATH_MAX: usize = 1024;

/// What to start: `file` (searched on `PATH` unless it has a `/`), `argv`
/// (its first entry is `file` itself, as Node passes it), `env` as
/// `KEY=value` entries, `cwd`, and the three descriptors the child gets
/// (`None` is `/dev/null`).
pub struct Spawn<'a> {
    pub file: &'a str,
    pub argv: &'a [String],
    pub env: &'a [String],
    pub cwd: Option<&'a str>,
    pub stdio: [Option<i32>; 3],
}

fn c_strings(items: &[String]) -> Option<Vec<CString>> {
    items
        .iter()
        .map(|item| CString::new(item.as_bytes()).ok())
        .collect()
}

/// `uv__spawn_find_path_in_env`: the value of the first `PATH=` entry.
fn path_in(env: &[String]) -> Option<&str> {
    env.iter().find_map(|entry| entry.strip_prefix("PATH="))
}

/// `uv__spawn_resolve_and_spawn`: the pid of the started child, or the errno
/// libuv's `uv_spawn` returns (`EINVAL` for a NUL in any string, which Node
/// refuses before it gets here).
pub fn spawn(request: &Spawn<'_>) -> Result<i32, i32> {
    let (Some(argv), Some(envp)) = (c_strings(request.argv), c_strings(request.env)) else {
        return Err(libc::EINVAL);
    };
    let cwd = match request.cwd {
        Some(cwd) => Some(CString::new(cwd).map_err(|_| libc::EINVAL)?),
        None => None,
    };
    let start = |path: &str| -> Result<i32, i32> {
        let path = CString::new(path).map_err(|_| libc::EINVAL)?;
        sys::posix_spawn_one(&path, &argv, &envp, cwd.as_deref(), request.stdio)
    };
    let file = request.file;
    if file.contains('/') {
        return start(file);
    }
    if file.len() > NAME_MAX {
        return Err(libc::ENAMETOOLONG);
    }
    let path = path_in(request.env).unwrap_or(DEFAULT_PATH);
    // musl's execvp search, as libuv adapts it: each entry joined with the
    // file (an empty entry is the file itself), an over-long entry skipped.
    let limit = path.len().min(PATH_MAX - 1) + 1;
    let mut seen_eacces = false;
    let mut last = libc::ENOENT;
    for entry in path.split(':') {
        if entry.len() >= limit {
            continue;
        }
        let candidate = if entry.is_empty() {
            file.to_owned()
        } else {
            format!("{entry}/{file}")
        };
        match start(&candidate) {
            Ok(pid) => return Ok(pid),
            Err(libc::EACCES) => {
                seen_eacces = true;
                last = libc::EACCES;
            }
            Err(errno @ (libc::ENOENT | libc::ENOTDIR)) => last = errno,
            Err(errno) => return Err(errno),
        }
    }
    if seen_eacces {
        return Err(libc::EACCES);
    }
    Err(last)
}

/// The name Node gives signal `number` (`SIGKILL` for 9), if it names it.
pub fn signal_name(number: i32) -> Option<&'static str> {
    sys::signals()
        .into_iter()
        .find(|(value, _)| *value == number)
        .map(|(_, name)| name)
}

/// The number of the signal Node calls `name` on this platform.
pub fn signal_number(name: &str) -> Option<i32> {
    sys::signals()
        .into_iter()
        .find(|(_, known)| *known == name)
        .map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (i32, i32) {
        sys::socketpair().expect("socketpair")
    }

    #[test]
    fn a_missing_program_is_enoent_and_a_found_one_runs_with_the_env_given() {
        let (parent, child) = pair();
        let env = vec![
            String::from("PATH=/nonexistent-o2e:/usr/bin:/bin"),
            String::from("O2E=yes"),
        ];
        let argv = vec![
            String::from("sh"),
            String::from("-c"),
            String::from("printf \"$O2E\""),
        ];
        let pid = spawn(&Spawn {
            file: "sh",
            argv: &argv,
            env: &env,
            cwd: None,
            stdio: [None, Some(child), Some(child)],
        })
        .expect("sh runs");
        sys::close(child);
        sys::wait_exited(pid).expect("waitid");
        assert!(sys::exited_unreaped(pid), "a zombie until reaped");
        assert_eq!(sys::reap(pid).expect("reap"), Some((0, 0)));
        assert!(!sys::exited_unreaped(pid));
        let mut buffer = [0u8; 100];
        let read = sys::read_into(parent, &mut buffer).expect("read");
        assert_eq!(&buffer[..read], b"yes");
        sys::close(parent);
        let missing = spawn(&Spawn {
            file: "devryan-o2e-missing",
            argv: &[String::from("devryan-o2e-missing")],
            env: &env,
            cwd: None,
            stdio: [None, None, None],
        });
        assert_eq!(missing, Err(libc::ENOENT));
        let nowhere = spawn(&Spawn {
            file: "sh",
            argv: &argv,
            env: &env,
            cwd: Some("/nonexistent-o2e-dir"),
            stdio: [None, None, None],
        });
        assert_eq!(nowhere, Err(libc::ENOENT));
    }

    #[test]
    fn signals_are_named_as_node_names_them() {
        assert_eq!(signal_name(libc::SIGKILL), Some("SIGKILL"));
        assert_eq!(signal_number("SIGTERM"), Some(libc::SIGTERM));
        assert_eq!(signal_name(0), None);
        // Node's `signo_string` does not name it: the child's death by it is
        // reported as exit code 0 (S4 of the O2e review).
        #[cfg(target_os = "macos")]
        assert_eq!(signal_name(libc::SIGEMT), None);
    }
}

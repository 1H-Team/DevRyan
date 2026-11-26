//! Spawning a child as libuv's `uv_spawn` does for Node's
//! `child_process.spawn` (libuv 1.52, `src/unix/process.c`): the program
//! found on the child's own `PATH`, each candidate tried with
//! `posix_spawn`, the environment and arguments in the order given, the
//! working directory set in the child. libuv searches differently per
//! platform, and so does this module ([`Search`]):
//!
//! - macOS: libuv's own search before `posix_spawn`
//!   (`uv__spawn_resolve_and_spawn`, adapted from musl's `execvp`): an
//!   `ENOENT` or `ENOTDIR` tries the next entry, an `EACCES` is remembered
//!   and reported if nothing else is found, any other error is the spawn's
//!   (`ENOEXEC` included: `posix_spawn` runs no shell); no `PATH` is
//!   `_PATH_DEFPATH`.
//! - Linux: libuv forks, sets `environ` to the child's environment and calls
//!   glibc's `execvp`, so the search is glibc's (`posix/execvpe.c`): an
//!   `ENOEXEC` runs the file with `/bin/sh` (`maybe_script_execute`:
//!   `/bin/sh <the path tried> <the arguments after argv[0]>`), `ESTALE`,
//!   `ENODEV` and `ETIMEDOUT` try the next entry too, and no `PATH` is
//!   glibc's `CS_PATH`.
//!
//! The system calls are [`crate::fs::sys`]; this module has no unsafe code.
#![forbid(unsafe_code)]

use std::ffi::CString;

use crate::fs::sys;

/// `_PATH_DEFPATH` (macOS `<paths.h>`): libuv's search path on macOS when
/// the child's environment has none.
const DEFAULT_PATH: &str = "/usr/bin:/bin";

/// glibc's `CS_PATH` (`confstr(_CS_PATH)`), the path `execvp` searches when
/// the environment has no `PATH`.
const CS_PATH: &str = "/bin:/usr/bin";

/// `NAME_MAX` as both searches bound a file name.
const NAME_MAX: usize = 255;

/// glibc's `_PATH_BSHELL`, the shell `execvp` runs a file without a
/// format the kernel knows (`ENOEXEC`) with.
const SHELL: &str = "/bin/sh";

/// How one platform's libuv finds and starts a program.
#[derive(Clone, Copy, Debug)]
pub struct Search {
    /// The search path when the child's environment has no `PATH`.
    pub default_path: &'static str,
    /// `PATH_MAX`: an entry as long as the path (capped at `PATH_MAX - 1`)
    /// is skipped.
    pub path_max: usize,
    /// glibc's `ENOEXEC` fallback: the file run with `/bin/sh`.
    pub shell_fallback: bool,
    /// The errors after which the next entry is tried (`EACCES` is always
    /// one, and remembered).
    pub try_next: fn(i32) -> bool,
}

/// libuv's search on macOS.
pub const LIBUV_DARWIN: Search = Search {
    default_path: DEFAULT_PATH,
    path_max: 1024,
    shell_fallback: false,
    try_next: |errno| errno == libc::ENOENT || errno == libc::ENOTDIR,
};

/// glibc's `execvp`, which libuv's forked child calls on Linux.
pub const GLIBC_EXECVP: Search = Search {
    default_path: CS_PATH,
    path_max: 4096,
    shell_fallback: true,
    try_next: |errno| {
        [
            libc::ENOENT,
            libc::ESTALE,
            libc::ENOTDIR,
            libc::ENODEV,
            libc::ETIMEDOUT,
        ]
        .contains(&errno)
    },
};

/// This platform's search.
#[cfg(target_os = "linux")]
pub const PLATFORM: Search = GLIBC_EXECVP;
/// This platform's search.
#[cfg(not(target_os = "linux"))]
pub const PLATFORM: Search = LIBUV_DARWIN;

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

/// `uv_spawn`'s search and start on this platform ([`PLATFORM`]): the pid
/// of the started child, or the errno libuv's `uv_spawn` returns (`EINVAL`
/// for a NUL in any string, which Node refuses before it gets here).
pub fn spawn(request: &Spawn<'_>) -> Result<i32, i32> {
    spawn_with(request, &PLATFORM)
}

/// [`spawn`] with the given platform's search (tests run the other
/// platform's rules here too: they are only system calls this platform
/// has).
pub fn spawn_with(request: &Spawn<'_>, search: &Search) -> Result<i32, i32> {
    let (Some(argv), Some(envp)) = (c_strings(request.argv), c_strings(request.env)) else {
        return Err(libc::EINVAL);
    };
    let cwd = match request.cwd {
        Some(cwd) => Some(CString::new(cwd).map_err(|_| libc::EINVAL)?),
        None => None,
    };
    let spawn_path = |path: &str, argv: &[CString]| -> Result<i32, i32> {
        let path = CString::new(path).map_err(|_| libc::EINVAL)?;
        sys::posix_spawn_one(&path, argv, &envp, cwd.as_deref(), request.stdio)
    };
    // One `execve` of the search, and glibc's `maybe_script_execute` after
    // an `ENOEXEC`: `/bin/sh`, the path tried, then argv without its first
    // entry (whose errno, if the shell fails too, is the attempt's).
    let start = |path: &str| -> Result<i32, i32> {
        match spawn_path(path, &argv) {
            Err(libc::ENOEXEC) if search.shell_fallback => {
                let mut shell = vec![
                    CString::new(SHELL).map_err(|_| libc::EINVAL)?,
                    CString::new(path).map_err(|_| libc::EINVAL)?,
                ];
                shell.extend(argv.iter().skip(1).cloned());
                spawn_path(SHELL, &shell)
            }
            other => other,
        }
    };
    let file = request.file;
    if file.contains('/') {
        return start(file);
    }
    if file.len() > NAME_MAX {
        return Err(libc::ENAMETOOLONG);
    }
    let path = path_in(request.env).unwrap_or(search.default_path);
    // Each entry joined with the file (an empty entry is the file itself),
    // an over-long entry skipped (musl's, glibc's and so libuv's bound).
    let limit = path.len().min(search.path_max - 1) + 1;
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
            Err(errno) if (search.try_next)(errno) => last = errno,
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
        // The first real-time signal glibc leaves to programs.
        #[cfg(target_os = "linux")]
        assert_eq!(signal_name(34), None);
    }

    /// Everything a child started with `stdout` as one end writes, to its end.
    fn output_of(
        search: &Search,
        file: &str,
        argv: &[String],
        env: &[String],
    ) -> Result<String, i32> {
        let (parent, child) = pair();
        let spawned = spawn_with(
            &Spawn {
                file,
                argv,
                env,
                cwd: None,
                stdio: [None, Some(child), None],
            },
            search,
        );
        sys::close(child);
        let read = spawned.map(|pid| {
            let mut out = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = sys::read_into(parent, &mut buffer).expect("read");
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buffer[..n]);
            }
            sys::wait_exited(pid).expect("waitid");
            assert_eq!(sys::reap(pid).expect("reap"), Some((0, 0)));
            String::from_utf8_lossy(&out).into_owned()
        });
        sys::close(parent);
        read
    }

    #[test]
    fn a_file_without_an_interpreter_line_is_run_by_bin_sh_only_under_glibc() {
        /// The test's scratch, removed however the test ends.
        struct Scratch(std::path::PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        use std::os::unix::fs::PermissionsExt;
        let scratch =
            Scratch(std::env::temp_dir().join(format!("ledger-io-enoexec-{}", std::process::id())));
        std::fs::create_dir_all(&scratch.0).expect("scratch");
        let dir_text = scratch
            .0
            .to_str()
            .expect("a UTF-8 temporary directory")
            .to_owned();
        let plain = format!("{dir_text}/plain");
        std::fs::write(&plain, "printf '%s|' \"$0\" \"$@\"\n").expect("write");
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let env = vec![format!("PATH=/nonexistent-o2e:{dir_text}")];
        let with_slash = vec![plain.clone(), String::from("a b"), String::from("c")];
        // glibc's maybe_script_execute: /bin/sh, the path tried, the
        // arguments after argv[0].
        assert_eq!(
            output_of(&GLIBC_EXECVP, &plain, &with_slash, &env),
            Ok(format!("{plain}|a b|c|"))
        );
        let searched = vec![String::from("plain"), String::from("x")];
        assert_eq!(
            output_of(&GLIBC_EXECVP, "plain", &searched, &env),
            Ok(format!("{plain}|x|"))
        );
        // libuv's macOS search: posix_spawn's ENOEXEC is the spawn's error,
        // found by a search or given with a slash.
        assert_eq!(
            output_of(&LIBUV_DARWIN, &plain, &with_slash, &env),
            Err(libc::ENOEXEC)
        );
        assert_eq!(
            output_of(&LIBUV_DARWIN, "plain", &searched, &env),
            Err(libc::ENOEXEC)
        );
    }
}

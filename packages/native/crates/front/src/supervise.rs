//! Supervision of the JavaScript server as a child: its own process group, a
//! private environment, a health wait, a clean stop, and a watchdog process
//! that ends the child's group if the front dies for any reason, `kill -9`
//! included. The watchdog holds the read end of a pipe whose write end only
//! the front holds; the kernel closes it when the front dies. No change to
//! the server is needed (S2's approach).

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::sys;

/// A free loopback port, the way QA's `reservePort` finds one.
pub fn free_port() -> io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

pub struct ChildSpec {
    pub program: String,
    /// `{port}` in any argument is replaced with the child's port.
    pub args: Vec<String>,
    /// The child's whole environment; nothing is inherited.
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    /// Where the child's stdout and stderr go; the front's stderr when `None`.
    pub log: Option<PathBuf>,
    pub port: u16,
}

pub struct Supervised {
    child: Child,
    pub pid: i32,
    watchdog: Option<(Child, ChildStdin)>,
    pub port: u16,
}

pub fn describe(status: ExitStatus) -> String {
    match (status.code(), status.signal()) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        _ => "unknown".into(),
    }
}

impl Supervised {
    pub fn spawn(spec: &ChildSpec, watchdog_grace: Duration) -> io::Result<Self> {
        let port = spec.port.to_string();
        let args: Vec<String> = spec.args.iter().map(|arg| arg.replace("{port}", &port)).collect();
        let mut command = Command::new(&spec.program);
        command.args(&args).env_clear().envs(&spec.env).stdin(Stdio::null()).process_group(0);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        match &spec.log {
            Some(path) => {
                let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
                command.stdout(file.try_clone()?).stderr(file);
            }
            None => {
                command.stdout(Stdio::from(io::stderr())).stderr(Stdio::from(io::stderr()));
            }
        }
        let child = command.spawn()?;
        let pid = child.id() as i32;
        // The watchdog checks the group leader's command line before signalling,
        // so a reused process group id is never touched.
        let expect = format!("{} {}", spec.program.rsplit('/').next().unwrap_or(&spec.program), args.join(" "));
        let watchdog = match spawn_watchdog(pid, &expect, watchdog_grace) {
            Ok(watchdog) => Some(watchdog),
            Err(error) => {
                let mut child = child;
                let _ = sys::kill_group(pid, sys::SIGKILL);
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(Self {
            child,
            pid,
            watchdog,
            port: spec.port,
        })
    }

    pub fn watchdog_pid(&self) -> Option<i32> {
        self.watchdog.as_ref().map(|(child, _)| child.id() as i32)
    }

    /// `Some(status)` once the watchdog has exited (it should live as long as the child).
    pub fn watchdog_exit(&mut self) -> Option<ExitStatus> {
        self.watchdog.as_mut().and_then(|(watchdog, _)| watchdog.try_wait().ok().flatten())
    }

    /// `Some(status)` once the child has exited.
    pub fn try_exit(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Waits until `GET path` answers 200 (and, with `ready_field`, the JSON
    /// body has that field `true`), the child exits, or `timeout` passes.
    pub fn wait_healthy(&mut self, path: &str, ready_field: Option<&str>, timeout: Duration) -> Result<Duration, String> {
        let started = Instant::now();
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        loop {
            if let Some(status) = self.try_exit() {
                return Err(format!("the child exited before it was healthy ({})", describe(status)));
            }
            if let Some((status, body)) = probe(address, path)
                && status == 200
                && ready_field.is_none_or(|field| {
                    serde_json::from_slice::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|value| value.get(field).cloned())
                        == Some(serde_json::Value::Bool(true))
                })
            {
                return Ok(started.elapsed());
            }
            if started.elapsed() > timeout {
                return Err(format!("the child was not healthy within {} ms", timeout.as_millis()));
            }
            if sys::stop_requested() {
                return Err("stopped by a signal before the child was healthy".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// SIGTERM to the child's group, SIGKILL after `grace`, then releases the
    /// watchdog. Returns how the child ended.
    pub fn stop(&mut self, grace: Duration) -> String {
        let outcome = match self.try_exit() {
            Some(status) => describe(status),
            None => {
                let _ = sys::kill_group(self.pid, sys::SIGTERM);
                let deadline = Instant::now() + grace;
                loop {
                    if let Some(status) = self.try_exit() {
                        break describe(status);
                    }
                    if Instant::now() > deadline {
                        let _ = sys::kill_group(self.pid, sys::SIGKILL);
                        break self.child.wait().map(describe).unwrap_or_else(|_| "unknown".into()) + " after SIGKILL";
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            }
        };
        // Whatever else is left in the group goes with its leader.
        let deadline = Instant::now() + grace;
        while sys::group_alive(self.pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if sys::group_alive(self.pid) {
            let _ = sys::kill_group(self.pid, sys::SIGKILL);
        }
        self.release_watchdog();
        outcome
    }

    /// Tells the watchdog the child is handled, so it exits without signalling.
    pub fn release_watchdog(&mut self) {
        if let Some((mut watchdog, mut pipe)) = self.watchdog.take() {
            let _ = pipe.write_all(b"R");
            drop(pipe);
            let _ = watchdog.wait();
        }
    }
}

fn spawn_watchdog(pgid: i32, expect: &str, grace: Duration) -> io::Result<(Child, ChildStdin)> {
    let exe = std::env::current_exe()?;
    let mut watchdog = Command::new(exe)
        .args([
            "watchdog",
            "--pgid",
            &pgid.to_string(),
            "--grace-ms",
            &grace.as_millis().to_string(),
            "--expect",
            expect,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(io::stderr()))
        .process_group(0)
        .spawn()?;
    let pipe = watchdog.stdin.take().ok_or_else(|| io::Error::other("watchdog stdin missing"))?;
    Ok((watchdog, pipe))
}

/// The leader's command line, as `ps` prints it.
fn command_line(pid: i32) -> Option<String> {
    // -ww: the whole command line, however long.
    let output = Command::new("/bin/ps").args(["-ww", "-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The watchdog's body: block on stdin; on a release byte exit quietly; on end
/// of file (the front is gone) end the group whose leader is still the child.
pub fn watchdog_main(pgid: i32, expect: &str, grace: Duration) -> i32 {
    let mut stdin = io::stdin();
    let mut byte = [0u8; 1];
    let released = loop {
        match stdin.read(&mut byte) {
            Ok(0) => break false,
            Ok(_) if byte[0] == b'R' => break true,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break false,
        }
    };
    if released || !sys::group_alive(pgid) {
        return 0;
    }
    let leader_matches = command_line(pgid).is_some_and(|line| line.contains(expect));
    if !leader_matches && sys::pid_alive(pgid) {
        // The group id now belongs to something else: touch nothing.
        eprintln!(
            "{}",
            serde_json::json!({ "event": "watchdog-skipped", "reason": "group leader is not the child" })
        );
        return 0;
    }
    eprintln!("{}", serde_json::json!({ "event": "watchdog-stopping-child", "pgid": pgid }));
    let _ = sys::kill_group(pgid, sys::SIGTERM);
    let deadline = Instant::now() + grace;
    while sys::group_alive(pgid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if sys::group_alive(pgid) {
        let _ = sys::kill_group(pgid, sys::SIGKILL);
    }
    0
}

/// One `GET path` with `Connection: close`: the status and body.
pub fn probe(address: SocketAddr, path: &str) -> Option<(u16, Vec<u8>)> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let (length, head) = crate::http::parse_response_head(&response).ok()??;
    let mut body = response[length..].to_vec();
    if crate::http::response_body("GET", &head) == crate::http::BodyKind::Chunked {
        let mut decoded = Vec::new();
        crate::http::ChunkDecoder::default().feed(&body, &mut decoded).ok()?;
        body = decoded;
    }
    Some((head.status, body))
}

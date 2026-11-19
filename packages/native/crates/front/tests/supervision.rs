//! Supervision, against the real binary. This test target has its own main
//! (harness = false) so the same executable can also act as the supervised
//! child: `--child-server --port N` runs a small HTTP server that starts a
//! grandchild (`/bin/sleep`) in its process group.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

fn child_server(args: &[String]) -> ! {
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let port: u16 = value("--port").and_then(|p| p.parse().ok()).expect("--port");
    let die_after: Option<u64> = value("--die-after-ms").and_then(|v| v.parse().ok());
    let healthy = !args.iter().any(|a| a == "--never-healthy");
    let grandchild = Command::new("/bin/sleep").arg("600").spawn().expect("sleep");
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    if let Some(ms) = die_after {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            std::process::exit(7);
        });
    }
    let grandchild_pid = grandchild.id();
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let body = format!(
            r#"{{"ok":true,"isOpenCodeReady":{healthy},"grandchild":{grandchild_pid},"pid":{}}}"#,
            std::process::id()
        );
        let status = if healthy { "200 OK" } else { "503 Service Unavailable" };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
    std::process::exit(0);
}

fn alive(pid: i64) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn wait_gone(pids: &[i64], within: Duration) -> Vec<i64> {
    let deadline = Instant::now() + within;
    loop {
        let left: Vec<i64> = pids.iter().copied().filter(|pid| alive(*pid)).collect();
        if left.is_empty() || Instant::now() > deadline {
            return left;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct Started {
    front: Child,
    stdout: BufReader<ChildStdout>,
    ready: Value,
}

impl Drop for Started {
    fn drop(&mut self) {
        // Never leave anything behind, even when an assertion failed.
        let _ = self.front.kill();
        let _ = self.front.wait();
    }
}

fn start(extra_child_args: &[&str], front_args: &[&str]) -> Result<Started, String> {
    let me = std::env::current_exe().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_devryan-front"));
    command
        .args([
            "serve",
            "--listen",
            "127.0.0.1:0",
            "--spawn",
            "--stop-grace-ms",
            "5000",
            "--ready-field",
            "isOpenCodeReady",
        ])
        .args(front_args);
    command.arg("--").arg(&me).args(["--child-server", "--port", "{port}"]).args(extra_child_args);
    let mut front = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut stdout = BufReader::new(front.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    let ready: Value = serde_json::from_str(&line).map_err(|e| format!("{e}: {line:?}"))?;
    Ok(Started { front, stdout, ready })
}

fn health(address: &str) -> Value {
    let mut stream = TcpStream::connect(address).unwrap();
    write!(stream, "GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).unwrap();
    serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

fn pids(started: &Started, health: &Value) -> Vec<i64> {
    vec![
        started.ready["child_pid"].as_i64().unwrap(),
        health["grandchild"].as_i64().unwrap(),
        started.ready["watchdog_pid"].as_i64().unwrap(),
    ]
}

fn starts_healthy_and_stops_cleanly() -> Result<(), String> {
    let mut started = start(&[], &[])?;
    if started.ready["event"] != "ready" {
        return Err(format!("not ready: {}", started.ready));
    }
    let report = health(started.ready["listen"].as_str().unwrap());
    let all = pids(&started, &report);
    if all.iter().any(|pid| !alive(*pid)) {
        return Err(format!("expected child, grandchild and watchdog alive: {all:?}"));
    }
    let front = started.front.id().to_string();
    Command::new("/bin/kill").args(["-TERM", &front]).status().unwrap();
    let mut line = String::new();
    started.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    let stopped: Value = serde_json::from_str(&line).map_err(|e| format!("{e}: {line:?}"))?;
    if stopped["event"] != "stopped" {
        return Err(format!("expected stopped, got {stopped}"));
    }
    let status = started.front.wait().unwrap();
    if !status.success() {
        return Err(format!("front exited with {status}"));
    }
    let left = wait_gone(&all, Duration::from_secs(5));
    if !left.is_empty() {
        return Err(format!("still alive after a clean stop: {left:?}"));
    }
    Ok(())
}

fn kill_9_of_the_front_leaves_no_child() -> Result<(), String> {
    let mut started = start(&[], &[])?;
    let report = health(started.ready["listen"].as_str().unwrap());
    let all = pids(&started, &report);
    Command::new("/bin/kill").args(["-KILL", &started.front.id().to_string()]).status().unwrap();
    let _ = started.front.wait();
    let left = wait_gone(&all, Duration::from_secs(15));
    if !left.is_empty() {
        return Err(format!("still alive after kill -9 of the front: {left:?}"));
    }
    Ok(())
}

fn a_child_that_dies_is_reported() -> Result<(), String> {
    let mut started = start(&["--die-after-ms", "1500"], &[])?;
    let report = health(started.ready["listen"].as_str().unwrap());
    let all = pids(&started, &report);
    let mut line = String::new();
    started.stdout.read_line(&mut line).map_err(|e| e.to_string())?;
    let event: Value = serde_json::from_str(&line).map_err(|e| format!("{e}: {line:?}"))?;
    if event["event"] != "child-exited" || event["status"] != "exit code 7" {
        return Err(format!("expected child-exited with exit code 7, got {event}"));
    }
    let status = started.front.wait().unwrap();
    if status.code() != Some(3) {
        return Err(format!("front exited with {status}, expected 3"));
    }
    // The dead child's grandchild and the watchdog go too.
    let left = wait_gone(&all, Duration::from_secs(10));
    if !left.is_empty() {
        return Err(format!("left after the child died: {left:?}"));
    }
    Ok(())
}

fn a_child_that_never_gets_healthy_is_stopped() -> Result<(), String> {
    let me = std::env::current_exe().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_devryan-front"))
        .args([
            "serve",
            "--listen",
            "127.0.0.1:0",
            "--spawn",
            "--ready-timeout-ms",
            "1500",
            "--stop-grace-ms",
            "2000",
            "--ready-field",
            "isOpenCodeReady",
            "--",
        ])
        .arg(&me)
        .args(["--child-server", "--port", "{port}", "--never-healthy"])
        .output()
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.code() != Some(2) || !stderr.contains("not healthy within 1500 ms") {
        return Err(format!("unexpected: {:?} {stderr}", output.status));
    }
    // No process running this test binary as a child server may remain.
    let ps = Command::new("/bin/ps").args(["-eo", "pid=,command="]).output().unwrap();
    let me = me.to_string_lossy().to_string();
    let left: Vec<String> = String::from_utf8_lossy(&ps.stdout)
        .lines()
        .filter(|l| l.contains(&me) && l.contains("--never-healthy"))
        .map(String::from)
        .collect();
    if !left.is_empty() {
        return Err(format!("child left: {left:?}"));
    }
    Ok(())
}

type Test = fn() -> Result<(), String>;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--child-server") {
        child_server(&args);
    }
    // libtest flags such as --test-threads or --nocapture are accepted and ignored.
    let filter = args.iter().skip(1).find(|a| !a.starts_with('-'));
    let tests: [(&str, Test); 4] = [
        ("starts_healthy_and_stops_cleanly", starts_healthy_and_stops_cleanly),
        ("kill_9_of_the_front_leaves_no_child", kill_9_of_the_front_leaves_no_child),
        ("a_child_that_dies_is_reported", a_child_that_dies_is_reported),
        ("a_child_that_never_gets_healthy_is_stopped", a_child_that_never_gets_healthy_is_stopped),
    ];
    let mut failed = 0;
    let mut ran = 0;
    for (name, test) in tests {
        if filter.is_some_and(|f| !name.contains(f.as_str())) {
            continue;
        }
        ran += 1;
        match test() {
            Ok(()) => println!("test {name} ... ok"),
            Err(error) => {
                failed += 1;
                println!("test {name} ... FAILED\n  {error}");
            }
        }
    }
    println!("\nsupervision: {} passed; {failed} failed", ran - failed);
    if failed > 0 {
        std::process::exit(1);
    }
}

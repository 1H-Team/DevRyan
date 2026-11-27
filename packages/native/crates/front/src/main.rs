//! The `devryan-front` command line. See packages/native/DOCUMENTATION.md.
//!
//!   devryan-front serve --listen 127.0.0.1:0 (--upstream 127.0.0.1:P | --spawn [child options] -- PROGRAM ARGS...)
//!   devryan-front watchdog --pgid N --expect TEXT [--grace-ms N]      (internal)
//!
//! Output on stdout is one JSON object per line for `serve` (`ready`,
//! `child-exited`, `stopped`). Child environment values are never printed.
//!
//! Exit codes: 0 stopped cleanly, 2 refused (a bad option or address, a child
//! that could not start or never got healthy), 3 the child or its watchdog died.

use std::collections::BTreeMap;
use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use devryan_front::proxy::Proxy;
use devryan_front::supervise::{self, ChildSpec, Supervised};
use devryan_front::{sys, util};

/// The command refused to run: a bad option or address, or a child that could not start or never got healthy.
const REFUSED: u8 = 2;
/// `serve`: the supervised child or its watchdog died.
const CHILD_EXITED: u8 = 3;

struct Args {
    values: Vec<(String, String)>,
    flags: Vec<String>,
    rest: Vec<String>,
}

const FLAGS: &[&str] = &["--spawn"];

/// The options each command accepts; anything else is refused.
fn allowed(command: &str) -> &'static [&'static str] {
    match command {
        "serve" => &[
            "--listen",
            "--upstream",
            "--spawn",
            "--child-env-file",
            "--child-cwd",
            "--child-log",
            "--health-path",
            "--ready-field",
            "--ready-timeout-ms",
            "--stop-grace-ms",
        ],
        "watchdog" => &["--pgid", "--expect", "--grace-ms"],
        _ => &[],
    }
}

fn parse(command: &str, argv: &[String]) -> Result<Args, String> {
    let mut args = Args {
        values: Vec::new(),
        flags: Vec::new(),
        rest: Vec::new(),
    };
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if arg == "--" {
            if command != "serve" {
                return Err("-- is only for serve --spawn".into());
            }
            args.rest = argv[index + 1..].to_vec();
            break;
        }
        if arg.starts_with("--") && !allowed(command).contains(&arg.as_str()) {
            return Err(format!("{command} does not take {arg} (packages/native/DOCUMENTATION.md)"));
        }
        if FLAGS.contains(&arg.as_str()) {
            args.flags.push(arg.clone());
        } else if arg.starts_with("--") {
            let value = argv.get(index + 1).ok_or_else(|| format!("{arg} needs a value"))?;
            args.values.push((arg.clone(), value.clone()));
            index += 1;
        } else {
            return Err(format!("unexpected argument {arg:?}"));
        }
        index += 1;
    }
    Ok(args)
}

impl Args {
    fn one(&self, name: &str) -> Option<&str> {
        self.values.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
    fn required(&self, name: &str) -> Result<&str, String> {
        self.one(name).ok_or_else(|| format!("{name} is required"))
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|flag| flag == name)
    }
    fn millis(&self, name: &str, default: u64) -> Result<Duration, String> {
        match self.one(name) {
            Some(text) => text.parse().map(Duration::from_millis).map_err(|_| format!("{name} must be milliseconds")),
            None => Ok(Duration::from_millis(default)),
        }
    }
}

fn emit(value: Value) {
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn serve(args: &Args) -> Result<u8, String> {
    let listen = util::parse_loopback(args.required("--listen")?, "--listen")?;
    if listen.port() != 0 {
        // A fixed loopback port can bind beside a wildcard socket on the same port and shadow it.
        return Err("--listen takes port 0 (the bound address is printed in the ready line)".into());
    }
    let spawn = args.flag("--spawn");
    let upstream_port = match args.one("--upstream") {
        Some(text) => util::parse_loopback(text, "--upstream")?.port(),
        None if spawn => supervise::free_port().map_err(|e| format!("no free port: {e}"))?,
        None => return Err("--upstream or --spawn is required".into()),
    };
    let upstream = util::parse_loopback(
        &match args.one("--upstream") {
            Some(text) => text.to_string(),
            None => format!("127.0.0.1:{upstream_port}"),
        },
        "--upstream",
    )?;
    sys::install_stop_handler();
    // Each connection holds two descriptors; macOS starts a process with a soft limit of 256.
    if let Err(error) = sys::raise_open_file_limit() {
        eprintln!("{}", json!({ "event": "open-file-limit-not-raised", "error": error.to_string() }));
    }
    let grace = args.millis("--stop-grace-ms", 20_000)?;
    // Parsed before the child starts, so a bad value is refused with nothing running.
    let ready = args.millis("--ready-timeout-ms", 120_000)?;
    let mut child = None;
    if spawn {
        let program = args.rest.first().ok_or("--spawn needs -- PROGRAM ARGS...")?.clone();
        let env: BTreeMap<String, String> = match args.one("--child-env-file") {
            Some(path) => {
                let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
                let value: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
                value
                    .as_object()
                    .ok_or(format!("{path} must hold a JSON object"))?
                    .iter()
                    .map(|(k, v)| {
                        v.as_str()
                            .map(|text| (k.clone(), text.to_string()))
                            .ok_or(format!("{path}: the value of {k} is not a string"))
                    })
                    .collect::<Result<_, String>>()?
            }
            None => BTreeMap::new(),
        };
        let spec = ChildSpec {
            program,
            args: args.rest[1..].to_vec(),
            env,
            cwd: args.one("--child-cwd").map(PathBuf::from),
            log: args.one("--child-log").map(PathBuf::from),
            port: upstream.port(),
        };
        let mut supervised = Supervised::spawn(&spec, grace).map_err(|e| format!("could not start the child: {e}"))?;
        if let Err(error) = supervised.wait_healthy(args.one("--health-path").unwrap_or("/api/health"), args.one("--ready-field"), ready) {
            let outcome = supervised.stop(grace);
            return Err(format!("{error}; child stopped ({outcome})"));
        }
        child = Some(supervised);
    }
    let listener = TcpListener::bind(listen).map_err(|e| format!("bind {listen}: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?;
    let proxy = Proxy::new(upstream);
    let serving = Arc::clone(&proxy);
    let accept = thread::spawn(move || serving.serve(listener));
    emit(json!({
        "event": "ready",
        "listen": bound.to_string(),
        "upstream": upstream.to_string(),
        "child_pid": child.as_ref().map(|c| c.pid),
        "watchdog_pid": child.as_ref().and_then(Supervised::watchdog_pid),
    }));
    let mut code = 0u8;
    loop {
        if sys::stop_requested() {
            break;
        }
        if let Some(supervised) = child.as_mut()
            && let Some(status) = supervised.try_exit()
        {
            emit(json!({ "event": "child-exited", "pid": supervised.pid, "status": supervise::describe(status) }));
            code = CHILD_EXITED;
            break;
        }
        if let Some(supervised) = child.as_mut()
            && let Some(status) = supervised.watchdog_exit()
        {
            // Without its watchdog a kill -9 of the front would leave the child running: stop it now.
            emit(json!({ "event": "watchdog-exited", "status": supervise::describe(status) }));
            code = CHILD_EXITED;
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    proxy.stop();
    let _ = accept.join();
    // Connections end once their sockets are shut.
    if !proxy.wait_idle(Duration::from_secs(10)) {
        emit(json!({ "event": "connections-still-open" }));
    }
    let outcome = child.as_mut().map(|c| c.stop(grace));
    emit(json!({ "event": "stopped", "child": outcome, "connections": proxy.accepted.load(std::sync::atomic::Ordering::SeqCst) }));
    Ok(code)
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = argv.first().cloned() else {
        eprintln!("usage: devryan-front serve ... (packages/native/DOCUMENTATION.md)");
        return ExitCode::from(REFUSED);
    };
    let args = match parse(&command, &argv[1..]) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("devryan-front: {error}");
            return ExitCode::from(REFUSED);
        }
    };
    let result = match command.as_str() {
        "serve" => serve(&args),
        "watchdog" => (|| {
            let pgid: i32 = args.required("--pgid")?.parse().map_err(|_| "--pgid must be a number")?;
            let grace = args.millis("--grace-ms", 20_000)?;
            Ok(supervise::watchdog_main(pgid, args.required("--expect")?, grace) as u8)
        })(),
        other => Err(format!("unknown command {other:?}")),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            // A refusal: the command did not run (see packages/native/DOCUMENTATION.md).
            eprintln!("devryan-front: {error}");
            ExitCode::from(REFUSED)
        }
    }
}

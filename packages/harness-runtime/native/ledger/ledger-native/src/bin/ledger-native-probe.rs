//! Test-only (`test-hooks`): drives `ledger-native`'s modules for the Node
//! differential tests in `scripts/ledger-native/`. Never packaged.
//!
//!   ledger-native-probe codec            stdin: one tagged JSON line per value;
//!                                        stdout: {"echo":..., "wire":...} per line
//!   ledger-native-probe generate <seed> <count>
//!                                        random tagged values, one per line
//!   ledger-native-probe scenarios        stdin: an array of scenarios (execution
//!                                        context, I/O pool or stall clock), each
//!                                        under a fresh virtual clock; stdout: one
//!                                        {name, events} line per scenario
//!   ledger-native-probe transcript       stdin: one timed host script; the
//!                                        protocol (test-hooks stub runtime) on
//!                                        the virtual loop, driven as
//!                                        scripts/ledger-native/proto-virtual-js-arm.mjs
//!                                        drives the worker; stdout:
//!                                        `<ms>\t<line>` per message sent
//!   ledger-native-probe fs-steps         stdin: one file-system step per line
//!                                        (scripts/ledger-native/fs-js-arm.mjs steps);
//!                                        stdout: its outcome per line
//!   ledger-native-probe fs-programs      stdin: one {dir, program} per line
//!                                        (scripts/ledger-native/fs-programs.mjs);
//!                                        stdout: its trace per line, or `!<why>`
//!   ledger-native-probe jobs             stdin: one job-order program per line
//!                                        (scripts/ledger-native/jobs-programs.mjs);
//!                                        stdout: its trace per line, as
//!                                        scripts/ledger-native/jobs-js-arm.mjs prints it
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::io::{BufRead, Read, Write};
use std::rc::Rc;

use ledger_core::js::JsStr;
use ledger_native::codec::{decode_line, encode_line};
use ledger_native::ctx::{Remote, run_in_remote_execution_context};
use ledger_native::host;
use ledger_native::js::{Resolution, async_fn};
use ledger_native::signal::Controller;
use ledger_native::stall::StallClock;
use ledger_native::stub::{self, Env, Global, Log};
use ledger_native::value::{Func, Obj, W, to_js_string, to_number};
use ledger_native::virtual_host::VirtualHost;
use ledger_native::wire::{decode_wire_value, encode_wire_value};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("codec") => codec(),
        Some("generate") => {
            let seed = args.get(1).and_then(|text| text.parse().ok()).unwrap_or(1);
            let count = args
                .get(2)
                .and_then(|text| text.parse().ok())
                .unwrap_or(100);
            generate(seed, count);
        }
        Some("scenarios") => scenarios(),
        Some("fs-steps") => {
            let stdin = std::io::stdin();
            let lines = stdin
                .lock()
                .split(b'\n')
                .map(|line| line.expect("stdin"))
                .filter(|line| !line.is_empty());
            ledger_native::io_program::serve_steps(lines, print, |line| decode_line(line).ok());
        }
        Some("fs-programs") => fs_programs(),
        Some("transcript") => transcript(),
        Some("jobs") => {
            // `jobs node26`: Node 26.13's frame rule after a `yield`, to
            // compare the system Node's traces exactly.
            ledger_native::program::use_node_26_frame_rule(
                args.get(1).map(String::as_str) == Some("node26"),
            );
            jobs()
        }
        _ => {
            eprintln!(
                "usage: ledger-native-probe codec | generate <seed> <count> | scenarios | transcript | fs-steps | fs-programs | jobs [node26]"
            );
            std::process::exit(2);
        }
    }
}

fn print(value: &W) {
    let line = encode_line(value).unwrap_or_else(|_| b"{\"unencodable\":true}\n".to_vec());
    std::io::stdout().write_all(&line).expect("stdout");
}

/// The line codec and the wire layer, both directions.
fn codec() {
    let _virtual = VirtualHost::new(0);
    let stdin = std::io::stdin();
    for line in stdin.lock().split(b'\n') {
        let line = line.expect("stdin");
        if line.is_empty() {
            continue;
        }
        let Ok(value) = decode_line(&line) else {
            print(&W::object(vec![("corrupt", W::Bool(true))]));
            continue;
        };
        if value.has_unsupported() {
            print(&W::object(vec![("unsupported", W::Bool(true))]));
            continue;
        }
        let to_function = |_: &W| {
            W::Function(Rc::new(Func {
                source: "() => 0",
                call: Box::new(|_, _| Ok(Resolution::Value(W::Undefined))),
            }))
        };
        let decoded = decode_wire_value(&value, Some(&to_function));
        let wire = match encode_wire_value(&decoded, None, None) {
            Ok(encoded) => encoded,
            Err(error) => W::object(vec![("error", stub::summarize(&error))]),
        };
        print(&W::object(vec![("echo", value), ("wire", wire)]));
    }
}

/// mulberry32, as the JavaScript generators use it.
struct Random(u32);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n - 1)
    }
}

fn random_string(random: &mut Random) -> JsStr {
    const UNITS: [u16; 14] = [
        0x61, 0x7a, 0x30, 0x22, 0x5c, 0x0a, 0x00, 0x1f, 0xe9, 0x2028, 0xd800, 0xdc00, 0xffff, 0x24,
    ];
    let length = random.below(6);
    JsStr::from_units(
        (0..length)
            .map(|_| UNITS[random.below(UNITS.len())])
            .collect(),
    )
}

fn random_value(random: &mut Random, depth: usize) -> W {
    const NUMBERS: [f64; 10] = [
        0.0,
        -0.0,
        1.5,
        -7.0,
        1e21,
        1e-7,
        123_456_789.0,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    let pick = if depth >= 4 {
        random.below(6)
    } else {
        random.below(9)
    };
    match pick {
        0 => W::Undefined,
        1 => W::Null,
        2 => W::Bool(random.next() < 0.5),
        3 => W::Number(if random.next() < 0.5 {
            NUMBERS[random.below(NUMBERS.len())]
        } else {
            (random.next() - 0.5) * 1e6
        }),
        4 => W::String(random_string(random)),
        5 => W::Bytes(Rc::new(
            (0..random.below(5))
                .map(|_| random.below(256) as u8)
                .collect(),
        )),
        6 => W::Array(
            (0..random.below(4))
                .map(|_| random_value(random, depth + 1))
                .collect(),
        ),
        _ => {
            const KEYS: [&str; 9] = ["a", "b", "0", "7", "10", "01", "$dr", "__proto__", "z"];
            let mut object = Obj::new();
            for _ in 0..random.below(4) {
                object.put(
                    KEYS[random.below(KEYS.len())],
                    random_value(random, depth + 1),
                );
            }
            W::Object(object)
        }
    }
}

fn generate(seed: u32, count: usize) {
    let mut random = Random(seed);
    for _ in 0..count {
        print(&random_value(&mut random, 0));
    }
}

fn read_stdin() -> W {
    let mut text = Vec::new();
    std::io::stdin().read_to_end(&mut text).expect("stdin");
    decode_line(text.trim_ascii()).expect("a scenario")
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn scenarios() {
    for scenario in list(&read_stdin()) {
        run_scenario(&scenario);
    }
}

fn run_scenario(scenario: &W) {
    let epoch = to_number(&scenario.get("epoch"));
    let epoch = if epoch.is_nan() { 1_000_000.0 } else { epoch };
    let virtual_host = VirtualHost::new(epoch as i64);
    if let W::Object(env) = scenario.get("env") {
        for (name, value) in env.iter() {
            let value = match value {
                W::String(text) => Some(text.to_string_lossy()),
                _ => None,
            };
            virtual_host.set_env(&name.to_string_lossy(), value.as_deref());
        }
    }
    let log = Rc::new(Log {
        events: RefCell::new(Vec::new()),
        epoch,
    });
    if matches!(scenario.get("kind"), W::String(kind) if kind == "stall") {
        stall_scenario(scenario, &virtual_host, &log);
    } else {
        tasks_scenario(scenario, &virtual_host, &log);
    }
    let events = log.events.borrow().clone();
    print(&W::object(vec![
        ("name", scenario.get("name")),
        ("events", W::Array(events)),
    ]));
}

fn push(log: &Rc<Log>, entry: Vec<(&str, W)>) {
    let mut object = Obj::with(vec![("t", W::Number(host::now() - log.epoch))]);
    for (key, value) in entry {
        object.put(key, value);
    }
    log.events.borrow_mut().push(W::Object(object));
}

/// Tasks run in remote contexts, with a timeline of aborts, gates and
/// environment changes, until `until`.
fn tasks_scenario(scenario: &W, virtual_host: &Rc<VirtualHost>, log: &Rc<Log>) {
    let global = Global::new(None, Some(log.clone()));
    let controllers: Rc<RefCell<Vec<(JsStr, Controller)>>> = Rc::new(RefCell::new(Vec::new()));
    let pending = Rc::new(Cell::new(0usize));
    for action in list(&scenario.get("timeline")) {
        let (global, controllers, log, virtual_host) = (
            global.clone(),
            controllers.clone(),
            log.clone(),
            virtual_host.clone(),
        );
        let at = to_number(&action.get("at"));
        host::set_timeout(at, move || {
            push(&log, vec![("timeline", action.clone())]);
            if let W::String(task) = action.get("abort") {
                let env = Env::new(
                    Vec::new(),
                    global.clone(),
                    ledger_native::runtime::Scope {
                        cause: W::Undefined,
                    },
                    W::Undefined,
                );
                let reason = stub::value(&action.get("reason"), &env).unwrap_or(W::Undefined);
                let found = controllers
                    .borrow()
                    .iter()
                    .find(|(name, _)| *name == task)
                    .map(|(_, controller)| controller.clone());
                if let Some(controller) = found {
                    controller.abort(reason);
                }
            }
            for key in ["open", "fail"] {
                if !action.get(key).is_undefined() {
                    let program = vec![W::object(vec![
                        ("op", W::string(key)),
                        ("gate", action.get(key)),
                        ("value", action.get("value")),
                    ])];
                    let env = Env::new(
                        Vec::new(),
                        global.clone(),
                        ledger_native::runtime::Scope {
                            cause: W::Undefined,
                        },
                        W::Undefined,
                    );
                    let _ = stub::run(env, None, program);
                }
            }
            if let W::Object(env) = action.get("env") {
                for (name, value) in env.iter() {
                    let value = match value {
                        W::String(text) => Some(text.to_string_lossy()),
                        _ => None,
                    };
                    virtual_host.set_env(&name.to_string_lossy(), value.as_deref());
                }
            }
        });
    }
    for task in list(&scenario.get("tasks")) {
        let name = task.get("name");
        let controller = Controller::new();
        controllers
            .borrow_mut()
            .push((to_js_string(&name), controller.clone()));
        let env = Env::new(
            Vec::new(),
            global.clone(),
            ledger_native::runtime::Scope {
                cause: name.clone(),
            },
            name.clone(),
        );
        let program = list(&task.get("program"));
        let context = task.get("context");
        let progress_ms = match task.get("progressMs") {
            W::Undefined => 250.0,
            other => to_number(&other),
        };
        let remote = Remote {
            signal: Some(controller.signal()),
            on_report: Some(stub::log_sink(log, name.clone(), "report")),
            on_progress: Some({
                let (log, name) = (log.clone(), name.clone());
                Rc::new(move |waiting| {
                    push(
                        &log,
                        vec![("task", name.clone()), ("progress", W::Bool(waiting))],
                    )
                })
            }),
            progress_ms,
        };
        let (log, pending) = (log.clone(), pending.clone());
        pending.set(pending.get() + 1);
        let _ = async_fn::<(), W>(async move {
            // `async () => (await run(task.program ?? [], env)).value`.
            let action: ledger_native::ctx::Action = Box::new(move |ctx| {
                Ok(Resolution::Promise(async_fn(async move {
                    let ran = stub::run(env, ctx, program).await?;
                    Ok(Resolution::Value(ran.unwrap_or(W::Undefined)))
                })))
            });
            let outcome = run_in_remote_execution_context(&context, action, remote).await?;
            let steps = W::Array(
                outcome
                    .steps
                    .iter()
                    .map(|(phase, step)| {
                        W::Array(vec![
                            W::String(phase.clone()),
                            W::object(vec![
                                ("count", W::Number(step.count)),
                                ("elapsedMs", W::Number(step.elapsed_ms)),
                            ]),
                        ])
                    })
                    .collect(),
            );
            let mut result = Obj::with(vec![("failed", W::Bool(outcome.failed))]);
            if outcome.failed {
                result.put("error", stub::summarize(&outcome.value));
            } else {
                result.put("value", outcome.value);
            }
            result.put("steps", steps);
            push(&log, vec![("task", name), ("result", W::Object(result))]);
            pending.set(pending.get() - 1);
            Ok(Resolution::Value(()))
        });
    }
    let until = to_number(&scenario.get("until"));
    virtual_host.advance_to((log.epoch + if until.is_nan() { 60_000.0 } else { until }) as i64);
    push(
        log,
        vec![(
            "end",
            W::object(vec![("pending", W::Number(pending.get() as f64))]),
        )],
    );
}

/// The stall clock driven by hand, as its JavaScript tests drive it.
fn stall_scenario(scenario: &W, virtual_host: &Rc<VirtualHost>, log: &Rc<Log>) {
    let time = Rc::new(Cell::new(virtual_host.now_ms() as f64));
    let options = scenario.get("options");
    let number = |key: &str, default: f64| match options.get(key) {
        W::Undefined => default,
        other => to_number(&other),
    };
    let stalls = log.clone();
    let clock = StallClock::new(
        Rc::new({
            let time = time.clone();
            move || time.get()
        }),
        number("tickMs", ledger_native::stall::TICK_MS),
        number("stallMs", ledger_native::stall::STALL_MS),
        Some(Rc::new(move |stall| {
            let payload = W::object(vec![
                ("from", W::Number(stall.from)),
                ("to", W::Number(stall.to)),
                ("ms", W::Number(stall.ms)),
            ]);
            stalls
                .events
                .borrow_mut()
                .push(W::object(vec![("stall", payload)]));
        })),
    );
    let tick_ms = number("tickMs", ledger_native::stall::TICK_MS);
    let marks: RefCell<Vec<(JsStr, f64)>> = RefCell::new(Vec::new());
    let at = |reference: &W| -> Option<f64> {
        match reference {
            W::Undefined => None,
            W::Object(_) => {
                let base = match reference.get("mark") {
                    W::String(name) => marks
                        .borrow()
                        .iter()
                        .find(|(mark, _)| *mark == name)
                        .map_or(f64::NAN, |(_, at)| *at),
                    _ => time.get(),
                };
                let plus = match reference.get("plus") {
                    W::Undefined | W::Null => 0.0,
                    other => to_number(&other),
                };
                Some(base + plus)
            }
            other => Some(to_number(other)),
        }
    };
    for step in list(&scenario.get("steps")) {
        let amount = |key: &str| to_number(&step.get(key));
        if !step.get("run").is_undefined() {
            let mut passed = 0.0;
            while passed < amount("run") {
                time.set(time.get() + tick_ms);
                clock.tick();
                passed += tick_ms;
            }
        } else if !step.get("block").is_undefined() {
            time.set(time.get() + amount("block"));
            clock.tick();
        } else if !step.get("advance").is_undefined() {
            time.set(time.get() + amount("advance"));
        } else if let W::String(name) = step.get("mark") {
            marks.borrow_mut().push((name, time.get()));
        } else if let W::Object(env) = step.get("env") {
            for (name, value) in env.iter() {
                let value = match value {
                    W::String(text) => Some(text.to_string_lossy()),
                    _ => None,
                };
                virtual_host.set_env(&name.to_string_lossy(), value.as_deref());
            }
        } else if let W::String(query) = step.get("query") {
            let answer = match query.to_string_lossy().as_str() {
                "stalledMsBetween" => W::Number(clock.stalled_ms_between(
                    at(&step.get("from")).unwrap_or(f64::NAN),
                    at(&step.get("to")),
                )),
                "activeMsSince" => W::Number(clock.active_ms_since(
                    at(&step.get("since")).unwrap_or(f64::NAN),
                    at(&step.get("at")),
                )),
                "expired" => {
                    let cap = match step.get("cap") {
                        W::Undefined => f64::INFINITY,
                        other => to_number(&other),
                    };
                    W::Bool(clock.expired(
                        at(&step.get("since")).unwrap_or(f64::NAN),
                        amount("limit"),
                        cap,
                        at(&step.get("at")),
                    ))
                }
                "snapshot" => {
                    let (stalls, stalled, longest) = clock.snapshot();
                    W::object(vec![
                        ("stalls", W::Number(stalls)),
                        ("stalledMs", W::Number(stalled)),
                        ("longestStallMs", W::Number(longest)),
                    ])
                }
                other => W::string(&format!("unknown query {other}")),
            };
            log.events.borrow_mut().push(W::object(vec![
                ("query", W::String(query)),
                ("answer", answer),
            ]));
        }
    }
}

/// The protocol on the virtual loop: deliver each step's message at its
/// time, answer every callback at once (`['answer', ...args]`, one message
/// each), and run the clock to `until`.
fn transcript() {
    const EPOCH: i64 = 1_000_000;
    let script = read_stdin();
    let virtual_host = VirtualHost::new(EPOCH);
    let out: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let answers: Rc<RefCell<std::collections::VecDeque<W>>> = Rc::default();
    let writer: ledger_native::proto::Writer = {
        let (out, answers) = (out.clone(), answers.clone());
        Rc::new(move |line: Vec<u8>| {
            let text = String::from_utf8_lossy(&line).trim_end().to_string();
            out.borrow_mut()
                .push(format!("{}\t{text}", host::now() - EPOCH as f64));
            if let Ok(message) = decode_line(&line)
                && matches!(message.get("type"), W::String(kind) if kind == "callback")
            {
                answers.borrow_mut().push_back(message);
            }
        })
    };
    let init = W::object(vec![
        ("type", W::string("init")),
        ("workerData", script.get("init")),
    ]);
    let mut process = None;
    virtual_host.deliver(|| {
        process = ledger_native::proto::start(&init, stub::factory(), writer).ok();
    });
    let Some(process) = process else {
        eprintln!("init refused");
        std::process::exit(70);
    };
    let answer_all = || {
        loop {
            let next = answers.borrow_mut().pop_front();
            let Some(callback) = next else { break };
            let mut value = vec![W::string("answer")];
            value.extend(list(&callback.get("args")));
            let reply = W::object(vec![
                ("type", W::string("callback-result")),
                ("id", callback.get("id")),
                ("failed", W::Bool(false)),
                ("value", W::Array(value)),
            ]);
            virtual_host.deliver(|| ledger_native::proto::Process::handle(&process, reply));
        }
    };
    let run_to = |target: i64| {
        loop {
            answer_all();
            match virtual_host.next_expiry() {
                Some(expiry) if expiry <= target => virtual_host.advance_to(expiry),
                _ => break,
            }
        }
        virtual_host.advance_to(target);
        answer_all();
    };
    for step in list(&script.get("steps")) {
        run_to(EPOCH + to_number(&step.get("at")) as i64);
        let message = step.get("send");
        virtual_host.deliver(|| ledger_native::proto::Process::handle(&process, message));
        answer_all();
    }
    let until = to_number(&script.get("until"));
    run_to(EPOCH + if until.is_nan() { 0 } else { until as i64 });
    let mut stdout = std::io::stdout();
    for line in out.borrow().iter() {
        writeln!(stdout, "{line}").expect("stdout");
    }
}

/// Job-order programs on the crate's `js` and `host` under a virtual clock.
/// The `node` module's I/O programs, one `{dir, program}` per line.
fn fs_programs() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().split(b'\n') {
        let line = line.expect("stdin");
        if line.is_empty() {
            continue;
        }
        let input = decode_line(&line).expect("a program");
        let dir = to_js_string(&input.get("dir")).to_string_lossy();
        match ledger_native::io_program::run_program(&input.get("program"), &dir) {
            Ok(trace) => writeln!(stdout, "{trace}").expect("stdout"),
            Err(why) => writeln!(stdout, "!{why}").expect("stdout"),
        }
        stdout.flush().expect("stdout");
    }
}

fn jobs() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let (mut programs, mut leaking, mut left) = (0usize, 0usize, 0usize);
    for line in stdin.lock().split(b'\n') {
        let line = line.expect("stdin");
        if line.is_empty() {
            continue;
        }
        let program = decode_line(&line).expect("a program");
        let before = ledger_native::js::live_tasks();
        let virtual_host = VirtualHost::new(1_000);
        let trace = ledger_native::program::run(&program, &virtual_host);
        writeln!(stdout, "{trace}").expect("stdout");
        // The census: with the program's registers forgotten and its loop
        // replaced, what it started and still holds is only what holds
        // itself (an await of a promise only its own task could settle):
        // JavaScript's collector frees it, `Rc` cannot. Reported, not
        // compared.
        drop(virtual_host);
        drop(VirtualHost::new(1_000));
        let alive = ledger_native::js::live_tasks() - before;
        programs += 1;
        if alive > 0 {
            leaking += 1;
            left += alive;
        }
    }
    eprintln!(
        "census: {programs} programs, {leaking} left {left} tasks alive in cycles of their own"
    );
}

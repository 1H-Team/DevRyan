//! Test-only (`test-hooks`): the Rust side of the content object store's
//! differential test (`scripts/ledger-native/object-differential.mjs`), the
//! twin of `scripts/ledger-native/object-js-arm.mjs`. One request per line,
//! one answer line each, on a loop with the real clock:
//!
//! - `{op: 'objects', steps, abort?}`: steps against the object store
//!   (`crate::objects`, `crate::durability`), each awaited in turn inside
//!   one execution context with a signal (aborted before the call when
//!   `abort` is `'before'`); a step's outcome is its value or its error, as
//!   `store_program::show` prints them;
//! - `{op: 'env', set}`: the environment the ported code reads.
//!
//! The sync shim (`syncShim` steps): while on, the object directory's
//! handle, every content object temporary's and every copy temporary's log
//! their open, sync and close (and a content temporary its link), and the
//! faults given (`<op>:objects`, `<op>:pending`, `<op>:copy`) fail them with
//! EIO after the real call, as the JavaScript arm's shim does; a sync the
//! handle never made is logged as such.
//!
//! Written as a port is (one `async_fn` per async function, one `.await`
//! per JavaScript await), so the arms' awaits match.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::ctx::{Ctx, Remote, run_in_remote_execution_context};
use crate::durability::{mark_object_directory_pending, sync_pending_object_directory};
use crate::host::{self, EventLoop, RealClock};
use crate::js::{Promise, Resolution, async_fn};
use crate::objects::{
    self, Repo, ViewMaterializer, bytes_for, copy_mutation_object, create_view_materializer,
    inspect_mutation_file, mutation_file_stamp, mutation_stat_stamp, require_mutation_space,
};
use crate::signal::Controller;
use crate::store_program::show;
use crate::value::{JsError, W, to_js_string, to_number, truthy};
use crate::{Ret, WPromise};

#[derive(Default)]
struct Shim {
    faults: Vec<String>,
    log: Vec<String>,
    /// `filehandle.sync()` calls counted at each handle's open, by path.
    calls: HashMap<String, u64>,
}

/// The change hook (`changeAt` steps): at the `nth` time an observed
/// file's handle reaches `at` (`open`, `read`, `eof`, `close`), the file's
/// mode is changed (its group execute bit flipped), as the JavaScript arm's
/// hook does; every event of an observed handle is logged (`changeLog`).
struct Change {
    file: String,
    at: String,
    nth: u64,
    seen: u64,
    /// Every event of an observed handle while the hook is on.
    log: Vec<String>,
}

thread_local! {
    static CHANGE: RefCell<Option<Change>> = const { RefCell::new(None) };
    static SHIM: RefCell<Option<Shim>> = const { RefCell::new(None) };
    /// The environment `host::env` reads, over the process's.
    static ENV: RefCell<HashMap<String, Option<String>>> = RefCell::new(HashMap::new());
    static MATERIALIZERS: RefCell<HashMap<String, ViewMaterializer>> = RefCell::new(HashMap::new());
}

/// The handle kind a fault names: the object directory, a content object
/// temporary or a copy's temporary.
fn kind_of(path: &str) -> &'static str {
    if path.ends_with("/objects") {
        "objects"
    } else if path.contains(".devryan-") {
        "copy"
    } else {
        "pending"
    }
}

/// A content object temporary's link (`seams`), logged.
pub fn handle_linked(temporary: &str, outcome: &str) {
    SHIM.with(|shim| {
        if let Some(shim) = shim.borrow_mut().as_mut() {
            shim.log.push(format!("link {temporary} {outcome}"));
        }
    });
}

/// An observed file's event (`seams`): the change hook.
pub fn observation(event: &str, path: &str) {
    let due = CHANGE.with(|change| {
        let mut change = change.borrow_mut();
        let Some(change) = change.as_mut() else {
            return false;
        };
        change.log.push(format!("{event} {path}"));
        if change.file != path || change.at != event {
            return false;
        }
        change.seen += 1;
        change.seen == change.nth
    });
    if due {
        use std::os::unix::fs::PermissionsExt as _;
        // port: sync call (the test's change, as the JavaScript arm's chmodSync)
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            let mode = metadata.permissions().mode() & 0o7777;
            // port: sync call (the test's change, as the JavaScript arm's chmodSync)
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode ^ 0o010));
        }
    }
}

/// A shimmed handle opened (`seams`).
pub fn handle_opened(path: &str) {
    SHIM.with(|shim| {
        if let Some(shim) = shim.borrow_mut().as_mut() {
            shim.log.push(format!("open {path}"));
            shim.calls
                .insert(path.to_owned(), crate::seams::sync_calls());
        }
    });
}

/// The outcome of a shimmed handle's `sync` or `close` (`seams`): logged,
/// and failed with EIO when the shim has that fault next.
pub fn handle_outcome(op: &str, path: &str, outcome: Result<(), W>) -> Result<(), W> {
    SHIM.with(|shim| {
        let mut shim = shim.borrow_mut();
        let Some(shim) = shim.as_mut() else {
            return outcome;
        };
        outcome?;
        if op == "sync" && shim.calls.get(path).copied() == Some(crate::seams::sync_calls()) {
            shim.log.push(format!("{op} {path} not made"));
            return Ok(());
        }
        let wanted = format!("{op}:{}", kind_of(path));
        let failed = shim
            .faults
            .iter()
            .position(|fault| *fault == wanted)
            .map(|at| shim.faults.remove(at))
            .is_some();
        shim.log
            .push(format!("{op} {path} {}", if failed { "EIO" } else { "ok" }));
        if !failed {
            return Ok(());
        }
        let syscall = if op == "sync" { "fsync" } else { "close" };
        let mut error = JsError::new("Error", &format!("EIO: i/o error, {syscall}"));
        error.set_field("errno", W::Number(-5.0));
        error.set_field("code", W::string("EIO"));
        error.set_field("syscall", W::string(syscall));
        Err(W::Error(Rc::new(error)))
    })
}

fn text(value: &W) -> String {
    to_js_string(value).to_string_lossy()
}

fn list(value: &W) -> Vec<W> {
    match value {
        W::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn error_with(code: &str, message: &str) -> W {
    let mut error = JsError::new("Error", message);
    error.set_field("code", W::string(code));
    W::Error(Rc::new(error))
}

fn outcome(result: Result<W, W>) -> W {
    match result {
        Ok(value) => W::object(vec![("ok", show(&value))]),
        Err(error) => W::object(vec![("error", show(&error))]),
    }
}

fn repo(step: &W) -> Repo {
    Repo {
        root: text(&step.get("root")),
        directory: text(&step.get("directory")),
    }
}

fn set_env(set: &W) {
    if let W::Object(object) = set {
        ENV.with(|env| {
            let mut env = env.borrow_mut();
            for (key, value) in object.iter() {
                let value = (!matches!(value, W::Null | W::Undefined)).then(|| text(value));
                host::set_process_env(&key.to_string_lossy(), value.as_deref());
                env.insert(key.to_string_lossy(), value);
            }
        });
    }
}

/// A typed promise as the arms show its value.
fn shown<T: Clone + 'static>(promise: Promise<T, W>, into: impl FnOnce(T) -> W + 'static) -> Ret {
    Ok(Resolution::Promise(
        promise.then_ok(move |value| Ok(Resolution::Value(into(value)))),
    ))
}

/// One step: its value (a promise for an async call) or what it throws.
fn step(ctx: &Ctx, controller: &Controller, spec: &W) -> Ret {
    let undefined = || Ok(Resolution::Value(W::Undefined));
    match text(&spec.get("s")).as_str() {
        "inspect" => {
            let directory = spec.get("directory");
            let directory = (!directory.is_undefined()).then(|| text(&directory));
            shown(
                inspect_mutation_file(
                    ctx,
                    &repo(spec),
                    &text(&spec.get("file")),
                    directory.as_deref(),
                    truthy(&spec.get("preview")),
                ),
                |value| value,
            )
        }
        "stamp" => shown(
            mutation_file_stamp(
                &text(&spec.get("directory")),
                &text(&spec.get("file")),
                None,
            ),
            |stamp| stamp.map_or(W::Null, |stamp| W::string(&stamp)),
        ),
        "space" => shown(
            require_mutation_space(
                &text(&spec.get("directory")),
                to_number(&spec.get("bytes")) as i128,
            ),
            |()| W::Undefined,
        ),
        "materializer" => {
            let made = create_view_materializer(&repo(spec), &text(&spec.get("view")), None);
            MATERIALIZERS.with(|all| all.borrow_mut().insert(text(&spec.get("as")), made));
            undefined()
        }
        "materialize" => {
            let Some(made) =
                MATERIALIZERS.with(|all| all.borrow().get(&text(&spec.get("m"))).cloned())
            else {
                return Err(error_with("no_materializer", &text(&spec.get("m"))));
            };
            shown(
                made.materialize(
                    ctx,
                    &spec.get("file"),
                    &spec.get("entry"),
                    to_number(&spec.get("mode")) as u32,
                ),
                |stat| {
                    stat.map_or(W::Null, |stat| {
                        W::object(vec![("stamp", W::string(&mutation_stat_stamp(&stat)))])
                    })
                },
            )
        }
        "copy" => shown(
            copy_mutation_object(
                ctx,
                &repo(spec),
                &spec.get("entry"),
                &text(&spec.get("target")),
                to_number(&spec.get("mode")) as u32,
                !matches!(spec.get("durable"), W::Bool(false)),
            ),
            |()| W::Undefined,
        ),
        "bytes" => shown(bytes_for(&repo(spec), &spec.get("hash")), W::Bytes),
        "sync" => Ok(Resolution::Promise(sync_pending_object_directory(&text(
            &spec.get("root"),
        )))),
        "markPending" => {
            mark_object_directory_pending(&text(&spec.get("directory")));
            undefined()
        }
        "reset" => {
            objects::reset_verified_mutation_objects();
            undefined()
        }
        "env" => {
            set_env(&spec.get("set"));
            undefined()
        }
        "abort" => {
            controller.abort(error_with("call_aborted", "aborted by the scenario"));
            undefined()
        }
        "syncShim" => {
            SHIM.with(|shim| {
                *shim.borrow_mut() = if truthy(&spec.get("off")) {
                    None
                } else {
                    Some(Shim {
                        faults: list(&spec.get("faults")).iter().map(text).collect(),
                        ..Shim::default()
                    })
                };
            });
            undefined()
        }
        "changeAt" => {
            CHANGE.with(|change| {
                *change.borrow_mut() = (!truthy(&spec.get("off"))).then(|| Change {
                    file: text(&spec.get("file")),
                    at: text(&spec.get("at")),
                    nth: to_number(&spec.get("nth")) as u64,
                    seen: 0,
                    log: Vec::new(),
                });
            });
            undefined()
        }
        "changeLog" => Ok(Resolution::Value(CHANGE.with(|change| {
            change.borrow().as_ref().map_or(W::Null, |change| {
                W::Array(change.log.iter().map(|line| W::string(line)).collect())
            })
        }))),
        "syncLog" => Ok(Resolution::Value(SHIM.with(|shim| {
            shim.borrow().as_ref().map_or(W::Null, |shim| {
                W::Array(shim.log.iter().map(|line| W::string(line)).collect())
            })
        }))),
        "concurrent" => {
            let started: Vec<Resolution<W, W>> = list(&spec.get("steps"))
                .iter()
                .map(|inner| match step(ctx, controller, inner) {
                    Ok(Resolution::Value(value)) => Resolution::Value(value),
                    Ok(Resolution::Promise(promise)) => Resolution::Promise(promise),
                    Err(error) => Resolution::Promise(Promise::reject(error)),
                })
                .collect();
            Ok(Resolution::Promise(Promise::all_settled(started).then_ok(
                |outcomes| {
                    Ok(Resolution::Value(W::Array(
                        outcomes.into_iter().map(outcome).collect(),
                    )))
                },
            )))
        }
        // A chain of `n` jobs, and the order the steps given settle in (each
        // started at once): where no I/O intervenes, that order is the jobs.
        "ticks" => {
            let mut chain: WPromise = Promise::resolve(Resolution::Value(W::Undefined));
            for _ in 0..to_number(&spec.get("n")) as usize {
                chain = chain.then_ok(|_| Ok(Resolution::Value(W::Undefined)));
            }
            Ok(Resolution::Promise(chain))
        }
        "settleOrder" => {
            let order: Rc<RefCell<Vec<W>>> = Rc::default();
            let started: Vec<Resolution<W, W>> = list(&spec.get("steps"))
                .iter()
                .enumerate()
                .map(|(index, inner)| {
                    let promise = match step(ctx, controller, inner) {
                        Ok(resolution) => Promise::resolve(resolution),
                        Err(error) => Promise::reject(error),
                    };
                    let (done, failed) = (order.clone(), order.clone());
                    Resolution::Promise(promise.then(
                        move |_| {
                            done.borrow_mut().push(W::Number(index as f64));
                            Ok(Resolution::Value(W::Undefined))
                        },
                        move |_| {
                            failed.borrow_mut().push(W::Number(index as f64));
                            Ok(Resolution::Value(W::Undefined))
                        },
                    ))
                })
                .collect();
            Ok(Resolution::Promise(Promise::all(started).then_ok(
                move |_| Ok(Resolution::Value(W::Array(order.borrow().clone()))),
            )))
        }
        other => Err(error_with("unknown_step", other)),
    }
}

/// One request, in a remote execution context whose signal it may abort.
fn request_of(request: W) -> WPromise {
    let controller = Controller::new();
    if text(&request.get("abort")) == "before" {
        controller.abort(error_with("call_aborted", "aborted before the call"));
    }
    let captured = W::object(vec![("cancellable", W::Bool(true))]);
    let action: crate::ctx::Action = {
        let controller = controller.clone();
        Box::new(move |ctx| -> Ret {
            let steps = list(&request.get("steps"));
            Ok(Resolution::Promise(async_fn(async move {
                let mut outcomes = Vec::new();
                for item in steps {
                    let result = match step(&ctx, &controller, &item) {
                        Ok(resolution) => Promise::resolve(resolution).await,
                        Err(error) => Err(error),
                    };
                    outcomes.push(outcome(result));
                }
                Ok(Resolution::Value(W::Array(outcomes)))
            })))
        })
    };
    let settled = run_in_remote_execution_context(
        &captured,
        action,
        Remote {
            signal: Some(controller.signal()),
            on_report: None,
            on_progress: None,
            progress_ms: 250.0,
        },
    );
    settled.then_ok(|outcome| {
        Ok(Resolution::Value(if outcome.failed {
            W::object(vec![("error", show(&outcome.value))])
        } else {
            W::object(vec![("ok", show(&outcome.value))])
        }))
    })
}

/// `ledger-native-probe objects`: one request per line, one answer line each.
pub fn serve(
    lines: impl Iterator<Item = Vec<u8>>,
    mut out: impl FnMut(&W),
    decode: impl Fn(&[u8]) -> Option<W>,
) {
    let event_loop = EventLoop::new(
        Box::new(RealClock::new()),
        Box::new(|name: &str| {
            ENV.with(|env| env.borrow().get(name).cloned())
                .unwrap_or_else(|| std::env::var(name).ok())
        }),
        Box::new(|| {}),
    );
    host::install(event_loop.clone());
    for line in lines {
        let Some(request) = decode(&line) else {
            out(&W::object(vec![("corrupt", W::Bool(true))]));
            continue;
        };
        if text(&request.get("op")) == "env" {
            set_env(&request.get("set"));
            out(&W::object(vec![("ok", W::Bool(true))]));
            continue;
        }
        let answer: Rc<RefCell<Option<W>>> = Rc::default();
        {
            let answer = answer.clone();
            let _ = request_of(request).then(
                move |value| {
                    *answer.borrow_mut() = Some(value);
                    Ok(Resolution::Value(()))
                },
                |_| Ok(Resolution::Value(())),
            );
        }
        event_loop.checkpoint();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            event_loop.checkpoint();
            if answer.borrow().is_some() && event_loop.blocking_pending() == 0 {
                break;
            }
            if std::time::Instant::now() > deadline {
                *answer.borrow_mut() = Some(W::object(vec![(
                    "timeout",
                    W::string(&format!(
                        "the request did not settle within 60 s ({} sources and pool jobs open)",
                        event_loop.blocking_pending()
                    )),
                )]));
                break;
            }
            event_loop.timers_phase();
            event_loop.check_phase();
            let wait = event_loop.poll_timeout().map_or(20, |ms| ms.min(20));
            event_loop.poll_phase(Some(wait), &mut |_| {});
        }
        let shown = answer.borrow_mut().take().unwrap_or(W::Null);
        out(&shown);
    }
}

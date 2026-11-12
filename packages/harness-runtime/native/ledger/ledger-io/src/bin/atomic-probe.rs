//! Test-only driver of `ledger_io::atomic` and `ledger_io::fs` for the Node
//! differential tests in `scripts/ledger-native/` (built only with the
//! `probe` feature; never packaged).
//!
//! Modes (the first argument):
//! - `scenario`: one scenario of the shared specification as JSON on stdin
//!   (`{"scenario": …, "root": …}`), one result as JSON on stdout. The shapes
//!   are those of `scripts/ledger-native/atomic-js-arm.mjs`, its JavaScript twin.
//! - `counter <lock> <file> <iterations> <timeoutMs>`: increment the integer
//!   in `<file>` under the lock, `<iterations>` times.
//! - `hold <lock>`: take the lock, print `held <pid>`, sleep until killed.
//! - `wait <lock> <timeoutMs>`: take and release the lock; print the outcome.
//! - `write-atomic <file> <text>`, `lock-once <lock>`, `sync-file <path>`,
//!   `copyfile <src> <dst> <flags>`: one primitive each, for system-call traces.
//! - `stat <path>...`: stamps, `mtimeMs` and file types, one JSON line.
//! - `errors`: the system errors ledger-io names (`errno`, name, message),
//!   for comparison with Node's `util.getSystemErrorMap()`.
//!
//! Failures are printed as `failure` records (`code`, `errno`, `syscall`,
//! `path`, `dest`, `message`), with paths under a scenario's root made
//! relative, as the JavaScript arm prints Node's errors.
use std::cell::{Cell, RefCell};
use std::io::{Read, Write};
use std::rc::Rc;

use ledger_core::js::{JsObject, JsStr, Value, parse_utf8, stringify_utf8};
use ledger_io::atomic::{self, Env, FileHandle, Fs, LockOptions, RealFs, SystemEnv, WriteOptions};
use ledger_io::fs::{self, DirEntry, Error, OpenFlags, Result, Stat};
use ledger_io::path;

fn object(fields: Vec<(&str, Value)>) -> Value {
    let mut object = JsObject::new();
    for (key, value) in fields {
        object.insert(JsStr::from(key), value);
    }
    Value::Object(object)
}

fn text(value: &str) -> Value {
    Value::String(JsStr::from(value))
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get_str(key))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    match field(value, key) {
        Some(Value::String(text)) => Some(text.to_string_lossy()),
        _ => None,
    }
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    match field(value, key) {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    }
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    field(value, key).and_then(Value::as_array).unwrap_or(&[])
}

fn emit(value: &Value) {
    let mut bytes = stringify_utf8(value)
        .expect("probe output nests shallowly")
        .unwrap_or_default();
    bytes.push(b'\n');
    let mut out = std::io::stdout();
    out.write_all(&bytes).expect("stdout");
    out.flush().expect("stdout");
}

/// `relativeTo(root)` of the JavaScript arm.
fn relative(root: &str, file: &str) -> String {
    if root.is_empty() {
        file.to_owned()
    } else if file == root {
        ".".to_owned()
    } else if let Some(rest) = file.strip_prefix(&format!("{root}/")) {
        rest.to_owned()
    } else {
        file.to_owned()
    }
}

/// `maskRoot(root)` of the JavaScript arm: the root's paths in a message.
fn mask_root(root: &str, text: &str) -> String {
    if root.is_empty() {
        return text.to_owned();
    }
    text.replace(&format!("{root}/"), "").replace(root, ".")
}

/// `failureOf(error)` of the JavaScript arm: what Node puts on an error.
fn failure(root: &str, error: &Error) -> Value {
    let mut fields = vec![("code", text(&error.code))];
    if let Some(errno) = error.errno {
        fields.push(("errno", number(errno as f64)));
    }
    if let Some(syscall) = error.syscall {
        fields.push(("syscall", text(syscall)));
    }
    if let Some(path) = &error.path {
        fields.push(("path", text(&relative(root, path))));
    }
    if let Some(dest) = &error.dest {
        fields.push(("dest", text(&relative(root, dest))));
    }
    fields.push(("message", text(&mask_root(root, &error.message))));
    object(fields)
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex"))
        .collect()
}

struct Fault {
    op: String,
    path: Option<String>,
    nth: Option<f64>,
    code: String,
    seen: Cell<f64>,
}

struct ObserveRule {
    op: String,
    read: Vec<usize>,
    exists: Vec<usize>,
}

/// A change made to the file system just before a matching call (the
/// JavaScript arm's `alter`): the call's argument `arg` becomes a directory
/// or a file with `content`.
struct AlterRule {
    op: String,
    path: Option<String>,
    nth: Option<f64>,
    arg: usize,
    directory: bool,
    content: Option<String>,
    seen: Cell<f64>,
}

type Trace = Rc<RefCell<Vec<Value>>>;

/// The recording file system: every call is traced as the JavaScript arm
/// traces it, faults are injected before the call, observations run first.
struct RecordingFs {
    root: String,
    trace: Trace,
    observations: RefCell<Vec<Value>>,
    faults: Vec<Fault>,
    observe: Vec<ObserveRule>,
    alter: Vec<AlterRule>,
}

/// The arguments of one recorded call before paths are made relative.
enum Arg {
    Path(String),
    Text(String),
    Value(Value),
}

impl RecordingFs {
    fn encode(&self, arg: &Arg) -> Value {
        match arg {
            Arg::Path(file) => text(&relative(&self.root, file)),
            Arg::Text(value) => text(&relative(&self.root, value)),
            Arg::Value(value) => value.clone(),
        }
    }

    fn raw(arg: &Arg) -> Option<&str> {
        match arg {
            Arg::Path(file) | Arg::Text(file) => Some(file),
            Arg::Value(_) => None,
        }
    }

    fn recorded<T>(&self, op: &str, args: Vec<Arg>, call: impl FnOnce() -> Result<T>) -> Result<T> {
        let entry = object(vec![
            ("op", text(op)),
            (
                "args",
                Value::Array(args.iter().map(|arg| self.encode(arg)).collect()),
            ),
        ]);
        let index = {
            let mut trace = self.trace.borrow_mut();
            trace.push(entry);
            trace.len() - 1
        };
        self.run_observations(op, &args);
        let first = args
            .first()
            .and_then(Self::raw)
            .map(|file| relative(&self.root, file));
        self.run_alterations(op, first.as_ref(), &args);
        for fault in &self.faults {
            if fault.op != op
                || fault
                    .path
                    .as_ref()
                    .is_some_and(|wanted| Some(wanted) != first.as_ref())
            {
                continue;
            }
            let seen = fault.seen.get() + 1.0;
            fault.seen.set(seen);
            if fault.nth.is_none_or(|nth| nth == seen) {
                self.mark(index, &fault.code, None);
                return Err(Error::coded(
                    &fault.code,
                    &format!("injected {}", fault.code),
                ));
            }
        }
        call().inspect_err(|error| self.mark(index, &error.code, Some(error)))
    }

    /// Records a failed call: an injected one by its code, a real one with its `failure`.
    fn mark(&self, index: usize, code: &str, real: Option<&Error>) {
        let mut trace = self.trace.borrow_mut();
        if let Value::Object(entry) = &mut trace[index] {
            entry.insert(JsStr::from("error"), text(code));
            match real {
                Some(error) => {
                    entry.insert(JsStr::from("failure"), failure(&self.root, error));
                }
                None => {
                    entry.insert(JsStr::from("injected"), Value::Bool(true));
                }
            }
        }
    }

    fn run_alterations(&self, op: &str, first: Option<&String>, args: &[Arg]) {
        for rule in &self.alter {
            if rule.op != op
                || rule
                    .path
                    .as_ref()
                    .is_some_and(|wanted| Some(wanted) != first)
            {
                continue;
            }
            let seen = rule.seen.get() + 1.0;
            rule.seen.set(seen);
            if !rule.nth.is_none_or(|nth| nth == seen) {
                continue;
            }
            let Some(target) = args.get(rule.arg).and_then(Self::raw) else {
                continue;
            };
            if rule.directory {
                let _ = std::fs::remove_file(target);
                std::fs::create_dir(target).expect("alter");
            } else if let Some(content) = &rule.content {
                std::fs::write(target, with_pid(content)).expect("alter");
            }
        }
    }

    fn run_observations(&self, op: &str, args: &[Arg]) {
        for rule in self.observe.iter().filter(|rule| rule.op == op) {
            let mut record = JsObject::new();
            record.insert(JsStr::from("op"), text(op));
            for &index in &rule.read {
                let value = match args.get(index).and_then(Self::raw).map(fs::read_file) {
                    Some(Ok(bytes)) => Value::String(JsStr::from_utf8_lossy(&bytes)),
                    Some(Err(error)) => object(vec![("error", text(&error.code))]),
                    None => Value::Null,
                };
                record.insert(JsStr::from(format!("read{index}").as_str()), value);
            }
            for &index in &rule.exists {
                let exists = args
                    .get(index)
                    .and_then(Self::raw)
                    .is_some_and(|file| fs::lstat(file).is_ok());
                record.insert(
                    JsStr::from(format!("exists{index}").as_str()),
                    Value::Bool(exists),
                );
            }
            self.observations.borrow_mut().push(Value::Object(record));
        }
    }
}

struct RecordingHandle<'a> {
    fs: &'a RecordingFs,
    file: String,
    inner: fs::File,
}

impl FileHandle for RecordingHandle<'_> {
    fn write_file(&mut self, data: &[u8]) -> Result<()> {
        let shown = String::from_utf8_lossy(data).into_owned();
        let inner = &mut self.inner;
        self.fs.recorded(
            "handle.writeFile",
            vec![Arg::Path(self.file.clone()), Arg::Text(shown)],
            || inner.write_file(data),
        )
    }
    fn sync(&mut self) -> Result<()> {
        let inner = &mut self.inner;
        self.fs
            .recorded("handle.sync", vec![Arg::Path(self.file.clone())], || {
                inner.sync()
            })
    }
    fn close(&mut self) -> Result<()> {
        let inner = &mut self.inner;
        self.fs
            .recorded("handle.close", vec![Arg::Path(self.file.clone())], || {
                inner.close()
            })
    }
}

impl Fs for RecordingFs {
    fn mkdir_recursive(&self, path: &str, mode: u32) -> Result<()> {
        let options = object(vec![
            ("recursive", Value::Bool(true)),
            ("mode", number(mode as f64)),
        ]);
        self.recorded(
            "mkdir",
            vec![Arg::Path(path.to_owned()), Arg::Value(options)],
            || RealFs.mkdir_recursive(path, mode),
        )
    }
    fn readdir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let options = object(vec![("withFileTypes", Value::Bool(true))]);
        self.recorded(
            "readdir",
            vec![Arg::Path(path.to_owned()), Arg::Value(options)],
            || RealFs.readdir(path),
        )
    }
    fn stat(&self, path: &str) -> Result<Stat> {
        self.recorded("stat", vec![Arg::Path(path.to_owned())], || {
            RealFs.stat(path)
        })
    }
    fn rm_force(&self, path: &str) -> Result<()> {
        let options = object(vec![("force", Value::Bool(true))]);
        self.recorded(
            "rm",
            vec![Arg::Path(path.to_owned()), Arg::Value(options)],
            || RealFs.rm_force(path),
        )
    }
    fn open(&self, path: &str, flags: OpenFlags, mode: u32) -> Result<Box<dyn FileHandle + '_>> {
        let mut args = vec![
            Arg::Path(path.to_owned()),
            Arg::Value(text(flags.as_node())),
        ];
        if flags == OpenFlags::WriteExclusive {
            args.push(Arg::Value(number(mode as f64)));
        }
        let inner = self.recorded("open", args, || fs::File::open(path, flags, mode))?;
        Ok(Box::new(RecordingHandle {
            fs: self,
            file: path.to_owned(),
            inner,
        }))
    }
    fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.recorded(
            "rename",
            vec![Arg::Path(from.to_owned()), Arg::Path(to.to_owned())],
            || RealFs.rename(from, to),
        )
    }
    fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        self.recorded(
            "chmod",
            vec![Arg::Path(path.to_owned()), Arg::Value(number(mode as f64))],
            || RealFs.chmod(path, mode),
        )
    }
    fn link(&self, from: &str, to: &str) -> Result<()> {
        self.recorded(
            "link",
            vec![Arg::Path(from.to_owned()), Arg::Path(to.to_owned())],
            || RealFs.link(from, to),
        )
    }
    fn unlink(&self, path: &str) -> Result<()> {
        self.recorded("unlink", vec![Arg::Path(path.to_owned())], || {
            RealFs.unlink(path)
        })
    }
    fn read_file_utf8(&self, path: &str) -> Result<JsStr> {
        self.recorded(
            "readFile",
            vec![Arg::Path(path.to_owned()), Arg::Value(text("utf8"))],
            || RealFs.read_file_utf8(path),
        )
    }
}

struct Clock {
    value: Cell<f64>,
    base: Cell<f64>,
}

/// The scenario's environment: the same wrappers as the JavaScript arm.
struct ScenarioEnv<'a> {
    trace: Trace,
    clock: &'a Clock,
    now_clock: bool,
    wait_clock: bool,
    alive: Option<bool>,
    token: Option<String>,
    id: Option<String>,
    abort_after: Option<f64>,
    signal_checks: f64,
    progress: Vec<Value>,
}

impl ScenarioEnv<'_> {
    fn log(&self, value: Value) {
        self.trace.borrow_mut().push(value);
    }
}

impl Env for ScenarioEnv<'_> {
    fn now(&mut self) -> f64 {
        if self.now_clock {
            self.log(object(vec![
                ("op", text("now")),
                (
                    "value",
                    number(self.clock.value.get() - self.clock.base.get()),
                ),
            ]));
            self.clock.value.get()
        } else {
            self.log(object(vec![("op", text("now"))]));
            atomic::date_now()
        }
    }
    fn wait(&mut self, milliseconds: f64) {
        self.log(object(vec![
            ("op", text("wait")),
            ("ms", number(milliseconds)),
        ]));
        if self.wait_clock {
            self.clock.value.set(self.clock.value.get() + milliseconds);
        } else {
            atomic::set_timeout_sleep(milliseconds);
        }
    }
    fn is_process_alive(&mut self, pid: f64) -> bool {
        let result = self.alive.unwrap_or_else(|| atomic::is_process_alive(pid));
        self.log(object(vec![
            ("op", text("isAlive")),
            ("pid", number(pid)),
            ("result", Value::Bool(result)),
        ]));
        result
    }
    fn random_token(&mut self) -> Result<JsStr> {
        self.log(object(vec![("op", text("randomToken"))]));
        match &self.token {
            Some(token) => Ok(JsStr::from(token.as_str())),
            None => Ok(JsStr::from(atomic::random_hex_id()?.as_str())),
        }
    }
    fn random_id(&mut self) -> Result<String> {
        self.log(object(vec![("op", text("randomId"))]));
        match &self.id {
            Some(id) => Ok(id.clone()),
            None => atomic::random_hex_id(),
        }
    }
    fn throw_if_aborted(&mut self) -> Result<()> {
        let Some(after) = self.abort_after else {
            return Ok(());
        };
        self.signal_checks += 1.0;
        let aborted = self.signal_checks > after;
        self.log(object(vec![
            ("op", text("signal")),
            ("aborted", Value::Bool(aborted)),
        ]));
        if aborted {
            Err(Error::coded("ABORT_ERR", "aborted"))
        } else {
            Ok(())
        }
    }
    fn on_progress(&mut self, phase: &str, state: &str) {
        self.progress.push(text(&format!("{phase}:{state}")));
    }
}

fn with_pid(content: &str) -> String {
    content.replace("<pid>", &fs::getpid().to_string())
}

fn run_callback(
    steps: &[Value],
    root: &str,
    clock: &Clock,
    outputs: &mut Vec<Value>,
) -> Result<Option<Value>> {
    let mut value = None;
    for step in steps {
        if let Some(target) = string_field(step, "inspect") {
            // Read with the standard library, not the code under test.
            use std::os::unix::fs::PermissionsExt;
            let file = path::join(&[root, &target]);
            let record = match (std::fs::read(&file), std::fs::metadata(&file)) {
                (Ok(bytes), Ok(meta)) => object(vec![
                    ("inspect", text(&target)),
                    ("content", Value::String(JsStr::from_utf8_lossy(&bytes))),
                    ("mode", number((meta.permissions().mode() & 0o777) as f64)),
                ]),
                (Err(error), _) | (_, Err(error)) => object(vec![
                    ("inspect", text(&target)),
                    (
                        "error",
                        text(&fs::error_name(error.raw_os_error().unwrap_or(0))),
                    ),
                ]),
            };
            outputs.push(record);
        } else if let Some(target) = string_field(step, "write") {
            let content = with_pid(&string_field(step, "content").unwrap_or_default());
            std::fs::write(path::join(&[root, &target]), content)
                .map_err(|error| Error::coded("SETUP", &error.to_string()))?;
        } else if field(step, "recordElapsed").is_some() {
            outputs.push(object(vec![(
                "elapsed",
                number(clock.value.get() - clock.base.get()),
            )]));
        } else if let Some(code) = string_field(step, "throw") {
            return Err(Error::coded(&code, &format!("injected {code}")));
        } else if let Some(returned) = field(step, "return") {
            value = Some(returned.clone());
        }
    }
    Ok(value)
}

/// The tree as the JavaScript arm's `snapshotTree` prints it, read with the
/// standard library rather than the code under test (the differential test
/// also snapshots this root with Node and compares).
fn snapshot_tree(root: &str) -> Value {
    fn walk(root: &str, relative: &str, entries: &mut Vec<Value>) {
        use std::os::unix::fs::PermissionsExt;
        let directory = if relative.is_empty() {
            root.to_owned()
        } else {
            format!("{root}/{relative}")
        };
        let mut names: Vec<Vec<u8>> = std::fs::read_dir(&directory)
            .expect("snapshot")
            .map(|entry| {
                use std::os::unix::ffi::OsStrExt;
                entry.expect("snapshot").file_name().as_bytes().to_vec()
            })
            .collect();
        names.sort();
        for name in names {
            let name = String::from_utf8_lossy(&name).into_owned();
            let file = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let full = format!("{root}/{file}");
            let meta = std::fs::symlink_metadata(&full).expect("snapshot");
            let mode = number((meta.permissions().mode() & 0o777) as f64);
            if meta.is_dir() {
                entries.push(object(vec![
                    ("path", text(&file)),
                    ("type", text("dir")),
                    ("mode", mode),
                ]));
                walk(root, &file, entries);
            } else if meta.is_file() {
                let content = Value::String(JsStr::from_utf8_lossy(
                    &std::fs::read(&full).expect("snapshot"),
                ));
                entries.push(object(vec![
                    ("path", text(&file)),
                    ("type", text("file")),
                    ("mode", mode),
                    ("content", content),
                ]));
            } else {
                entries.push(object(vec![("path", text(&file)), ("type", text("other"))]));
            }
        }
    }
    let mut entries = Vec::new();
    walk(root, "", &mut entries);
    Value::Array(entries)
}

fn run_operation(run: &Value, root: &str, clock: &Clock) -> Value {
    let trace: Trace = Rc::new(RefCell::new(Vec::new()));
    let faults = array_field(run, "faults")
        .iter()
        .map(|fault| Fault {
            op: string_field(fault, "op").unwrap_or_default(),
            path: string_field(fault, "path"),
            nth: number_field(fault, "nth"),
            code: string_field(fault, "code").unwrap_or_default(),
            seen: Cell::new(0.0),
        })
        .collect();
    let indices = |rule: &Value, key: &str| {
        array_field(rule, key)
            .iter()
            .filter_map(|v| {
                if let Value::Number(n) = v {
                    Some(*n as usize)
                } else {
                    None
                }
            })
            .collect()
    };
    let observe = array_field(run, "observe")
        .iter()
        .map(|rule| ObserveRule {
            op: string_field(rule, "op").unwrap_or_default(),
            read: indices(rule, "read"),
            exists: indices(rule, "exists"),
        })
        .collect();
    let alter = array_field(run, "alter")
        .iter()
        .map(|rule| AlterRule {
            op: string_field(rule, "op").unwrap_or_default(),
            path: string_field(rule, "path"),
            nth: number_field(rule, "nth"),
            arg: number_field(rule, "arg").unwrap_or(0.0) as usize,
            directory: matches!(field(rule, "directory"), Some(Value::Bool(true))),
            content: string_field(rule, "content"),
            seen: Cell::new(0.0),
        })
        .collect();
    let recording = RecordingFs {
        root: root.to_owned(),
        trace: trace.clone(),
        observations: RefCell::new(Vec::new()),
        faults,
        observe,
        alter,
    };
    let empty = Value::Object(JsObject::new());
    let options = field(run, "options").unwrap_or(&empty);
    let mut env = ScenarioEnv {
        trace: trace.clone(),
        clock,
        now_clock: string_field(run, "now").as_deref() == Some("clock"),
        wait_clock: string_field(run, "wait").as_deref() == Some("clock"),
        alive: match field(run, "isAlive") {
            Some(Value::Bool(value)) => Some(*value),
            _ => None,
        },
        token: string_field(options, "randomToken"),
        id: string_field(options, "randomId"),
        abort_after: field(run, "signal").and_then(|signal| number_field(signal, "abortAfter")),
        signal_checks: 0.0,
        progress: Vec::new(),
    };
    let target = path::join(&[root, &string_field(run, "path").unwrap_or_default()]);
    let mut callback_outputs = Vec::new();
    let outcome: Result<Option<Value>> = match string_field(run, "op").as_deref() {
        Some("writeFileAtomic") => {
            let data = string_field(run, "data").unwrap_or_default();
            let write = WriteOptions {
                mode: number_field(options, "mode").map(|m| m as u32),
                directory_mode: number_field(options, "directoryMode").map(|m| m as u32),
                stale_tmp_age_ms: number_field(options, "staleTmpAgeMs"),
            };
            atomic::write_file_atomic(&target, data.as_bytes(), &write, &recording, &mut env)
                .map(|()| None)
        }
        Some("lock") => {
            let lock = LockOptions {
                timeout_ms: number_field(options, "timeoutMs"),
                retry_ms: number_field(options, "retryMs"),
                malformed_stale_ms: number_field(options, "malformedStaleMs"),
            };
            let steps = array_field(run, "callback");
            atomic::with_cross_process_file_lock(&target, &lock, &recording, &mut env, |_| {
                run_callback(steps, root, clock, &mut callback_outputs)
            })
        }
        Some("cleanup") => atomic::cleanup_stale_atomic_files(
            &target,
            number_field(options, "staleAfterMs"),
            &recording,
            &mut env,
        )
        .map(|count| Some(number(count as f64))),
        other => Err(Error::coded("UNKNOWN_OPERATION", &format!("{other:?}"))),
    };
    let mut fields = match outcome {
        Ok(Some(value)) => vec![("ok", Value::Bool(true)), ("value", value)],
        Ok(None) => vec![("ok", Value::Bool(true))],
        Err(error) => vec![
            ("ok", Value::Bool(false)),
            ("error", text(&error.code)),
            ("failure", failure(root, &error)),
        ],
    };
    let progress = std::mem::take(&mut env.progress);
    drop(env);
    fields.push(("trace", Value::Array(trace.borrow().clone())));
    fields.push(("progress", Value::Array(progress)));
    fields.push((
        "observations",
        Value::Array(recording.observations.borrow().clone()),
    ));
    fields.push(("callback", Value::Array(callback_outputs)));
    fields.push(("after", snapshot_tree(root)));
    object(fields)
}

fn setup(steps: &[Value], root: &str) {
    for step in steps {
        if let Some(target) = string_field(step, "write") {
            let file = path::join(&[root, &target]);
            std::fs::create_dir_all(path::dirname(&file)).expect("setup");
            let bytes = match string_field(step, "hex") {
                Some(hex) => hex_bytes(&hex),
                None => with_pid(&string_field(step, "content").unwrap_or_default()).into_bytes(),
            };
            std::fs::write(&file, bytes).expect("setup");
        } else if let Some(target) = string_field(step, "symlink") {
            let file = path::join(&[root, &target]);
            std::fs::create_dir_all(path::dirname(&file)).expect("setup");
            std::os::unix::fs::symlink(string_field(step, "target").unwrap_or_default(), &file)
                .expect("setup");
        } else if let Some(target) = string_field(step, "mkdir") {
            std::fs::create_dir_all(path::join(&[root, &target])).expect("setup");
        } else if let Some(target) = string_field(step, "utimes") {
            fs::utimes(
                &path::join(&[root, &target]),
                number_field(step, "atime").unwrap_or(0.0),
                number_field(step, "mtime").unwrap_or(0.0),
            )
            .expect("setup");
        } else if let Some(target) = string_field(step, "chmod") {
            fs::chmod(
                &path::join(&[root, &target]),
                number_field(step, "mode").unwrap_or(0.0) as u32,
            )
            .expect("setup");
        }
    }
}

fn scenario_main() {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).expect("stdin");
    let request = parse_utf8(&input).expect("request JSON");
    let root = string_field(&request, "root").expect("root");
    let scenario = field(&request, "scenario").expect("scenario");
    let clock = Clock {
        value: Cell::new(0.0),
        base: Cell::new(0.0),
    };
    let mut runs = Vec::new();
    for step in array_field(scenario, "steps") {
        if let Some(Value::Array(steps)) = field(step, "setup") {
            setup(steps, &root);
        } else if let Some(change) = field(step, "clock") {
            if let Some(value) = number_field(change, "set") {
                clock.value.set(value);
                clock.base.set(value);
            }
            if let Some(target) = string_field(change, "setToMtime") {
                let value = fs::stat(&path::join(&[&root, &target]))
                    .expect("clock")
                    .mtime_ms();
                clock.value.set(value);
                clock.base.set(value);
            }
            if let Some(advance) = number_field(change, "advance") {
                clock.value.set(clock.value.get() + advance);
            }
        } else if let Some(run) = field(step, "run") {
            runs.push(run_operation(run, &root, &clock));
        }
    }
    emit(&object(vec![
        ("pid", number(fs::getpid() as f64)),
        ("runs", Value::Array(runs)),
        ("final", snapshot_tree(&root)),
    ]));
}

fn fail(error: &Error) -> ! {
    emit(&object(vec![
        ("ok", Value::Bool(false)),
        ("error", text(&error.code)),
        ("failure", failure("", error)),
    ]));
    std::process::exit(1);
}

fn arg(args: &[String], index: usize) -> &str {
    args.get(index).map(String::as_str).unwrap_or_else(|| {
        eprintln!("atomic-probe: missing argument {index}");
        std::process::exit(64)
    })
}

fn number_arg(args: &[String], index: usize) -> f64 {
    arg(args, index).parse().unwrap_or_else(|_| {
        eprintln!("atomic-probe: argument {index} is not a number");
        std::process::exit(64)
    })
}

fn counter(args: &[String]) {
    let lock = arg(args, 2);
    let file = arg(args, 3).to_owned();
    let iterations = number_arg(args, 4) as u64;
    let options = LockOptions {
        timeout_ms: Some(number_arg(args, 5)),
        ..LockOptions::default()
    };
    for _ in 0..iterations {
        let result =
            atomic::with_cross_process_file_lock(lock, &options, &RealFs, &mut SystemEnv, |_| {
                let current = match std::fs::read_to_string(&file) {
                    Ok(text) => text.trim().parse::<u64>().unwrap_or(0),
                    Err(_) => 0,
                };
                std::fs::write(&file, format!("{}", current + 1))
                    .map_err(|error| Error::coded("COUNTER_WRITE", &error.to_string()))
            });
        if let Err(error) = result {
            fail(&error);
        }
    }
    emit(&object(vec![
        ("ok", Value::Bool(true)),
        ("done", number(iterations as f64)),
    ]));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match arg(&args, 1) {
        "scenario" => scenario_main(),
        "counter" => counter(&args),
        "hold" => {
            let result = atomic::with_cross_process_file_lock(
                arg(&args, 2),
                &LockOptions {
                    timeout_ms: Some(60_000.0),
                    ..LockOptions::default()
                },
                &RealFs,
                &mut SystemEnv,
                |_| -> Result<()> {
                    println!("held {}", fs::getpid());
                    std::io::stdout().flush().expect("stdout");
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                },
            );
            if let Err(error) = result {
                fail(&error);
            }
        }
        "wait" => {
            let started = atomic::date_now();
            let options = LockOptions {
                timeout_ms: Some(number_arg(&args, 3)),
                ..LockOptions::default()
            };
            let result = atomic::with_cross_process_file_lock(
                arg(&args, 2),
                &options,
                &RealFs,
                &mut SystemEnv,
                |_| Ok(()),
            );
            let elapsed = number(atomic::date_now() - started);
            match result {
                Ok(()) => emit(&object(vec![
                    ("ok", Value::Bool(true)),
                    ("elapsed", elapsed),
                ])),
                Err(error) => emit(&object(vec![
                    ("ok", Value::Bool(false)),
                    ("error", text(&error.code)),
                    ("elapsed", elapsed),
                ])),
            }
        }
        "write-atomic" => {
            if let Err(error) = atomic::write_file_atomic(
                arg(&args, 2),
                arg(&args, 3).as_bytes(),
                &WriteOptions::default(),
                &RealFs,
                &mut SystemEnv,
            ) {
                fail(&error);
            }
            emit(&object(vec![("ok", Value::Bool(true))]));
        }
        "lock-once" => {
            if let Err(error) = atomic::with_cross_process_file_lock(
                arg(&args, 2),
                &LockOptions::default(),
                &RealFs,
                &mut SystemEnv,
                |_| Ok(()),
            ) {
                fail(&error);
            }
            emit(&object(vec![("ok", Value::Bool(true))]));
        }
        "sync-file" => {
            if let Err(error) = atomic::sync_directory(&RealFs, arg(&args, 2)) {
                fail(&error);
            }
            emit(&object(vec![("ok", Value::Bool(true))]));
        }
        "copyfile" => {
            if let Err(error) =
                fs::copyfile(arg(&args, 2), arg(&args, 3), number_arg(&args, 4) as u32)
            {
                fail(&error);
            }
            emit(&object(vec![("ok", Value::Bool(true))]));
        }
        "errors" => {
            let mut out: Vec<Value> = fs::system_errors()
                .into_iter()
                .map(|(errno, name, message)| {
                    Value::Array(vec![number(-errno as f64), text(name), text(message)])
                })
                .collect();
            // An errno libuv does not know, as `util.getSystemErrorName` prints it.
            out.push(Value::Array(vec![
                number(-9999.0),
                text(&fs::error_name(9999)),
                text(&fs::error_message(9999)),
            ]));
            emit(&Value::Array(out));
        }
        "stat" => {
            let mut out = Vec::new();
            for file in &args[2..] {
                let record = match (fs::lstat(file), fs::stat(file)) {
                    (Ok(link), Ok(followed)) => object(vec![
                        ("path", text(file)),
                        ("stamp", text(&link.stamp(true))),
                        ("identity", text(&link.stamp(false))),
                        ("mtimeMs", number(followed.mtime_ms())),
                        ("isFile", Value::Bool(link.is_file())),
                        ("isDirectory", Value::Bool(link.is_directory())),
                        ("isSymbolicLink", Value::Bool(link.is_symbolic_link())),
                        (
                            "realpath",
                            fs::realpath(file).map(|p| text(&p)).unwrap_or(Value::Null),
                        ),
                        (
                            "statfsBsize",
                            fs::statfs(file)
                                .map(|s| number(s.bsize as f64))
                                .unwrap_or(Value::Null),
                        ),
                    ]),
                    (Err(error), _) | (_, Err(error)) => {
                        object(vec![("path", text(file)), ("error", text(&error.code))])
                    }
                };
                out.push(record);
            }
            emit(&Value::Array(out));
        }
        other => {
            eprintln!("atomic-probe: unknown mode {other}");
            std::process::exit(64);
        }
    }
}

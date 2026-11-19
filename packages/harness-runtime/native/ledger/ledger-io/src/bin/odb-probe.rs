//! Test-only driver of `ledger_io::git::odb` for the Node differential tests
//! in `scripts/ledger-native/` (built only with the `probe` feature; never
//! packaged). Each mode prints what the Git command it stands for prints, so
//! the tests compare bytes; "ask Git" is printed as `ask-git <code>` (per
//! line for the batch modes; otherwise on stderr with exit status 3).
//!
//! The bounds are `OdbOptions::default()` unless `ODB_PROBE_MAX_OBJECT_BYTES`,
//! `ODB_PROBE_MAX_DELTA_DEPTH`, `ODB_PROBE_DELTA_BUDGET`,
//! `ODB_PROBE_MAX_TREE_DEPTH` or `ODB_PROBE_MAX_ROWS` set them, and
//! `ODB_PROBE_VERIFY=1` checks every id.
//!
//! Modes (the first argument, the repository second):
//! - `open <git>`: `ok <object format>`.
//! - `batch-all <git>` / `batch-all-check <git>`: `cat-file
//!   --batch-all-objects --batch` / `--batch-check`.
//! - `batch <git>` / `batch-check <git>`: `cat-file --batch` /
//!   `--batch-check` of the names on stdin, one per line.
//! - `ls-tree <git> <tree> [<prefix>]`: `ls-tree -r -l -z <tree> [-- <prefix>/]`.
//! - `ls-tree-many <git>`: one listing per stdin line (`<tree>` or `<tree>
//!   <prefix>`), each printed as `ok <length>\n<rows>` or `ask-git <code>\n`.
//! - `for-each-ref <git> [<pattern>]`: `for-each-ref [<pattern>]`.
//! - `read-ref <git> <name>`: the id, or `absent`; `read-ref-many <git>` one
//!   answer line per name on stdin.
//! - `write <git>`: writes the objects on stdin (`<type> <length>\n<bytes>`
//!   records) as loose objects; prints each id.
//! - `write-trace`: one write through a recording file system, as JSON (the
//!   shapes of `scripts/ledger-native/odb-js-arm.mjs`, its twin).
//! - `stress <git> <rounds> [<stop file>]`: reads the objects on stdin
//!   (`<id> <type> <size>` lines) again and again, checking every id, for
//!   `<rounds>` rounds or until the stop file exists; prints the counts.
//! - `fuzz <git> <seed> <rounds>`: corrupts one object file at a time in
//!   this (scratch) repository and reads every object on stdin; prints the
//!   counts and the peak resident memory.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::ExitCode;

use ledger_core::js::{JsObject, JsStr, Value, parse_utf8, stringify_utf8};
use ledger_io::fs::{self, Error, Result, Stat};
use ledger_io::git::odb::{
    Answer, AskGit, Kind, LooseEnv, LooseFs, NameLookup, ObjectFormat, Odb, OdbOptions, Oid,
    RealLooseFs, Repository, SystemLooseEnv, write_loose_object,
};
use ledger_io::path;

const ASK_GIT: u8 = 3;

fn ask_exit(refused: &AskGit) -> ExitCode {
    eprintln!("ask-git {} {}", refused.reason.code(), refused.detail);
    ExitCode::from(ASK_GIT)
}

fn arg(args: &[String], index: usize) -> &str {
    args.get(index).map(String::as_str).unwrap_or_else(|| {
        eprintln!("odb-probe: missing argument {index}");
        std::process::exit(2)
    })
}

fn options() -> OdbOptions {
    let number = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.parse::<u64>().expect(name))
    };
    let mut options = OdbOptions::default();
    if let Some(value) = number("ODB_PROBE_MAX_OBJECT_BYTES") {
        options.max_object_bytes = value;
    }
    if let Some(value) = number("ODB_PROBE_MAX_DELTA_DEPTH") {
        options.max_delta_depth = value as usize;
    }
    if let Some(value) = number("ODB_PROBE_DELTA_BUDGET") {
        options.delta_budget_bytes = value;
    }
    if let Some(value) = number("ODB_PROBE_MAX_TREE_DEPTH") {
        options.max_tree_depth = value as usize;
    }
    if let Some(value) = number("ODB_PROBE_MAX_ROWS") {
        options.max_listing_rows = value as usize;
    }
    options.verify_ids = std::env::var("ODB_PROBE_VERIFY").as_deref() == Ok("1");
    options
}

fn open(git: &str) -> Answer<Odb> {
    Odb::open(git, options())
}

fn stdin_lines() -> Vec<Vec<u8>> {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).expect("stdin");
    let mut lines: Vec<Vec<u8>> = input
        .split(|byte| *byte == b'\n')
        .map(<[u8]>::to_vec)
        .collect();
    if lines.last().is_some_and(Vec::is_empty) {
        lines.pop();
    }
    lines
}

fn batch_line(out: &mut Vec<u8>, odb: &Odb, name: &[u8], check: bool) {
    match odb.read_name(name, check) {
        Ok(NameLookup::Submodule(oid)) => {
            out.extend_from_slice(format!("{oid} submodule\n").as_bytes())
        }
        Ok(NameLookup::Found(found)) => {
            out.extend_from_slice(
                format!("{} {} {}\n", found.oid, found.kind.name(), found.size).as_bytes(),
            );
            if let Some(data) = found.data {
                out.extend_from_slice(&data);
                out.push(b'\n');
            }
        }
        Ok(NameLookup::Missing) => {
            out.extend_from_slice(name);
            out.extend_from_slice(b" missing\n");
        }
        Err(refused) => {
            out.extend_from_slice(name);
            out.extend_from_slice(format!(" ask-git {}\n", refused.reason.code()).as_bytes());
        }
    }
}

fn write_out(bytes: &[u8]) {
    let mut out = std::io::stdout();
    out.write_all(bytes).expect("stdout");
    out.flush().expect("stdout");
}

fn batch_all(git: &str, check: bool) -> ExitCode {
    let odb = match open(git) {
        Ok(odb) => odb,
        Err(refused) => return ask_exit(&refused),
    };
    let ids = match odb.all_object_ids() {
        Ok(ids) => ids,
        Err(refused) => return ask_exit(&refused),
    };
    let mut out = Vec::new();
    for oid in ids {
        let found = if check {
            odb.info(&oid)
                .map(|info| info.map(|info| (info.kind, info.size, None)))
        } else {
            odb.read(&oid).map(|object| {
                object.map(|object| (object.kind, object.data.len() as u64, Some(object.data)))
            })
        };
        match found {
            Ok(Some((kind, size, data))) => {
                out.extend_from_slice(format!("{oid} {} {size}\n", kind.name()).as_bytes());
                if let Some(data) = data {
                    out.extend_from_slice(&data);
                    out.push(b'\n');
                }
            }
            Ok(None) => {
                eprintln!("odb-probe: {oid} was listed but is missing");
                return ExitCode::from(4);
            }
            Err(refused) => return ask_exit(&refused),
        }
    }
    write_out(&out);
    ExitCode::SUCCESS
}

fn parse_oid(text: &str) -> Oid {
    Oid::from_hex(text).unwrap_or_else(|| {
        eprintln!("odb-probe: not an id: {text}");
        std::process::exit(2)
    })
}

fn ls_tree(args: &[String]) -> ExitCode {
    let odb = match open(arg(args, 2)) {
        Ok(odb) => odb,
        Err(refused) => return ask_exit(&refused),
    };
    match odb.list_tree(&parse_oid(arg(args, 3)), args.get(4).map(String::as_str)) {
        Ok(rows) => {
            let mut out = Vec::new();
            for row in rows {
                out.extend_from_slice(&row.text());
                out.push(0);
            }
            write_out(&out);
            ExitCode::SUCCESS
        }
        Err(refused) => ask_exit(&refused),
    }
}

fn ls_tree_many(args: &[String]) -> ExitCode {
    let odb = match open(arg(args, 2)) {
        Ok(odb) => odb,
        Err(refused) => return ask_exit(&refused),
    };
    let mut out = Vec::new();
    for line in stdin_lines() {
        let line = String::from_utf8(line).expect("listing request");
        let (tree, prefix) = match line.split_once(' ') {
            Some((tree, prefix)) => (tree, Some(prefix)),
            None => (line.as_str(), None),
        };
        match odb.list_tree(&parse_oid(tree), prefix) {
            Ok(rows) => {
                let mut listing = Vec::new();
                for row in rows {
                    listing.extend_from_slice(&row.text());
                    listing.push(0);
                }
                out.extend_from_slice(format!("ok {}\n", listing.len()).as_bytes());
                out.extend_from_slice(&listing);
            }
            Err(refused) => {
                out.extend_from_slice(format!("ask-git {}\n", refused.reason.code()).as_bytes())
            }
        }
    }
    write_out(&out);
    ExitCode::SUCCESS
}

fn read_ref_many(args: &[String]) -> ExitCode {
    let repo = match Repository::open(arg(args, 2)) {
        Ok(repo) => repo,
        Err(refused) => return ask_exit(&refused),
    };
    let mut out = String::new();
    for line in stdin_lines() {
        match repo.read_ref(&String::from_utf8_lossy(&line)) {
            Ok(Some(oid)) => out.push_str(&format!("{oid}\n")),
            Ok(None) => out.push_str("absent\n"),
            Err(refused) => out.push_str(&format!("ask-git {}\n", refused.reason.code())),
        }
    }
    write_out(out.as_bytes());
    ExitCode::SUCCESS
}

fn for_each_ref(args: &[String]) -> ExitCode {
    let odb = match open(arg(args, 2)) {
        Ok(odb) => odb,
        Err(refused) => return ask_exit(&refused),
    };
    let refs = match odb
        .repository()
        .for_each_ref(args.get(3).map(String::as_str))
    {
        Ok(refs) => refs,
        Err(refused) => return ask_exit(&refused),
    };
    let mut out = String::new();
    for entry in refs {
        match odb.info(&entry.oid) {
            Ok(Some(info)) => out.push_str(&format!(
                "{} {}\t{}\n",
                entry.oid,
                info.kind.name(),
                entry.name
            )),
            // Git dies on a ref naming a missing object.
            Ok(None) => {
                eprintln!("odb-probe: {} names a missing object", entry.name);
                return ExitCode::from(4);
            }
            Err(refused) => return ask_exit(&refused),
        }
    }
    write_out(out.as_bytes());
    ExitCode::SUCCESS
}

fn read_ref(args: &[String]) -> ExitCode {
    let repo = match Repository::open(arg(args, 2)) {
        Ok(repo) => repo,
        Err(refused) => return ask_exit(&refused),
    };
    match repo.read_ref(arg(args, 3)) {
        Ok(Some(oid)) => write_out(format!("{oid}\n").as_bytes()),
        Ok(None) => write_out(b"absent\n"),
        Err(refused) => return ask_exit(&refused),
    }
    ExitCode::SUCCESS
}

fn kind_of(name: &str) -> Kind {
    Kind::from_name(name.as_bytes()).unwrap_or_else(|| {
        eprintln!("odb-probe: not a type: {name}");
        std::process::exit(2)
    })
}

fn write(args: &[String]) -> ExitCode {
    let git = arg(args, 2);
    let repo = match Repository::open(git) {
        Ok(repo) => repo,
        Err(refused) => return ask_exit(&refused),
    };
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).expect("stdin");
    let mut at = 0;
    let mut out = String::new();
    while at < input.len() {
        let end = at
            + input[at..]
                .iter()
                .position(|byte| *byte == b'\n')
                .expect("record header");
        let header = std::str::from_utf8(&input[at..end]).expect("record header");
        let (kind, length) = header.split_once(' ').expect("record header");
        let length: usize = length.parse().expect("record length");
        let content = &input[end + 1..end + 1 + length];
        at = end + 1 + length;
        match write_loose_object(
            &RealLooseFs,
            &mut SystemLooseEnv,
            git,
            kind_of(kind),
            content,
            repo.format(),
        ) {
            Ok(oid) => out.push_str(&format!("{oid}\n")),
            Err(error) => {
                eprintln!("odb-probe: write failed: {}", error.message);
                return ExitCode::from(1);
            }
        }
    }
    write_out(out.as_bytes());
    ExitCode::SUCCESS
}

// --- write-trace -----------------------------------------------------------

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

fn relative(root: &str, file: &str) -> String {
    file.strip_prefix(&format!("{root}/"))
        .map_or_else(|| file.to_owned(), str::to_owned)
}

struct Fault {
    op: String,
    nth: f64,
    code: String,
    alter: String,
}

/// The JavaScript arm's `inject`: an error of this code for the call.
fn injected(code: &str, syscall: &'static str, file: &str) -> Error {
    let errno = match code {
        "ENOENT" => libc::ENOENT,
        "EINVAL" => libc::EINVAL,
        "EEXIST" => libc::EEXIST,
        "EACCES" => libc::EACCES,
        "EIO" => libc::EIO,
        "ENOSPC" => libc::ENOSPC,
        _ => return Error::coded(code, code),
    };
    Error::os(errno, syscall, Some(file))
}

/// A file system that records every call and fails the ones the scenario
/// names, after the scenario's change to the fan-out directory.
struct TracingFs {
    root: String,
    faults: Vec<Fault>,
    calls: RefCell<BTreeMap<String, f64>>,
    trace: RefCell<Vec<Value>>,
}

impl TracingFs {
    /// Records the call and returns the injected failure, if any.
    fn call(
        &self,
        op: &str,
        file: &str,
        syscall: &'static str,
        extra: Vec<(&str, Value)>,
    ) -> Option<Error> {
        let mut fields = vec![
            ("op", text(op)),
            ("path", text(&relative(&self.root, file))),
        ];
        fields.extend(extra);
        let mut failure = None;
        // A fault names the nth call of its operation.
        let count = {
            let mut calls = self.calls.borrow_mut();
            let count = calls.entry(op.to_owned()).or_insert(0.0);
            *count += 1.0;
            *count
        };
        for fault in &self.faults {
            if fault.op != op || fault.nth != count {
                continue;
            }
            let directory = if op == "mkdir" || op == "stat" {
                file.to_owned()
            } else {
                path::dirname(file)
            };
            match fault.alter.as_str() {
                "remove-dir" => {
                    let _ = std::fs::remove_dir_all(&directory);
                }
                "replace-dir" => {
                    let _ = std::fs::rename(&directory, format!("{directory}.replaced"));
                    let _ = std::fs::create_dir(&directory);
                }
                _ => {}
            }
            failure = Some(injected(&fault.code, syscall, file));
            break;
        }
        fields.push((
            "injected",
            failure
                .as_ref()
                .map_or(Value::Null, |error| text(&error.code)),
        ));
        self.trace.borrow_mut().push(object(fields));
        failure
    }

    fn outcome<T>(&self, result: Result<T>) -> Result<T> {
        if let Err(error) = &result
            && let Some(Value::Object(last)) = self.trace.borrow_mut().last_mut()
        {
            last.insert(JsStr::from("error"), text(&error.code));
        }
        result
    }
}

impl LooseFs for TracingFs {
    fn utimes(&self, file: &str, atime: f64, mtime: f64) -> Result<()> {
        if let Some(error) = self.call(
            "utimes",
            file,
            "utime",
            vec![
                ("atime", Value::Number(atime)),
                ("mtime", Value::Number(mtime)),
            ],
        ) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.utimes(file, atime, mtime))
    }
    fn mkdir_recursive(&self, file: &str) -> Result<()> {
        if let Some(error) = self.call(
            "mkdir",
            file,
            "mkdir",
            vec![("recursive", Value::Bool(true))],
        ) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.mkdir_recursive(file))
    }
    fn stat(&self, file: &str) -> Result<Stat> {
        if let Some(error) = self.call("stat", file, "stat", vec![]) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.stat(file))
    }
    fn write_file_exclusive(&self, file: &str, data: &[u8], mode: u32) -> Result<()> {
        if let Some(error) = self.call(
            "writeFile",
            file,
            "open",
            vec![
                ("mode", Value::Number(f64::from(mode))),
                ("flag", text("wx")),
            ],
        ) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.write_file_exclusive(file, data, mode))
    }
    fn link(&self, from: &str, to: &str) -> Result<()> {
        if let Some(error) = self.call(
            "link",
            from,
            "link",
            vec![("dest", text(&relative(&self.root, to)))],
        ) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.link(from, to))
    }
    fn unlink(&self, file: &str) -> Result<()> {
        if let Some(error) = self.call("unlink", file, "unlink", vec![]) {
            return self.outcome(Err(error));
        }
        self.outcome(RealLooseFs.unlink(file))
    }
}

struct ScriptedEnv {
    now: f64,
    uuids: Vec<String>,
}

impl LooseEnv for ScriptedEnv {
    fn now(&mut self) -> f64 {
        self.now
    }
    fn random_uuid(&mut self) -> Result<String> {
        Ok(if self.uuids.is_empty() {
            "00000000-0000-4000-8000-000000000000".to_owned()
        } else {
            self.uuids.remove(0)
        })
    }
}

fn write_trace() -> ExitCode {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).expect("stdin");
    let request = parse_utf8(&input).expect("request JSON");
    let root = string_field(&request, "root").expect("root");
    let git = path::join(&[&root, &string_field(&request, "gitDir").expect("gitDir")]);
    let format = if string_field(&request, "format").as_deref() == Some("sha256") {
        ObjectFormat::Sha256
    } else {
        ObjectFormat::Sha1
    };
    let faults = field(&request, "faults")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .map(|fault| Fault {
            op: string_field(fault, "op").expect("op"),
            nth: number_field(fault, "nth").unwrap_or(1.0),
            code: string_field(fault, "code").expect("code"),
            alter: string_field(fault, "alter").unwrap_or_default(),
        })
        .collect();
    let uuids = field(&request, "uuids")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .map(|uuid| match uuid {
            Value::String(text) => text.to_string_lossy(),
            _ => panic!("uuid"),
        })
        .collect();
    let tracing = TracingFs {
        root: root.clone(),
        faults,
        calls: RefCell::new(BTreeMap::new()),
        trace: RefCell::new(Vec::new()),
    };
    let mut env = ScriptedEnv {
        now: number_field(&request, "now").expect("now"),
        uuids,
    };
    let content = string_field(&request, "content").expect("content");
    let kind = kind_of(&string_field(&request, "kind").expect("kind"));
    let result =
        match write_loose_object(&tracing, &mut env, &git, kind, content.as_bytes(), format) {
            Ok(oid) => object(vec![("oid", text(&oid.hex()))]),
            Err(error) => {
                let mut fields = vec![("code", text(&error.code))];
                if let Some(syscall) = error.syscall {
                    fields.push(("syscall", text(syscall)));
                }
                if let Some(file) = &error.path {
                    fields.push(("path", text(&relative(&root, file))));
                }
                object(vec![("error", object(fields))])
            }
        };
    let output = object(vec![
        ("result", result),
        ("trace", Value::Array(tracing.trace.into_inner())),
    ]);
    let mut bytes = stringify_utf8(&output)
        .expect("shallow")
        .unwrap_or_default();
    bytes.push(b'\n');
    write_out(&bytes);
    ExitCode::SUCCESS
}

// --- stress and fuzz -------------------------------------------------------

struct Expected {
    oid: Oid,
    kind: String,
    size: u64,
}

fn expected_objects() -> Vec<Expected> {
    stdin_lines()
        .into_iter()
        .map(|line| {
            let line = String::from_utf8(line).expect("expected objects");
            let mut parts = line.split(' ');
            Expected {
                oid: parse_oid(parts.next().expect("id")),
                kind: parts.next().expect("type").to_owned(),
                size: parts.next().expect("size").parse().expect("size"),
            }
        })
        .collect()
}

#[derive(Default)]
struct Counts {
    found: u64,
    wrong: u64,
    absent: u64,
    asked: BTreeMap<&'static str, u64>,
    panics: u64,
}

impl Counts {
    fn record(&mut self, expected: &Expected, answer: Answer<Option<(Kind, u64)>>) {
        match answer {
            Ok(Some((kind, size))) if kind.name() == expected.kind && size == expected.size => {
                self.found += 1
            }
            Ok(Some(_)) => self.wrong += 1,
            Ok(None) => self.absent += 1,
            Err(refused) => *self.asked.entry(refused.reason.code()).or_default() += 1,
        }
    }

    fn json(&self, extra: Vec<(&str, Value)>) -> Vec<u8> {
        let mut asked = JsObject::new();
        for (code, count) in &self.asked {
            asked.insert(JsStr::from(*code), Value::Number(*count as f64));
        }
        let mut fields = vec![
            ("found", Value::Number(self.found as f64)),
            ("wrong", Value::Number(self.wrong as f64)),
            ("absent", Value::Number(self.absent as f64)),
            ("askGit", Value::Object(asked)),
            ("panics", Value::Number(self.panics as f64)),
        ];
        fields.extend(extra);
        let mut bytes = stringify_utf8(&object(fields))
            .expect("shallow")
            .unwrap_or_default();
        bytes.push(b'\n');
        bytes
    }
}

/// Reads every expected object in full (id checked) and by header.
fn read_all(odb: &Odb, expected: &[Expected], counts: &mut Counts) {
    for item in expected {
        counts.record(
            item,
            odb.read_verified(&item.oid)
                .map(|found| found.map(|object| (object.kind, object.data.len() as u64))),
        );
        counts.record(
            item,
            odb.info(&item.oid)
                .map(|found| found.map(|info| (info.kind, info.size))),
        );
    }
}

fn stress(args: &[String]) -> ExitCode {
    let git = arg(args, 2);
    let rounds: u64 = arg(args, 3).parse().expect("rounds");
    let stop = args.get(4);
    let expected = expected_objects();
    let shared = match open(git) {
        Ok(odb) => odb,
        Err(refused) => return ask_exit(&refused),
    };
    let mut counts = Counts::default();
    let mut done = 0u64;
    for round in 0..rounds {
        if stop.is_some_and(|file| std::path::Path::new(file).exists()) {
            break;
        }
        done += 1;
        // A long-lived database (as the ledger keeps one) and a fresh one.
        read_all(&shared, &expected, &mut counts);
        if round % 4 == 0 {
            match open(git) {
                Ok(fresh) => read_all(&fresh, &expected, &mut counts),
                Err(refused) => *counts.asked.entry(refused.reason.code()).or_default() += 1,
            }
        }
    }
    write_out(&counts.json(vec![("rounds", Value::Number(done as f64))]));
    ExitCode::SUCCESS
}

/// mulberry32, as the JavaScript generators use.
struct Random(u32);

impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            (self.next() as usize) % bound
        }
    }
}

fn object_files(git: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![format!("{git}/objects")];
    while let Some(directory) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = format!("{directory}/{}", entry.file_name().to_string_lossy());
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push(file);
            } else {
                files.push(file);
            }
        }
    }
    files.sort();
    files
}

/// One corruption of `data`: bytes flipped, overwritten, inserted or cut,
/// a huge size written over a header, or random bytes.
fn mutate(random: &mut Random, data: &[u8]) -> (Vec<u8>, &'static str) {
    let mut out = data.to_vec();
    let at = random.below(out.len().max(1));
    match random.below(8) {
        0 | 1 => {
            for _ in 0..1 + random.below(4) {
                let index = random.below(out.len().max(1));
                if let Some(byte) = out.get_mut(index) {
                    *byte ^= 1 << random.below(8);
                }
            }
            (out, "flip")
        }
        2 => {
            out.truncate(at);
            (out, "truncate")
        }
        3 => {
            let count = 1 + random.below(64);
            for index in at..(at + count).min(out.len()) {
                out[index] = random.next() as u8;
            }
            (out, "overwrite")
        }
        4 => {
            let count = 1 + random.below(16);
            let bytes: Vec<u8> = (0..count).map(|_| random.next() as u8).collect();
            out.splice(at..at, bytes);
            (out, "insert")
        }
        5 => {
            // Continuation bits and high size bits: a declared size near 2^64.
            for index in at..(at + 10).min(out.len()) {
                out[index] |= 0xff;
            }
            (out, "huge-size")
        }
        6 => {
            let length = random.below(data.len().max(1) * 2 + 1);
            ((0..length).map(|_| random.next() as u8).collect(), "random")
        }
        _ => {
            let cut = random.below(out.len().max(1));
            out.drain(cut..(cut + 1 + random.below(32)).min(out.len()));
            (out, "cut")
        }
    }
}

fn fuzz(args: &[String]) -> ExitCode {
    let git = arg(args, 2);
    let mut random = Random(arg(args, 3).parse().expect("seed"));
    let rounds: u64 = arg(args, 4).parse().expect("rounds");
    let expected = expected_objects();
    let files: Vec<String> = object_files(git)
        .into_iter()
        .filter(|file| !file.ends_with(".bitmap"))
        .collect();
    let options = OdbOptions {
        max_object_bytes: 16 * 1024 * 1024,
        delta_budget_bytes: 64 * 1024 * 1024,
        verify_ids: true,
        ..OdbOptions::default()
    };
    let mut counts = Counts::default();
    let mut kinds: BTreeMap<&'static str, u64> = BTreeMap::new();
    std::panic::set_hook(Box::new(|_| {}));
    for _ in 0..rounds {
        let file = &files[random.below(files.len())];
        let original = std::fs::read(file).expect("object file");
        let (mutated, kind) = mutate(&mut random, &original);
        *kinds.entry(kind).or_default() += 1;
        // Object files are read-only, as Git and the ledger leave them.
        let _ = std::fs::remove_file(file);
        std::fs::write(file, &mutated).expect("mutated file");
        let round = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut local = Counts::default();
            match Odb::open(git, options) {
                Ok(odb) => {
                    read_all(&odb, &expected, &mut local);
                    let _ = odb.all_object_ids();
                }
                Err(refused) => *local.asked.entry(refused.reason.code()).or_default() += 1,
            }
            local
        }));
        match round {
            Ok(local) => {
                counts.found += local.found;
                counts.wrong += local.wrong;
                counts.absent += local.absent;
                for (code, count) in local.asked {
                    *counts.asked.entry(code).or_default() += count;
                }
            }
            Err(_) => counts.panics += 1,
        }
        std::fs::remove_file(file).expect("mutated file");
        std::fs::write(file, &original).expect("restored file");
    }
    let mut mutations = JsObject::new();
    for (kind, count) in kinds {
        mutations.insert(JsStr::from(kind), Value::Number(count as f64));
    }
    write_out(&counts.json(vec![
        ("rounds", Value::Number(rounds as f64)),
        ("files", Value::Number(files.len() as f64)),
        ("mutations", Value::Object(mutations)),
        (
            "peakResidentBytes",
            Value::Number(fs::peak_resident_bytes() as f64),
        ),
    ]));
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match arg(&args, 1) {
        "open" => match open(arg(&args, 2)) {
            Ok(odb) => {
                write_out(format!("ok {}\n", odb.format().name()).as_bytes());
                ExitCode::SUCCESS
            }
            Err(refused) => ask_exit(&refused),
        },
        "batch-all" => batch_all(arg(&args, 2), false),
        "batch-all-check" => batch_all(arg(&args, 2), true),
        mode @ ("batch" | "batch-check") => {
            let odb = match open(arg(&args, 2)) {
                Ok(odb) => odb,
                Err(refused) => return ask_exit(&refused),
            };
            let mut out = Vec::new();
            for line in stdin_lines() {
                batch_line(&mut out, &odb, &line, mode == "batch-check");
            }
            write_out(&out);
            ExitCode::SUCCESS
        }
        "ls-tree" => ls_tree(&args),
        "ls-tree-many" => ls_tree_many(&args),
        "read-ref-many" => read_ref_many(&args),
        "for-each-ref" => for_each_ref(&args),
        "read-ref" => read_ref(&args),
        "write" => write(&args),
        "write-trace" => write_trace(),
        "stress" => stress(&args),
        "fuzz" => fuzz(&args),
        other => {
            eprintln!("odb-probe: unknown mode {other}");
            ExitCode::from(2)
        }
    }
}

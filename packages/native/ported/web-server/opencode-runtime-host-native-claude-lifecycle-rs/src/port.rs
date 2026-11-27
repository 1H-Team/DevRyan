//! The Rust port of `opencode/runtime-host/native-claude-lifecycle.js`: the lifecycle record's
//! parsers, the enrollment capacity check and the transition state machine (6 of 9; the record and
//! grant fingerprints and `hasLegacyClaudeFence` are SHA-256 and stay in JS). Checks run in the
//! source's order so each refusal carries the same code; byte bounds measure the written-out
//! `JSON.stringify`; `structuredClone` of a validated record is the record as given; `===` between
//! objects that crossed the bindings is false (two rows are never the same reference).

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

type Obj = Map<String, Value>;

const PROTOCOL: &str = "devryan.claude-lifecycle/1";
const ACCOUNTS: usize = 64;
const UNRESOLVED: usize = 128;
const BYTES: usize = 61_440;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const BINDING: [&str; 5] = ["profileID", "service", "configDirectory", "enrollmentID", "generation"];
const ACCOUNT: [&str; 7] = [
    "profileID",
    "service",
    "configDirectory",
    "enrollmentID",
    "generation",
    "grantFingerprint",
    "recordFingerprint",
];
const PHASES: [&str; 5] = ["in-flight", "replacement-prepared", "blocked", "enrollment-prepared", "deletion-prepared"];

fn fail<T>(code: &str) -> Result<T, String> {
    Err(code.into())
}

fn invalid<T>() -> Result<T, String> {
    fail(INVALID)
}

const INVALID: &str = "native_claude_lifecycle_invalid";
const CAPACITY: &str = "native_claude_lifecycle_capacity";
const CONFLICT: &str = "native_claude_lifecycle_conflict";
const UNSETTLED: &str = "native_claude_refresh_unsettled";
const TAKEN: &str = "native_claude_enrollment_conflict";
const REQUIRED: &str = "native_claude_enrollment_required";

/// `sameClaudeEnrollment` of two validated rows.
fn enrolled(a: &Value, b: &Value) -> bool {
    BINDING.iter().all(|k| same(&get(a, k), &get(b, k)))
}

fn check(ok: bool, code: &str) -> Result<(), String> {
    if ok { Ok(()) } else { fail(code) }
}

fn marker(v: &Value) -> Option<&str> {
    v.as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.keys().next())
        .map(String::as_str)
        .filter(|k| k.starts_with('$'))
}

/// A non-array object's own keys (`None` when `record()` refuses it).
fn own_keys(v: &Value) -> Option<Vec<String>> {
    match (v, marker(v)) {
        (Value::Object(o), None) => Some(o.keys().cloned().collect()),
        (Value::Object(o), Some("$bytes")) => Some((0..o["$bytes"].as_array().map_or(0, Vec::len)).map(|i| i.to_string()).collect()),
        (Value::Object(_), Some("$utf16" | "$num" | "$undefined" | "$bigint" | "$function")) => None,
        (Value::Object(_), Some(_)) => Some(Vec::new()),
        _ => None,
    }
}

fn get(v: &Value, key: &str) -> Value {
    v.as_object()
        .filter(|_| marker(v).is_none())
        .and_then(|o| o.get(key))
        .cloned()
        .unwrap_or_else(js::undefined)
}

/// `value[key]` where `value` may be `null`/`undefined` (a `TypeError` in JS).
fn read(v: &Value, key: &str) -> Result<Value, String> {
    if v.is_null() || js::is_undefined(v) {
        let shown = if v.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(get(v, key))
}

fn exact(v: &Value, fields: &[&str]) -> Result<(), String> {
    let ok = own_keys(v).is_some_and(|k| k.len() == fields.len() && fields.iter().all(|f| k.iter().any(|x| x == f)));
    if ok { Ok(()) } else { invalid() }
}

fn text(v: &Value) -> bool {
    js::string_units(v).is_some_and(|u| (1..=256).contains(&u.len()) && !u.iter().any(|c| *c <= 0x1f))
}

fn digest(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn safe_int(v: &Value) -> Option<f64> {
    js::as_number(v).filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE)
}

fn is(v: &Value, s: &str) -> bool {
    v.as_str() == Some(s)
}

/// `a === b` across the bindings.
fn same(a: &Value, b: &Value) -> bool {
    match (js::as_number(a), js::as_number(b), js::string_units(a), js::string_units(b)) {
        (Some(x), Some(y), _, _) => x == y,
        (None, None, Some(x), Some(y)) => x == y,
        (None, None, None, None) => (js::is_undefined(a) && js::is_undefined(b)) || (!a.is_object() && !a.is_array() && a == b),
        _ => false,
    }
}

/// Node's POSIX `path.normalize` (a trailing slash kept) over UTF-16 units of an absolute path.
fn normalized(p: &[u16]) -> bool {
    let mut stack: Vec<&[u16]> = Vec::new();
    for seg in p.split(|u| *u == 0x2f) {
        match seg {
            [] | [0x2e] => {}
            [0x2e, 0x2e] => drop(stack.pop()),
            s => stack.push(s),
        }
    }
    let mut out = [&[0x2f][..], &stack.join(&[0x2f][..])].concat();
    if p.last() == Some(&0x2f) && out.len() > 1 {
        out.push(0x2f);
    }
    out == p
}

fn binding(v: &Value) -> Result<(), String> {
    let directory = js::string_units(&get(v, "configDirectory"));
    let service = get(v, "service");
    let suffix_ok = |s: &str| {
        s.strip_prefix("Claude Code-credentials").is_some_and(|r| {
            r.is_empty()
                || r.strip_prefix('-')
                    .is_some_and(|h| h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        })
    };
    let ok = own_keys(v).is_some()
        && ["profileID", "service", "enrollmentID", "generation"].iter().all(|k| text(&get(v, k)))
        && directory.is_some_and(|d| d.len() <= 4096 && !d.iter().any(|c| *c <= 0x1f) && d.first() == Some(&0x2f) && normalized(&d))
        && service.as_str().is_some_and(suffix_ok);
    if ok { Ok(()) } else { invalid() }
}

fn account(v: &Value) -> Result<(), String> {
    binding(v)?;
    check(digest(&get(v, "grantFingerprint")) && digest(&get(v, "recordFingerprint")), INVALID)
}

/// The UTF-8 length of `JSON.stringify(v)`'s text for a string (quotes and escapes included).
fn quoted_len(units: &[u16]) -> usize {
    let one = |c: Result<char, std::char::DecodeUtf16Error>| match c {
        Ok('"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t') => 2,
        Ok(c) if (c as u32) < 0x20 => 6,
        Ok(c) => c.len_utf8(),
        Err(_) => 6,
    };
    2 + char::decode_utf16(units.iter().copied()).map(one).sum::<usize>()
}

/// `Buffer.byteLength(JSON.stringify(v))`, `None` for `undefined` (NaN and infinities print
/// `null`, `-0` prints `0`, a `Map`/`Set` `{}`, a `Date` its ISO text, a typed array its indexes).
fn json_len(v: &Value) -> Result<Option<usize>, String> {
    if js::is_undefined(v) || marker(v) == Some("$function") {
        return Ok(None);
    }
    if let Some(u) = js::string_units(v) {
        return Ok(Some(quoted_len(&u)));
    }
    if let Some(n) = js::as_number(v) {
        return Ok(Some(if n.is_finite() { js::number_to_string(n).len() } else { 4 }));
    }
    let list = |items: Vec<usize>| 2 + items.iter().sum::<usize>() + items.len().saturating_sub(1);
    Ok(Some(match (v, marker(v)) {
        (Value::Null, _) => 4,
        (Value::Bool(b), _) => {
            if *b {
                4
            } else {
                5
            }
        }
        (Value::Array(items), _) => list(items.iter().map(|x| Ok(json_len(x)?.unwrap_or(4))).collect::<Result<_, String>>()?),
        (_, Some("$bigint")) => return Err("Do not know how to serialize a BigInt".into()), // recorded-literal: V8 TypeError text
        (_, Some("$date")) => {
            if is(&v["$date"], "Invalid") {
                4
            } else {
                26
            }
        }
        (_, Some("$map" | "$set")) => 2,
        (Value::Object(o), m) => {
            let pairs: Vec<(String, Value)> = match m {
                Some("$bytes") => o["$bytes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, b)| (i.to_string(), b.clone()))
                    .collect(),
                _ => o.iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
            };
            let mut items = Vec::new();
            for (k, x) in &pairs {
                if let Some(n) = json_len(x)? {
                    items.push(quoted_len(&k.encode_utf16().collect::<Vec<_>>()) + 1 + n);
                }
            }
            list(items)
        }
        _ => 4,
    }))
}

fn byte_length(v: &Value) -> Result<usize, String> {
    Ok(json_len(v)?.unwrap_or(0))
}

fn rows(v: &Value, key: &str) -> Vec<Value> {
    get(v, key).as_array().cloned().unwrap_or_default()
}

fn unique(values: impl Iterator<Item = Value>) -> bool {
    let all: Vec<Value> = values.collect();
    all.iter().enumerate().all(|(i, a)| {
        !all[..i]
            .iter()
            .any(|b| same(a, b) || (js::as_number(a).is_some_and(f64::is_nan) && js::as_number(b).is_some_and(f64::is_nan)))
    })
}

fn device_ok(device: &Value, inode: &Value) -> bool {
    (device.is_null() && inode.is_null()) || [device, inode].iter().all(|x| safe_int(x).is_some_and(|n| n >= 0.0))
}

fn parse_lifecycle(value: &Value) -> Result<Value, String> {
    exact(value, &["protocol", "revision", "accounts", "unresolved"])?;
    let (accounts, unresolved) = (get(value, "accounts"), get(value, "unresolved"));
    let ok = is(&get(value, "protocol"), PROTOCOL)
        && safe_int(&get(value, "revision")).is_some_and(|r| r >= 0.0)
        && accounts.as_array().is_some_and(|a| a.len() <= ACCOUNTS)
        && unresolved.as_array().is_some_and(|u| u.len() <= UNRESOLVED);
    check(ok, INVALID)?;
    check(byte_length(value)? <= BYTES, INVALID)?;
    let (accounts, unresolved) = (rows(value, "accounts"), rows(value, "unresolved"));
    for row in &accounts {
        exact(row, &ACCOUNT)?;
        account(row)?;
    }
    for row in &unresolved {
        let phase = read(row, "phase")?;
        let extra: &[&str] = match phase.as_str() {
            Some("replacement-prepared") => &["replacementRecordFingerprint", "replacementGrantFingerprint"],
            Some("deletion-prepared") => &["incomplete", "directoryDevice", "directoryInode"],
            _ => &[],
        };
        exact(row, &[&ACCOUNT[..], &["attemptID", "phase"], extra].concat())?;
        account(row)?;
        let replacement =
            is(&phase, "replacement-prepared") && (!digest(&get(row, "replacementRecordFingerprint")) || !digest(&get(row, "replacementGrantFingerprint")));
        let deletion =
            is(&phase, "deletion-prepared") && (!get(row, "incomplete").is_boolean() || !device_ok(&get(row, "directoryDevice"), &get(row, "directoryInode")));
        check(
            text(&get(row, "attemptID")) && PHASES.iter().any(|p| is(&phase, p)) && !replacement && !deletion,
            INVALID,
        )?;
    }
    for key in ["profileID", "service", "configDirectory", "enrollmentID", "grantFingerprint"] {
        check(unique(accounts.iter().map(|r| get(r, key))), INVALID)?;
    }
    for key in ["attemptID", "grantFingerprint"] {
        check(unique(unresolved.iter().map(|r| get(r, key))), INVALID)?;
    }
    let prepared: Vec<&Value> = unresolved.iter().filter(|r| is(&get(r, "phase"), "enrollment-prepared")).collect();
    for key in ["profileID", "service", "configDirectory", "enrollmentID"] {
        check(unique(accounts.iter().chain(prepared.iter().copied()).map(|r| get(r, key))), INVALID)?;
    }
    check(accounts.len() + prepared.len() <= ACCOUNTS, CAPACITY)?;
    for (i, left) in unresolved.iter().enumerate() {
        let lr = get(left, "replacementGrantFingerprint");
        let clash = unresolved[i + 1..].iter().any(|right| {
            !js::is_undefined(&lr) && (same(&lr, &get(right, "grantFingerprint")) || same(&lr, &get(right, "replacementGrantFingerprint")))
                || same(&get(right, "replacementGrantFingerprint"), &get(left, "grantFingerprint"))
        });
        check(!clash, INVALID)?;
    }
    Ok(value.clone())
}

fn parse_operation(value: &Value) -> Result<Value, String> {
    check(own_keys(value).is_some(), INVALID)?;
    let kind = get(value, "kind");
    // Per kind: the subject (a full account, or a binding) and the other fields it carries.
    let (subject, extra): (&str, &[&str]) = match kind.as_str().unwrap_or_default() {
        "enroll" => ("account", &[]),
        "begin" | "block-legacy" | "prepare-enrollment" => ("account", &["attemptID"]),
        "prepare-deletion" => ("binding", &["attemptID", "recordFingerprint", "directoryDevice", "directoryInode"]),
        "settle-deletion" | "settle" | "settle-enrollment" => ("binding", &["attemptID", "recordFingerprint"]),
        "prepare" => ("binding", &["attemptID", "recordFingerprint", "grantFingerprint"]),
        "cancel-before-dispatch" => ("binding", &["attemptID"]),
        _ => return invalid(),
    };
    exact(value, &[&["kind", subject][..], extra].concat())?;
    let inner = get(value, subject);
    exact(&inner, if subject == "account" { &ACCOUNT } else { &BINDING })?;
    if subject == "account" {
        account(&inner)?
    } else {
        binding(&inner)?
    }
    let has = |k: &str| extra.contains(&k);
    let device = has("directoryDevice") && !device_ok(&get(value, "directoryDevice"), &get(value, "directoryInode"));
    let ok = (!has("attemptID") || text(&get(value, "attemptID"))) && (!has("recordFingerprint") || digest(&get(value, "recordFingerprint")));
    check(ok && (!has("grantFingerprint") || digest(&get(value, "grantFingerprint"))) && !device, INVALID)?;
    Ok(value.clone())
}

fn same_enrollment(left: &Value, right: &Value) -> Result<bool, String> {
    for key in BINDING {
        if !same(&read(left, key)?, &read(right, key)?) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Port of `sameClaudeEnrollment` (`native-claude-lifecycle.js:46`).
pub fn same_claude_enrollment(left: Value, right: Value) -> Result<Value, String> {
    Ok(same_enrollment(&left, &right)?.into())
}

/// Port of `emptyClaudeLifecycle` (`native-claude-lifecycle.js:47`).
pub fn empty_claude_lifecycle() -> Result<Value, String> {
    Ok(json!({ "protocol": PROTOCOL, "revision": 0, "accounts": [], "unresolved": [] }))
}

fn zeros(n: usize) -> Value {
    "0".repeat(n).into()
}

fn with(base: &Value, extra: &[(&str, Value)]) -> Value {
    let mut out: Obj = base.as_object().cloned().unwrap_or_default();
    for (k, v) in extra {
        out.insert((*k).into(), v.clone());
    }
    Value::Object(out)
}

fn without(base: &Value, removed: &[&str]) -> Value {
    Value::Object(
        base.as_object()
            .into_iter()
            .flatten()
            .filter(|(k, _)| !removed.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

fn renewal(selected: &Value) -> Value {
    with(
        selected,
        &[
            ("attemptID", zeros(36)),
            ("phase", "replacement-prepared".into()),
            ("replacementRecordFingerprint", zeros(64)),
            ("replacementGrantFingerprint", zeros(64)),
        ],
    )
}

fn state_of(revision: Value, accounts: &[Value], unresolved: &[Value]) -> Value {
    json!({ "protocol": PROTOCOL, "revision": revision, "accounts": accounts, "unresolved": unresolved })
}

/// Port of `assertClaudeEnrollmentCapacity` (`native-claude-lifecycle.js:50`).
pub fn assert_claude_enrollment_capacity(value: Value, selected: Value) -> Result<Value, String> {
    let state = parse_lifecycle(&value)?;
    exact(&selected, &BINDING)?;
    binding(&selected)?;
    let (accounts, unresolved) = (rows(&state, "accounts"), rows(&state, "unresolved"));
    let prepared_count = unresolved.iter().filter(|r| is(&get(r, "phase"), "enrollment-prepared")).count();
    let full = safe_int(&get(&state, "revision")) == Some(MAX_SAFE) || accounts.len() + prepared_count >= ACCOUNTS || unresolved.len() >= UNRESOLVED;
    check(!full, CAPACITY)?;
    let row = with(&selected, &[("grantFingerprint", zeros(64)), ("recordFingerprint", zeros(64))]);
    let prepared = with(&row, &[("attemptID", get(&selected, "enrollmentID")), ("phase", "enrollment-prepared".into())]);
    let futures = [
        state_of(js::number(MAX_SAFE), &accounts, &[&unresolved[..], &[prepared]].concat()),
        state_of(
            js::number(MAX_SAFE),
            &[&accounts[..], std::slice::from_ref(&row)].concat(),
            &[&unresolved[..], &[renewal(&row)]].concat(),
        ),
    ];
    for future in &futures {
        check(byte_length(future)? <= BYTES, CAPACITY)?;
    }
    Ok(js::undefined())
}

/// Port of `parseClaudeLifecycle` (`native-claude-lifecycle.js:62`).
pub fn parse_claude_lifecycle(value: Value) -> Result<Value, String> {
    parse_lifecycle(&value)
}

/// Port of `parseClaudeLifecycleOperation` (`native-claude-lifecycle.js:89`).
pub fn parse_claude_lifecycle_operation(value: Value) -> Result<Value, String> {
    parse_operation(&value)
}

/// Port of `transitionClaudeLifecycle` (`native-claude-lifecycle.js:107`).
pub fn transition_claude_lifecycle(value: Value, expected_revision: Value, operation: Value) -> Result<Value, String> {
    let state = parse_lifecycle(&value)?;
    let action = parse_operation(&operation)?;
    let revision = safe_int(&get(&state, "revision")).unwrap_or(0.0);
    check(same(&js::number(revision), &expected_revision) && revision != MAX_SAFE, CONFLICT)?;
    let (mut accounts, mut unresolved) = (rows(&state, "accounts"), rows(&state, "unresolved"));
    let kind = get(&action, "kind").as_str().unwrap_or_default().to_string();
    let attempt = get(&action, "attemptID");
    let blocked = |unresolved: &[Value], grant: &Value| {
        unresolved
            .iter()
            .any(|r| same(&get(r, "grantFingerprint"), grant) || same(&get(r, "replacementGrantFingerprint"), grant))
    };
    let field_eq = |a: &Value, b: &Value, k: &str| same(&get(a, k), &get(b, k));
    match kind.as_str() {
        "enroll" => {
            let selected = get(&action, "account");
            let conflict = blocked(&unresolved, &get(&selected, "grantFingerprint"))
                || accounts.iter().any(|r| {
                    field_eq(r, &selected, "grantFingerprint")
                        || !field_eq(r, &selected, "profileID")
                            && (field_eq(r, &selected, "service") || field_eq(r, &selected, "configDirectory") || field_eq(r, &selected, "enrollmentID"))
                });
            check(!conflict, TAKEN)?;
            match accounts.iter().position(|r| field_eq(r, &selected, "profileID")) {
                None => {
                    check(accounts.len() < ACCOUNTS, CAPACITY)?;
                    accounts.push(selected);
                }
                Some(i) => {
                    check(
                        !field_eq(&accounts[i], &selected, "enrollmentID") && !field_eq(&accounts[i], &selected, "generation"),
                        TAKEN,
                    )?;
                    accounts[i] = selected;
                }
            }
        }
        "begin" | "block-legacy" | "prepare-enrollment" => {
            let acct = get(&action, "account");
            check(
                !blocked(&unresolved, &get(&acct, "grantFingerprint")) && !unresolved.iter().any(|r| same(&get(r, "attemptID"), &attempt)),
                UNSETTLED,
            )?;
            check(unresolved.len() < UNRESOLVED, CAPACITY)?;
            if kind == "begin" {
                let enrolled = accounts
                    .iter()
                    .any(|r| enrolled(r, &acct) && field_eq(r, &acct, "grantFingerprint") && field_eq(r, &acct, "recordFingerprint"));
                check(enrolled, REQUIRED)?;
            }
            if kind == "prepare-enrollment" {
                let prepared = unresolved.iter().filter(|r| is(&get(r, "phase"), "enrollment-prepared")).count();
                check(accounts.len() + prepared < ACCOUNTS, CAPACITY)?;
                let taken = accounts.iter().any(|r| {
                    ["profileID", "service", "configDirectory", "enrollmentID", "grantFingerprint"]
                        .iter()
                        .any(|k| field_eq(r, &acct, k))
                });
                check(!taken, TAKEN)?;
            }
            let phase = match kind.as_str() {
                "begin" => "in-flight",
                "prepare-enrollment" => "enrollment-prepared",
                _ => "blocked",
            };
            unresolved.push(with(&acct, &[("attemptID", attempt.clone()), ("phase", phase.into())]));
        }
        "prepare-deletion" => {
            let bind = get(&action, "binding");
            let selected = accounts.iter().find(|r| enrolled(r, &bind)).cloned();
            let prepared = unresolved
                .iter()
                .position(|r| enrolled(r, &bind) && is(&get(r, "phase"), "enrollment-prepared"));
            let row = selected.clone().or_else(|| prepared.map(|i| unresolved[i].clone()));
            let busy = unresolved
                .iter()
                .enumerate()
                .any(|(i, item)| Some(i) != prepared && (enrolled(item, &bind) || same(&get(item, "attemptID"), &attempt)));
            let Some(row) = row.filter(|r| field_eq(r, &action, "recordFingerprint") && !busy) else {
                return fail(CONFLICT);
            };
            if let Some(i) = prepared {
                unresolved.remove(i);
            }
            check(unresolved.len() < UNRESOLVED, CAPACITY)?;
            let extra = [
                ("attemptID", attempt.clone()),
                ("phase", "deletion-prepared".into()),
                ("incomplete", selected.is_none().into()),
                ("directoryDevice", get(&action, "directoryDevice")),
                ("directoryInode", get(&action, "directoryInode")),
            ];
            unresolved.push(with(&without(&row, &["attemptID", "phase"]), &extra));
        }
        _ => {
            let bind = get(&action, "binding");
            let index = unresolved.iter().position(|r| same(&get(r, "attemptID"), &attempt) && enrolled(r, &bind));
            let Some(index) = index else {
                return fail(CONFLICT);
            };
            let pending = unresolved[index].clone();
            let phase = get(&pending, "phase");
            let record = get(&action, "recordFingerprint");
            match kind.as_str() {
                "settle-deletion" => {
                    check(is(&phase, "deletion-prepared") && same(&get(&pending, "recordFingerprint"), &record), CONFLICT)?;
                    accounts.retain(|r| !enrolled(r, &bind));
                    unresolved.remove(index);
                }
                "settle-enrollment" => {
                    check(
                        is(&phase, "enrollment-prepared") && same(&get(&pending, "recordFingerprint"), &record),
                        CONFLICT,
                    )?;
                    accounts.push(without(&pending, &["attemptID", "phase"]));
                    unresolved.remove(index);
                }
                "prepare" => {
                    let grant = get(&action, "grantFingerprint");
                    let taken = unresolved
                        .iter()
                        .enumerate()
                        .any(|(i, r)| i != index && (same(&get(r, "grantFingerprint"), &grant) || same(&get(r, "replacementGrantFingerprint"), &grant)))
                        || accounts.iter().any(|r| !enrolled(r, &pending) && same(&get(r, "grantFingerprint"), &grant));
                    check(is(&phase, "in-flight") && !taken, UNSETTLED)?;
                    unresolved[index] = with(
                        &pending,
                        &[
                            ("phase", "replacement-prepared".into()),
                            ("replacementRecordFingerprint", record),
                            ("replacementGrantFingerprint", grant),
                        ],
                    );
                }
                "settle" => {
                    let selected = accounts.iter().position(|r| enrolled(r, &bind));
                    let ok = is(&phase, "replacement-prepared") && same(&get(&pending, "replacementRecordFingerprint"), &record);
                    let (true, Some(selected)) = (ok, selected) else {
                        return fail(CONFLICT);
                    };
                    accounts[selected] = with(
                        &accounts[selected],
                        &[
                            ("recordFingerprint", get(&pending, "replacementRecordFingerprint")),
                            ("grantFingerprint", get(&pending, "replacementGrantFingerprint")),
                        ],
                    );
                    unresolved.remove(index);
                }
                _ => {
                    check(is(&phase, "in-flight"), CONFLICT)?;
                    unresolved.remove(index);
                }
            }
        }
    }
    if ["enroll", "prepare-enrollment", "settle-enrollment"].contains(&kind.as_str()) {
        let selected = if kind == "settle-enrollment" {
            accounts.last().cloned().unwrap_or_else(js::undefined)
        } else {
            get(&action, "account")
        };
        let (future_accounts, future_unresolved) = if kind == "prepare-enrollment" {
            (
                [&accounts[..], std::slice::from_ref(&selected)].concat(),
                unresolved.iter().filter(|r| !same(&get(r, "attemptID"), &attempt)).cloned().collect::<Vec<_>>(),
            )
        } else {
            (accounts.clone(), unresolved.clone())
        };
        let probe = state_of(
            js::number(MAX_SAFE),
            &future_accounts,
            &[&future_unresolved[..], &[renewal(&selected)]].concat(),
        );
        check(future_unresolved.len() < UNRESOLVED && byte_length(&probe)? <= BYTES, CAPACITY)?;
    }
    // The record keeps its own key order: `state` is the parsed clone, updated in place.
    let next = with(
        &state,
        &[
            ("revision", js::number(revision + 1.0)),
            ("accounts", Value::Array(accounts)),
            ("unresolved", Value::Array(unresolved)),
        ],
    );
    check(byte_length(&next)? <= BYTES, CAPACITY)?;
    parse_lifecycle(&next)
}

//! `required-checks.js` (`validateRequiredChecks`, `validateRequiredCheckReceipts`,
//! `visualCheckPassed`) and `check-correction.js` (`validateCheckCorrection`,
//! `validateCheckCorrectionHistory`, `applyCheckCorrection`,
//! `isCheckCorrectionTransition`): the validators the ledger codec reaches.

use std::collections::HashSet;

use devryan_js_layer::js::{JsStr, Value};

use crate::error::{Failure, JsResult, coded_type_error, range_error, type_error};
use crate::jsv::{
    EMPTY_ARRAY, UNDEFINED, as_number, as_str, get, is_finite, is_one_of, is_record, is_safe_integer, is_str, json_byte_length, json_equal, keys, nullish_or,
    object, spread, stringify, to_string, truthy,
};
use crate::regex::pattern;
use crate::text::{split_slashes, trim, units};

pattern!(sha256_hex, r"^[a-f0-9]{64}$", false);
pattern!(absolute_path, r"^(?:[\\/]|[a-zA-Z]:)", false);
pattern!(environment_name, r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$", false);
pattern!(
    vitest_edge_command,
    r"^npx vitest run (supabase\/functions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\/__tests__)(?: --maxWorkers=[1-9]\d{0,2})?$",
    false
);
pattern!(edge_function_name, r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$", false);

/// `hash(value)`: a lowercase SHA-256 hex digest.
pub fn hash(value: &Value) -> bool {
    as_str(value).is_some_and(|text| sha256_hex().test(text.units()))
}

/// `text(value, maximum)` of required-checks.js: trimmed non-empty, at most
/// `maximum` UTF-16 units.
fn text(value: &Value, maximum: usize) -> bool {
    as_str(value).is_some_and(|text| !trim(text.units()).is_empty() && text.len() <= maximum)
}

fn has_parent_segment(text: &[u16]) -> bool {
    split_slashes(text).iter().any(|piece| *piece == units("..").as_slice())
}

/// `relativePath(value)`.
fn relative_path(value: &Value) -> bool {
    text(value, 512) && as_str(value).is_some_and(|text| !text.units().contains(&0) && !absolute_path().test(text.units()) && !has_parent_segment(text.units()))
}

/// `new Set(strings).size === strings.length` for an array of strings.
fn unique_strings(items: &[Value]) -> bool {
    let mut seen = HashSet::new();
    items.iter().all(|item| seen.insert(as_str(item)))
}

/// `validateRequiredChecks(value = [])`.
pub fn validate_required_checks(value: &Value) -> JsResult<()> {
    let value = if matches!(value, Value::Undefined) { &EMPTY_ARRAY } else { value };
    let Some(checks) = value.as_array().filter(|checks| checks.len() <= 8) else {
        return type_error("requiredChecks must contain at most eight checks");
    };
    let mut names: HashSet<&JsStr> = HashSet::new();
    for check in checks {
        let paths = get(check, "paths").as_array();
        let path_bad = |entry: &Value| {
            !text(entry, 512)
                || as_str(entry).is_some_and(|entry| entry.units().contains(&0) || absolute_path().test(entry.units()) || has_parent_segment(entry.units()))
        };
        if !is_record(check)
            || !text(get(check, "name"), 128)
            || as_str(get(check, "name")).is_some_and(|name| names.contains(name))
            || !text(get(check, "command"), 2048)
            || paths.is_none_or(|paths| paths.is_empty() || paths.len() > 32 || paths.iter().any(path_bad) || !unique_strings(paths))
        {
            return type_error("Each required check needs a unique name, exact command, and bounded project-relative file paths");
        }
        let cwd = get(check, "cwd");
        if !matches!(cwd, Value::Undefined) && !(is_str(cwd, ".") || relative_path(cwd)) {
            return type_error("Invalid required check working directory");
        }
        let environment = get(check, "environment");
        if !matches!(environment, Value::Undefined) && !environment_name().test(to_string(environment)?.units()) {
            return type_error("Invalid required check environment");
        }
        let purpose = get(check, "purpose");
        let prerequisites = get(check, "prerequisites");
        if (!matches!(purpose, Value::Undefined) && !is_one_of(purpose, &["implementation", "integration", "deployment"]))
            || (!matches!(prerequisites, Value::Undefined)
                && prerequisites
                    .as_array()
                    .is_none_or(|items| items.len() > 16 || items.iter().any(|entry| !text(entry, 128)) || !unique_strings(items)))
        {
            return type_error("Invalid required check purpose or prerequisites");
        }
        let kind = get(check, "kind");
        if !matches!(kind, Value::Undefined) && !is_one_of(kind, &["command", "visual"]) {
            return type_error("Invalid required check kind");
        }
        let visual = get(check, "visual");
        if is_str(kind, "visual")
            && (!is_record(visual)
                || !is_str(get(visual, "state"), "populated")
                || !is_one_of(get(visual, "dataSource"), &["fixture", "live"])
                || !relative_path(get(visual, "reportPath"))
                || get(visual, "assertions")
                    .as_array()
                    .is_none_or(|items| items.is_empty() || items.len() > 32 || items.iter().any(|entry| !text(entry, 256)) || !unique_strings(items)))
        {
            return type_error("Visual checks need populated state, data source, assertions and a project-relative report");
        }
        if !is_str(kind, "visual") && !matches!(visual, Value::Undefined) {
            return type_error("Visual requirements need visual kind");
        }
        names.insert(as_str(get(check, "name")).expect("a checked name"));
    }
    if json_byte_length(value)? > 32 * 1024 {
        return range_error("requiredChecks exceeds 32 KiB");
    }
    Ok(())
}

fn valid_visual_observation(visual: &Value) -> bool {
    let assertions = get(visual, "assertions").as_array();
    let evidence = get(visual, "evidence").as_array();
    let freshness = get(visual, "servedFreshness");
    is_record(visual)
        && is_str(get(visual, "state"), "populated")
        && is_one_of(get(visual, "dataSource"), &["fixture", "live"])
        && hash(get(visual, "reportHash"))
        && assertions.is_some_and(|items| {
            items.len() <= 32
                && items
                    .iter()
                    .all(|entry| is_record(entry) && text(get(entry, "name"), 256) && is_one_of(get(entry, "status"), &["passed", "failed"]))
                && {
                    let mut seen = HashSet::new();
                    items.iter().all(|entry| seen.insert(as_str(get(entry, "name"))))
                }
        })
        && evidence.is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 16
                && items
                    .iter()
                    .all(|entry| is_record(entry) && relative_path(get(entry, "path")) && hash(get(entry, "sha256")))
        })
        && (matches!(freshness, Value::Undefined) || is_one_of(freshness, &["fresh", "unknown", "stale"]))
}

/// `visualCheckPassed(check, visual)` for a validated visual check.
pub fn visual_check_passed(check: &Value, visual: &Value) -> bool {
    let freshness = get(visual, "servedFreshness");
    let declared = get(check, "visual");
    let observed = get(visual, "assertions").as_array().unwrap_or_default();
    let required = get(declared, "assertions").as_array().unwrap_or_default();
    valid_visual_observation(visual)
        && (matches!(freshness, Value::Undefined) || is_str(freshness, "fresh"))
        && as_str(get(visual, "dataSource")) == as_str(get(declared, "dataSource"))
        && observed.len() == required.len()
        && required.iter().all(|name| {
            observed
                .iter()
                .any(|entry| as_str(get(entry, "name")) == as_str(name) && is_str(get(entry, "status"), "passed"))
        })
}

const RECEIPT_STATUSES: [&str; 7] = ["passed", "failed", "not-observed", "pending", "blocked", "skipped", "waived"];
const ENVIRONMENT_REASONS: [&str; 3] = ["docker_daemon_unavailable", "docker_socket_denied", "uid_mapping_unavailable"];

/// `validateRequiredCheckReceipts(receipts = [], checks = [])`.
pub fn validate_required_check_receipts(receipts: &Value, checks: &Value) -> JsResult<()> {
    let receipts = if matches!(receipts, Value::Undefined) { &EMPTY_ARRAY } else { receipts };
    let checks = if matches!(checks, Value::Undefined) { &EMPTY_ARRAY } else { checks };
    validate_required_checks(checks)?;
    let checks = checks.as_array().expect("validated checks");
    let Some(receipts) = receipts.as_array().filter(|receipts| receipts.len() <= checks.len()) else {
        return type_error("Invalid required check receipts");
    };
    let mut seen: HashSet<&JsStr> = HashSet::new();
    for receipt in receipts {
        let name = as_str(get(receipt, "name"));
        let check = checks.iter().find(|entry| name.is_some() && as_str(get(entry, "name")) == name);
        let message_id = get(receipt, "messageId");
        let status = get(receipt, "status");
        let exit_code = get(receipt, "exitCode");
        let content_hash = get(receipt, "contentHash");
        let conflict = get(receipt, "identityConflict");
        let observed_at = get(receipt, "observedAt");
        let Some(check) = check else {
            return type_error("Invalid required check receipt");
        };
        let name = name.expect("a found check's name");
        if seen.contains(name)
            || !text(get(receipt, "callId"), 256)
            || !(text(message_id, 256)
                || (matches!(message_id, Value::Null) && is_str(status, "waived"))
                || (matches!(message_id, Value::Null)
                    && is_one_of(status, &["not-observed", "pending"])
                    && matches!(exit_code, Value::Null)
                    && matches!(content_hash, Value::Null)))
            || !(matches!(conflict, Value::Undefined) || matches!(conflict, Value::Bool(true)))
            || (matches!(conflict, Value::Bool(true)) && !matches!(message_id, Value::Null))
            || !(matches!(exit_code, Value::Null) || is_safe_integer(exit_code))
            || !is_finite(observed_at)
            || as_number(observed_at).is_some_and(|at| at < 0.0)
            || !is_one_of(status, &RECEIPT_STATUSES)
            || !(matches!(content_hash, Value::Null) || hash(content_hash))
            || (is_str(status, "passed") && (as_number(exit_code) != Some(0.0) || !hash(content_hash)))
        {
            return type_error("Invalid required check receipt");
        }
        let unavailable = get(receipt, "environmentUnavailable");
        if !matches!(unavailable, Value::Undefined)
            && (!is_str(status, "skipped")
                || !hash(content_hash)
                || matches!(exit_code, Value::Null)
                || as_number(exit_code) == Some(0.0)
                || !is_record(unavailable)
                || keys(unavailable).iter().any(|key| key != "reason" && key != "hint")
                || !is_one_of(get(unavailable, "reason"), &ENVIRONMENT_REASONS)
                || !text(get(unavailable, "hint"), 512))
        {
            return type_error("Invalid environment-unavailable receipt");
        }
        if is_str(status, "skipped") && !truthy(unavailable) {
            return type_error("Skipped checks require canonical environment-unavailable evidence");
        }
        let waiver = get(receipt, "waiver");
        if is_str(status, "waived")
            && (!is_record(waiver)
                || !is_str(get(waiver, "source"), "authenticated-user")
                || !text(get(waiver, "userId"), 256)
                || !text(get(waiver, "reason"), 2048)
                || !hash(content_hash))
        {
            return type_error("Invalid user waiver receipt");
        }
        if !is_str(status, "waived") && !matches!(waiver, Value::Undefined) {
            return type_error("Waiver cannot accompany another outcome");
        }
        if is_str(get(check, "kind"), "visual") && is_str(status, "passed") && !visual_check_passed(check, get(receipt, "visual")) {
            return type_error("Visual pass requires populated assertion and artifact evidence");
        }
        seen.insert(name);
    }
    Ok(())
}

const CORRECTION_INVALID: &str = "required_check_correction_invalid";
const CORRECTION_LIMIT: &str = "required_check_correction_history_limit";
const CORRECTION_STALE: &str = "required_check_correction_stale";
const CORRECTION_FIELDS: [&str; 7] = [
    "name",
    "previousCommand",
    "command",
    "reason",
    "observedAt",
    "previousReceipt",
    "runnerIdentity",
];
const IDENTITY_FIELDS: [&str; 10] = [
    "kind",
    "packagePath",
    "packageSha256",
    "scriptPath",
    "scriptSha256",
    "functionName",
    "selector",
    "testPath",
    "coverageHash",
    "verifiedBy",
];

fn fail<T>(code: &str) -> JsResult<T> {
    coded_type_error(code, code)
}

/// `parseVitestEdgeCommand(command)`: (functionName, testPath).
fn parse_vitest_edge_command(command: &Value) -> Option<(Vec<u16>, Vec<u16>)> {
    let text = as_str(command)?.units();
    let captures = vitest_edge_command().exec(text)?;
    let (test_start, test_end) = captures[1].expect("group 1");
    let (name_start, name_end) = captures[2].expect("group 2");
    Some((text[name_start..name_end].to_vec(), text[test_start..test_end].to_vec()))
}

/// `correctedEdgeCommand(functionName)`.
fn corrected_edge_command(function_name: &[u16]) -> JsResult<Vec<u16>> {
    if !edge_function_name().test(function_name) {
        return fail(CORRECTION_INVALID);
    }
    let mut command = units("npm run test:edge -- --function ");
    command.extend_from_slice(function_name);
    Ok(command)
}

/// `Object.keys(value).sort().join()`.
fn sorted_keys_joined(value: &Value) -> Vec<u16> {
    let mut names = keys(value);
    names.sort();
    names.iter().map(|key| key.units().to_vec()).collect::<Vec<_>>().join(&u16::from(b','))
}

/// `validateCheckCorrection(correction, check)` (its frozen copy is the
/// correction itself; nothing here can observe the freeze).
pub fn validate_check_correction(correction: &Value, check: &Value) -> JsResult<()> {
    validate_required_checks(&Value::Array(vec![check.clone()]))?;
    let source = parse_vitest_edge_command(get(check, "command"));
    let identity = get(correction, "runnerIdentity");
    let mut identity_target: Vec<&str> = IDENTITY_FIELDS.to_vec();
    identity_target.sort_unstable();
    let identity_target = units(&identity_target.join(","));
    let invalid = !is_record(correction)
        || keys(correction).iter().any(|key| !CORRECTION_FIELDS.iter().any(|field| key == field))
        || match &source {
            None => true,
            Some((function_name, test_path)) => {
                let function_path = [units("supabase/functions/"), function_name.clone()].concat();
                let mut nested = function_path.clone();
                nested.push(u16::from(b'/'));
                is_str(get(check, "kind"), "visual")
                    || as_str(get(correction, "name")) != as_str(get(check, "name"))
                    || as_str(get(correction, "previousCommand")) != as_str(get(check, "command"))
                    || as_str(get(correction, "command")).map(JsStr::units) != Some(corrected_edge_command(function_name)?.as_slice())
                    || !is_str(get(correction, "reason"), "repository_edge_deno_runner")
                    || !is_finite(get(correction, "observedAt"))
                    || as_number(get(correction, "observedAt")).is_some_and(|at| at < 0.0)
                    || !is_record(identity)
                    || sorted_keys_joined(identity) != identity_target
                    || !is_str(get(identity, "kind"), "edge-deno-function-v1")
                    || !is_str(get(identity, "packagePath"), "package.json")
                    || !is_str(get(identity, "scriptPath"), "scripts/testing/run-deno-tests.mjs")
                    || !is_str(get(identity, "selector"), "--function")
                    || as_str(get(identity, "functionName")).map(JsStr::units) != Some(function_name.as_slice())
                    || as_str(get(identity, "testPath")).map(JsStr::units) != Some(test_path.as_slice())
                    || !is_str(get(identity, "verifiedBy"), "host-policy")
                    || !hash(get(identity, "packageSha256"))
                    || !hash(get(identity, "scriptSha256"))
                    || !hash(get(identity, "coverageHash"))
                    || get(check, "paths").as_array().unwrap_or_default().iter().any(|path| {
                        let path = as_str(path).map(JsStr::units).unwrap_or_default();
                        path != function_path.as_slice() && !path.starts_with(&nested)
                    })
            }
        };
    if invalid {
        return fail(CORRECTION_INVALID);
    }
    let previous_receipt = get(correction, "previousReceipt");
    if !matches!(previous_receipt, Value::Undefined) {
        validate_required_check_receipts(&Value::Array(vec![previous_receipt.clone()]), &Value::Array(vec![check.clone()]))?;
    }
    Ok(())
}

/// `const { previousCheck, ...correction } = entry`.
fn split_previous_check(entry: &Value) -> (Value, Value) {
    let mut rest = spread(entry);
    let previous = rest.remove(&JsStr::from("previousCheck")).unwrap_or(Value::Undefined);
    (previous, Value::Object(rest))
}

/// `validateCheckCorrectionHistory(history = [])`.
pub fn validate_check_correction_history(history: &Value) -> JsResult<()> {
    let history = if matches!(history, Value::Undefined) { &EMPTY_ARRAY } else { history };
    let Some(entries) = history.as_array().filter(|entries| entries.len() <= 128) else {
        return fail(CORRECTION_LIMIT);
    };
    if json_byte_length(history)? > 256 * 1024 {
        return fail(CORRECTION_LIMIT);
    }
    for entry in entries {
        if !is_record(entry) {
            return fail(CORRECTION_INVALID);
        }
        let (previous_check, correction) = split_previous_check(entry);
        validate_check_correction(&correction, &previous_check)?;
    }
    Ok(())
}

/// `applyCheckCorrection({ checks = [], receipts = [], history = [] }, correction)`:
/// `{ checks, receipts, history }`.
pub fn apply_check_correction(checks: &Value, receipts: &Value, history: &Value, correction: &Value) -> JsResult<Value> {
    let checks = if matches!(checks, Value::Undefined) { &EMPTY_ARRAY } else { checks };
    let receipts = if matches!(receipts, Value::Undefined) { &EMPTY_ARRAY } else { receipts };
    let history = if matches!(history, Value::Undefined) { &EMPTY_ARRAY } else { history };
    validate_required_check_receipts(receipts, checks)?;
    validate_check_correction_history(history)?;
    let history_items = history.as_array().expect("validated history");
    if history_items.len() >= 128 {
        return fail(CORRECTION_LIMIT);
    }
    let check_items = checks.as_array().expect("validated checks");
    let wanted = as_str(get(correction, "name"));
    let Some(previous_check) = check_items.iter().find(|check| wanted.is_some() && as_str(get(check, "name")) == wanted) else {
        return fail(CORRECTION_STALE);
    };
    if as_str(get(previous_check, "command")) != as_str(get(correction, "previousCommand")) {
        return fail(CORRECTION_STALE);
    }
    let receipt_items = receipts.as_array().expect("validated receipts");
    let previous_name = as_str(get(previous_check, "name"));
    let previous_receipt = receipt_items.iter().find(|receipt| as_str(get(receipt, "name")) == previous_name);
    if stringify(nullish_or(get(correction, "previousReceipt"), &Value::Null))? != stringify(previous_receipt.unwrap_or(&Value::Null))? {
        return fail(CORRECTION_STALE);
    }
    validate_check_correction(correction, previous_check)?;
    let next_checks: Vec<Value> = check_items
        .iter()
        .map(|check| {
            if as_str(get(check, "name")) == previous_name {
                let mut copy = spread(check);
                copy.set("command", get(correction, "command").clone());
                Value::Object(copy)
            } else {
                check.clone()
            }
        })
        .collect();
    let mut appended = spread(correction);
    appended.set("previousCheck", previous_check.clone());
    let mut next_history = history_items.to_vec();
    next_history.push(Value::Object(appended));
    let next_history = Value::Array(next_history);
    validate_check_correction_history(&next_history)?;
    let next_receipts: Vec<Value> = receipt_items
        .iter()
        .filter(|receipt| as_str(get(receipt, "name")) != previous_name)
        .cloned()
        .collect();
    Ok(object(vec![
        ("checks", Value::Array(next_checks)),
        ("receipts", Value::Array(next_receipts)),
        ("history", next_history),
    ]))
}

/// `isCheckCorrectionTransition(previous, next)` for a validated `previous`.
/// Its `catch` turns a JavaScript throw into `false`; a refusal stays one.
pub fn is_check_correction_transition(previous: &Value, next: &Value) -> JsResult<bool> {
    let prior = nullish_or(get(previous, "requiredCheckCorrections"), &EMPTY_ARRAY);
    let history = nullish_or(get(next, "requiredCheckCorrections"), &EMPTY_ARRAY);
    let prior_items = prior.as_array().unwrap_or_default();
    let history_items = match history {
        Value::Array(items) => items,
        // `history.slice` is not a function: the JavaScript throws there.
        Value::Object(object) if object.get_str("length").is_some() => return crate::error::unsupported("a correction history object with a length"),
        // A string's JSON never equals an array's; nothing else has a length.
        _ => return Ok(false),
    };
    if history_items.len() != prior_items.len() + 1 || !json_equal(&Value::Array(history_items[..history_items.len() - 1].to_vec()), prior)? {
        return Ok(false);
    }
    let attempt = || -> JsResult<bool> {
        let last = history_items.last().expect("a last entry");
        if matches!(last, Value::Null | Value::Undefined) {
            return type_error("Cannot destructure the last correction");
        }
        let (previous_check, correction) = split_previous_check(last);
        let wanted = as_str(get(&correction, "name"));
        let declared = get(previous, "requiredChecks")
            .as_array()
            .and_then(|checks| checks.iter().find(|check| wanted.is_some() && as_str(get(check, "name")) == wanted))
            .unwrap_or(&UNDEFINED);
        if !json_equal(&previous_check, declared)? {
            return Ok(false);
        }
        let applied = apply_check_correction(get(previous, "requiredChecks"), get(previous, "requiredCheckReceipts"), prior, &correction)?;
        Ok(json_equal(get(&applied, "checks"), get(next, "requiredChecks"))?
            && json_equal(get(&applied, "receipts"), get(next, "requiredCheckReceipts"))?
            && json_equal(get(&applied, "history"), history)?)
    };
    match attempt() {
        Ok(result) => Ok(result),
        Err(Failure::Throw(_)) => Ok(false),
        Err(refusal) => Err(refusal),
    }
}

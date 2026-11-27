//! `packages/ui/src/lib/sessionDiffStats.ts` (family `session-diff-stats`; inlined by `live-aggregate`).

use crate::js::{Js, Obj, Str, Value, error, get, get_key_opt, get_opt, iterate, math_max, number, own_keys, s, spread, truthy};
use crate::plant;

pub const EXPORTS: &[&str] = &[
    "getScopedMessageDiffTotals",
    "getSessionSummaryDiffTotals",
    "normalizeChatOwnedDiffSummary",
    "parseSessionDiffCount",
    "resolveSessionDiffStats",
    "resolveTouchedFileWorkingTreeDiffStats",
    "stripUntrustedSessionDiffSummary",
];

pub fn call(_ctx: &mut crate::ctx::Ctx<'_>, export: &str, args: &[Value]) -> Option<Js> {
    let (first, second) = (super::arg(args, 0), super::arg(args, 1));
    Some(match export {
        "parseSessionDiffCount" => Ok(Value::Number(parse_session_diff_count(&first))),
        "getSessionSummaryDiffTotals" => get_session_summary_diff_totals(&first).map(totals_object),
        "resolveSessionDiffStats" => resolve_session_diff_stats(&first).map(|stats| stats.map_or(Value::Null, totals_object)),
        "resolveTouchedFileWorkingTreeDiffStats" => {
            resolve_touched_file_working_tree_diff_stats(&first, &second).map(|stats| stats.map_or(Value::Null, totals_object))
        }
        "getScopedMessageDiffTotals" => get_scoped_message_diff_totals(&first).map(totals_object),
        "stripUntrustedSessionDiffSummary" => strip_untrusted_session_diff_summary(&first),
        "normalizeChatOwnedDiffSummary" => strip_untrusted_session_diff_summary(&first),
        _ => return None,
    })
}

/// `{ additions, deletions }`.
pub fn totals_object((additions, deletions): (f64, f64)) -> Value {
    Value::Object(Obj::object_from(vec![
        (s("additions"), Value::Number(additions)),
        (s("deletions"), Value::Number(deletions)),
    ]))
}

pub fn parse_session_diff_count(value: &Value) -> f64 {
    match value {
        Value::Number(number) if number.is_finite() => {
            if plant::on("session-diff-stats-negative-kept") {
                *number
            } else {
                math_max(0.0, *number)
            }
        }
        Value::String(_) if plant::on("session-diff-stats-string-unparsed") => 0.0,
        Value::String(text) => {
            let parsed = number::from_string(text);
            if parsed.is_finite() { math_max(0.0, parsed) } else { 0.0 }
        }
        Value::Bool(true) if plant::on("session-diff-stats-true-counts") => 1.0,
        _ => 0.0,
    }
}

fn sum_diffs(diffs: &Value, expression: &str) -> Js<(f64, f64)> {
    let (mut additions, mut deletions) = (0.0, 0.0);
    for diff in iterate(diffs, expression)? {
        additions += parse_session_diff_count(&get(&diff, "additions", "diff.additions")?);
        if !plant::on("session-diff-stats-deletions-ignored") {
            deletions += parse_session_diff_count(&get(&diff, "deletions", "diff.deletions")?);
        }
    }
    Ok((additions, deletions))
}

/// `summary.diffs ?? []` (an empty list for `null` and `undefined`).
fn diffs_or_empty(summary: &Value) -> Value {
    let diffs = get_opt(summary, "diffs");
    if diffs.is_nullish() { Value::Object(Obj::array(Vec::new())) } else { diffs }
}

pub fn get_session_summary_diff_totals(summary: &Value) -> Js<(f64, f64)> {
    if !truthy(summary) {
        return Ok((0.0, 0.0));
    }
    let additions = get(summary, "additions", "summary.additions")?;
    let deletions = get(summary, "deletions", "summary.deletions")?;
    let scalar = if plant::on("session-diff-stats-totals-need-both") {
        !matches!(additions, Value::Undefined) && !matches!(deletions, Value::Undefined)
    } else {
        !matches!(additions, Value::Undefined) || !matches!(deletions, Value::Undefined)
    };
    if scalar {
        return Ok((parse_session_diff_count(&additions), parse_session_diff_count(&deletions)));
    }
    sum_diffs(&diffs_or_empty(summary), "summary.diffs ?? []")
}

pub fn get_scoped_message_diff_totals(summary: &Value) -> Js<(f64, f64)> {
    if plant::on("session-diff-stats-scoped-trusts-totals") {
        return get_session_summary_diff_totals(summary);
    }
    sum_diffs(&diffs_or_empty(summary), "summary?.diffs ?? []")
}

pub fn resolve_session_diff_stats(summary: &Value) -> Js<Option<(f64, f64)>> {
    let stats = get_scoped_message_diff_totals(summary)?;
    Ok(if stats.0 == 0.0 && stats.1 == 0.0 { None } else { Some(stats) })
}

/// `value.replace(/\\/g, '/').replace(/^\.\//, '')`.
fn normalize_session_diff_path(value: &Value) -> Js<Str> {
    let Value::String(text) = value else {
        return Err(error(
            "TypeError",
            "client-engine: value.replace of a value that is no string is not reproduced",
        ));
    };
    let slash = u16::from(b'/');
    let forward: Vec<u16> = text
        .iter()
        .map(|unit| {
            if *unit == u16::from(b'\\')
                && !plant::on("session-diff-stats-backslash-kept")
                && !(plant::on("rv-sds-first-backslash-only")
                    && text.iter().position(|unit| *unit == u16::from(b'\\')) != text.iter().position(|other| std::ptr::eq(other, unit)))
            {
                slash
            } else {
                *unit
            }
        })
        .collect();
    let mut rest = if forward.len() >= 2 && forward[0] == u16::from(b'.') && forward[1] == slash {
        &forward[2..]
    } else {
        &forward[..]
    };
    while plant::on("rv-sds-strip-all-dot-slash") && rest.len() >= 2 && rest[0] == u16::from(b'.') && rest[1] == slash {
        rest = &rest[2..];
    }
    Ok(rest.into())
}

pub fn resolve_touched_file_working_tree_diff_stats(touched_files: &Value, diff_stats: &Value) -> Js<Option<(f64, f64)>> {
    let (mut additions, mut deletions) = (0.0, 0.0);
    for file in iterate(touched_files, "touchedFiles")? {
        // `diffStats?.[normalizeSessionDiffPath(file)]`: a nullish `diffStats` short-circuits before the key is
        // computed (the C0i review's S3), so a file that is no string throws only when there are stats to read.
        let stats = if diff_stats.is_nullish() {
            Value::Undefined
        } else {
            get_key_opt(diff_stats, &normalize_session_diff_path(&file)?)
        };
        additions += parse_session_diff_count(&get_opt(
            &stats,
            if plant::on("session-diff-stats-additions-key") {
                "additions"
            } else {
                "insertions"
            },
        ));
        deletions += parse_session_diff_count(&get_opt(&stats, "deletions"));
    }
    Ok(if additions == 0.0 && deletions == 0.0 {
        None
    } else {
        Some((additions, deletions))
    })
}

pub fn strip_untrusted_session_diff_summary(target: &Value) -> Js {
    let summary = get(target, "summary", "target.summary")?;
    if !truthy(&summary) {
        return Ok(target.clone());
    }
    let next = spread(&summary);
    let before_keys = own_keys(&next).len();
    for key in ["additions", "deletions", "files", "diffs"] {
        if key == "files" && plant::on("session-diff-stats-files-kept") {
            continue;
        }
        next.borrow_mut().props.remove(&s(key));
    }
    let after_keys = own_keys(&next).len();
    if after_keys == before_keys {
        return Ok(if plant::on("session-diff-stats-unchanged-copied") {
            Value::Object(spread(target))
        } else {
            target.clone()
        });
    }
    if after_keys > 0 {
        let result = spread(target);
        result.borrow_mut().props.set(s("summary"), Value::Object(next));
        return Ok(Value::Object(result));
    }
    // `const { summary: _summary, ...withoutSummary } = target`.
    let result = spread(target);
    result.borrow_mut().props.remove(&s("summary"));
    Ok(Value::Object(result))
}

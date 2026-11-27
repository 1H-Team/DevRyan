//! The Rust port of `part-delta.ts`. Text is handled as UTF-16 code units, as JS indexes it
//! (slices may split a surrogate pair, and the result then crosses as a lone-surrogate string).
//! The `syncDebug` calls only log when the browser flag is set, so they have no port. The
//! regular expressions are matched by hand: `\s` and `trim` are JS whitespace (U+FEFF and the
//! line separators, not U+0085), `.` is any code unit but a line terminator.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

type Units = Vec<u16>;

const MIN_PARTIAL_DEDUPE_OVERLAP: usize = 5;
const MIN_FULL_FRAME_DUPLICATE_LENGTH: usize = 32;
const MAX_JAMMED_DUPLICATE_SCAN_LENGTH: usize = 2_048;
const MALFORMED: &str = "Skipped malformed tool call \"";
const LOOP_GUARD: &str = "Tool loop guard stopped repeated schema-invalid calls to \"";

fn u(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// A string argument as code units (`None` for `undefined` and `null`).
fn text_of(value: &Value) -> Option<Units> {
    js::string_units(value)
}

fn out(units: &[u16]) -> Value {
    js::utf16_string(units)
}

fn is_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|u| !is_space(*u)).unwrap_or(units.len());
    let end = units.iter().rposition(|u| !is_space(*u)).map_or(start, |i| i + 1);
    &units[start..end.max(start)]
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    (from..=hay.len().checked_sub(needle.len())?).find(|&i| hay[i..].starts_with(needle))
}

fn contains(hay: &[u16], needle: &str) -> bool {
    index_of(hay, &u(needle), 0).is_some()
}

/// `value.lastIndexOf(unit, from)`.
fn last_unit(hay: &[u16], unit: u16, from: usize) -> Option<usize> {
    hay.get(..=from.min(hay.len().checked_sub(1)?))?.iter().rposition(|x| *x == unit)
}

/// Port of `appendNonOverlappingDelta` (`part-delta.ts:21`).
pub fn append_non_overlapping_delta(existing_value: Value, delta: Value, context: Value) -> Result<Value, String> {
    let _ = context;
    let existing = text_of(&existing_value).unwrap_or_default();
    let delta = text_of(&delta).unwrap_or_default();
    if existing.is_empty() || delta.is_empty() {
        return Ok(out(&[existing.as_slice(), &delta].concat()));
    }
    if existing.ends_with(&delta) {
        return Ok(out(&existing));
    }
    let max_overlap = existing.len().min(delta.len() - 1);
    let overlap = (MIN_PARTIAL_DEDUPE_OVERLAP..=max_overlap)
        .rev()
        .find(|&o| existing.ends_with(&delta[..o]))
        .unwrap_or(0);
    Ok(out(&[existing.as_slice(), &delta[overlap..]].concat()))
}

fn meaningful(units: &[u16]) -> bool {
    trim(units).len() >= MIN_FULL_FRAME_DUPLICATE_LENGTH
}

/// `splitLineRecords`: (content, separator) pairs.
fn split_lines(value: &[u16]) -> Vec<(Units, Units)> {
    let mut records = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let Some(newline) = index_of(value, &[10], start) else {
            records.push((value[start..].to_vec(), Vec::new()));
            break;
        };
        let separator_start = if newline > start && value[newline - 1] == 13 { newline - 1 } else { newline };
        records.push((value[start..separator_start].to_vec(), value[separator_start..=newline].to_vec()));
        start = newline + 1;
    }
    records
}

fn collapse_line_repeats(value: &[u16]) -> Units {
    let records = split_lines(value);
    let mut output = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < records.len() {
        let (content, separator) = &records[index];
        if let Some((next_content, next_separator)) = records.get(index + 1)
            && meaningful(content)
            && trim(content) == trim(next_content)
        {
            output.extend(content);
            output.extend(if next_separator.is_empty() { separator } else { next_separator });
            index += 2;
            continue;
        }
        output.extend(content);
        output.extend(separator);
        index += 1;
    }
    output
}

fn collapse_jammed_repeats(value: &[u16]) -> Units {
    let mut output = value.to_vec();
    if output.len() > MAX_JAMMED_DUPLICATE_SCAN_LENGTH {
        return output;
    }
    let mut changed = true;
    while changed {
        changed = false;
        for start in 0..output.len() {
            let max_length = (output.len() - start) / 2;
            if max_length < MIN_FULL_FRAME_DUPLICATE_LENGTH {
                break;
            }
            let lead = output[start];
            let mut second = last_unit(&output, lead, start + max_length);
            while let Some(second_start) = second.filter(|s| *s >= start + MIN_FULL_FRAME_DUPLICATE_LENGTH) {
                let length = second_start - start;
                if output[start..second_start] == output[second_start..second_start + length] && meaningful(&output[start..second_start]) {
                    output.drain(second_start..second_start + length);
                    changed = true;
                    break;
                }
                second = last_unit(&output, lead, second_start - 1);
            }
            if changed {
                break;
            }
        }
    }
    output
}

fn collapse(value: &[u16]) -> Units {
    if value.len() < MIN_FULL_FRAME_DUPLICATE_LENGTH * 2 {
        return value.to_vec();
    }
    collapse_jammed_repeats(&collapse_line_repeats(value))
}

/// Port of `collapseExactAdjacentTextRepeats` (`part-delta.ts:150`).
pub fn collapse_exact_adjacent_text_repeats(value: Value) -> Result<Value, String> {
    Ok(out(&collapse(&text_of(&value).unwrap_or_default())))
}

fn strip_malformed(value: &[u16]) -> Units {
    let (marker, blocked, guard) = (u(MALFORMED), u("Tool \""), u(LOOP_GUARD));
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < value.len() {
        let Some(start) = index_of(value, &marker, cursor) else {
            output.extend(&value[cursor..]);
            break;
        };
        output.extend(&value[cursor..start]);
        let from = start + marker.len();
        let line = index_of(value, &[10], from).map(|n| n + 1);
        let candidates = [
            index_of(value, &marker, from),
            index_of(value, &blocked, from),
            index_of(value, &guard, from),
            line,
        ];
        cursor = candidates.into_iter().flatten().min().unwrap_or(value.len());
    }
    output
}

/// Matches `"[^"]+"<middle>\d+<tail>` at `at` (after the literal head), returning its end.
fn quoted_then_digits(value: &[u16], at: usize, middle: &str, tail: &[&str]) -> Option<usize> {
    let close = at + value.get(at..)?.iter().position(|x| *x == u16::from(b'"'))?;
    if close == at {
        return None;
    }
    let mut at = close;
    for (index, literal) in std::iter::once(middle).chain(tail.iter().copied()).enumerate() {
        let lit = u(literal);
        if !value.get(at..)?.starts_with(&lit) {
            return None;
        }
        at += lit.len();
        if index < tail.len() {
            let digits = value[at..].iter().take_while(|x| (u16::from(b'0')..=u16::from(b'9')).contains(x)).count();
            if digits == 0 {
                return None;
            }
            at += digits;
        }
    }
    Some(at)
}

/// `value.replace(/\s*<head>"[^"]+"<middle>\d+<tail...>/g, "")`.
fn remove_diagnostic(value: &[u16], head: &str, middle: &str, tail: &[&str]) -> Units {
    let head = u(head);
    let mut output = Vec::with_capacity(value.len());
    let (mut copied, mut search) = (0, 0);
    while let Some(found) = index_of(value, &head, search) {
        match quoted_then_digits(value, found + head.len(), middle, tail) {
            Some(end) => {
                let mut begin = found;
                while begin > copied && is_space(value[begin - 1]) {
                    begin -= 1;
                }
                output.extend(&value[copied..begin]);
                copied = end;
                search = end;
            }
            None => search = found + 1,
        }
    }
    output.extend(&value[copied..]);
    output
}

/// `cleanupDiagnosticWhitespace`.
fn cleanup(value: &[u16]) -> Units {
    let mut spaced = Vec::with_capacity(value.len());
    let mut pending = Vec::new();
    for &unit in value {
        match unit {
            0x20 | 0x09 => pending.push(unit),
            10 => {
                pending.clear();
                spaced.push(unit);
            }
            _ => {
                spaced.append(&mut pending);
                spaced.push(unit);
            }
        }
    }
    spaced.append(&mut pending);
    let mut joined: Units = Vec::with_capacity(spaced.len());
    let mut run = 0;
    for &unit in &spaced {
        run = if unit == 10 { run + 1 } else { 0 };
        if run <= 2 {
            joined.push(unit);
        }
    }
    trim(&joined).to_vec()
}

fn strip_internal(value: &[u16]) -> Units {
    if !contains(value, MALFORMED)
        && !contains(value, "has been temporarily blocked after")
        && !contains(value, "Tool loop guard stopped repeated schema-invalid calls")
    {
        return value.to_vec();
    }
    let blocked_tail = [" repeated validation failures. Do not retry this tool. Use a different approach to complete the task."];
    let stripped = remove_diagnostic(&strip_malformed(value), "Tool \"", "\" has been temporarily blocked after ", &blocked_tail);
    let guard_tail = [" attempts (limit ", "). Adjust tool arguments and retry."];
    let stripped = remove_diagnostic(&stripped, LOOP_GUARD, "\" after ", &guard_tail);
    if stripped == value { value.to_vec() } else { cleanup(&stripped) }
}

/// Port of `stripInternalToolRunnerDiagnostics` (`part-delta.ts:209`).
pub fn strip_internal_tool_runner_diagnostics(value: Value) -> Result<Value, String> {
    Ok(out(&strip_internal(&text_of(&value).unwrap_or_default())))
}

/// Strips `literal`, then an optional backtick, for the hand-matched cursor patterns.
fn eat<'a>(rest: &'a str, parts: &[&str]) -> Option<&'a str> {
    let mut rest = rest;
    for part in parts {
        rest = match *part {
            "`?" => rest.strip_prefix('`').unwrap_or(rest),
            "'" => rest.strip_prefix('\'').or_else(|| rest.strip_prefix('\u{2019}'))?,
            literal => rest.strip_prefix(literal)?,
        };
    }
    Some(rest)
}

/// `CURSOR_ASSISTANT_TOOL_WORKAROUND_PATTERNS.some((p) => p.test(value.trim()))`.
fn cursor_workaround_line(content: &[u16]) -> bool {
    let line = String::from_utf16_lossy(trim(content));
    let first = [
        "The ",
        "`?",
        "edit",
        "`?",
        " tool is blocked, so I",
        "'",
        "ll use ",
        "`?",
        "Write",
        "`?",
        " and ",
        "`?",
        "StrReplace",
        "`?",
        " to ",
    ];
    let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let first_match = eat(&line, &first).is_some_and(|rest| rest.ends_with(['.', '!', '?']) && !rest.contains(terminator));
    let second = [
        "Continuing with ",
        "`?",
        "Write",
        "`?",
        " and ",
        "`?",
        "StrReplace",
        "`?",
        " since ",
        "`?",
        "edit",
        "`?",
        " is blocked.",
    ];
    !line.is_empty() && (first_match || eat(&line, &second) == Some(""))
}

fn strip_cursor_lines(value: &[u16]) -> Units {
    if !(contains(value, "edit") && contains(value, "StrReplace")) {
        return value.to_vec();
    }
    let mut changed = false;
    let mut output = Vec::new();
    for (content, separator) in split_lines(value) {
        if cursor_workaround_line(&content) {
            changed = true;
            continue;
        }
        output.extend(content);
        output.extend(separator);
    }
    if changed { cleanup(&output) } else { value.to_vec() }
}

fn visible(value: &[u16]) -> Units {
    strip_cursor_lines(&strip_internal(&collapse(value)))
}

/// Port of `normalizeAssistantVisibleText` (`part-delta.ts:261`).
pub fn normalize_assistant_visible_text(value: Value) -> Result<Value, String> {
    Ok(out(&visible(&text_of(&value).unwrap_or_default())))
}

/// Port of `normalizeAssistantReasoningText` (`part-delta.ts:267`).
pub fn normalize_assistant_reasoning_text(value: Value) -> Result<Value, String> {
    Ok(out(&strip_internal(&collapse(&text_of(&value).unwrap_or_default()))))
}

/// Port of `normalizeAssistantPartText` (`part-delta.ts:271`).
pub fn normalize_assistant_part_text(value: Value, part_type: Option<String>) -> Result<Value, String> {
    if part_type.as_deref() == Some("reasoning") {
        normalize_assistant_reasoning_text(value)
    } else {
        normalize_assistant_visible_text(value)
    }
}

/// `streamingRepeatTailStart`.
fn tail_start(value: &[u16]) -> usize {
    match last_unit(value, 10, value.len()) {
        Some(last) if last > 0 => last_unit(value, 10, last - 1).map_or(0, |i| i + 1),
        _ => 0,
    }
}

fn full_frame_replay(existing: &[u16], delta: &[u16]) -> bool {
    delta.len() >= MIN_FULL_FRAME_DUPLICATE_LENGTH && existing.ends_with(delta)
}

fn text_delta(existing: Units, delta: &[u16]) -> Units {
    if delta.is_empty() || full_frame_replay(&existing, delta) {
        return existing;
    }
    if existing.is_empty() {
        return collapse(delta);
    }
    let combined = [existing.as_slice(), delta].concat();
    if combined.len() <= MAX_JAMMED_DUPLICATE_SCAN_LENGTH {
        return collapse(&combined);
    }
    let start = tail_start(&existing);
    let collapsed = collapse_line_repeats(&combined[start..]);
    if collapsed.len() == combined.len() - start {
        combined
    } else {
        [&existing[..start], collapsed.as_slice()].concat()
    }
}

/// Port of `appendStreamingTextDelta` (`part-delta.ts:295`).
pub fn append_streaming_text_delta(existing_value: Value, delta: Value) -> Result<Value, String> {
    let existing = text_of(&existing_value).unwrap_or_default();
    Ok(out(&text_delta(existing, &text_of(&delta).unwrap_or_default())))
}

fn output_delta(existing: Units, delta: &[u16]) -> Units {
    if delta.is_empty() || full_frame_replay(&existing, delta) {
        existing
    } else {
        [existing.as_slice(), delta].concat()
    }
}

/// Port of `appendStreamingOutputDelta` (`part-delta.ts:321`).
pub fn append_streaming_output_delta(existing_value: Value, delta: Value) -> Result<Value, String> {
    let existing = text_of(&existing_value).unwrap_or_default();
    Ok(out(&output_delta(existing, &text_of(&delta).unwrap_or_default())))
}

/// Port of `appendStreamingFieldDelta` (`part-delta.ts:327`).
pub fn append_streaming_field_delta(field: String, existing_value: Value, delta: Value) -> Result<Value, String> {
    if field == "output" {
        append_streaming_output_delta(existing_value, delta)
    } else {
        append_streaming_text_delta(existing_value, delta)
    }
}

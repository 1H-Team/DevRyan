//! The Rust port of `plan-implementation-detection.ts`, with what it uses of
//! `@/lib/messages/actionablePlan` (`parsePlanImplementationRequestPart`, and
//! `resolveMessagePlanCard(parts, { isPlanModeSource: true })` down to its plan text) and of
//! `revert-transactions` / `message-order` inlined. Text is UTF-16 code units as JS indexes it;
//! the plan regexes are matched by hand (`\s` is JS white space, `.` excludes line terminators,
//! no `m` flag). `JSON.parse` is serde_json's (both read JSON; serde refuses lone-surrogate
//! escapes and numbers beyond f64, which JS reads).

#![forbid(unsafe_code)]

use serde_json::{Map, Value, json};

use crate::js;

type R<T> = Result<T, String>;

fn undef() -> Value {
    js::undefined()
}

fn nullish(v: &Value) -> bool {
    v.is_null() || js::is_undefined(v)
}

fn marker<'a>(v: &'a Value, tag: &str) -> Option<&'a Value> {
    match v {
        Value::Object(o) if o.len() == 1 => o.get(tag),
        _ => None,
    }
}

fn set_items(v: &Value) -> Option<&Vec<Value>> {
    marker(v, "$set").and_then(Value::as_array)
}

/// `typeof v === "number"`.
fn num(v: &Value) -> Option<f64> {
    if v.is_number() || marker(v, "$num").is_some() {
        js::as_number(v)
    } else {
        None
    }
}

/// `typeof v === "string"`, as UTF-16 code units.
fn units(v: &Value) -> Option<Vec<u16>> {
    if v.is_string() || marker(v, "$utf16").is_some() {
        js::string_units(v)
    } else {
        None
    }
}

/// A plain object (not a marker of `undefined`, a number, a string or a `Set`).
fn plain(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Object(o) if !(o.len() == 1 && ["$undefined", "$num", "$utf16", "$set"].iter().any(|t| o.contains_key(*t))) => Some(o),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if js::is_undefined(v) => false,
        _ if marker(v, "$num").is_some() => num(v).is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ if marker(v, "$utf16").is_some() => units(v).is_some_and(|u| !u.is_empty()),
        _ => true,
    }
}

/// `===` (`same_zero`: SameValueZero, as `Map` and `Set` keys compare). Objects equal nothing.
fn eq(a: &Value, b: &Value, same_zero: bool) -> bool {
    if let (Some(x), Some(y)) = (num(a), num(b)) {
        return x == y || (same_zero && x.is_nan() && y.is_nan());
    }
    if let (Some(x), Some(y)) = (units(a), units(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => js::is_undefined(a) && js::is_undefined(b),
    }
}

fn is_str(v: &Value, text: &str) -> bool {
    units(v).is_some_and(|u| u == text.encode_utf16().collect::<Vec<_>>())
}

/// JS `ToString` of a property key.
fn key_of(v: &Value) -> String {
    if let Some(n) = num(v) {
        return js::number_to_string(n);
    }
    if let Some(u) = units(v) {
        return String::from_utf16_lossy(&u);
    }
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|i| if nullish(i) { String::new() } else { key_of(i) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(v) => "undefined".into(),
        _ if set_items(v).is_some() => "[object Set]".into(),
        _ => "[object Object]".into(),
    }
}

/// The key V8 names in "Cannot read properties of ...": none for an array.
fn reading(v: &Value) -> Option<String> {
    match v {
        Value::Array(_) => None,
        _ if set_items(v).is_some() => Some("#<Set>".into()),
        _ if plain(v).is_some() => Some("#<Object>".into()),
        _ => Some(key_of(v)),
    }
}

fn read_error(base: &Value, key: Option<String>) -> String {
    let kind = if base.is_null() { "null" } else { "undefined" };
    match key {
        Some(key) => format!("Cannot read properties of {kind} (reading '{key}')"),
        None => format!("Cannot read properties of {kind}"),
    }
}

fn index_key(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse::<u32>().ok().filter(|n| canonical && *n != u32::MAX)
}

/// `v[key]` on a value that is not nullish.
fn prop(v: &Value, key: &str) -> Value {
    if let Some(u) = units(v) {
        return match key {
            "length" => js::number(u.len() as f64),
            _ => index_key(key).and_then(|i| u.get(i as usize)).map_or_else(undef, |c| js::utf16_string(&[*c])),
        };
    }
    match v {
        Value::Array(items) if key == "length" => js::number(items.len() as f64),
        Value::Array(items) => index_key(key).and_then(|i| items.get(i as usize)).cloned().unwrap_or_else(undef),
        _ => plain(v).and_then(|o| o.get(key)).cloned().unwrap_or_else(undef),
    }
}

/// `v.key`, failing as V8 does on `null` and `undefined`.
fn get(v: &Value, key: &str) -> R<Value> {
    if nullish(v) { Err(read_error(v, Some(key.into()))) } else { Ok(prop(v, key)) }
}

/// `v[key]` for any key value.
fn get_by(v: &Value, key: &Value) -> R<Value> {
    if nullish(v) {
        Err(read_error(v, reading(key)))
    } else {
        Ok(prop(v, &key_of(key)))
    }
}

/// `v?.key`.
fn opt(v: &Value, key: &str) -> Value {
    if nullish(v) { undef() } else { prop(v, key) }
}

/// `state.session?.find((candidate) => candidate.id === sessionID)`.
fn find_session(state: &Value, session_id: &Value) -> R<Value> {
    let sessions = prop(state, "session");
    if nullish(&sessions) {
        return Ok(undef());
    }
    let Value::Array(list) = &sessions else {
        return Err("state.session?.find is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for candidate in list {
        if eq(&get(candidate, "id")?, session_id, false) {
            return Ok(candidate.clone());
        }
    }
    Ok(undef())
}

/// `getEffectiveSessionRevertMessageID(state, sessionID, session)`.
fn effective(state: &Value, session_id: &Value, session: &Value) -> R<Value> {
    let transaction = opt(&get(state, "revert_transaction")?, &key_of(session_id));
    if truthy(&transaction) && !is_str(&prop(&transaction, "status"), "failed") {
        return Ok(prop(&transaction, "messageID"));
    }
    let session = if nullish(session) {
        find_session(state, session_id)?
    } else {
        session.clone()
    };
    Ok(opt(&opt(&session, "revert"), "messageID"))
}

/// `messagesBefore(messages, marker)`: `None` when it returns `messages` itself.
fn before(messages: &Value, marker: &Value) -> R<Option<Vec<Value>>> {
    let Value::Array(list) = messages else {
        return Err("messages.findIndex is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    for (index, message) in list.iter().enumerate() {
        if eq(&get(message, "id")?, marker, false) {
            return Ok(Some(list[..index].to_vec()));
        }
    }
    Ok(None)
}

// ---- actionablePlan ----

type U = Vec<u16>;

fn u(text: &str) -> U {
    text.encode_utf16().collect()
}

fn ws(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn line_terminator(c: u16) -> bool {
    matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn trim(s: &[u16]) -> &[u16] {
    let start = s.iter().position(|c| !ws(*c)).unwrap_or(s.len());
    let end = s.iter().rposition(|c| !ws(*c)).map_or(start, |i| i + 1);
    &s[start..end.max(start)]
}

fn trim_end(s: &[u16]) -> &[u16] {
    &s[..s.iter().rposition(|c| !ws(*c)).map_or(0, |i| i + 1)]
}

fn trim_start(s: &[u16]) -> &[u16] {
    &s[s.iter().position(|c| !ws(*c)).unwrap_or(s.len())..]
}

fn blank(s: &[u16]) -> bool {
    trim(s).is_empty()
}

/// `text.split(/\r?\n/)`.
fn lines(s: &[u16]) -> Vec<&[u16]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in s.iter().enumerate() {
        if *c == 10 {
            let end = if i > start && s[i - 1] == 13 { i - 1 } else { i };
            out.push(&s[start..end]);
            start = i + 1;
        }
    }
    out.push(&s[start..]);
    out
}

/// `getPartText(part)`: the longest of `text`, `content`, `value` (strings only).
fn part_text(part: &Value) -> U {
    let mut best = U::new();
    for key in ["text", "content", "value"] {
        if let Some(t) = units(&prop(part, key))
            && t.len() > best.len()
        {
            best = t;
        }
    }
    best
}

/// The sentinel token `` `{0,3}<!--\s*plan\s*-->`{0,3} `` at `q`: its end.
fn token_at(s: &[u16], q: usize) -> Option<usize> {
    let mut i = q;
    while i < s.len() && i - q < 3 && s[i] == 96 {
        i += 1;
    }
    let lit = |i: usize, t: &str| {
        let t = u(t);
        (s.len() >= i + t.len() && s[i..i + t.len()] == t[..]).then_some(i + t.len())
    };
    i = lit(i, "<!--")?;
    while i < s.len() && ws(s[i]) {
        i += 1;
    }
    i = lit(i, "plan")?;
    while i < s.len() && ws(s[i]) {
        i += 1;
    }
    i = lit(i, "-->")?;
    let mut k = 0;
    while i < s.len() && k < 3 && s[i] == 96 {
        i += 1;
        k += 1;
    }
    Some(i)
}

/// `(^|[\r\n])([ \t]*TOKEN[ \t]*)` then `(?:\r?\n|$)` (consumed) or `(?=\r?\n|$)`, from `from`:
/// (match index, group 1 length, match end).
fn sentinel_line(s: &[u16], from: usize, consume: bool) -> Option<(usize, usize, usize)> {
    for p in from..s.len() {
        for g1 in [0usize, 1] {
            if (g1 == 0 && p != 0) || (g1 == 1 && !matches!(s[p], 10 | 13)) {
                continue;
            }
            let mut i = p + g1;
            while i < s.len() && matches!(s[i], 9 | 32) {
                i += 1;
            }
            let Some(mut e) = token_at(s, i) else { continue };
            while e < s.len() && matches!(s[e], 9 | 32) {
                e += 1;
            }
            let tail = if e == s.len() {
                Some(0)
            } else if s[e] == 10 {
                Some(1)
            } else if s[e] == 13 && s.get(e + 1) == Some(&10) {
                Some(2)
            } else {
                None
            };
            if let Some(n) = tail {
                return Some((p, g1, if consume { e + n } else { e }));
            }
        }
    }
    None
}

/// `/^\s{0,3}(#{1,4})\s+(.+?)\s*$/.exec(line)`: (level, heading).
fn heading(line: &[u16]) -> Option<(usize, U)> {
    let lead = line.iter().take_while(|c| ws(**c)).count();
    if lead > 3 {
        return None;
    }
    let hashes = line[lead..].iter().take_while(|c| **c == 35).count();
    if hashes == 0 || hashes > 4 {
        return None;
    }
    let r = &line[lead + hashes..];
    let run = r.iter().take_while(|c| ws(**c)).count();
    if run == 0 {
        return None;
    }
    let rest = trim_end(&r[run..]);
    if !rest.is_empty() {
        return (!rest.iter().any(|c| line_terminator(*c))).then(|| (hashes, rest.to_vec()));
    }
    (1..run).rev().find(|j| !line_terminator(r[*j])).map(|j| (hashes, vec![r[j]]))
}

const SECTIONS: [&str; 17] = [
    "context",
    "critical files",
    "implementation",
    "visual details",
    "verification",
    "constraints & assumptions",
    "constraints",
    "assumptions",
    "steps",
    "implementation steps",
    "approach",
    "files to change",
    "testing",
    "verification steps",
    "risks",
    "",
    "",
];

/// A heading line that starts or counts toward a plan.
fn plan_heading(line: &[u16]) -> bool {
    let Some((level, text)) = heading(line) else { return false };
    let lower = String::from_utf16_lossy(trim(&text)).to_lowercase();
    let mut normalized = String::new();
    let mut in_ws = false;
    for c in lower.chars() {
        if c.len_utf16() == 1 && ws(c as u16) {
            in_ws = true;
        } else {
            if in_ws {
                normalized.push(' ');
            }
            in_ws = false;
            normalized.push(c);
        }
    }
    if in_ws {
        normalized.push(' ');
    }
    level == 1 || SECTIONS[..15].contains(&normalized.as_str())
}

fn count_headings(s: &[u16]) -> usize {
    if s.is_empty() {
        return 0;
    }
    lines(s).into_iter().filter(|l| plan_heading(l)).count()
}

/// `splitStructuredPlanFallback(text)`: the plan text.
fn structured(s: &[u16]) -> Option<U> {
    if s.is_empty() {
        return None;
    }
    let mut offset = 0;
    let mut start = None;
    for line in lines(s) {
        if plan_heading(line) {
            start = Some(offset);
            break;
        }
        offset += line.len() + 1;
    }
    let plan = s[start?.min(s.len())..].to_vec();
    (count_headings(&plan) >= 2).then_some(plan)
}

/// `splitPlanCardSentinel(text)`: the plan text.
fn sentinel_split(s: &[u16]) -> Option<U> {
    if s.is_empty() {
        return None;
    }
    sentinel_line(s, 0, true).map(|(_, _, end)| s[end..].to_vec())
}

/// `joinPlanSourceParts(parts, indexes)`: the joined text and the spans (part index, start, end, raw start).
fn join_parts(parts: &[Value], indexes: &[usize]) -> (U, Vec<(usize, usize, usize, usize)>) {
    let sentinel = u("<!--plan-->"); // recorded-literal: PLAN_CARD_SENTINEL of @/lib/messages/actionablePlan
    let mut text = U::new();
    let mut spans = Vec::new();
    for &index in indexes {
        let raw = part_text(&parts[index]);
        let trimmed = trim(&raw).to_vec();
        if trimmed.is_empty() {
            continue;
        }
        let from = text.iter().rposition(|c| *c == 10).map_or(0, |i| i + 1);
        let mut last: &[u16] = trim(&text[from..]);
        let ticks = last.iter().take_while(|c| **c == 96).count().min(3);
        last = &last[ticks..];
        let last: U = last.iter().copied().filter(|c| !ws(*c)).collect();
        let split_marker = !last.is_empty() && last != sentinel && sentinel.starts_with(&last);
        if !text.is_empty() && !split_marker {
            text.push(10);
        }
        let start = text.len();
        text.extend(&trimmed);
        spans.push((index, start, text.len(), raw.len() - trim_start(&raw).len()));
    }
    (text, spans)
}

/// `sourcePartRanges(source, start, end)`: the part index of each range.
fn ranges(spans: &[(usize, usize, usize, usize)], start: usize, end: usize) -> Vec<usize> {
    spans.iter().filter(|(_, s, e, _)| end.min(*e) > start.max(*s)).map(|(i, ..)| *i).collect()
}

/// A reasoning plan candidate: plan text, first range part index, last part index.
struct Candidate {
    plan: U,
    first_range: Option<usize>,
    last_part: usize,
}

fn flush(parts: &[Value], indexes: &[usize], out: &mut Vec<Candidate>) {
    if indexes.is_empty() {
        return;
    }
    let (text, spans) = join_parts(parts, indexes);
    let mut markers = Vec::new();
    let mut from = 0;
    while from <= text.len() {
        let Some(m) = sentinel_line(&text, from, false) else { break };
        from = m.2;
        markers.push(m);
    }
    let last_part = indexes[indexes.len() - 1];
    let mut found = None;
    for index in (0..markers.len()).rev() {
        let (at, g1, end_of_marker) = markers[index];
        let start = at + g1;
        let body = end_of_marker
            + if text[end_of_marker..].starts_with(&[13, 10]) {
                2
            } else if text.get(end_of_marker) == Some(&10) {
                1
            } else {
                0
            };
        let end = markers.get(index + 1).map_or(text.len(), |n| n.0 + n.1);
        let plan = trim_end(&text[body.min(end)..end]).to_vec();
        if blank(&plan) {
            continue;
        }
        found = Some(Candidate {
            plan,
            first_range: ranges(&spans, start, end).first().copied(),
            last_part,
        });
        break;
    }
    if found.is_none()
        && markers.is_empty()
        && let Some(plan) = structured(&text)
    {
        let start = text.len() - plan.len();
        found = Some(Candidate {
            plan,
            first_range: ranges(&spans, start, text.len()).first().copied(),
            last_part,
        });
    }
    if found.is_none() && !markers.is_empty() {
        let (at, g1, _) = markers[markers.len() - 1];
        found = Some(Candidate {
            plan: U::new(),
            first_range: ranges(&spans, at + g1, text.len()).first().copied(),
            last_part,
        });
    }
    if let Some(candidate) = found {
        out.push(candidate);
    }
}

fn kind_is(part: &Value, kind: &str) -> R<bool> {
    Ok(is_str(&get(part, "type")?, kind))
}

/// `collectReasoningPlans(parts)`.
fn reasoning_plans(parts: &[Value]) -> R<Vec<Candidate>> {
    let mut out = Vec::new();
    let mut indexes = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if kind_is(part, "reasoning")? {
            // recorded-literal: part type read by @/lib/messages/actionablePlan
            indexes.push(index);
        } else if !kind_is(part, "step-start")? && !kind_is(part, "step-finish")? {
            // recorded-literal: part types read by @/lib/messages/actionablePlan
            flush(parts, &indexes, &mut out);
            indexes.clear();
        }
    }
    flush(parts, &indexes, &mut out);
    Ok(out)
}

/// `resolveMessagePlanCard(parts, { isPlanModeSource: true })?.planText`.
fn plan_card_text(parts: &[Value]) -> R<Option<U>> {
    let mut texts: Vec<U> = Vec::new();
    for part in parts {
        if kind_is(part, "text")? {
            let t = trim(&part_text(part)).to_vec();
            if !t.is_empty() {
                texts.push(t);
            }
        }
    }
    let joined = texts.join(&10u16);
    let sentinel = sentinel_split(&joined);
    let text_split = sentinel.clone().or_else(|| structured(&joined));
    let candidates = reasoning_plans(parts)?;
    if let Some(plan) = sentinel.filter(|p| !blank(p)) {
        return Ok(Some(plan));
    }
    if let Some(candidate) = candidates.last() {
        let Some(_) = candidate.first_range else {
            return Err("Cannot read properties of undefined (reading 'partIndex')".into()); // recorded-literal: the V8 TypeError text
        };
        if let Some(plan) = straddle(parts, text_split.as_deref(), candidate)? {
            return Ok(Some(plan));
        }
    }
    if let Some(plan) = text_split.filter(|p| !blank(p)) {
        return Ok(Some(plan));
    }
    Ok(candidates.into_iter().rev().find(|c| !blank(&c.plan)).map(|c| c.plan))
}

/// `resolveReasoningStraddlePlan` for its last candidate (it returns on the first one it sees).
fn straddle(parts: &[Value], text_split: Option<&[u16]>, candidate: &Candidate) -> R<Option<U>> {
    let mut tail_indexes = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if i > candidate.last_part && kind_is(part, "text")? {
            tail_indexes.push(i);
        }
    }
    let (tail, _) = join_parts(parts, &tail_indexes);
    if blank(&tail) {
        return Ok(None);
    }
    let mut tool_between = false;
    if let Some(&first) = tail_indexes.first() {
        for part in &parts[(candidate.last_part + 1).min(first)..first] {
            if kind_is(part, "tool")? {
                tool_between = true;
                break;
            }
        }
    }
    let body_in_text = blank(&candidate.plan) && !tail_indexes.is_empty() && !tool_between && sentinel_split(&tail).is_none();
    if !body_in_text && count_headings(&tail) < 1 {
        return Ok(None);
    }
    let combined = if candidate.plan.is_empty() {
        tail.clone()
    } else {
        [candidate.plan.as_slice(), &[10], &tail].concat()
    };
    if !body_in_text && count_headings(&combined) < 2 {
        return Ok(None);
    }
    if let Some(text_plan) = text_split.filter(|p| !blank(p)) {
        if !trim_end(&combined).ends_with(trim(text_plan)) {
            return Ok(None);
        }
        let first_line = lines(trim_start(text_plan))[0];
        if heading(first_line).is_some_and(|(level, _)| level == 1) {
            return Ok(None);
        }
    }
    Ok(Some(combined))
}

/// `parsePlanImplementationRequestPart(part)`: (sourceSessionId, sourceMessageId, planIndex).
fn parse_request(part: &Value) -> Option<(Value, Value, f64)> {
    if !truthy(part) || !is_str(&prop(part, "type"), "text") || prop(part, "synthetic") != Value::Bool(true) {
        return None;
    }
    let raw = part_text(part);
    let text = trim(&raw);
    let rest = [u("[devryan-plan-action:v1] "), u("[openchamber-plan-action:v1] ")]
        .into_iter()
        .find(|p| text.starts_with(p))
        .map(|p| &text[p.len()..])?;
    let parsed: Value = serde_json::from_str(&String::from_utf16(rest).ok()?).ok()?;
    let field = |k: &str| parsed.as_object().and_then(|o| o.get(k)).cloned().unwrap_or_else(undef);
    if !is_str(&field("action"), "implement") {
        return None;
    }
    let (session, message) = (field("sourceSessionId"), field("sourceMessageId"));
    for id in [&session, &message] {
        if units(id).is_none_or(|t| blank(&t)) {
            return None;
        }
    }
    let index = parsed
        .get("planIndex")
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && *n >= 0.0)?;
    let directory = field("projectDirectory");
    if !js::is_undefined(&directory) {
        let d = units(&directory)?;
        if blank(&d) || d.len() > 4096 || d.iter().any(|c| *c < 0x20 || (0x7f..=0x9f).contains(c)) {
            return None;
        }
    }
    Some((session, message, index))
}

// ---- the unit ----

/// `for (const item of value)`.
fn iterate(value: &Value, name: &str) -> R<Vec<Value>> {
    if let Some(items) = set_items(value) {
        return Ok(items.clone());
    }
    if let Some(t) = units(value) {
        let chars = char::decode_utf16(t.iter().copied());
        return Ok(chars
            .map(|c| c.map_or_else(|e| js::utf16_string(&[e.unpaired_surrogate()]), |c| Value::String(c.into())))
            .collect());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        _ => Err(format!("{name} is not iterable")),
    }
}

/// `hasMatchingPlanCard(state, message, planIndex)`.
fn matching_plan_card(state: &Value, message: &Value, plan_index: f64) -> R<bool> {
    if !is_str(&get(message, "role")?, "assistant") || plan_index != 0.0 {
        return Ok(false);
    }
    let parts = get_by(&get(state, "part")?, &prop(message, "id"))?;
    let parts = if nullish(&parts) { Value::Array(Vec::new()) } else { parts };
    let list = iterate(&parts, "parts")?;
    if units(&parts).is_some() {
        return Err("parts.forEach is not a function".into()); // recorded-literal: the V8 TypeError text
    }
    if set_items(&parts).is_some() {
        for part in &list {
            if kind_is(part, "reasoning")? {
                return Err("Cannot read properties of undefined (reading 'text')".into()); // recorded-literal: the V8 TypeError text
            }
        }
    }
    let plan = plan_card_text(&list)?;
    if set_items(&parts).is_some() && plan.is_some() {
        return Err("parts.flatMap is not a function".into()); // recorded-literal: the V8 TypeError text
    }
    Ok(plan.is_some_and(|p| !blank(&p)))
}

/// Port of `detectPlanImplementationRequestCandidate` (`plan-implementation-detection.ts:35`).
pub fn detect_plan_implementation_request_candidate(arg0: serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    if nullish(&arg0) {
        let (shown, kind) = if arg0.is_null() {
            ("object null", "null")
        } else {
            ("undefined", "undefined")
        };
        return Err(format!("Cannot destructure property 'sessionID' of '{shown}' as it is {kind}."));
    }
    let (session_id, state) = (prop(&arg0, "sessionID"), prop(&arg0, "state"));
    let raw = get_by(&get(&state, "message")?, &session_id)?;
    if !truthy(&raw) || eq(&prop(&raw, "length"), &js::number(0.0), false) {
        return Ok(None);
    }
    let revert = effective(&state, &session_id, &undef())?;
    let messages = if truthy(&revert) {
        before(&raw, &revert)?.map_or(raw.clone(), Value::Array)
    } else {
        raw
    };
    let Value::Array(list) = &messages else {
        return Err("messages.map is not a function".into()); // recorded-literal: the V8 TypeError text
    };
    let mut by_id: Vec<(Value, usize)> = Vec::new();
    for (index, message) in list.iter().enumerate() {
        let id = get(message, "id")?;
        match by_id.iter_mut().find(|(k, _)| eq(k, &id, true)) {
            Some(entry) => entry.1 = index,
            None => by_id.push((id, index)),
        }
    }
    for implementation_index in (0..list.len()).rev() {
        let implementation = &list[implementation_index];
        if !is_str(&get(implementation, "role")?, "user") {
            continue;
        }
        let parts = get_by(&get(&state, "part")?, &prop(implementation, "id"))?;
        let parts = if nullish(&parts) { Value::Array(Vec::new()) } else { parts };
        for part in iterate(&parts, "state.part[implementationMessage.id] ?? []")? {
            let Some((source_session, source_message, plan_index)) = parse_request(&part) else {
                continue;
            };
            if !eq(&source_session, &session_id, false) {
                continue;
            }
            let Some(&(_, source_index)) = by_id.iter().find(|(k, _)| eq(k, &source_message, true)) else {
                continue;
            };
            if source_index >= implementation_index {
                continue;
            }
            if !matching_plan_card(&state, &list[source_index], plan_index)? {
                continue;
            }
            let key = format!(
                "{}:{}:plan:{}",
                key_of(&source_session),
                key_of(&source_message),
                js::number_to_string(plan_index)
            );
            return Ok(Some(json!({
                "sourceSessionId": source_session,
                "sourceMessageId": source_message,
                "implementationMessageId": prop(implementation, "id"),
                "implementationKey": key,
            })));
        }
    }
    Ok(None)
}

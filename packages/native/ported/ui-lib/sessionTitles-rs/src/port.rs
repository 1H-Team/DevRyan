//! The Rust port of `sessionTitles.ts` (6 of 7 exports; `mergeSessionPreservingMeaningfulTitle`
//! rests on the managed-task display-name formatter of `@devryan/orchestration-runtime` and stays
//! in TS). Every regex is matched by hand, with its backtracking where it shows: `/i` without `u`
//! is ASCII-only case folding, `\b` is ASCII, `\s` is JS white space. Lengths and the 77-unit cut
//! are UTF-16 (a cut can leave a lone surrogate, as in JS).

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const DEFAULT_SESSION_TITLE: &str = "Untitled Session";
const MAX_LEN: usize = 80;
const VERBS: [&str; 21] = [
    "add",
    "build",
    "change",
    "create",
    "delete",
    "diagnose",
    "find",
    "fix",
    "hide",
    "implement",
    "investigate",
    "make",
    "move",
    "refactor",
    "remove",
    "rename",
    "replace",
    "start",
    "summarize",
    "test",
    "update",
];
const TERMS: [(&str, &str); 5] = [("api", "API"), ("pdf", "PDF"), ("pr", "PR"), ("ui", "UI"), ("url", "URL")];

/// JS `\s`.
fn sp(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JS `\w` without `u`.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `.` without `s`: anything but a line terminator.
fn dot(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Whether `s[at..]` starts with the ASCII literal `lit`, ignoring ASCII case.
fn ci_at(s: &[char], at: usize, lit: &str) -> bool {
    let lit: Vec<char> = lit.chars().collect();
    s.len() >= at + lit.len() && s[at..at + lit.len()].iter().zip(&lit).all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn ws_run(s: &[char], at: usize) -> usize {
    s[at.min(s.len())..].iter().take_while(|c| sp(**c)).count()
}

fn trim(s: &str) -> &str {
    s.trim_matches(sp)
}

/// `value.replace(/\s+/g, " ").trim()`.
fn collapse(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if sp(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    trim(&out).to_string()
}

fn quotes(value: &str) -> String {
    value
        .chars()
        .filter_map(|c| match c {
            '\u{201c}' | '\u{201d}' | '`' | '"' => None,
            '\u{2018}' | '\u{2019}' => Some('\''),
            c => Some(c),
        })
        .collect()
}

/// `normalizeKnownTitleTerms`: `\bapi\b`/gi and friends, in order.
fn known_terms(value: &str) -> String {
    let mut text = value.to_string();
    for (pattern, replacement) in TERMS {
        let s: Vec<char> = text.chars().collect();
        let n = pattern.len();
        let mut out = String::with_capacity(text.len());
        let mut i = 0;
        while i < s.len() {
            if (i == 0 || !word(s[i - 1])) && ci_at(&s, i, pattern) && s.get(i + n).is_none_or(|c| !word(*c)) {
                out.push_str(replacement);
                i += n;
            } else {
                out.push(s[i]);
                i += 1;
            }
        }
        text = out;
    }
    text
}

/// `value[0].toUpperCase() + value.slice(1)` (a supplementary first character stays).
fn capitalize_first(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return String::new() };
    let mut out: String = if (first as u32) < 0x10000 {
        first.to_uppercase().collect()
    } else {
        first.to_string()
    };
    out.push_str(chars.as_str());
    out
}

/// `/^(?:a|an|the)\s+/i` removed, then trimmed.
fn strip_article(value: &str) -> String {
    let s: Vec<char> = value.chars().collect();
    let cut = ["a", "an", "the"].iter().find_map(|a| {
        let n = a.len();
        (ci_at(&s, 0, a) && ws_run(&s, n) > 0).then(|| n + ws_run(&s, n))
    });
    let rest: String = s[cut.unwrap_or(0)..].iter().collect();
    trim(&rest).to_string()
}

fn route_context_from_path(value: &str) -> String {
    let last = value.split(['\\', '/']).map(trim).rfind(|s| !s.is_empty()).unwrap_or("");
    let mut dashed = String::new();
    for c in last.chars() {
        if c == '-' || c == '_' {
            if !dashed.ends_with('\u{0}') {
                dashed.push('\u{0}');
            }
        } else {
            dashed.push(c);
        }
    }
    collapse(&dashed.replace('\u{0}', " "))
}

/// `ROUTE_CONTEXT_PATTERN`: `(path, rest)`.
fn route_match(s: &[char]) -> Option<(String, String)> {
    let head = ["in", "on", "for"].iter().find(|w| ci_at(s, 0, w))?.len();
    let ws = ws_run(s, head);
    if ws == 0 {
        return None;
    }
    let start = head + ws;
    let prefixes: [&[char]; 3] = [&['/'], &['.', '.', '/'], &['.', '/']];
    for prefix in prefixes {
        if !s[start..].starts_with(prefix) {
            continue;
        }
        let body = start + prefix.len();
        let run = s[body..].iter().take_while(|c| **c != ',' && !sp(**c)).count();
        for k in (1..=run).rev() {
            let after = body + k;
            let a_max = ws_run(s, after);
            for a in (0..=a_max).rev() {
                let comma_at = after + a;
                let commas: &[usize] = if s.get(comma_at) == Some(&',') { &[1, 0] } else { &[0] };
                for &c in commas {
                    let b_at = comma_at + c;
                    let b_max = ws_run(s, b_at);
                    for b in (0..=b_max).rev() {
                        let rest = &s[b_at + b..];
                        if !rest.is_empty() && rest.iter().all(|ch| dot(*ch)) {
                            return Some((s[start..after].iter().collect(), rest.iter().collect()));
                        }
                    }
                }
            }
        }
    }
    None
}

/// `TRAILING_FIX_REFERENCE_PATTERN`: the verb as written.
fn trailing_fix(s: &[char]) -> Option<String> {
    for at in 0..s.len() {
        if at > 0 && word(s[at - 1]) || !word(s[at]) {
            continue;
        }
        for verb in ["fix", "repair", "resolve", "debug", "diagnose"] {
            if !ci_at(s, at, verb) {
                continue;
            }
            let after = at + verb.len();
            let ws = ws_run(s, after);
            if ws == 0 {
                continue;
            }
            let object = after + ws;
            for target in ["this", "it", "that", "issue", "bug"] {
                if !ci_at(s, object, target) {
                    continue;
                }
                let end = object + target.len();
                if end == s.len() || (end + 1 == s.len() && s[end] == '.') {
                    return Some(s[at..after].iter().collect());
                }
            }
        }
    }
    None
}

fn derive_smart(text: &str) -> Option<String> {
    let mut request = quotes(text);
    let mut route_context = String::new();
    let chars: Vec<char> = request.chars().collect();
    if let Some((path, rest)) = route_match(&chars) {
        route_context = route_context_from_path(&path);
        request = rest;
    }
    let collapsed = collapse(&request);
    let c: Vec<char> = collapsed.chars().collect();
    let stripped = ["please", "can you", "could you", "would you", "i want you to"]
        .iter()
        .find_map(|p| (ci_at(&c, 0, p) && ws_run(&c, p.len()) > 0).then(|| p.len() + ws_run(&c, p.len())))
        .unwrap_or(0);
    let request: String = c[stripped..].iter().collect();
    let request = trim(&request).to_string();
    let r: Vec<char> = request.chars().collect();
    if !route_context.is_empty()
        && let Some(verb) = trailing_fix(&r)
    {
        let normalized = known_terms(&collapse(&format!("{} {route_context}", verb.to_lowercase())));
        return (!normalized.is_empty()).then(|| capitalize_first(&normalized));
    }
    let verb = VERBS.iter().find(|v| ci_at(&r, 0, v) && r.get(v.len()).is_none_or(|c| !word(*c)))?;
    let rest_at = verb.len() + ws_run(&r, verb.len());
    let rest = &r[rest_at..];
    if !rest.iter().all(|c| dot(*c)) {
        return None;
    }
    let mut object = strip_article(&rest.iter().collect::<String>());
    if matches!(*verb, "remove" | "delete" | "hide") {
        let o: Vec<char> = object.chars().collect();
        if ci_at(&o, 0, "button") && ws_run(&o, 6) > 0 {
            let to = 6 + ws_run(&o, 6);
            if ci_at(&o, to, "to") && ws_run(&o, to + 2) > 0 {
                let rest: String = o[to + 2 + ws_run(&o, to + 2)..].iter().collect();
                object = format!("{} button", trim(&rest));
            }
        }
    }
    if *verb != "find" {
        object = strip_article(&object);
    }
    let with_context = if route_context.is_empty() || object.is_empty() || object.to_lowercase().contains(&route_context.to_lowercase()) {
        object
    } else {
        format!("{route_context} {object}")
    };
    let normalized = known_terms(&collapse(&format!("{verb} {with_context}")));
    (!normalized.is_empty()).then(|| capitalize_first(&normalized))
}

/// `text.length <= 80 ? text : text.slice(0, 77).trimEnd() + "..."`, in UTF-16 units.
fn clip(text: &str) -> Value {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= MAX_LEN {
        return Value::String(text.into());
    }
    let mut cut = units[..MAX_LEN - 3].to_vec();
    while cut.last().is_some_and(|&u| char::from_u32(u32::from(u)).is_some_and(sp)) {
        cut.pop();
    }
    cut.extend("...".encode_utf16());
    js::utf16_string(&cut)
}

/// `/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/` on one line: the capture.
fn heading(line: &[char]) -> Option<String> {
    let tail_ok = |t: &[char]| {
        let mut i = t.iter().take_while(|c| sp(**c)).count();
        i += t[i..].iter().take_while(|c| **c == '#').count();
        t[i..].iter().all(|c| sp(*c))
    };
    for a in (0..=ws_run(line, 0).min(3)).rev() {
        let hashes = line[a..].iter().take_while(|c| **c == '#').count();
        for h in (1..=hashes.min(6)).rev() {
            let at = a + h;
            for w in (1..=ws_run(line, at)).rev() {
                let start = at + w;
                for m in 1..=line.len().saturating_sub(start) {
                    if !dot(line[start + m - 1]) {
                        break;
                    }
                    if tail_ok(&line[start + m..]) {
                        return Some(line[start..start + m].iter().collect());
                    }
                }
            }
        }
    }
    None
}

fn title_text(title: &Value) -> Option<&str> {
    title.as_str()
}

fn cursor_error(title: &str) -> bool {
    let s: Vec<char> = trim(title).chars().collect();
    if !ci_at(&s, 0, "cursor-acp") {
        return false;
    }
    let a = 10 + ws_run(&s, 10);
    if a == 10 || !ci_at(&s, a, "error") {
        return false;
    }
    let b = a + 5 + ws_run(&s, a + 5);
    s.get(b) == Some(&':')
}

fn generated(title: &str) -> bool {
    let s: Vec<char> = trim(title).chars().collect();
    if !ci_at(&s, 0, "new session") {
        return false;
    }
    let mut i = 11 + ws_run(&s, 11);
    if s.get(i) != Some(&'-') {
        return false;
    }
    i += 1 + ws_run(&s, i + 1);
    let digits = |i: &mut usize, n: usize| {
        let ok = s.len() >= *i + n && s[*i..*i + n].iter().all(char::is_ascii_digit);
        *i += n;
        ok
    };
    let lit = |i: &mut usize, c: char| {
        let ok = s.get(*i).is_some_and(|x| x.eq_ignore_ascii_case(&c));
        *i += 1;
        ok
    };
    if !(digits(&mut i, 4)
        && lit(&mut i, '-')
        && digits(&mut i, 2)
        && lit(&mut i, '-')
        && digits(&mut i, 2)
        && lit(&mut i, 't')
        && digits(&mut i, 2)
        && lit(&mut i, ':')
        && digits(&mut i, 2)
        && lit(&mut i, ':')
        && digits(&mut i, 2))
    {
        return false;
    }
    if s.get(i) == Some(&'.') {
        let n = s[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n > 0 && s.get(i + 1 + n).is_some_and(|c| c.eq_ignore_ascii_case(&'z')) && i + 2 + n == s.len() {
            return true;
        }
    }
    s.get(i).is_some_and(|c| c.eq_ignore_ascii_case(&'z')) && i + 1 == s.len()
}

fn plan_control(title: &str) -> bool {
    let s: Vec<char> = title.chars().filter(|c| !sp(*c)).collect();
    if s.first() != Some(&'<') || s.last() != Some(&'>') {
        return false;
    }
    let prefix = s[1..].iter().take_while(|c| **c == '!' || **c == '-').count();
    let marks = &s[1..1 + prefix];
    let opener = marks.first() == Some(&'!') || marks.starts_with(&['-', '-']);
    let at = 1 + prefix;
    if !opener || !ci_at(&s, at, "plan") {
        return false;
    }
    let dashes = &s[at + 4..s.len() - 1];
    !dashes.is_empty() && dashes.iter().all(|c| *c == '-')
}

fn placeholder(title: &Value) -> bool {
    let normalized = title_text(title).map(collapse).unwrap_or_default();
    normalized.is_empty()
        || normalized.to_lowercase() == DEFAULT_SESSION_TITLE.to_lowercase()
        || cursor_error(&normalized)
        || generated(&normalized)
        || plan_control(&normalized)
}

fn derive(text: &Value, fallback: Value) -> Value {
    let raw = text.as_str().map(trim).unwrap_or("");
    let lines: Vec<&str> = raw.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let last = lines.len() - 1;
    let found = lines.iter().enumerate().find_map(|(i, line)| {
        let line = if i == last { raw.rsplit('\n').next().unwrap_or("") } else { line };
        let chars: Vec<char> = line.chars().collect();
        heading(&chars).map(|h| trim(&h).to_string()).filter(|h| !h.is_empty())
    });
    if let Some(found) = found {
        return clip(&known_terms(&quotes(&found)));
    }
    let normalized = collapse(raw);
    if normalized.is_empty() {
        return fallback;
    }
    match derive_smart(&normalized) {
        Some(smart) => clip(&smart),
        None => clip(&normalized),
    }
}

fn default_fallback(fallback: Value) -> Value {
    if js::is_undefined(&fallback) {
        Value::String(DEFAULT_SESSION_TITLE.into())
    } else {
        fallback
    }
}

/// Port of `isCursorAcpErrorTitle` (`sessionTitles.ts:114`).
pub fn is_cursor_acp_error_title(title: Value) -> Result<bool, String> {
    Ok(title_text(&title).is_some_and(cursor_error))
}

/// Port of `isGeneratedNewSessionTitle` (`sessionTitles.ts:121`).
pub fn is_generated_new_session_title(title: Value) -> Result<bool, String> {
    Ok(title_text(&title).is_some_and(generated))
}

/// Port of `isPlanControlSessionTitle` (`sessionTitles.ts:128`).
pub fn is_plan_control_session_title(title: Value) -> Result<bool, String> {
    Ok(title_text(&title).is_some_and(plan_control))
}

/// Port of `deriveSessionTitleFromUserText` (`sessionTitles.ts:135`).
pub fn derive_session_title_from_user_text(text: Value, fallback: Value) -> Result<Value, String> {
    Ok(derive(&text, default_fallback(fallback)))
}

/// Port of `isPlaceholderSessionTitle` (`sessionTitles.ts:164`).
pub fn is_placeholder_session_title(title: Value) -> Result<bool, String> {
    Ok(placeholder(&title))
}

/// Port of `resolveDisplaySessionTitle` (`sessionTitles.ts:187`).
pub fn resolve_display_session_title(arg0: Value) -> Result<Value, String> {
    if arg0.is_null() || js::is_undefined(&arg0) {
        let kind = if arg0.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot destructure property 'title' of '{kind}' as it is {kind}.")); // recorded-literal: V8 TypeError text
    }
    let field = |k: &str| arg0.as_object().and_then(|o| o.get(k)).cloned().unwrap_or_else(js::undefined);
    let (title, latest, fallback) = (field("title"), field("latestUserText"), default_fallback(field("fallback")));
    let normalized = match title.as_str() {
        Some(t) => {
            let collapsed = collapse(t);
            let words: Vec<&str> = collapsed.split(' ').collect();
            let kept: Vec<&str> = words
                .iter()
                .enumerate()
                .filter(|(i, w)| *i == 0 || w.to_lowercase() != words[i - 1].to_lowercase())
                .map(|(_, w)| *w)
                .collect();
            kept.join(" ")
        }
        None => String::new(),
    };
    if cursor_error(&normalized) {
        return Ok(derive(&latest, fallback));
    }
    if placeholder(&Value::String(normalized.clone())) {
        let prompt = if latest.is_null() || js::is_undefined(&latest) {
            String::new()
        } else {
            match latest.as_str() {
                Some(t) => collapse(t),
                None => return Err("value.replace is not a function".into()), // recorded-literal: V8 TypeError text
            }
        };
        if prompt.is_empty() {
            return Ok(fallback);
        }
        return Ok(clip(&prompt));
    }
    Ok(Value::String(normalized))
}

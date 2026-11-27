//! The Rust port of `skills-catalog/source.js` (`parseSkillRepoSource`). Its three patterns are
//! matched by hand over UTF-16 units: `\s` is JS white space and line terminators, `.` excludes
//! line terminators, `/i` folds ASCII letters only (non-Unicode mode).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

fn space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `text` starts with the ASCII `prefix`, ASCII letters compared case-insensitively.
fn strip_ci<'a>(text: &'a [u16], prefix: &str) -> Option<&'a [u16]> {
    let p = units(prefix);
    let lower = |c: u16| u8::try_from(c).map_or(c, |b| u16::from(b.to_ascii_lowercase()));
    (text.len() >= p.len() && text.iter().zip(&p).all(|(a, b)| lower(*a) == lower(*b))).then(|| &text[p.len()..])
}

const SLASH: u16 = 0x2f;

/// `([^/\s]+)\/` then the rest, split at the first slash.
fn owner_rest(text: &[u16]) -> Option<(&[u16], &[u16])> {
    let slash = text.iter().position(|c| *c == SLASH || space(*c)).filter(|i| *i > 0 && text[*i] == SLASH)?;
    Some((&text[..slash], &text[slash + 1..]))
}

/// `String(owner || '').trim()` / the repo without one trailing `.git` (any case).
fn owner_repo(owner: &[u16], repo: &[u16]) -> Option<(Vec<u16>, Vec<u16>)> {
    let owner = trim(owner).to_vec();
    let repo = trim(repo);
    let repo = if repo.len() >= 4 && strip_ci(&repo[repo.len() - 4..], ".git").is_some() {
        &repo[..repo.len() - 4]
    } else {
        repo
    };
    (!owner.is_empty() && !repo.is_empty()).then(|| (owner, repo.to_vec()))
}

fn failure(message: &str) -> Value {
    json!({ "ok": false, "error": { "kind": "invalidSource", "message": message } })
}

fn success(owner: &[u16], repo: &[u16], subpath: Value) -> Value {
    let joined = |parts: &[&[u16]]| js::utf16_string(&parts.concat());
    let (slash, git) = (units("/"), units(".git"));
    json!({
        "ok": true, "host": "github.com", "owner": js::utf16_string(owner), "repo": js::utf16_string(repo),
        "cloneUrlSsh": joined(&[&units("git@github.com:"), owner, &slash, repo, &git]),
        "cloneUrlHttps": joined(&[&units("https://github.com/"), owner, &slash, repo, &git]),
        "effectiveSubpath": subpath, "normalizedRepo": joined(&[owner, &slash, repo]),
    })
}

fn trimmed_or_null(value: Option<Vec<u16>>) -> Value {
    value
        .map(|v| trim(&v).to_vec())
        .filter(|t| !t.is_empty())
        .map_or(Value::Null, |t| js::utf16_string(&t))
}

/// Port of `parseSkillRepoSource` (`source.js:12`).
pub fn parse_skill_repo_source(input: Value, options: Value) -> Result<Value, String> {
    let all = js::string_units(&input).unwrap_or_default();
    let raw = trim(&all);
    if raw.is_empty() {
        return Ok(failure("Repository source is required"));
    }
    if options.is_null() {
        return Err("Cannot read properties of null (reading 'subpath')".into()); // recorded-literal: V8 TypeError text
    }
    let subpath = options
        .as_object()
        .filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
        .and_then(|o| o.get("subpath"))
        .and_then(js::string_units);
    let explicit = trimmed_or_null(subpath);
    for (prefixes, message) in [
        (&["git@github.com:"][..], "Invalid SSH repository URL"),
        (&["https://github.com/", "http://github.com/"][..], "Invalid HTTPS repository URL"),
    ] {
        let Some(rest) = prefixes.iter().find_map(|p| strip_ci(raw, p)) else {
            continue;
        };
        let Some((owner, repo)) = owner_rest(rest).filter(|(_, r)| !r.is_empty() && !r.iter().any(|c| space(*c) || *c == 0x23)) else {
            continue;
        };
        return Ok(owner_repo(owner, repo).map_or_else(|| failure(message), |(o, r)| success(&o, &r, explicit.clone())));
    }
    let terminator = |c: &u16| matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029);
    let shorthand = owner_rest(raw).and_then(|(owner, rest)| {
        let end = rest.iter().position(|c| *c == SLASH || space(*c)).unwrap_or(rest.len());
        let (repo, tail) = rest.split_at(end);
        let sub = match tail.split_first() {
            None => None,
            Some((&SLASH, sub)) if !sub.is_empty() && !sub.iter().any(terminator) => Some(sub.to_vec()),
            _ => return None,
        };
        (!repo.is_empty()).then_some((owner, repo, sub))
    });
    let Some((owner, repo, sub)) = shorthand else {
        return Ok(failure("Unsupported repository source format"));
    };
    let Some((o, r)) = owner_repo(owner, repo) else {
        return Ok(failure("Invalid repository source"));
    };
    let effective = if explicit.is_null() { trimmed_or_null(sub) } else { explicit };
    Ok(success(&o, &r, effective))
}

//! The Rust port of `commitTemplate.ts`. Lengths are UTF-16 code units; the subject regex is
//! matched by hand (JS `\s`/`\S`, and `.` stops at `\n`, `\r`, U+2028 and U+2029).

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const ALLOWED_COMMIT_TYPES: [&str; 11] = ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"];
const COMMIT_SUBJECT_MAX_LENGTH: usize = 72;

/// JS `\s` (and `trim`): white space and line terminators, U+FEFF included, U+0085 not.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.split(/\r?\n/)`.
fn lines(text: &str) -> Vec<&str> {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .into_iter()
        .enumerate()
        .map(|(i, p)| if i < last { p.strip_suffix('\r').unwrap_or(p) } else { p })
        .collect()
}

fn strip(message: &str) -> String {
    let kept: Vec<&str> = lines(message)
        .into_iter()
        .filter(|line| !line.trim_start_matches(js_space).starts_with('#'))
        .collect();
    kept.join("\n").trim_matches(js_space).to_string()
}

/// `SUBJECT_REGEX.exec(line)?.[4]`: `type(scope)!: summary`.
fn summary(line: &str) -> Option<&str> {
    let rest = ALLOWED_COMMIT_TYPES
        .iter()
        .find_map(|t| line.strip_prefix(t).filter(|r| r.starts_with(['(', '!', ':'])))?;
    let rest = match rest.strip_prefix('(') {
        Some(inner) => {
            let end = inner.find(')')?;
            let scope = &inner[..end];
            let mut chars = scope.chars();
            let first_ok = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            if !first_ok || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
                return None;
            }
            &inner[end + 1..]
        }
        None => rest,
    };
    let rest = rest.strip_prefix('!').unwrap_or(rest).strip_prefix(':')?;
    let body = rest.trim_start_matches(js_space);
    if body.len() == rest.len() || body.is_empty() || body.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(body)
}

/// Port of `stripCommitComments` (`commitTemplate.ts:44`).
pub fn strip_commit_comments(message: String) -> Result<String, String> {
    Ok(strip(&message))
}

/// Port of `validateCommitMessage` (`commitTemplate.ts:57`).
pub fn validate_commit_message(message: String) -> Result<Value, String> {
    let cleaned = strip(&message);
    let mut errors: Vec<String> = Vec::new();
    if cleaned.is_empty() {
        errors.push("Commit message is empty".into());
        return Ok(json!({ "valid": false, "errors": errors, "cleaned": cleaned }));
    }
    let first_line = lines(&cleaned)[0];
    let length = len16(first_line);
    if length > COMMIT_SUBJECT_MAX_LENGTH {
        errors.push(format!("Subject is {length} chars; keep it \u{2264} {COMMIT_SUBJECT_MAX_LENGTH}"));
    }
    let Some(summary) = summary(first_line) else {
        errors.push(format!(
            "Subject must match \"type(scope): summary\" or \"type: summary\" using one of: {}",
            ALLOWED_COMMIT_TYPES.join(", ")
        ));
        return Ok(json!({ "valid": false, "errors": errors, "cleaned": cleaned }));
    };
    let summary = summary.trim_matches(js_space);
    if summary.is_empty() {
        errors.push("Subject summary is empty".into());
    }
    if summary.ends_with('.') {
        errors.push("Subject summary must not end with a period".into());
    }
    Ok(json!({ "valid": errors.is_empty(), "errors": errors, "cleaned": cleaned }))
}

/// Port of `buildCommitMsgHookScript` (`commitTemplate.ts:94`).
pub fn build_commit_msg_hook_script() -> Result<String, String> {
    let alternation = ALLOWED_COMMIT_TYPES.join("|");
    let list = ALLOWED_COMMIT_TYPES.join(", ");
    let max = COMMIT_SUBJECT_MAX_LENGTH;
    Ok(format!(
        r##"#!/usr/bin/env bash
# Conventional Commit validator (managed by DevRyan)
# Installed via global core.hooksPath. Edit at ~/.config/git/hooks/commit-msg.
set -euo pipefail

msg_file="${{1:-}}"
if [ -z "${{msg_file}}" ] || [ ! -f "${{msg_file}}" ]; then
  exit 0
fi

# Match git's default commit.cleanup=strip: drop comment-only lines and trim.
cleaned="$(grep -v '^[[:space:]]*#' "${{msg_file}}" | awk 'NF {{found=1}} found' | awk 'NF || prev {{print; prev=NF}}' | sed -e :a -e '/^\n*$/{{$d;N;ba' -e '}}')"

if [ -z "${{cleaned}}" ]; then
  echo "✖ commit-msg: empty commit message after stripping comments" >&2
  exit 1
fi

subject="$(printf '%s\n' "${{cleaned}}" | head -n 1)"
subject_len=${{#subject}}
max_len={max}

errors=()

if [ "${{subject_len}}" -gt "${{max_len}}" ]; then
  errors+=("subject is ${{subject_len}} chars; keep it ≤ ${{max_len}}")
fi

# type(scope)!: summary | type(scope): summary | type!: summary | type: summary
subject_re='^({alternation})(\([a-z0-9][a-z0-9_-]*\))?(!)?:[[:space:]]+[^[:space:]].*$'
if ! [[ "${{subject}}" =~ ${{subject_re}} ]]; then
  errors+=("subject must match 'type(scope): summary' or 'type: summary' using one of: {list}")
fi

# Reject trailing period on summary.
if [[ "${{subject}}" =~ \.[[:space:]]*$ ]]; then
  errors+=("subject summary must not end with a period")
fi

if [ "${{#errors[@]}}" -gt 0 ]; then
  echo "✖ commit-msg validation failed:" >&2
  for err in "${{errors[@]}}"; do
    echo "   - ${{err}}" >&2
  done
  echo "" >&2
  echo "Allowed types: {list}" >&2
  echo "Subject:       ${{subject}}" >&2
  exit 1
fi

exit 0
"##
    ))
}

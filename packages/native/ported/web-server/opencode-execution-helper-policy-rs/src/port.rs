//! The Rust port of `opencode/execution-helper-policy.js`. The reviewed argument lists compare
//! by their `JSON.stringify` text in JS; for arrays of strings that is equality of every
//! string's UTF-16 units, which is what is compared here.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

#[rustfmt::skip]
const FLAGS: [&str; 11] = ["--no-optional-locks", "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "-c", "core.symlinks=true", "-c", "core.quotepath=false"];
#[rustfmt::skip]
const DISCOVERY: [&[&str]; 5] = [&["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"], &["remote", "get-url", "origin"], &["rev-list", "--max-parents=0", "HEAD"], &["rev-parse", "-q", "--verify", "HEAD"], &["worktree", "list", "--porcelain"]];
#[rustfmt::skip]
const INFO: [&[&str]; 5] = [&["symbolic-ref", "--quiet", "--short", "HEAD"], &["remote"], &["for-each-ref", "--format=%(refname:short)", "refs/heads"], &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], &["config", "init.defaultBranch"]];

fn listed(args: &[Vec<u16>], set: &[&[&str]]) -> bool {
    set.iter()
        .any(|known| known.len() == args.len() && known.iter().zip(args).all(|(k, a)| k.encode_utf16().eq(a.iter().copied())))
}

/// `/^refs\/remotes\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\/HEAD$/` without `..` or `//`.
fn remote_head(units: &[u16]) -> bool {
    let Ok(text) = String::from_utf16(units) else { return false };
    let Some(name) = text.strip_prefix("refs/remotes/").and_then(|t| t.strip_suffix("/HEAD")) else {
        return false;
    };
    let mut chars = name.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    first && name.len() <= 256 && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-')) && !text.contains("..") && !text.contains("//")
}

/// Port of `isReviewedControllerGitArgs` (`execution-helper-policy.js:20`).
pub fn is_reviewed_controller_git_args(args: Value) -> Result<Value, String> {
    let Some(items) = args.as_array() else { return Ok(false.into()) };
    let Some(args) = items.iter().map(js::string_units).collect::<Option<Vec<_>>>() else {
        return Ok(false.into());
    };
    if listed(&args, &DISCOVERY) {
        return Ok(true.into());
    }
    if args.len() < FLAGS.len() || !FLAGS.iter().zip(&args).all(|(f, a)| f.encode_utf16().eq(a.iter().copied())) {
        return Ok(false.into());
    }
    let body = &args[FLAGS.len()..];
    let symbolic = body.len() == 2 && body[0].iter().copied().eq("symbolic-ref".encode_utf16()) && remote_head(&body[1]);
    Ok((listed(body, &INFO) || symbolic).into())
}

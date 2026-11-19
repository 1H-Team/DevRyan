//! Refs of the files backend (`refs/files-backend.c`, `refs/packed-backend.c`):
//! a loose ref file holding one id, otherwise `packed-refs`. Anything else (a
//! symbolic ref, a symlink, other content, a malformed or unsorted-but-marked
//! `packed-refs`, a name outside the simple form) asks Git. Reftable
//! repositories never get here: `Repository::open` asks Git for them.
#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use super::repo::not_found;
use super::{Answer, ObjectFormat, Oid, Reason, Repository, ask, io_ask};

/// A ref and the id it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub name: String,
    pub oid: Oid,
}

/// Whether `name` is a ref name in the form the reader answers: `refs/`,
/// then components of `[A-Za-z0-9._-]` that are not empty, do not start with
/// `.`, do not end with `.lock` or `.`, and hold no `..`. Every such name is
/// valid for `check_refname_format`; other valid names ask Git.
pub fn valid_ref_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("refs/") else {
        return false;
    };
    !rest.is_empty()
        && rest.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with('.')
                && !part.ends_with(".lock")
                && !part.contains("..")
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

/// A loose ref file's id: exactly the lowercase hex id of the repository's
/// length, optionally followed by one newline (what `update-ref` writes).
fn loose_content(data: &[u8], format: ObjectFormat) -> Answer<Oid> {
    let text = data.strip_suffix(b"\n").unwrap_or(data);
    if text.starts_with(b"ref:") {
        return ask(Reason::RefFormat, "a symbolic ref");
    }
    match Oid::from_hex_bytes(text) {
        Some(oid) if oid.format() == format => Ok(oid),
        _ => ask(Reason::RefFormat, "a loose ref that is not one id"),
    }
}

/// One loose ref by name: `Ok(None)` when there is no such file (or a
/// directory, which Git reads past to `packed-refs`).
fn read_loose(repo: &Repository, name: &str) -> Answer<Option<Oid>> {
    let path = format!("{}/{name}", repo.git_dir());
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if not_found(&error) => return Ok(None),
        Err(error) => return Err(io_ask(&error, "loose ref")),
    };
    if metadata.is_dir() {
        return Ok(None);
    }
    if !metadata.is_file() {
        return ask(
            Reason::RefFormat,
            "a loose ref that is not a regular file (a symlink?)",
        );
    }
    match std::fs::read(&path) {
        Ok(data) => loose_content(&data, repo.format()).map(Some),
        // Removed between the two calls (`pack-refs`): read `packed-refs`.
        Err(error) if not_found(&error) => Ok(None),
        Err(error) => Err(io_ask(&error, "loose ref")),
    }
}

/// `packed-refs`, parsed: every ref in it (an empty map when it is absent).
/// Lines are `<id> <name>` with an optional `^<id>` peel line after one;
/// an optional first line `# pack-refs with:` names its traits. Duplicates,
/// a missing final newline, any other line, and a file whose `sorted` trait
/// is untrue ask Git (Git would then binary-search an unsorted file).
fn read_packed(repo: &Repository) -> Answer<BTreeMap<String, Oid>> {
    let data = match std::fs::read(format!("{}/packed-refs", repo.git_dir())) {
        Ok(data) => data,
        Err(error) if not_found(&error) => return Ok(BTreeMap::new()),
        Err(error) => return Err(io_ask(&error, "packed-refs")),
    };
    let mut refs = BTreeMap::new();
    if data.is_empty() {
        return Ok(refs);
    }
    if !data.ends_with(b"\n") {
        return ask(Reason::RefFormat, "packed-refs: unterminated line");
    }
    let hex = repo.format().hex_len();
    let mut sorted_trait = false;
    let mut previous: Option<String> = None;
    let mut in_order = true;
    let mut peelable = false;
    for (number, line) in data[..data.len() - 1]
        .split(|byte| *byte == b'\n')
        .enumerate()
    {
        if number == 0
            && let Some(traits) = line.strip_prefix(b"# pack-refs with:")
        {
            sorted_trait = traits
                .split(|byte| *byte == b' ')
                .any(|word| word == b"sorted");
            continue;
        }
        if let Some(peeled) = line.strip_prefix(b"^") {
            if !peelable
                || Oid::from_hex_bytes(peeled).is_none_or(|oid| oid.format() != repo.format())
            {
                return ask(
                    Reason::RefFormat,
                    "packed-refs: a misplaced or malformed peel line",
                );
            }
            peelable = false;
            continue;
        }
        if line.len() <= hex + 1 || line[hex] != b' ' {
            return ask(Reason::RefFormat, "packed-refs: a malformed line");
        }
        let oid = Oid::from_hex_bytes(&line[..hex])
            .ok_or_else(|| super::AskGit::new(Reason::RefFormat, "packed-refs: not an id"))?;
        let name = std::str::from_utf8(&line[hex + 1..])
            .ok()
            .filter(|name| valid_ref_name(name));
        let Some(name) = name else {
            return ask(
                Reason::RefName,
                "packed-refs: a ref name outside the simple form",
            );
        };
        if previous.as_deref().is_some_and(|before| before >= name) {
            in_order = false;
        }
        previous = Some(name.to_owned());
        if refs.insert(name.to_owned(), oid).is_some() {
            return ask(Reason::RefFormat, "packed-refs: a ref listed twice");
        }
        peelable = true;
    }
    if sorted_trait && !in_order {
        return ask(
            Reason::RefFormat,
            "packed-refs: marked sorted but out of order",
        );
    }
    Ok(refs)
}

impl Repository {
    /// The id a ref names (`rev-parse --verify <ref>`, `for-each-ref
    /// --format=%(objectname) <ref>` when it names one ref): the loose ref
    /// file, otherwise `packed-refs`; `Ok(None)` when neither has it.
    pub fn read_ref(&self, name: &str) -> Answer<Option<Oid>> {
        if !valid_ref_name(name) {
            return ask(Reason::RefName, "a ref name outside the simple form");
        }
        if let Some(oid) = read_loose(self, name)? {
            return Ok(Some(oid));
        }
        Ok(read_packed(self)?.get(name).copied())
    }

    /// `for-each-ref [<pattern>]` without a format: every ref under `refs/`,
    /// loose refs over packed ones, sorted by name, filtered as Git matches a
    /// pattern without wildcards (the name itself, or a prefix ending at a
    /// `/`). A wildcard pattern, or any loose file under `refs/` the reader
    /// would not read, asks Git.
    pub fn for_each_ref(&self, pattern: Option<&str>) -> Answer<Vec<Ref>> {
        if let Some(pattern) = pattern {
            let trimmed = pattern.strip_suffix('/').unwrap_or(pattern);
            if pattern.contains(['*', '?', '[', '\\'])
                || !(trimmed == "refs" || valid_ref_name(trimmed))
            {
                return ask(Reason::RefName, "a pattern outside the simple form");
            }
        }
        let mut refs = read_packed(self)?;
        let mut stack = vec!["refs".to_owned()];
        while let Some(directory) = stack.pop() {
            let entries = match std::fs::read_dir(format!("{}/{directory}", self.git_dir())) {
                Ok(entries) => entries,
                Err(error) if not_found(&error) => continue,
                Err(error) => return Err(io_ask(&error, "refs")),
            };
            for entry in entries {
                let entry = entry.map_err(|error| io_ask(&error, "refs"))?;
                let Ok(file) = entry.file_name().into_string() else {
                    return ask(Reason::RefName, "a loose ref name that is not UTF-8");
                };
                // Git skips these while it lists loose refs.
                if file.starts_with('.') || file.ends_with(".lock") {
                    continue;
                }
                let name = format!("{directory}/{file}");
                let kind = entry.file_type().map_err(|error| io_ask(&error, "refs"))?;
                if kind.is_dir() {
                    stack.push(name);
                    continue;
                }
                if !valid_ref_name(&name) {
                    return ask(Reason::RefName, "a loose ref name outside the simple form");
                }
                if !kind.is_file() {
                    return ask(
                        Reason::RefFormat,
                        "a loose ref that is not a regular file (a symlink?)",
                    );
                }
                match std::fs::read(format!("{}/{name}", self.git_dir())) {
                    Ok(data) => {
                        refs.insert(name, loose_content(&data, self.format())?);
                    }
                    Err(error) if not_found(&error) => {}
                    Err(error) => return Err(io_ask(&error, "loose ref")),
                }
            }
        }
        let matches = |name: &str| match pattern {
            None => true,
            Some(pattern) => {
                name == pattern
                    || (name.starts_with(pattern)
                        && (pattern.ends_with('/')
                            || name.as_bytes().get(pattern.len()) == Some(&b'/')))
            }
        };
        Ok(refs
            .into_iter()
            .filter(|(name, _)| matches(name))
            .map(|(name, oid)| Ref { name, oid })
            .collect())
    }
}

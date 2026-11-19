//! Tree walks: `git ls-tree -r -l -z` listings (the port of the JavaScript's
//! `listTreeRows` and its paged `listDirectPrefix`) and `<tree>:<path>`
//! names (Git's `get_tree_entry`).
//!
//! Trees are parsed exactly as `parseTree` parses them. A tree is answered
//! only when it is strictly in Git's order with no name twice (`inGitOrder`):
//! Git walks a tree on that assumption, stopping at the first entry past a
//! path and matching a repeated name more than once, so any other tree asks
//! Git. So do a mode `ls-tree` would print otherwise (anywhere in a tree the
//! walk reads, which is stricter than the JavaScript), a missing object, an
//! object of the wrong type, and a prefix Git's pathspec rules could read
//! differently.
#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::rc::Rc;

use super::{Answer, AskGit, Kind, Odb, Oid, Reason, ask};

/// One parsed tree entry: mode and name as bytes, the id raw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntryBytes {
    pub mode: Vec<u8>,
    pub name: Vec<u8>,
    pub oid: Oid,
}

const TREE_MODE: &[u8] = b"40000";

/// `parseTree(data, oidLength)`: each entry is the bytes up to the first
/// space (mode), up to the next NUL (name), then the raw id. `None` where the
/// JavaScript throws.
pub fn parse_tree_entries(data: &[u8], hash: usize) -> Option<Vec<TreeEntryBytes>> {
    let mut entries = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let space = at + data[at..].iter().position(|byte| *byte == b' ')?;
        let nul = space + 1 + data[space + 1..].iter().position(|byte| *byte == 0)?;
        if nul + 1 + hash > data.len() {
            return None;
        }
        entries.push(TreeEntryBytes {
            mode: data[at..space].to_vec(),
            name: data[space + 1..nul].to_vec(),
            oid: Oid::from_raw(&data[nul + 1..nul + 1 + hash])?,
        });
        at = nul + 1 + hash;
    }
    Some(entries)
}

/// Git's sort name: a subtree's name as if it ended in `/`.
fn sort_name(entry: &TreeEntryBytes) -> Vec<u8> {
    let mut name = entry.name.clone();
    if entry.mode == TREE_MODE {
        name.push(b'/');
    }
    name
}

/// `inGitOrder(entries)`: sort names strictly increasing, no name twice.
pub fn in_git_order(entries: &[TreeEntryBytes]) -> bool {
    let mut names = std::collections::HashSet::new();
    let mut last: Option<Vec<u8>> = None;
    for entry in entries {
        let key = sort_name(entry);
        if last.as_ref().is_some_and(|last| *last >= key) || !names.insert(entry.name.as_slice()) {
            return false;
        }
        last = Some(key);
    }
    true
}

/// One row of `ls-tree -r -l -z`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeRow {
    pub mode: &'static str,
    pub kind: Kind,
    pub oid: Oid,
    /// The blob's size; `None` for a submodule, printed `-`.
    pub size: Option<u64>,
    /// The path as Git prints it with `-z` (raw bytes, no quoting).
    pub path: Vec<u8>,
}

impl TreeRow {
    /// The row as `ls-tree -l -z` prints it, without its terminating NUL.
    pub fn text(&self) -> Vec<u8> {
        let size = self
            .size
            .map_or_else(|| "-".to_owned(), |size| size.to_string());
        let mut out = format!(
            "{} {} {} {size:>7}\t",
            self.mode,
            self.kind.name(),
            self.oid
        )
        .into_bytes();
        out.extend_from_slice(&self.path);
        out
    }
}

/// The modes `ls-tree` prints as stored (`LISTED_MODES`).
fn listed(mode: &[u8]) -> Option<(&'static str, Kind)> {
    match mode {
        b"100644" => Some(("100644", Kind::Blob)),
        b"100755" => Some(("100755", Kind::Blob)),
        b"120000" => Some(("120000", Kind::Blob)),
        b"160000" => Some(("160000", Kind::Commit)),
        _ => None,
    }
}

/// A tree read, parsed and order-checked for a walk.
fn read_tree(odb: &Odb, oid: &Oid) -> Answer<Vec<TreeEntryBytes>> {
    let object = odb
        .read_object(oid, odb.options.verify_ids)?
        .ok_or_else(|| AskGit::new(Reason::TreeMissing, format!("tree {oid} is missing")))?;
    if object.kind != Kind::Tree {
        return ask(
            Reason::TreeMissing,
            format!("{oid} is a {}, not a tree", object.kind.name()),
        );
    }
    let entries = parse_tree_entries(&object.data, odb.format().raw_len())
        .ok_or_else(|| AskGit::new(Reason::TreeFormat, format!("tree {oid}")))?;
    // Git orders and walks by the mode it parses (`040000` is a tree to it);
    // a tree holding any mode but the five Git writes is not answered here.
    if let Some(entry) = entries
        .iter()
        .find(|entry| entry.mode != TREE_MODE && listed(&entry.mode).is_none())
    {
        return ask(
            Reason::TreeMode,
            format!("tree {oid}: mode {}", String::from_utf8_lossy(&entry.mode)),
        );
    }
    if !in_git_order(&entries) {
        return ask(Reason::TreeOrder, format!("tree {oid}"));
    }
    Ok(entries)
}

/// The pathspec prefixes the JavaScript pages by: `[a-zA-Z0-9_-]` components.
fn simple_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
}

pub(crate) fn list_tree(odb: &Odb, tree: &Oid, prefix: Option<&str>) -> Answer<Vec<TreeRow>> {
    let Some(prefix) = prefix else {
        return list_from(odb, tree, Vec::new());
    };
    if !simple_prefix(prefix) {
        return ask(
            Reason::NameSyntax,
            "a prefix outside [a-zA-Z0-9_-] components",
        );
    }
    let mut oid = *tree;
    for part in prefix.split('/') {
        let entries = read_tree(odb, &oid)?;
        let Some(entry) = entries.iter().find(|entry| entry.name == part.as_bytes()) else {
            return Ok(Vec::new());
        };
        if entry.mode != TREE_MODE {
            return ask(Reason::TreeMode, "a prefix component that is not a tree");
        }
        oid = entry.oid;
    }
    let mut path = prefix.as_bytes().to_vec();
    path.push(b'/');
    list_from(odb, &oid, path)
}

/// Every non-tree entry under `tree`, depth first in stored order, each tree
/// read once per listing and every blob's size from its header.
fn list_from(odb: &Odb, tree: &Oid, prefix: Vec<u8>) -> Answer<Vec<TreeRow>> {
    type Entries = Rc<Vec<TreeEntryBytes>>;
    let options = odb.options;
    let mut parsed: HashMap<Oid, Entries> = HashMap::new();
    let mut sizes: HashMap<Oid, u64> = HashMap::new();
    let mut rows = Vec::new();
    let open = |oid: &Oid, parsed: &mut HashMap<Oid, Entries>| -> Answer<Entries> {
        if let Some(entries) = parsed.get(oid) {
            return Ok(Rc::clone(entries));
        }
        let entries = Rc::new(read_tree(odb, oid)?);
        parsed.insert(*oid, Rc::clone(&entries));
        Ok(entries)
    };
    // Each open tree: its entries, the next entry to visit, its path.
    let mut stack: Vec<(Entries, usize, Vec<u8>)> = vec![(open(tree, &mut parsed)?, 0, prefix)];
    while let Some((entries, next, path)) = stack.last_mut() {
        let Some(entry) = entries.get(*next).cloned() else {
            stack.pop();
            continue;
        };
        *next += 1;
        let mut name = path.clone();
        name.extend_from_slice(&entry.name);
        if entry.mode == TREE_MODE {
            if stack.len() >= options.max_tree_depth {
                return ask(
                    Reason::TreeLimit,
                    format!("deeper than {} trees", options.max_tree_depth),
                );
            }
            let child = open(&entry.oid, &mut parsed)?;
            name.push(b'/');
            stack.push((child, 0, name));
            continue;
        }
        let Some((mode, kind)) = listed(&entry.mode) else {
            return ask(
                Reason::TreeMode,
                String::from_utf8_lossy(&entry.mode).into_owned(),
            );
        };
        let size = if kind == Kind::Blob {
            if let Some(size) = sizes.get(&entry.oid) {
                Some(*size)
            } else {
                let info = odb.info_unchecked(&entry.oid)?.ok_or_else(|| {
                    AskGit::new(
                        Reason::TreeMissing,
                        format!("blob {} is missing", entry.oid),
                    )
                })?;
                if info.kind != Kind::Blob {
                    return ask(
                        Reason::TreeMissing,
                        format!("{} is a {}, not a blob", entry.oid, info.kind.name()),
                    );
                }
                sizes.insert(entry.oid, info.size);
                Some(info.size)
            }
        } else {
            None
        };
        if rows.len() >= options.max_listing_rows {
            return ask(
                Reason::TreeLimit,
                format!("more than {} rows", options.max_listing_rows),
            );
        }
        rows.push(TreeRow {
            mode,
            kind,
            oid: entry.oid,
            size,
            path: name,
        });
    }
    Ok(rows)
}

/// `get_tree_entry(tree, path)`: components looked up one tree at a time;
/// absent when a component is not in its (ordered) tree, or a component
/// before the last is not a tree (Git's `find_tree_entry` stops there). A
/// root that is a blob is absent too; a commit or tag root asks Git (Git
/// peels it to its tree).
pub(crate) fn resolve_path(odb: &Odb, tree: &Oid, path: &[u8]) -> Answer<Option<(Oid, Vec<u8>)>> {
    if path.is_empty()
        || path == b"."
        || path == b".."
        || path.starts_with(b"./")
        || path.starts_with(b"../")
    {
        return ask(Reason::NameSyntax, "an empty or relative path");
    }
    if path.split(|byte| *byte == b'/').any(<[u8]>::is_empty)
        || path.iter().any(|byte| matches!(byte, 0 | b'\n' | b'\r'))
    {
        return ask(Reason::NameSyntax, "a path with an empty component");
    }
    let Some(root) = odb.info_unchecked(tree)? else {
        return Ok(None);
    };
    match root.kind {
        Kind::Tree => {}
        Kind::Blob => return Ok(None),
        Kind::Commit | Kind::Tag => {
            return ask(Reason::Peel, format!("{tree} is a {}", root.kind.name()));
        }
    }
    let parts: Vec<&[u8]> = path.split(|byte| *byte == b'/').collect();
    let mut oid = *tree;
    for (index, part) in parts.iter().enumerate() {
        let entries = read_tree(odb, &oid)?;
        let Some(entry) = entries.iter().find(|entry| entry.name == *part) else {
            return Ok(None);
        };
        if index + 1 == parts.len() {
            return Ok(Some((entry.oid, entry.mode.clone())));
        }
        if entry.mode != TREE_MODE {
            return Ok(None);
        }
        oid = entry.oid;
    }
    unreachable!("the loop returns at the last component")
}

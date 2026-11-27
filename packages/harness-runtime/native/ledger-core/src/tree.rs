//! Git tree objects and direct tree commits: a port of
//! `packages/harness-runtime/lib/session-changes-trees.js` (`parseTree`,
//! `serializeTree`, `objectID` and `commitTreeChanges`; `writeLooseObject` is
//! file-system work and belongs to the I/O layer).
//!
//! The JavaScript is the reference. Names, modes and object ids are kept as
//! JavaScript strings (`JsStr`) because that is what the JavaScript holds:
//! `parseTree` decodes names and modes as latin1 (one code unit per byte) and
//! ids as lowercase hex, and `serializeTree` writes every code unit's low byte
//! (`Buffer.from(text, 'latin1')`) and decodes ids as `Buffer.from(oid, 'hex')`
//! does: pairs of hex digits read from each unit's low byte, up to the first
//! pair that is not one. Every place where Rust would otherwise differ is
//! marked `JS:`.
//!
//! This crate implements no hash function. An object's id is its header and
//! content handed to a `Digest` the caller supplies (SHA-1 for 40-character
//! ids, SHA-256 for 64), as `crypto.createHash(...).update(header).update(content)`.
#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::js::JsStr;

/// The mode of a blob entry the ledger writes.
pub const BLOB_MODE: &str = "100644";
/// The mode of a subtree entry, as Git writes it (no leading zero).
pub const TREE_MODE: &str = "40000";

/// The status of the `invalid_change_record` error `parseTree` throws.
pub const STATUS_UNAVAILABLE: u16 = 503;
/// The default status of `changeError` (`session-changes-git.js`).
pub const STATUS_CONFLICT: u16 = 409;

/// One tree entry, as `parseTree` returns it and `serializeTree` takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: JsStr,
    pub name: JsStr,
    pub oid: JsStr,
}

impl TreeEntry {
    pub fn new(mode: &str, name: JsStr, oid: JsStr) -> Self {
        TreeEntry {
            mode: JsStr::from(mode),
            name,
            oid,
        }
    }

    fn is_tree(&self) -> bool {
        self.mode == TREE_MODE
    }
}

/// `changeError('invalid_change_record', status)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidChangeRecord {
    pub status: u16,
}

/// `parseTree(data, oidLength)`. Fails as the JavaScript throws
/// (`invalid_change_record`, 503) on an entry without a space, without a
/// NUL after it, or with fewer than `oid_length / 2` bytes of id left.
///
/// JS: for an odd `oid_length` the JavaScript's width is a fraction
/// (`41 / 2` is 20.5) and its offsets stop being integers; this rounds the
/// width down. The callers pass 40 or 64 only.
pub fn parse_tree(data: &[u8], oid_length: usize) -> Result<Vec<TreeEntry>, InvalidChangeRecord> {
    let width = oid_length / 2;
    let invalid = InvalidChangeRecord {
        status: STATUS_UNAVAILABLE,
    };
    let mut entries = Vec::new();
    let mut at = 0;
    while at < data.len() {
        // JS: `data.indexOf(0x20, at)`, then `data.indexOf(0, space + 1)`.
        let space = data[at..]
            .iter()
            .position(|byte| *byte == b' ')
            .map(|offset| at + offset)
            .ok_or(invalid)?;
        let nul = data[space + 1..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| space + 1 + offset)
            .ok_or(invalid)?;
        if nul + 1 + width > data.len() {
            return Err(invalid);
        }
        entries.push(TreeEntry {
            mode: latin1_string(&data[at..space]),
            name: latin1_string(&data[space + 1..nul]),
            oid: hex_string(&data[nul + 1..nul + 1 + width]),
        });
        at = nul + 1 + width;
    }
    Ok(entries)
}

/// `buffer.toString('latin1')`.
pub fn latin1_string(bytes: &[u8]) -> JsStr {
    JsStr::from_units(bytes.iter().map(|byte| u16::from(*byte)).collect())
}

/// `Buffer.from(text, 'latin1')`: each code unit's low byte.
pub fn latin1_bytes(text: &[u16]) -> impl Iterator<Item = u8> + '_ {
    text.iter().map(|unit| *unit as u8)
}

/// `buffer.toString('hex')`.
pub fn hex_string(bytes: &[u8]) -> JsStr {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut units = Vec::with_capacity(bytes.len() * 2);
    for byte in bytes {
        units.push(u16::from(DIGITS[usize::from(byte >> 4)]));
        units.push(u16::from(DIGITS[usize::from(byte & 15)]));
    }
    JsStr::from_units(units)
}

/// `Buffer.from(text, 'hex')`: one byte per pair of hex digits (either case),
/// each digit read from its code unit's low byte, stopping at the first pair
/// that is not two digits; an odd last unit is ignored.
pub fn hex_bytes(text: &[u16]) -> Vec<u8> {
    let digit = |unit: u16| -> Option<u8> {
        let byte = unit as u8;
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(text.len() / 2);
    for &[high, low] in text.as_chunks::<2>().0 {
        match (digit(high), digit(low)) {
            (Some(high), Some(low)) => out.push(high << 4 | low),
            _ => break,
        }
    }
    out
}

/// Git's entry order: names compared bytewise (latin1), a subtree's name as
/// if it ended in `/`, then by length (`Buffer.compare`).
pub fn compare_entries(left: &TreeEntry, right: &TreeEntry) -> Ordering {
    fn key(entry: &TreeEntry) -> impl Iterator<Item = u8> + '_ {
        let slash = entry.is_tree().then_some(b'/');
        latin1_bytes(entry.name.units()).chain(slash)
    }
    key(left).cmp(key(right))
}

/// `serializeTree(entries)`: the entries in Git's order (a stable sort, so
/// entries that compare equal keep their order), each as
/// `<mode> <name>\0<raw id>`.
pub fn serialize_tree(entries: &[TreeEntry]) -> Vec<u8> {
    let mut sorted: Vec<&TreeEntry> = entries.iter().collect();
    sorted.sort_by(|left, right| compare_entries(left, right));
    let mut out = Vec::new();
    for entry in sorted {
        out.extend(latin1_bytes(entry.mode.units()));
        out.push(b' ');
        out.extend(latin1_bytes(entry.name.units()));
        out.push(0);
        out.extend(hex_bytes(entry.oid.units()));
    }
    out
}

/// A Git object type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ObjectKind {
    Blob,
    Tree,
}

impl ObjectKind {
    pub fn name(self) -> &'static str {
        match self {
            ObjectKind::Blob => "blob",
            ObjectKind::Tree => "tree",
        }
    }
}

/// The object header `"<type> <length>\0"` that precedes its content in the
/// hashed (and stored) bytes.
pub fn object_header(kind: &str, length: usize) -> Vec<u8> {
    format!("{kind} {length}\0").into_bytes()
}

/// A hash function the caller supplies: the lowercase hex digest of the
/// concatenation of `parts`.
pub trait Digest {
    fn hex(&mut self, parts: &[&[u8]]) -> JsStr;
}

/// `objectID(type, content, oidLength)`: the digest of the header and the
/// content, with the caller's hash for this repository's id width.
pub fn object_id(digest: &mut impl Digest, kind: &str, content: &[u8]) -> JsStr {
    digest.hex(&[&object_header(kind, content.len()), content])
}

/// One staged change of `commitTreeChanges`: a new blob holding a string's
/// UTF-8 (`Buffer.from(value)`, lone surrogates as `EF BF BD`), an existing
/// blob by id (`{ oid }`), or a removal (`null`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Blob(JsStr),
    Existing(JsStr),
    Remove,
}

/// The object store `commitTreeChanges` runs over: `readTree(oid)` and
/// `writeObject(type, content)` (which returns the new object's id).
pub trait TreeStore {
    type Error;
    fn read_tree(&mut self, oid: &JsStr) -> Result<Vec<u8>, Self::Error>;
    fn write_object(&mut self, kind: ObjectKind, content: &[u8]) -> Result<JsStr, Self::Error>;
}

/// Why `commit_tree_changes` failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitError<E> {
    /// `invalid_change_record`: a file where a directory is needed or the
    /// reverse (409), or a tree that does not parse (503).
    Invalid(InvalidChangeRecord),
    /// The store's own error, as `readTree` or `writeObject` rejected.
    Store(E),
}

/// A string-keyed map in insertion order, as JavaScript's `Map`: setting an
/// existing key keeps its position, deleting and setting again moves it last.
struct OrderedMap<V> {
    slots: Vec<Option<(JsStr, V)>>,
    positions: HashMap<JsStr, usize>,
}

impl<V> OrderedMap<V> {
    fn new() -> Self {
        OrderedMap {
            slots: Vec::new(),
            positions: HashMap::new(),
        }
    }

    fn get(&self, key: &JsStr) -> Option<&V> {
        self.positions
            .get(key)
            .and_then(|&at| self.slots[at].as_ref().map(|(_, value)| value))
    }

    fn get_mut(&mut self, key: &JsStr) -> Option<&mut V> {
        let at = *self.positions.get(key)?;
        self.slots[at].as_mut().map(|(_, value)| value)
    }

    fn set(&mut self, key: JsStr, value: V) {
        if let Some(&at) = self.positions.get(&key)
            && let Some(slot) = self.slots[at].as_mut()
        {
            slot.1 = value;
            return;
        }
        self.positions.insert(key.clone(), self.slots.len());
        self.slots.push(Some((key, value)));
    }

    fn delete(&mut self, key: &JsStr) {
        if let Some(at) = self.positions.remove(key) {
            self.slots[at] = None;
        }
    }

    fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.slots.iter().flatten().map(|(_, value)| value)
    }

    fn into_entries(self) -> impl Iterator<Item = (JsStr, V)> {
        self.slots.into_iter().flatten()
    }
}

/// A node of the change tree: a directory of further changes, or a change.
enum Node {
    Directory(OrderedMap<Node>),
    Leaf(Change),
}

/// One directory being rewritten: its entries, the children still to visit,
/// and the name it has in its parent.
struct Frame {
    entries: OrderedMap<TreeEntry>,
    children: std::vec::IntoIter<(JsStr, Node)>,
    name: Option<JsStr>,
}

/// `commitTreeChanges({ tree, changes, oidLength, readTree, writeObject })`:
/// rewrites only the trees on the changed paths of `tree` (or of an empty
/// tree when `tree` is `None` or empty) and returns the new root tree's id;
/// an empty result is Git's empty tree, written like any other.
///
/// `changes` maps keys of the form `a/b/c.json` to changes, as the store's
/// `pending` map; a repeated key keeps its first position and takes its last
/// change, as `Map` does. Keys are split at `/` as `key.split('/')`.
///
/// Objects are written in this order: one blob per distinct new string, in
/// the order of `changes`, then every rewritten tree after its subtrees. The
/// JavaScript starts the same writes concurrently, so on success the set of
/// objects written and the root are the same; their order is not.
///
/// JS: one exception to "the same root". Within one directory, the
/// JavaScript adds entries that are new to it (not in the tree it rewrites)
/// as their branches finish, and `serializeTree`'s stable sort keeps that
/// order for entries that compare equal. Two such entries compare equal only
/// when they are of the same kind (both files or both subtrees) and their
/// names have the same latin1 bytes while differing as strings, which needs
/// a code unit above U+00FF (`Ā` and `\ud800` both become byte `00`). The
/// JavaScript's root then depends on timing; this adds them in the order of
/// `changes` (each branch finishing before the next starts), which is one of
/// the roots the JavaScript can give, though not always the one it gives
/// with no delays. Keys reach `commitTreeChanges` only through the change
/// store's `pending` map: `validKey` (ASCII) for `set`, `remove` and the
/// lists, and `importPrefix`, which copies names listed from a tree of the
/// ledger by `git ls-tree` (decoded as UTF-8). The product's `importPrefix`
/// calls copy the ledger's own `runs/` and `bases/` trees, so a ledger the
/// product wrote holds no such names; only a tree written by another program
/// could.
///
/// JS: on failure the JavaScript rejects with the first error to settle,
/// while its other branches keep reading and writing; this returns the first
/// error in this order and stops. A conflict among one directory's children
/// is found before any of its subtrees is read, as the JavaScript finds it
/// synchronously. What remains timing-dependent in the JavaScript is a
/// conflict inside one subtree against an unreadable or unparsable tree
/// (503) inside another, and a failing blob write against any conflict found
/// while rewriting (this always reports the write's error, which comes
/// first here): either can be reported.
pub fn commit_tree_changes<S: TreeStore>(
    tree: Option<&JsStr>,
    changes: &[(JsStr, Change)],
    oid_length: usize,
    store: &mut S,
) -> Result<JsStr, CommitError<S::Error>> {
    let conflict = CommitError::Invalid(InvalidChangeRecord {
        status: STATUS_CONFLICT,
    });
    // The change tree, built as the JavaScript's nested Maps.
    let mut root: OrderedMap<Node> = OrderedMap::new();
    let mut ordered: OrderedMap<Change> = OrderedMap::new();
    for (key, change) in changes {
        ordered.set(key.clone(), change.clone());
    }
    let ordered: Vec<(JsStr, Change)> = ordered.into_entries().collect();
    for (key, change) in &ordered {
        let parts: Vec<JsStr> = key
            .units()
            .split(|unit| *unit == u16::from(b'/'))
            .map(|part| JsStr::from_units(part.to_vec()))
            .collect();
        let (name, directories) = parts.split_last().expect("split yields one part at least");
        let mut node = &mut root;
        for part in directories {
            if node.get(part).is_none() {
                node.set(part.clone(), Node::Directory(OrderedMap::new()));
            }
            match node.get_mut(part) {
                Some(Node::Directory(child)) => node = child,
                _ => return Err(conflict),
            }
        }
        if let Some(Node::Directory(_)) = node.get(name) {
            return Err(conflict);
        }
        node.set(name.clone(), Node::Leaf(change.clone()));
    }
    // One blob per distinct string, in the order of the changes.
    let mut blobs: HashMap<JsStr, JsStr> = HashMap::new();
    for (_, change) in &ordered {
        if let Change::Blob(value) = change
            && !blobs.contains_key(value)
        {
            let oid = store
                .write_object(ObjectKind::Blob, &value.to_utf8())
                .map_err(CommitError::Store)?;
            blobs.insert(value.clone(), oid);
        }
    }
    // `rewrite(oid, node)`, depth first without recursion.
    let open = |store: &mut S,
                oid: Option<&JsStr>,
                node: OrderedMap<Node>,
                name: Option<JsStr>|
     -> Result<Frame, CommitError<S::Error>> {
        let mut entries = OrderedMap::new();
        // JS: `if (oid)`: an empty string is no tree.
        if let Some(oid) = oid.filter(|oid| !oid.is_empty()) {
            let data = store.read_tree(oid).map_err(CommitError::Store)?;
            for entry in parse_tree(&data, oid_length).map_err(CommitError::Invalid)? {
                entries.set(entry.name.clone(), entry);
            }
        }
        let children: Vec<(JsStr, Node)> = node.into_entries().collect();
        // JS: each child's file-or-directory check runs synchronously as
        // `Promise.all` maps the children, before any subtree's read can
        // settle, so a conflict among this directory's children is reported
        // ahead of any failure inside a subtree. The first conflict in
        // order wins, as `Promise.all` subscribes in order.
        for (name, change) in &children {
            let existing = entries.get(name);
            let conflict = match change {
                Node::Directory(_) => existing.is_some_and(|entry| !entry.is_tree()),
                Node::Leaf(_) => existing.is_some_and(TreeEntry::is_tree),
            };
            if conflict {
                return Err(CommitError::Invalid(InvalidChangeRecord {
                    status: STATUS_CONFLICT,
                }));
            }
        }
        Ok(Frame {
            entries,
            children: children.into_iter(),
            name,
        })
    };
    let mut stack = vec![open(store, tree.filter(|oid| !oid.is_empty()), root, None)?];
    loop {
        let frame = stack
            .last_mut()
            .expect("the root frame is never popped here");
        match frame.children.next() {
            Some((name, Node::Directory(child))) => {
                let existing = frame.entries.get(&name);
                if existing.is_some_and(|entry| !entry.is_tree()) {
                    return Err(conflict);
                }
                let oid = existing.map(|entry| entry.oid.clone());
                let next = open(store, oid.as_ref(), child, Some(name))?;
                stack.push(next);
            }
            Some((name, Node::Leaf(change))) => {
                if frame.entries.get(&name).is_some_and(TreeEntry::is_tree) {
                    return Err(conflict);
                }
                match change {
                    Change::Remove => frame.entries.delete(&name),
                    Change::Blob(value) => {
                        let oid = blobs[&value].clone();
                        frame
                            .entries
                            .set(name.clone(), TreeEntry::new(BLOB_MODE, name, oid));
                    }
                    Change::Existing(oid) => {
                        frame
                            .entries
                            .set(name.clone(), TreeEntry::new(BLOB_MODE, name, oid));
                    }
                }
            }
            None => {
                let frame = stack.pop().expect("a frame is on the stack");
                let is_root = stack.is_empty();
                // Git stores no empty trees below the root.
                let written = if frame.entries.is_empty() && !is_root {
                    None
                } else {
                    let entries: Vec<TreeEntry> = frame.entries.values().cloned().collect();
                    Some(
                        store
                            .write_object(ObjectKind::Tree, &serialize_tree(&entries))
                            .map_err(CommitError::Store)?,
                    )
                };
                let Some(parent) = stack.last_mut() else {
                    return Ok(written.expect("the root is always written"));
                };
                let name = frame.name.expect("a subtree has a name");
                match written {
                    Some(oid) => parent
                        .entries
                        .set(name.clone(), TreeEntry::new(TREE_MODE, name, oid)),
                    None => parent.entries.delete(&name),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> JsStr {
        JsStr::from(text)
    }

    #[test]
    fn a_subtree_sorts_as_if_its_name_ended_in_a_slash() {
        let oid = s("00");
        let entries = vec![
            TreeEntry::new("100644", s("foo0"), oid.clone()),
            TreeEntry::new(TREE_MODE, s("foo"), oid.clone()),
            TreeEntry::new("100644", s("foo.c"), oid.clone()),
            TreeEntry::new("100644", s("foo-"), oid.clone()),
        ];
        let names: Vec<String> = parse_tree(&serialize_tree(&entries), 2)
            .unwrap()
            .into_iter()
            .map(|entry| entry.name.to_string())
            .collect();
        assert_eq!(names, ["foo-", "foo.c", "foo", "foo0"]);
    }

    #[test]
    fn hex_reads_low_bytes_and_stops_at_the_first_bad_pair() {
        assert_eq!(hex_bytes(&[0x130, 0x130]), [0]);
        assert_eq!(hex_bytes(&s("abc").into_units()), [0xab]);
        assert_eq!(hex_bytes(&s("zzab").into_units()), Vec::<u8>::new());
        assert_eq!(hex_bytes(&s("abzz12").into_units()), [0xab]);
        assert_eq!(hex_bytes(&s("AB").into_units()), [0xab]);
    }

    #[test]
    fn a_truncated_tree_is_refused_with_503() {
        let invalid = Err(InvalidChangeRecord { status: 503 });
        assert_eq!(parse_tree(b"100644 a\0\x01", 4), invalid);
        assert_eq!(parse_tree(b"100644", 4), invalid);
        assert_eq!(parse_tree(b"", 4), Ok(Vec::new()));
    }
}

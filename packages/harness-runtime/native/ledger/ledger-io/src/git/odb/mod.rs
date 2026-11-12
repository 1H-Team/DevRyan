//! The ledger repository's object database, read in-process with Git as the
//! oracle (research file 28, `ledger-io::git::odb`, sections 4.2 and 5; plan
//! package L3a), and the loose-object writer of
//! `lib/session-changes-trees.js`.
//!
//! What it reads:
//! - loose objects (`objects/xx/…`, zlib, `<type> <size>\0` header, checked
//!   as Git checks it), and their type and size from the header alone;
//! - packs of version 2 with an index of version 2 (fan-out, binary search,
//!   large offsets, OFS and REF deltas, chains resolved without recursion,
//!   both object-id lengths), type and size from the entry headers and the
//!   delta header alone;
//! - refs: a loose ref file holding one id, otherwise `packed-refs`;
//! - `<tree>:<path>` names and `git ls-tree -r -l -z <tree> [-- <prefix>/]`
//!   listings, with the JavaScript's rule that a tree not in Git's order, or
//!   repeating a name, is not answered here.
//!
//! An object that is not found makes the reader list `objects/pack` again
//! before it reports it missing, as Git does, so a pack written meanwhile
//! (`repack`, and `prune` of the loose copies) is found.
//!
//! **Fail closed.** Every answer is `Ok(Some(_))` (found), `Ok(None)`
//! (absent: every object source was read and fully understood) or
//! `Err(AskGit)`: the reader met something it does not fully understand
//! (`Reason` lists every case) and the caller must ask Git, which answers or
//! fails exactly as before. It never guesses and never reports a missing
//! object it could not rule out.
//!
//! Loose objects are written exactly as the JavaScript writes them (`write`);
//! their zlib bytes differ from Node's zlib, so they are compared by content
//! and id, never as files.
#![forbid(unsafe_code)]

mod config;
mod delta;
mod inflate;
mod loose;
mod pack;
mod refs;
mod repo;
mod walk;
mod write;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex};

pub use refs::{Ref, valid_ref_name};
pub use repo::Repository;
pub use walk::{TreeRow, in_git_order, parse_tree_entries};
pub use write::{LooseEnv, LooseFs, RealLooseFs, SystemLooseEnv, write_loose_object};

use inflate::Source;
use pack::{EntryKind, Pack, PackSet};

/// A repository's object format: the hash of its object ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ObjectFormat {
    Sha1,
    Sha256,
}

impl ObjectFormat {
    /// Bytes of a raw id.
    pub fn raw_len(self) -> usize {
        match self {
            ObjectFormat::Sha1 => 20,
            ObjectFormat::Sha256 => 32,
        }
    }

    /// Characters of a hex id.
    pub fn hex_len(self) -> usize {
        self.raw_len() * 2
    }

    /// The name `rev-parse --show-object-format` prints.
    pub fn name(self) -> &'static str {
        match self {
            ObjectFormat::Sha1 => "sha1",
            ObjectFormat::Sha256 => "sha256",
        }
    }

    /// The format whose hex ids have `length` characters.
    pub fn from_hex_len(length: usize) -> Option<ObjectFormat> {
        match length {
            40 => Some(ObjectFormat::Sha1),
            64 => Some(ObjectFormat::Sha256),
            _ => None,
        }
    }

    /// The digest of the concatenation of `parts`.
    pub fn hash(self, parts: &[&[u8]]) -> Oid {
        use sha1::Digest as _;
        match self {
            ObjectFormat::Sha1 => {
                let mut hasher = sha1::Sha1::new();
                for part in parts {
                    hasher.update(part);
                }
                Oid::from_raw(&hasher.finalize()).expect("a SHA-1 digest is 20 bytes")
            }
            ObjectFormat::Sha256 => {
                let mut hasher = sha2::Sha256::new();
                for part in parts {
                    hasher.update(part);
                }
                Oid::from_raw(&hasher.finalize()).expect("a SHA-256 digest is 32 bytes")
            }
        }
    }

    /// `objectID(type, content, oidLength)`: the hash of `<type> <length>\0`
    /// and the content.
    pub fn object_id(self, kind: Kind, content: &[u8]) -> Oid {
        let header = format!("{} {}\0", kind.name(), content.len());
        self.hash(&[header.as_bytes(), content])
    }
}

/// An object id: 20 or 32 raw bytes.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Oid {
    len: u8,
    bytes: [u8; 32],
}

impl Oid {
    /// An id from its raw bytes (20 or 32 of them).
    pub fn from_raw(raw: &[u8]) -> Option<Oid> {
        if raw.len() != 20 && raw.len() != 32 {
            return None;
        }
        let mut bytes = [0u8; 32];
        bytes[..raw.len()].copy_from_slice(raw);
        Some(Oid {
            len: raw.len() as u8,
            bytes,
        })
    }

    /// An id from 40 or 64 lowercase hex digits, the only spelling the
    /// ledger writes and the reader accepts.
    pub fn from_hex(text: &str) -> Option<Oid> {
        Oid::from_hex_bytes(text.as_bytes())
    }

    /// As `from_hex`, from bytes.
    pub fn from_hex_bytes(text: &[u8]) -> Option<Oid> {
        if text.len() != 40 && text.len() != 64 {
            return None;
        }
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        };
        let mut bytes = [0u8; 32];
        for (index, pair) in text.chunks(2).enumerate() {
            bytes[index] = digit(pair[0])? << 4 | digit(pair[1])?;
        }
        Some(Oid {
            len: (text.len() / 2) as u8,
            bytes,
        })
    }

    pub fn raw(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }

    pub fn format(&self) -> ObjectFormat {
        if self.len == 20 {
            ObjectFormat::Sha1
        } else {
            ObjectFormat::Sha256
        }
    }

    /// Lowercase hex.
    pub fn hex(&self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(self.raw().len() * 2);
        for byte in self.raw() {
            out.push(char::from(DIGITS[usize::from(byte >> 4)]));
            out.push(char::from(DIGITS[usize::from(byte & 15)]));
        }
        out
    }
}

impl fmt::Debug for Oid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.hex())
    }
}

impl fmt::Display for Oid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.hex())
    }
}

/// A Git object type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Commit,
    Tree,
    Blob,
    Tag,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Commit => "commit",
            Kind::Tree => "tree",
            Kind::Blob => "blob",
            Kind::Tag => "tag",
        }
    }

    /// The type of a loose object's header.
    pub fn from_name(name: &[u8]) -> Option<Kind> {
        match name {
            b"commit" => Some(Kind::Commit),
            b"tree" => Some(Kind::Tree),
            b"blob" => Some(Kind::Blob),
            b"tag" => Some(Kind::Tag),
            _ => None,
        }
    }

    /// The type number of a pack entry (1 to 4).
    pub fn from_pack_type(number: u8) -> Option<Kind> {
        match number {
            1 => Some(Kind::Commit),
            2 => Some(Kind::Tree),
            3 => Some(Kind::Blob),
            4 => Some(Kind::Tag),
            _ => None,
        }
    }
}

/// Why the reader asks Git instead of answering. Every case the reader does
/// not fully understand has its own reason; none of them is ever reported as
/// "absent".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Reason {
    /// Not a repository the reader can open: not a directory, no `objects`,
    /// a linked worktree's `commondir`, `core.repositoryformatversion` other
    /// than 0 or 1, or a configuration file it cannot parse.
    RepositoryFormat,
    /// An `extensions.*` key: anything but `objectFormat` (sha1, sha256) in a
    /// version 1 repository, `refStorage` (reftable), `partialClone` and
    /// `compatObjectFormat` included, or any extension in version 0.
    Extension,
    /// `objects/info/alternates` exists: a missing object may be there.
    Alternates,
    /// A promisor remote or `.promisor` pack: a missing object may be fetched.
    Promisor,
    /// `refs/replace/` holds refs: Git would answer with the replacement.
    ReplaceRefs,
    /// A multi-pack index exists and the object is in none of the pack
    /// indexes the reader read.
    MultiPackIndex,
    /// A `.pack` without its `.idx`, or an `.idx` whose `.pack` is gone, and
    /// the object was not found elsewhere.
    UnindexedPack,
    /// `objects/pack` kept changing over every rescan.
    UnstablePacks,
    /// A pack of a version other than 2.
    PackVersion,
    /// A pack index of a version other than 2 (version 1 included).
    IndexVersion,
    /// A pack index the reader refuses: wrong size, non-monotonic fan-out,
    /// unsorted ids, checksum mismatch, a large offset outside its table.
    CorruptIndex,
    /// A pack the reader refuses: bad header, object count or checksum
    /// unlike its index, an entry it cannot parse, a missing delta base.
    CorruptPack,
    /// An object the reader refuses: zlib error, bad or unknown header,
    /// size unlike the declared one, trailing bytes, an invalid delta.
    CorruptObject,
    /// A declared object or delta size above `OdbOptions::max_object_bytes`.
    TooLarge,
    /// A delta chain longer than `OdbOptions::max_delta_depth`.
    DeltaDepth,
    /// A REF delta chain that returns to an entry it already visited.
    DeltaCycle,
    /// A chain that would produce more than `OdbOptions::delta_budget_bytes`.
    DeltaBudget,
    /// The content does not hash to the id it was read under (id check).
    IdMismatch,
    /// A system error other than "not found" while reading.
    Io,
    /// A ref that is not one plain id: symbolic, a symlink, odd content, the
    /// other id length, malformed `packed-refs`.
    RefFormat,
    /// A ref name or pattern outside the simple form the reader checks.
    RefName,
    /// A tree on the walk that is not in Git's order or repeats a name.
    TreeOrder,
    /// A tree entry mode `ls-tree` would print differently.
    TreeMode,
    /// An object a listing needs is missing, or not of the type it needs.
    TreeMissing,
    /// A tree that cannot be parsed.
    TreeFormat,
    /// A listing deeper or larger than its bounds.
    TreeLimit,
    /// A `<tree>:<path>` name or listing prefix in a form Git might read
    /// otherwise (relative, empty components, short or uppercase ids).
    NameSyntax,
    /// `<commit>:<path>` or `<tag>:<path>`: Git would peel to the tree.
    Peel,
}

impl Reason {
    /// The stable code the probe prints and the documentation lists.
    pub fn code(self) -> &'static str {
        match self {
            Reason::RepositoryFormat => "repository_format",
            Reason::Extension => "extension",
            Reason::Alternates => "alternates",
            Reason::Promisor => "promisor",
            Reason::ReplaceRefs => "replace_refs",
            Reason::MultiPackIndex => "multi_pack_index",
            Reason::UnindexedPack => "unindexed_pack",
            Reason::UnstablePacks => "unstable_packs",
            Reason::PackVersion => "pack_version",
            Reason::IndexVersion => "index_version",
            Reason::CorruptIndex => "corrupt_index",
            Reason::CorruptPack => "corrupt_pack",
            Reason::CorruptObject => "corrupt_object",
            Reason::TooLarge => "too_large",
            Reason::DeltaDepth => "delta_depth",
            Reason::DeltaCycle => "delta_cycle",
            Reason::DeltaBudget => "delta_budget",
            Reason::IdMismatch => "id_mismatch",
            Reason::Io => "io",
            Reason::RefFormat => "ref_format",
            Reason::RefName => "ref_name",
            Reason::TreeOrder => "tree_order",
            Reason::TreeMode => "tree_mode",
            Reason::TreeMissing => "tree_missing",
            Reason::TreeFormat => "tree_format",
            Reason::TreeLimit => "tree_limit",
            Reason::NameSyntax => "name_syntax",
            Reason::Peel => "peel",
        }
    }
}

/// "Ask Git": the reader cannot answer exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskGit {
    pub reason: Reason,
    /// What it met, for diagnostics (never file contents).
    pub detail: String,
}

impl AskGit {
    pub fn new(reason: Reason, detail: impl Into<String>) -> AskGit {
        AskGit {
            reason,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for AskGit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ask git: {} ({})",
            self.reason.code(),
            self.detail
        )
    }
}

/// `Ok(value)` or "ask Git".
pub type Answer<T> = Result<T, AskGit>;

pub(crate) fn ask<T>(reason: Reason, detail: impl Into<String>) -> Answer<T> {
    Err(AskGit::new(reason, detail))
}

pub(crate) fn io_ask(error: &std::io::Error, what: &str) -> AskGit {
    AskGit::new(
        Reason::Io,
        format!(
            "{what}: {}",
            error
                .raw_os_error()
                .map_or_else(|| error.kind().to_string(), crate::fs::error_name)
        ),
    )
}

/// Bounds of one read. Above any of them the reader asks Git.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OdbOptions {
    /// Largest object, or delta, the reader inflates.
    pub max_object_bytes: u64,
    /// Longest delta chain it follows.
    pub max_delta_depth: usize,
    /// Most bytes one chain may produce, its deltas' results summed.
    pub delta_budget_bytes: u64,
    /// Hash every object read in full and compare with its id.
    pub verify_ids: bool,
    /// Deepest tree a listing descends into.
    pub max_tree_depth: usize,
    /// Most rows one listing returns.
    pub max_listing_rows: usize,
}

impl Default for OdbOptions {
    fn default() -> OdbOptions {
        OdbOptions {
            max_object_bytes: 256 * 1024 * 1024,
            max_delta_depth: 10_000,
            delta_budget_bytes: 1024 * 1024 * 1024,
            verify_ids: false,
            max_tree_depth: 4096,
            max_listing_rows: 10_000_000,
        }
    }
}

/// An object's type and size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectInfo {
    pub kind: Kind,
    pub size: u64,
}

/// An object's type and content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub kind: Kind,
    pub data: Vec<u8>,
}

/// What a `cat-file` name resolved to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameLookup {
    /// The object: Git prints `<id> <type> <size>` (and the content).
    Found(Named),
    /// Nothing: Git prints `<name> missing`.
    Missing,
    /// `<tree>:<path>` naming a gitlink whose commit is not in the
    /// repository: Git prints `<id> submodule`.
    Submodule(Oid),
}

/// A resolved name's id, as Git prints it, and its object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub oid: Oid,
    pub kind: Kind,
    pub size: u64,
    /// The content, unless only the type and size were asked for.
    pub data: Option<Vec<u8>>,
}

/// Where an object was found.
enum Located {
    Packed(Arc<Pack>, u64),
    Loose(loose::LooseFile),
}

/// The object database of one repository. `Sync`: concurrent reads share
/// the pack list, which a miss refreshes.
pub struct Odb {
    repo: Repository,
    options: OdbOptions,
    packs: Mutex<PackSet>,
}

/// How many times a miss lists `objects/pack` again while packs vanish under it.
const RESCANS: usize = 5;

impl Odb {
    /// Opens the repository at `git_dir` (a bare repository or a `.git`
    /// directory). Asks Git for any repository it does not fully understand.
    pub fn open(git_dir: &str, options: OdbOptions) -> Answer<Odb> {
        Ok(Odb {
            repo: Repository::open(git_dir)?,
            options,
            packs: Mutex::new(PackSet::default()),
        })
    }

    pub fn repository(&self) -> &Repository {
        &self.repo
    }

    pub fn format(&self) -> ObjectFormat {
        self.repo.format()
    }

    pub fn options(&self) -> &OdbOptions {
        &self.options
    }

    fn check_id(&self, oid: &Oid) -> Answer<()> {
        if oid.format() != self.format() {
            return ask(Reason::NameSyntax, "an id of the other object format");
        }
        Ok(())
    }

    /// The type and size of an object, from its header alone where the format
    /// allows (a loose header; a pack entry header and, for a delta, the
    /// delta's own header and its chain's entry headers).
    pub fn info(&self, oid: &Oid) -> Answer<Option<ObjectInfo>> {
        self.check_id(oid)?;
        self.repo.check_replace_refs()?;
        if self.options.verify_ids {
            return Ok(self.read_object(oid, true)?.map(|object| ObjectInfo {
                kind: object.kind,
                size: object.data.len() as u64,
            }));
        }
        self.info_unchecked(oid)
    }

    fn info_unchecked(&self, oid: &Oid) -> Answer<Option<ObjectInfo>> {
        match self.locate(oid)? {
            None => Ok(None),
            Some(Located::Loose(file)) => file.info(&self.options).map(Some),
            Some(Located::Packed(pack, offset)) => self.packed_info(&pack, offset).map(Some),
        }
    }

    /// An object's type and content. With `OdbOptions::verify_ids` the
    /// content is hashed and compared with `oid`.
    pub fn read(&self, oid: &Oid) -> Answer<Option<Object>> {
        self.check_id(oid)?;
        self.repo.check_replace_refs()?;
        self.read_object(oid, self.options.verify_ids)
    }

    /// As `read`, always checking the id.
    pub fn read_verified(&self, oid: &Oid) -> Answer<Option<Object>> {
        self.check_id(oid)?;
        self.repo.check_replace_refs()?;
        self.read_object(oid, true)
    }

    fn read_object(&self, oid: &Oid, verify: bool) -> Answer<Option<Object>> {
        let object = match self.locate(oid)? {
            None => return Ok(None),
            Some(Located::Loose(file)) => file.read(&self.options)?,
            Some(Located::Packed(pack, offset)) => self.read_packed(&pack, offset)?,
        };
        if verify && self.format().object_id(object.kind, &object.data) != *oid {
            return ask(Reason::IdMismatch, format!("{oid}"));
        }
        Ok(Some(object))
    }

    /// One `cat-file --batch` (or, with `check`, `--batch-check`) name: a full
    /// lowercase id or `<tree id>:<path>`. Git's other spellings ask Git.
    pub fn read_name(&self, name: &[u8], check: bool) -> Answer<NameLookup> {
        self.repo.check_replace_refs()?;
        let (oid, gitlink) = match name.iter().position(|byte| *byte == b':') {
            None => (
                Oid::from_hex_bytes(name)
                    .ok_or_else(|| AskGit::new(Reason::NameSyntax, "not a full lowercase id"))?,
                false,
            ),
            Some(colon) => {
                let tree = Oid::from_hex_bytes(&name[..colon]).ok_or_else(|| {
                    AskGit::new(Reason::NameSyntax, "not a full lowercase id before ':'")
                })?;
                self.check_id(&tree)?;
                match walk::resolve_path(self, &tree, &name[colon + 1..])? {
                    None => return Ok(NameLookup::Missing),
                    Some((oid, mode)) => (oid, mode == b"160000"),
                }
            }
        };
        self.check_id(&oid)?;
        let found = if check && !self.options.verify_ids {
            self.info_unchecked(&oid)?.map(|info| Named {
                oid,
                kind: info.kind,
                size: info.size,
                data: None,
            })
        } else {
            self.read_object(&oid, self.options.verify_ids)?
                .map(|object| Named {
                    oid,
                    kind: object.kind,
                    size: object.data.len() as u64,
                    data: (!check).then_some(object.data),
                })
        };
        Ok(match found {
            Some(named) => NameLookup::Found(named),
            // `batch_object_write`: a missing object named through a gitlink entry.
            None if gitlink => NameLookup::Submodule(oid),
            None => NameLookup::Missing,
        })
    }

    /// `<tree>:<path>` as Git resolves it (`get_tree_entry`): the entry's id
    /// and mode, or absent. Asks Git for a root that is a commit or tag, a
    /// tree not in Git's order on the path, and any path Git might read
    /// otherwise (empty, relative, empty components).
    pub fn resolve_path(&self, tree: &Oid, path: &[u8]) -> Answer<Option<(Oid, Vec<u8>)>> {
        self.check_id(tree)?;
        self.repo.check_replace_refs()?;
        walk::resolve_path(self, tree, path)
    }

    /// The rows `git ls-tree -r -l -z <tree>` prints, or with a prefix those of
    /// `git --literal-pathspecs ls-tree -r -l -z <tree> -- <prefix>/`, in its
    /// order (see `walk`).
    pub fn list_tree(&self, tree: &Oid, prefix: Option<&str>) -> Answer<Vec<TreeRow>> {
        self.check_id(tree)?;
        self.repo.check_replace_refs()?;
        walk::list_tree(self, tree, prefix)
    }

    /// Every object id in the repository, sorted and without repeats, as
    /// `cat-file --batch-all-objects` visits them: loose objects with a
    /// well-formed name and every object of every pack index.
    pub fn all_object_ids(&self) -> Answer<Vec<Oid>> {
        self.repo.check_replace_refs()?;
        let (packs, unknown) = self.rescan()?;
        if let Some(unknown) = unknown {
            return Err(unknown);
        }
        if let Some(reason) = self.repo.miss_reason() {
            return Err(reason);
        }
        let mut ids: Vec<Oid> = loose::list(self.repo.git_dir(), self.format())?;
        for pack in &packs {
            for index in 0..pack.index.count() {
                ids.push(pack.index.oid_at(index));
            }
        }
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }

    /// The packs already listed (listing them the first time).
    fn current_packs(&self) -> Answer<Vec<Arc<Pack>>> {
        {
            let state = self
                .packs
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.scanned {
                return Ok(state.packs.clone());
            }
        }
        Ok(self.rescan()?.0)
    }

    /// Lists `objects/pack` again, keeping the packs whose index did not
    /// change, until nothing vanished during a listing (at most `RESCANS`
    /// times). Returns the packs and, when something there is not
    /// understood, the reason a miss must ask Git.
    fn rescan(&self) -> Answer<(Vec<Arc<Pack>>, Option<AskGit>)> {
        let mut state = self
            .packs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for attempt in 1..=RESCANS {
            let scan = pack::scan(&self.repo, &state)?;
            state.next_id = scan.next_id;
            state.packs = scan.packs;
            state.scanned = true;
            state.unknown = scan.unknown;
            if !scan.unstable {
                break;
            }
            if attempt == RESCANS {
                state.unknown = Some(AskGit::new(
                    Reason::UnstablePacks,
                    "packs vanished during every listing",
                ));
            }
        }
        Ok((state.packs.clone(), state.unknown.clone()))
    }

    /// Where `oid` is: the packs listed, then the loose object, then, after
    /// listing the packs again, both once more (Git's order). Absent only
    /// when nothing the reader did not understand could hold it.
    fn locate(&self, oid: &Oid) -> Answer<Option<Located>> {
        let packs = self.current_packs()?;
        if let Some(found) = find_packed(&packs, oid)? {
            return Ok(Some(found));
        }
        if let Some(file) = loose::open(self.repo.git_dir(), oid)? {
            return Ok(Some(Located::Loose(file)));
        }
        let (packs, unknown) = self.rescan()?;
        if let Some(found) = find_packed(&packs, oid)? {
            return Ok(Some(found));
        }
        if let Some(file) = loose::open(self.repo.git_dir(), oid)? {
            return Ok(Some(Located::Loose(file)));
        }
        if let Some(unknown) = unknown {
            return Err(unknown);
        }
        if let Some(reason) = self.repo.miss_reason() {
            return Err(reason);
        }
        Ok(None)
    }

    /// A packed object: its delta chain followed to its base without
    /// recursion (OFS and REF bases both in the same pack, as Git resolves
    /// them), then the deltas applied from the base up.
    fn read_packed(&self, pack: &Arc<Pack>, offset: u64) -> Answer<Object> {
        let limit = self.options.max_object_bytes;
        let mut deltas: Vec<(Arc<Pack>, u64, u64)> = Vec::new();
        let mut seen: HashSet<(u64, u64)> = HashSet::new();
        let mut current = (Arc::clone(pack), offset);
        let base = loop {
            if deltas.len() > self.options.max_delta_depth {
                return ask(
                    Reason::DeltaDepth,
                    format!("more than {} deltas", self.options.max_delta_depth),
                );
            }
            if !seen.insert((current.0.id, current.1)) {
                return ask(
                    Reason::DeltaCycle,
                    format!("entry at {} visited twice", current.1),
                );
            }
            let entry = current.0.entry(current.1)?;
            match entry.kind {
                EntryKind::Object(kind) => {
                    if entry.size > limit {
                        return ask(Reason::TooLarge, format!("{} bytes", entry.size));
                    }
                    let data = current.0.inflate(entry.data_start, entry.size)?;
                    break Object { kind, data };
                }
                EntryKind::Ofs(base_offset) => {
                    deltas.push((Arc::clone(&current.0), entry.data_start, entry.size));
                    current.1 = base_offset;
                }
                EntryKind::Ref(base) => {
                    deltas.push((Arc::clone(&current.0), entry.data_start, entry.size));
                    current.1 = ref_base_in_pack(&current.0, &base)?;
                }
            }
        };
        let mut result = base;
        let mut produced = 0u64;
        for (pack, data_start, size) in deltas.iter().rev() {
            if *size > limit {
                return ask(Reason::TooLarge, format!("a delta of {size} bytes"));
            }
            let delta = pack.inflate(*data_start, *size)?;
            let (_, target) = delta::sizes(&delta)
                .ok_or_else(|| AskGit::new(Reason::CorruptObject, "delta header"))?;
            if target > limit {
                return ask(
                    Reason::TooLarge,
                    format!("a delta result of {target} bytes"),
                );
            }
            produced = produced.saturating_add(target);
            if produced > self.options.delta_budget_bytes {
                return ask(
                    Reason::DeltaBudget,
                    format!("more than {} bytes", self.options.delta_budget_bytes),
                );
            }
            result.data = delta::apply(&result.data, &delta)
                .ok_or_else(|| AskGit::new(Reason::CorruptObject, "delta does not apply"))?;
        }
        Ok(result)
    }

    /// A packed object's type and size: the size from its entry header or,
    /// for a delta, from the delta's header; the type from its chain's base,
    /// reading only entry headers.
    fn packed_info(&self, pack: &Arc<Pack>, offset: u64) -> Answer<ObjectInfo> {
        let top = pack.entry(offset)?;
        let size = match top.kind {
            EntryKind::Object(kind) => {
                return Ok(ObjectInfo {
                    kind,
                    size: top.size,
                });
            }
            EntryKind::Ofs(_) | EntryKind::Ref(_) => {
                let head = pack.inflate_prefix(top.data_start, 20)?;
                delta::sizes(&head)
                    .ok_or_else(|| AskGit::new(Reason::CorruptObject, "delta header"))?
                    .1
            }
        };
        let mut seen: HashSet<(u64, u64)> = HashSet::new();
        let mut current = (Arc::clone(pack), offset);
        let mut depth = 0usize;
        loop {
            if depth > self.options.max_delta_depth {
                return ask(
                    Reason::DeltaDepth,
                    format!("more than {} deltas", self.options.max_delta_depth),
                );
            }
            if !seen.insert((current.0.id, current.1)) {
                return ask(
                    Reason::DeltaCycle,
                    format!("entry at {} visited twice", current.1),
                );
            }
            let entry = current.0.entry(current.1)?;
            match entry.kind {
                EntryKind::Object(kind) => return Ok(ObjectInfo { kind, size }),
                EntryKind::Ofs(base_offset) => current.1 = base_offset,
                EntryKind::Ref(base) => current.1 = ref_base_in_pack(&current.0, &base)?,
            }
            depth += 1;
        }
    }
}

/// The offset of a REF delta's base in the delta's own pack. Git looks for
/// it nowhere else (`get_delta_base` reads only that pack's index) and
/// reports the object missing when it is not there, so a base elsewhere,
/// loose or in another pack, asks Git rather than being answered.
fn ref_base_in_pack(pack: &Pack, base: &Oid) -> Answer<u64> {
    match pack.index.find(base)? {
        Some(offset) => Ok(offset),
        None => ask(
            Reason::CorruptPack,
            format!("REF delta base {base} outside its pack"),
        ),
    }
}

fn find_packed(packs: &[Arc<Pack>], oid: &Oid) -> Answer<Option<Located>> {
    for pack in packs {
        if let Some(offset) = pack.index.find(oid)? {
            return Ok(Some(Located::Packed(Arc::clone(pack), offset)));
        }
    }
    Ok(None)
}

/// The bytes a source holds from `offset`, as many as `buffer` takes or up to
/// the end; fewer only at the end.
pub(crate) fn read_fully(
    source: &dyn Source,
    offset: u64,
    buffer: &mut [u8],
) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        let read = source.read_at(offset + filled as u64, &mut buffer[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

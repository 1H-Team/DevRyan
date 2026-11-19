//! Packs of version 2 and their indexes of version 2 (`packfile.c`,
//! `Documentation/gitformat-pack.txt`), and the listing of `objects/pack`.
//!
//! An index is read whole and checked before any lookup: magic and version,
//! a monotonic fan-out, the size Git's `load_idx` requires, ids strictly
//! increasing and in their fan-out bucket, and its trailing checksum. Its pack
//! must be version 2 with the index's object count and, as its trailer, the
//! pack checksum the index records. Entry headers, OFS offsets and REF ids are
//! parsed as `unpack_object_header_buffer` and `get_delta_base` parse them.
#![forbid(unsafe_code)]

use std::collections::BTreeSet;
use std::sync::Arc;

use super::inflate::{FileSource, InflateError, Source, inflate, inflate_exact};
use super::repo::Repository;
use super::{Answer, AskGit, Kind, ObjectFormat, Oid, Reason, ask, io_ask, read_fully};

const INDEX_MAGIC: [u8; 4] = [0xff, b't', b'O', b'c'];
const PACK_MAGIC: &[u8; 4] = b"PACK";
const PACK_HEADER: u64 = 12;

/// A pack index of version 2, checked.
pub(crate) struct PackIndex {
    data: Vec<u8>,
    format: ObjectFormat,
    count: usize,
    large_count: usize,
}

fn be32(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

impl PackIndex {
    /// Parses and checks an index file's bytes.
    pub(crate) fn parse(data: Vec<u8>, format: ObjectFormat) -> Answer<PackIndex> {
        let hash = format.raw_len();
        if data.len() < 8 || data[..4] != INDEX_MAGIC {
            return ask(
                Reason::IndexVersion,
                "a pack index without the version 2 magic (version 1 or not an index)",
            );
        }
        if be32(&data, 4) != 2 {
            return ask(
                Reason::IndexVersion,
                format!("pack index version {}", be32(&data, 4)),
            );
        }
        if data.len() < 8 + 1024 + 2 * hash {
            return ask(Reason::CorruptIndex, "shorter than its header");
        }
        let mut count = 0u32;
        for bucket in 0..256 {
            let value = be32(&data, 8 + 4 * bucket);
            if value < count {
                return ask(Reason::CorruptIndex, "non-monotonic fan-out");
            }
            count = value;
        }
        let count = count as usize;
        let min = count
            .checked_mul(hash + 8)
            .and_then(|entries| entries.checked_add(8 + 1024 + 2 * hash))
            .ok_or_else(|| AskGit::new(Reason::CorruptIndex, "object count"))?;
        let max = min + count.saturating_sub(1) * 8;
        if data.len() < min || data.len() > max {
            return ask(Reason::CorruptIndex, "wrong index v2 file size");
        }
        let checksum = &data[data.len() - hash..];
        if format.hash(&[&data[..data.len() - hash]]).raw() != checksum {
            return ask(Reason::CorruptIndex, "index checksum mismatch");
        }
        let index = PackIndex {
            large_count: (data.len() - min) / 8,
            data,
            format,
            count,
        };
        let mut bucket_end = 0usize;
        let mut previous: Option<&[u8]> = None;
        for first in 0..256usize {
            let end = be32(&index.data, 8 + 4 * first) as usize;
            for position in bucket_end..end {
                let oid = index.oid_bytes(position);
                if usize::from(oid[0]) != first || previous.is_some_and(|before| before >= oid) {
                    return ask(Reason::CorruptIndex, "ids out of order");
                }
                previous = Some(oid);
            }
            bucket_end = end;
        }
        Ok(index)
    }

    pub(crate) fn count(&self) -> usize {
        self.count
    }

    fn oid_bytes(&self, position: usize) -> &[u8] {
        let hash = self.format.raw_len();
        let at = 8 + 1024 + position * hash;
        &self.data[at..at + hash]
    }

    pub(crate) fn oid_at(&self, position: usize) -> Oid {
        Oid::from_raw(self.oid_bytes(position)).expect("an index id has the repository's length")
    }

    /// The pack checksum the index records.
    fn pack_checksum(&self) -> &[u8] {
        let hash = self.format.raw_len();
        &self.data[self.data.len() - 2 * hash..self.data.len() - hash]
    }

    /// `nth_packed_object_offset`: a 31-bit offset, or with its top bit set
    /// the position of a 64-bit one in the large-offset table.
    pub(crate) fn offset_at(&self, position: usize) -> Answer<u64> {
        let hash = self.format.raw_len();
        let offsets = 8 + 1024 + self.count * (hash + 4);
        let small = be32(&self.data, offsets + 4 * position);
        if small & 0x8000_0000 == 0 {
            return Ok(u64::from(small));
        }
        let large = (small & 0x7fff_ffff) as usize;
        if large >= self.large_count {
            return ask(Reason::CorruptIndex, "large offset beyond its table");
        }
        let at = offsets + 4 * self.count + 8 * large;
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.data[at..at + 8]);
        Ok(u64::from_be_bytes(bytes))
    }

    /// Binary search within the fan-out bucket of `oid`'s first byte.
    pub(crate) fn find(&self, oid: &Oid) -> Answer<Option<u64>> {
        if oid.format() != self.format {
            return Ok(None);
        }
        let first = usize::from(oid.raw()[0]);
        let mut low = if first == 0 {
            0
        } else {
            be32(&self.data, 8 + 4 * (first - 1)) as usize
        };
        let mut high = be32(&self.data, 8 + 4 * first) as usize;
        while low < high {
            let middle = low + (high - low) / 2;
            match self.oid_bytes(middle).cmp(oid.raw()) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return self.offset_at(middle).map(Some),
            }
        }
        Ok(None)
    }
}

/// What a pack entry holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntryKind {
    Object(Kind),
    /// An OFS delta and its base's offset in the same pack.
    Ofs(u64),
    /// A REF delta and its base's id.
    Ref(Oid),
}

/// A parsed entry header.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Entry {
    pub kind: EntryKind,
    /// The inflated size of the entry's data (for a delta, of the delta).
    pub size: u64,
    /// Where the entry's zlib stream starts.
    pub data_start: u64,
}

/// A pack and its index, both checked, the pack open.
pub(crate) struct Pack {
    /// Unique within one `Odb`, for cycle detection.
    pub id: u64,
    pub name: String,
    pub index: PackIndex,
    source: Box<dyn Source>,
    stamp: Stamp,
}

/// What identifies an index file on disk between two listings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_ns: i64,
}

impl Stamp {
    fn of(metadata: &std::fs::Metadata) -> Stamp {
        use std::os::unix::fs::MetadataExt;
        Stamp {
            dev: metadata.dev(),
            ino: metadata.ino(),
            size: metadata.size(),
            mtime: metadata.mtime(),
            mtime_ns: metadata.mtime_nsec(),
        }
    }
}

fn corrupt_pack(name: &str, what: &str) -> AskGit {
    AskGit::new(Reason::CorruptPack, format!("{name}: {what}"))
}

impl Pack {
    /// A pack from its bytes and its checked index: version 2, the index's
    /// object count, the index's pack checksum as its trailer.
    #[cfg(test)]
    pub(crate) fn new(
        id: u64,
        name: &str,
        index: PackIndex,
        source: Box<dyn Source>,
    ) -> Answer<Pack> {
        Pack::with_stamp(
            id,
            name,
            index,
            source,
            Stamp {
                dev: 0,
                ino: 0,
                size: 0,
                mtime: 0,
                mtime_ns: 0,
            },
        )
    }

    fn with_stamp(
        id: u64,
        name: &str,
        index: PackIndex,
        source: Box<dyn Source>,
        stamp: Stamp,
    ) -> Answer<Pack> {
        let hash = index.format.raw_len() as u64;
        let mut header = [0u8; PACK_HEADER as usize];
        let read =
            read_fully(source.as_ref(), 0, &mut header).map_err(|error| io_ask(&error, "pack"))?;
        if read < header.len() || &header[..4] != PACK_MAGIC {
            return Err(corrupt_pack(name, "not a pack"));
        }
        let version = be32(&header, 4);
        if version != 2 {
            return ask(
                Reason::PackVersion,
                format!("{name}: pack version {version}"),
            );
        }
        if be32(&header, 8) as usize != index.count() {
            return Err(corrupt_pack(name, "object count unlike its index"));
        }
        if source.size() < PACK_HEADER + hash {
            return Err(corrupt_pack(name, "shorter than its header and trailer"));
        }
        let mut trailer = vec![0u8; hash as usize];
        read_fully(source.as_ref(), source.size() - hash, &mut trailer)
            .map_err(|error| io_ask(&error, "pack"))?;
        if trailer != index.pack_checksum() {
            return Err(corrupt_pack(name, "does not match its index"));
        }
        Ok(Pack {
            id,
            name: name.to_owned(),
            index,
            source,
            stamp,
        })
    }

    /// Where entries end: before the trailing checksum.
    fn data_end(&self) -> u64 {
        self.source.size() - self.index.format.raw_len() as u64
    }

    /// `unpack_object_header_buffer` and `get_delta_base` at `offset`.
    pub(crate) fn entry(&self, offset: u64) -> Answer<Entry> {
        let end = self.data_end();
        if offset < PACK_HEADER || offset >= end {
            return Err(corrupt_pack(&self.name, "entry offset outside the pack"));
        }
        let mut window = [0u8; 16 + 32];
        let available = ((end - offset).min(window.len() as u64)) as usize;
        let read = read_fully(self.source.as_ref(), offset, &mut window[..available])
            .map_err(|error| io_ask(&error, "pack"))?;
        let window = &window[..read];
        let mut used = 0usize;
        let first = *window
            .first()
            .ok_or_else(|| corrupt_pack(&self.name, "entry truncated"))?;
        used += 1;
        let type_number = (first >> 4) & 7;
        let mut size = u64::from(first & 15);
        let mut shift = 4u32;
        let mut byte = first;
        while byte & 0x80 != 0 {
            if used >= window.len() || shift > 64 - 7 {
                return Err(corrupt_pack(&self.name, "bad object header"));
            }
            byte = window[used];
            used += 1;
            size += u64::from(byte & 0x7f) << shift;
            shift += 7;
        }
        let kind = match type_number {
            6 => {
                let mut byte = *window
                    .get(used)
                    .ok_or_else(|| corrupt_pack(&self.name, "delta offset truncated"))?;
                used += 1;
                let mut base = u64::from(byte & 127);
                while byte & 128 != 0 {
                    base += 1;
                    if base >> 57 != 0 {
                        return Err(corrupt_pack(&self.name, "delta offset overflows"));
                    }
                    byte = *window
                        .get(used)
                        .ok_or_else(|| corrupt_pack(&self.name, "delta offset truncated"))?;
                    used += 1;
                    base = (base << 7) + u64::from(byte & 127);
                }
                if base == 0 || base >= offset {
                    return Err(corrupt_pack(&self.name, "delta base offset out of bound"));
                }
                EntryKind::Ofs(offset - base)
            }
            7 => {
                let hash = self.index.format.raw_len();
                let raw = window
                    .get(used..used + hash)
                    .ok_or_else(|| corrupt_pack(&self.name, "delta base id truncated"))?;
                used += hash;
                EntryKind::Ref(Oid::from_raw(raw).expect("a raw id of the repository's length"))
            }
            number => EntryKind::Object(Kind::from_pack_type(number).ok_or_else(|| {
                corrupt_pack(&self.name, &format!("unknown object type {number}"))
            })?),
        };
        Ok(Entry {
            kind,
            size,
            data_start: offset + used as u64,
        })
    }

    fn refused(&self, error: InflateError) -> AskGit {
        match error {
            InflateError::Corrupt(what) => {
                AskGit::new(Reason::CorruptObject, format!("{}: {what}", self.name))
            }
            InflateError::Io(error) => io_ask(&error, "pack"),
        }
    }

    /// An entry's data, which must inflate to exactly `size` bytes.
    pub(crate) fn inflate(&self, start: u64, size: u64) -> Answer<Vec<u8>> {
        inflate_exact(self.source.as_ref(), start, self.data_end(), size)
            .map(|inflated| inflated.data)
            .map_err(|error| self.refused(error))
    }

    /// At most the first `count` bytes of an entry's data.
    pub(crate) fn inflate_prefix(&self, start: u64, count: usize) -> Answer<Vec<u8>> {
        inflate(self.source.as_ref(), start, self.data_end(), count)
            .map(|inflated| inflated.data)
            .map_err(|error| self.refused(error))
    }
}

/// The packs an `Odb` has listed.
#[derive(Default)]
pub(crate) struct PackSet {
    pub packs: Vec<Arc<Pack>>,
    pub scanned: bool,
    /// Why a miss must ask Git: something in `objects/pack` not understood.
    pub unknown: Option<AskGit>,
    pub next_id: u64,
}

/// One listing of `objects/pack`.
pub(crate) struct Scan {
    pub packs: Vec<Arc<Pack>>,
    pub unknown: Option<AskGit>,
    /// An index or pack vanished between the listing and its opening.
    pub unstable: bool,
    /// The highest pack id handed out so far.
    pub next_id: u64,
}

fn not_found(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

/// Lists `objects/pack` as `prepare_packed_git_one` does: every `*.idx` with
/// its `.pack`. Packs already open whose index is unchanged are kept. What a
/// miss cannot rule out (a multi-pack index, a `.promisor` pack, a `.pack`
/// without an index, an index the reader refuses) becomes `unknown`.
pub(crate) fn scan(repo: &Repository, state: &PackSet) -> Answer<Scan> {
    let directory = format!("{}/objects/pack", repo.git_dir());
    let mut names = BTreeSet::new();
    match std::fs::read_dir(&directory) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| io_ask(&error, "objects/pack"))?;
                match entry.file_name().into_string() {
                    Ok(name) => {
                        names.insert(name);
                    }
                    Err(_) => {
                        return ask(
                            Reason::UnindexedPack,
                            "a name in objects/pack that is not UTF-8",
                        );
                    }
                }
            }
        }
        Err(error) if not_found(&error) => {}
        Err(error) => return Err(io_ask(&error, "objects/pack")),
    }
    let mut unknown: Option<AskGit> = None;
    let mut note = |reason: AskGit| {
        unknown.get_or_insert(reason);
    };
    for name in &names {
        if name.starts_with("multi-pack-index") {
            note(AskGit::new(Reason::MultiPackIndex, name.clone()));
        } else if name.ends_with(".promisor") {
            note(AskGit::new(Reason::Promisor, name.clone()));
        } else if let Some(base) = name.strip_suffix(".pack")
            && !names.contains(&format!("{base}.idx"))
        {
            note(AskGit::new(Reason::UnindexedPack, name.clone()));
        }
    }
    let mut packs = Vec::new();
    let mut unstable = false;
    let mut next_id = state.next_id;
    for name in names.iter().filter(|name| name.ends_with(".idx")) {
        let base = &name[..name.len() - 4];
        let index_path = format!("{directory}/{name}");
        let metadata = match std::fs::metadata(&index_path) {
            Ok(metadata) => metadata,
            Err(error) if not_found(&error) => {
                unstable = true;
                continue;
            }
            Err(error) => return Err(io_ask(&error, "pack index")),
        };
        let stamp = Stamp::of(&metadata);
        if let Some(kept) = state
            .packs
            .iter()
            .find(|pack| pack.name == *base && pack.stamp == stamp)
        {
            packs.push(Arc::clone(kept));
            continue;
        }
        let data = match std::fs::read(&index_path) {
            Ok(data) => data,
            Err(error) if not_found(&error) => {
                unstable = true;
                continue;
            }
            Err(error) => return Err(io_ask(&error, "pack index")),
        };
        let index = match PackIndex::parse(data, repo.format()) {
            Ok(index) => index,
            Err(refused) => {
                note(refused);
                continue;
            }
        };
        let source = match FileSource::open(&format!("{directory}/{base}.pack")) {
            Ok(source) => source,
            Err(error) if not_found(&error) => {
                unstable = true;
                note(AskGit::new(
                    Reason::UnindexedPack,
                    format!("{name} without its pack"),
                ));
                continue;
            }
            Err(error) => return Err(io_ask(&error, "pack")),
        };
        next_id += 1;
        match Pack::with_stamp(next_id, base, index, Box::new(source), stamp) {
            Ok(pack) => packs.push(Arc::new(pack)),
            Err(refused) => note(refused),
        }
    }
    Ok(Scan {
        packs,
        unknown,
        unstable,
        next_id,
    })
}

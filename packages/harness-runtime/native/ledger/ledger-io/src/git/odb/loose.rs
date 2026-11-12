//! Loose objects: `objects/<first two hex digits>/<the rest>`, a zlib stream
//! of `<type> <size>\0<content>`, checked as Git's `unpack_loose_header`,
//! `parse_loose_header` and `unpack_loose_rest` check it: a known type, a
//! decimal size without leading zeros, exactly that many bytes, the stream
//! ending there and nothing after it.
#![forbid(unsafe_code)]

use super::inflate::{FileSource, InflateError, Source, inflate, inflate_exact};
use super::{
    Answer, AskGit, Kind, Object, ObjectFormat, ObjectInfo, OdbOptions, Oid, Reason, ask, io_ask,
};

/// The longest header Git reads (`MAX_HEADER_LEN`) plus room: a header
/// without its NUL in this many bytes is refused.
const HEADER_WINDOW: usize = 64;

/// An opened loose object file.
pub(crate) struct LooseFile {
    source: FileSource,
    oid: Oid,
}

/// The path of a loose object.
pub(crate) fn path_of(git_dir: &str, oid: &Oid) -> String {
    let hex = oid.hex();
    format!("{git_dir}/objects/{}/{}", &hex[..2], &hex[2..])
}

/// Opens the loose copy of `oid`; `None` when there is none.
pub(crate) fn open(git_dir: &str, oid: &Oid) -> Answer<Option<LooseFile>> {
    match FileSource::open(&path_of(git_dir, oid)) {
        Ok(source) => Ok(Some(LooseFile { source, oid: *oid })),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
            Ok(None)
        }
        Err(error) => Err(io_ask(&error, "loose object")),
    }
}

fn refused(error: InflateError, oid: &Oid) -> AskGit {
    match error {
        InflateError::Corrupt(what) => {
            AskGit::new(Reason::CorruptObject, format!("loose {oid}: {what}"))
        }
        InflateError::Io(error) => io_ask(&error, "loose object"),
    }
}

/// `parse_loose_header`: the type, the size and the header's length.
pub(crate) fn parse_header(prefix: &[u8]) -> Option<(Kind, u64, usize)> {
    let space = prefix.iter().position(|byte| *byte == b' ')?;
    let kind = Kind::from_name(&prefix[..space])?;
    let mut at = space + 1;
    let first = *prefix.get(at)?;
    if !first.is_ascii_digit() {
        return None;
    }
    let mut size = u64::from(first - b'0');
    at += 1;
    if size != 0 {
        while let Some(byte) = prefix.get(at).filter(|byte| byte.is_ascii_digit()) {
            size = size.checked_mul(10)?.checked_add(u64::from(byte - b'0'))?;
            at += 1;
        }
    }
    if *prefix.get(at)? != 0 {
        return None;
    }
    Some((kind, size, at + 1))
}

impl LooseFile {
    fn header(&self) -> Answer<(Kind, u64, usize)> {
        let inflated = inflate(&self.source, 0, self.source.size(), HEADER_WINDOW)
            .map_err(|error| refused(error, &self.oid))?;
        parse_header(&inflated.data).ok_or_else(|| {
            AskGit::new(Reason::CorruptObject, format!("loose {}: header", self.oid))
        })
    }

    /// The type and size, from the header alone.
    pub(crate) fn info(&self, _options: &OdbOptions) -> Answer<ObjectInfo> {
        let (kind, size, _) = self.header()?;
        Ok(ObjectInfo { kind, size })
    }

    /// The whole object.
    pub(crate) fn read(&self, options: &OdbOptions) -> Answer<Object> {
        let (kind, size, header) = self.header()?;
        if size > options.max_object_bytes {
            return ask(
                Reason::TooLarge,
                format!("loose {}: {size} bytes", self.oid),
            );
        }
        let total = size + header as u64;
        let inflated = inflate_exact(&self.source, 0, self.source.size(), total)
            .map_err(|error| refused(error, &self.oid))?;
        if inflated.consumed != self.source.size() {
            return ask(
                Reason::CorruptObject,
                format!("loose {}: garbage after the stream", self.oid),
            );
        }
        let mut data = inflated.data;
        data.drain(..header);
        Ok(Object { kind, data })
    }
}

/// The ids of every loose object with a well-formed name (two hex digits,
/// then the rest of a lowercase id of the repository's length), as
/// `for_each_loose_file_in_objdir` finds them; other names are ignored.
pub(crate) fn list(git_dir: &str, format: ObjectFormat) -> Answer<Vec<Oid>> {
    let mut ids = Vec::new();
    let objects = format!("{git_dir}/objects");
    let read = |path: &str| -> Answer<Option<std::fs::ReadDir>> {
        match std::fs::read_dir(path) {
            Ok(entries) => Ok(Some(entries)),
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                Ok(None)
            }
            Err(error) => Err(io_ask(&error, "objects directory")),
        }
    };
    for first in 0..=255u8 {
        let directory = format!("{objects}/{first:02x}");
        let Some(entries) = read(&directory)? else {
            continue;
        };
        for entry in entries {
            let entry = entry.map_err(|error| io_ask(&error, "objects directory"))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.len() + 2 != format.hex_len() {
                continue;
            }
            if let Some(oid) = Oid::from_hex(&format!("{first:02x}{name}")) {
                ids.push(oid);
            }
        }
    }
    Ok(ids)
}

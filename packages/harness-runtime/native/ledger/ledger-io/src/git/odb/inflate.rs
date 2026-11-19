//! zlib streams inside a file (a loose object, a pack entry), inflated with
//! `miniz_oxide` into a buffer whose size the caller declared. The output is
//! never larger than declared plus one byte, and input is read in bounded
//! chunks, so a hostile stream cannot make a read use more memory than its
//! declared size or run forever.
#![forbid(unsafe_code)]

use miniz_oxide::inflate::TINFLStatus;
use miniz_oxide::inflate::core::inflate_flags::{
    TINFL_FLAG_HAS_MORE_INPUT, TINFL_FLAG_PARSE_ZLIB_HEADER,
    TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
};
use miniz_oxide::inflate::core::{DecompressorOxide, decompress};

/// Bytes read from a source as one chunk of input.
const CHUNK: u64 = 1024 * 1024;

/// Random-access bytes: an open file or, in tests, a buffer.
pub(crate) trait Source: Send + Sync {
    fn size(&self) -> u64;
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize>;
}

/// An open file and its size when it was opened.
pub(crate) struct FileSource {
    file: std::fs::File,
    size: u64,
}

impl FileSource {
    pub(crate) fn open(path: &str) -> std::io::Result<FileSource> {
        let file = std::fs::File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::from_raw_os_error(libc::EISDIR));
        }
        Ok(FileSource {
            file,
            size: metadata.len(),
        })
    }
}

impl Source for FileSource {
    fn size(&self) -> u64 {
        self.size
    }
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::unix::fs::FileExt;
        if offset >= self.size {
            return Ok(0);
        }
        let wanted = buffer
            .len()
            .min((self.size - offset).min(usize::MAX as u64) as usize);
        self.file.read_at(&mut buffer[..wanted], offset)
    }
}

impl Source for Vec<u8> {
    fn size(&self) -> u64 {
        self.len() as u64
    }
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize> {
        if offset >= self.len() as u64 {
            return Ok(0);
        }
        let start = offset as usize;
        let count = buffer.len().min(self.len() - start);
        buffer[..count].copy_from_slice(&self[start..start + count]);
        Ok(count)
    }
}

/// Why a stream was refused.
#[derive(Debug)]
pub(crate) enum InflateError {
    /// Not a zlib stream of the declared size ending where it should.
    Corrupt(&'static str),
    Io(std::io::Error),
}

/// The result of inflating: the bytes, whether the stream ended, and how
/// many input bytes it consumed from `start`.
pub(crate) struct Inflated {
    pub data: Vec<u8>,
    pub ended: bool,
    pub consumed: u64,
}

/// Inflates the zlib stream at `start` (input never read at or past `end`)
/// into at most `capacity` bytes. Stops when the stream ends or the output is
/// full; `ended` says which.
pub(crate) fn inflate(
    source: &dyn Source,
    start: u64,
    end: u64,
    capacity: usize,
) -> Result<Inflated, InflateError> {
    let mut state = Box::<DecompressorOxide>::default();
    let mut out = vec![0u8; capacity];
    let mut out_pos = 0usize;
    let mut input: Vec<u8> = Vec::new();
    let mut in_pos = 0usize;
    let mut next = start;
    let mut consumed = 0u64;
    // The first chunk is about the size of the output: a small object reads
    // little past its own stream.
    let mut chunk = (capacity as u64).saturating_add(64).clamp(512, CHUNK);
    loop {
        if in_pos == input.len() && next < end {
            let count = chunk.min(end - next) as usize;
            input = vec![0u8; count];
            let read = super::read_fully(source, next, &mut input).map_err(InflateError::Io)?;
            input.truncate(read);
            if read == 0 {
                return Err(InflateError::Corrupt("truncated"));
            }
            next += read as u64;
            in_pos = 0;
            chunk = CHUNK;
        }
        let more = next < end;
        let flags = TINFL_FLAG_PARSE_ZLIB_HEADER
            | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF
            | if more { TINFL_FLAG_HAS_MORE_INPUT } else { 0 };
        let (status, read, written) =
            decompress(&mut state, &input[in_pos..], &mut out, out_pos, flags);
        in_pos += read;
        consumed += read as u64;
        out_pos += written;
        match status {
            TINFLStatus::Done => {
                out.truncate(out_pos);
                return Ok(Inflated {
                    data: out,
                    ended: true,
                    consumed,
                });
            }
            TINFLStatus::HasMoreOutput => {
                if out_pos < capacity {
                    return Err(InflateError::Corrupt("no progress"));
                }
                return Ok(Inflated {
                    data: out,
                    ended: false,
                    consumed,
                });
            }
            TINFLStatus::NeedsMoreInput => {
                if !more && in_pos == input.len() {
                    return Err(InflateError::Corrupt("truncated"));
                }
                if read == 0 && written == 0 && in_pos < input.len() {
                    return Err(InflateError::Corrupt("no progress"));
                }
            }
            TINFLStatus::FailedCannotMakeProgress => {
                return Err(InflateError::Corrupt("truncated"));
            }
            TINFLStatus::Adler32Mismatch => return Err(InflateError::Corrupt("adler32")),
            _ => return Err(InflateError::Corrupt("zlib")),
        }
    }
}

/// Inflates a stream that must hold exactly `size` bytes and end there.
pub(crate) fn inflate_exact(
    source: &dyn Source,
    start: u64,
    end: u64,
    size: u64,
) -> Result<Inflated, InflateError> {
    let capacity = usize::try_from(size)
        .ok()
        .and_then(|size| size.checked_add(1))
        .ok_or(InflateError::Corrupt("size"))?;
    let inflated = inflate(source, start, end, capacity)?;
    if !inflated.ended || inflated.data.len() as u64 != size {
        return Err(InflateError::Corrupt("size unlike the declared one"));
    }
    Ok(inflated)
}

//! The request-body decompression body-parser asks of Node's zlib
//! (`createInflate` for `deflate`, `createGunzip` for `gzip`): RFC 1951
//! inflate inside the RFC 1950 (zlib) and RFC 1952 (gzip) wrappers, with
//! zlib's checks (the code-length rules of `inflate_table`, the window, the
//! trailers), reading its input as it arrives (`Input` pulls from any reader:
//! a request body on a socket, or bytes in memory).
//!
//! What Node adds around zlib, reproduced here (node_zlib.cc and zlib.js):
//! - **Members and trailing bytes (gunzip).** After a member ends, Node looks
//!   at the next byte of input: none, or `0x00`, ends the stream (trailing zero
//!   bytes are padding and everything after them is ignored); any other byte
//!   starts another member, which must be a valid gzip member (so `junk`, `1f`
//!   or `1f 00` after a member is an error, 400). Inflate (`deflate`) ignores
//!   whatever follows the end of its stream.
//! - **Output in 16 KiB pieces.** Node runs zlib with a 16 KiB output buffer
//!   and hands each full piece on before the next call; body-parser's limit
//!   counts what was handed on. A stream that fails is answered 413 when the
//!   pieces handed on before the failing call already exceed the limit, and
//!   400 otherwise ([`Outcome`]); a stream that ends is 413 when its whole
//!   output exceeds the limit. This is exact when the compressed body reaches
//!   Node in one read (Node also ends a call at the end of each read, so for a
//!   body read in several pieces where the failure falls within 16 KiB above
//!   the limit, Node's answer depends on how the bytes arrived).
//!
//! The decoder stops once its output passes the limit by more than one piece:
//! the answer is 413 whatever follows.

use std::io::{self, Read};

/// Why a body could not be inflated (the edge answers it; its text is not Express's).
#[derive(Debug, PartialEq, Eq)]
pub enum InflateError {
    /// The stream is malformed or ends early (400).
    Malformed(&'static str),
    /// The output passed the limit (413).
    TooLarge,
}

type Result<T> = std::result::Result<T, InflateError>;

/// Node's zlib output buffer (`zlib.constants.Z_DEFAULT_CHUNK`).
pub const PIECE: usize = 16 * 1024;

/// Why decoding stopped inside the decoder (before the 16 KiB rule is applied).
#[derive(Debug, PartialEq, Eq)]
enum Stop {
    Malformed(&'static str),
    /// The input ended inside the stream (Node: "unexpected end of file", from the call that finishes the stream).
    Truncated,
    /// The output passed the stop line (limit plus one piece): 413 whatever follows.
    Full,
    /// The reader failed (the connection broke): no answer is owed.
    Io,
}

impl From<io::Error> for Stop {
    fn from(_: io::Error) -> Self {
        Stop::Io
    }
}

/// The result of decoding a body: the inflated bytes, or the edge's refusal, or a broken connection.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Inflated(Vec<u8>),
    Refused(InflateError),
    /// The input could not be read to its end (the request never completed): nothing is answered.
    Broken,
}

/// Applies Node's 16 KiB rule (module comment) to a decoder's stop at output position `at`: how much output the
/// calls before the failing one handed on. zlib returns from a call when its output is full and it has more to
/// write, so the failing call holds the bytes after the last full piece; at an exact piece boundary the piece
/// before it is in the failing call too, unless the failure is one zlib finds only once it has room to write
/// (a match too far back, checked in its MATCH state after the room). An input that ends early fails in the
/// call that finishes the stream, after everything decoded was handed on.
fn refusal(stop: Stop, at: usize, limit: usize) -> Outcome {
    let handed_on = match stop {
        Stop::Io => return Outcome::Broken,
        Stop::Full => return Outcome::Refused(InflateError::TooLarge),
        Stop::Truncated => at,
        Stop::Malformed(why) if at > 0 && at.is_multiple_of(PIECE) && why != TOO_FAR_BACK => at - PIECE,
        Stop::Malformed(_) => at / PIECE * PIECE,
    };
    if handed_on > limit {
        Outcome::Refused(InflateError::TooLarge)
    } else {
        Outcome::Refused(InflateError::Malformed(match stop {
            Stop::Malformed(why) => why,
            _ => "unexpected end of file",
        }))
    }
}

const TOO_FAR_BACK: &str = "invalid distance too far back";

fn finished(out: Vec<u8>, limit: usize) -> Outcome {
    if out.len() > limit {
        Outcome::Refused(InflateError::TooLarge)
    } else {
        Outcome::Inflated(out)
    }
}

// ------------------------------------------------------------------ input

/// Compressed input pulled from a reader, a buffer at a time. The buffer always keeps the last bytes taken
/// (up to `HISTORY`) just before `start`, so the bit reader can give back the whole bytes it holds.
pub struct Input<R: Read> {
    reader: R,
    buffer: Vec<u8>,
    start: usize,
    end: usize,
    eof: bool,
}

const INPUT_BUFFER: usize = 64 * 1024;
const HISTORY: usize = 8;

impl<R: Read> Input<R> {
    pub fn new(reader: R) -> Self {
        Input {
            reader,
            buffer: vec![0; HISTORY + INPUT_BUFFER],
            start: 0,
            end: 0,
            eof: false,
        }
    }

    /// Refills when empty; false at the end of input.
    fn more(&mut self) -> std::result::Result<bool, Stop> {
        if self.start < self.end {
            return Ok(true);
        }
        if self.eof {
            return Ok(false);
        }
        // Everything before `end` has been taken: keep its last bytes at the front.
        let keep = self.end.min(HISTORY);
        self.buffer.copy_within(self.end - keep..self.end, 0);
        self.start = keep;
        self.end = keep;
        loop {
            match self.reader.read(&mut self.buffer[keep..]) {
                Ok(0) => {
                    self.eof = true;
                    return Ok(false);
                }
                Ok(count) => {
                    self.end = keep + count;
                    return Ok(true);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn byte(&mut self) -> std::result::Result<Option<u8>, Stop> {
        if !self.more()? {
            return Ok(None);
        }
        let byte = self.buffer[self.start];
        self.start += 1;
        Ok(Some(byte))
    }

    /// The next byte without taking it.
    fn peek(&mut self) -> std::result::Result<Option<u8>, Stop> {
        if !self.more()? {
            return Ok(None);
        }
        Ok(Some(self.buffer[self.start]))
    }

    fn need(&mut self) -> std::result::Result<u8, Stop> {
        self.byte()?.ok_or(Stop::Truncated)
    }

    /// Reads and drops the rest of the input (Node reads a request to its end before it answers).
    pub fn drain(&mut self) -> io::Result<()> {
        self.start = self.end;
        if self.eof {
            return Ok(());
        }
        loop {
            match self.reader.read(&mut self.buffer[HISTORY..]) {
                Ok(0) => {
                    self.eof = true;
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

/// A bit reader over `Input`: up to 64 bits held, least significant bit first.
struct Bits<'a, R: Read> {
    input: &'a mut Input<R>,
    hold: u64,
    count: u32,
}

impl<'a, R: Read> Bits<'a, R> {
    fn new(input: &'a mut Input<R>) -> Self {
        Bits { input, hold: 0, count: 0 }
    }

    /// Tops the bit buffer up to at least 56 bits where the input allows.
    #[inline(always)]
    fn refill(&mut self) -> std::result::Result<(), Stop> {
        let input = &mut *self.input;
        if input.end - input.start >= 8 {
            let word = u64::from_le_bytes(input.buffer[input.start..input.start + 8].try_into().unwrap_or([0; 8]));
            self.hold |= word << self.count;
            let taken = (63 - self.count) >> 3;
            input.start += taken as usize;
            self.count |= 56;
            return Ok(());
        }
        while self.count <= 56 {
            match input.byte()? {
                Some(byte) => {
                    self.hold |= u64::from(byte) << self.count;
                    self.count += 8;
                }
                None => break,
            }
        }
        Ok(())
    }

    /// `n` bits (n ≤ 32), or "unexpected end of file".
    #[inline(always)]
    fn bits(&mut self, n: u32) -> std::result::Result<u32, Stop> {
        if self.count < n {
            self.refill()?;
            if self.count < n {
                return Err(Stop::Truncated);
            }
        }
        let value = (self.hold & ((1u64 << n) - 1)) as u32;
        self.hold >>= n;
        self.count -= n;
        Ok(value)
    }

    /// Drops the bits to the next byte boundary and gives the whole bytes still held back to the input.
    fn align_and_unload(&mut self) {
        let drop = self.count & 7;
        self.hold >>= drop;
        self.count -= drop;
        // Whole bytes held go back: the input's buffer still has them just before `start`.
        let bytes = (self.count / 8) as usize;
        self.input.start = self.input.start.saturating_sub(bytes);
        self.hold = 0;
        self.count = 0;
    }
}

// ------------------------------------------------------------------ Huffman codes

const MAX_BITS: usize = 15;
/// Bits of the first-level lookup table; longer codes are decoded canonically.
const FAST_BITS: u32 = 11;
const FAST_SIZE: usize = 1 << FAST_BITS;
/// Table entry: symbol in the low 16 bits, code length in bits 16..20; 0 = longer than FAST_BITS; INVALID = no code.
const INVALID: u32 = u32::MAX;

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    None,
    CodeLengths,
    Symbols,
}

/// A canonical Huffman code: a first-level table, and the counts and symbols for the codes longer than it.
struct Huffman {
    fast: Box<[u32; FAST_SIZE]>,
    count: [u16; MAX_BITS + 1],
    symbol: Vec<u16>,
}

impl Huffman {
    /// Builds the code of `lengths`. With `check` (a dynamic block's codes, as zlib's inflate_table checks them), an
    /// over-subscribed set is refused, and so is an incomplete one, except a literal/length or distance code whose
    /// longest code has one bit; the fixed codes are built unchecked (the fixed distance code is incomplete).
    fn new(lengths: &[u8], check: Check) -> std::result::Result<Self, Stop> {
        let mut count = [0u16; MAX_BITS + 1];
        for length in lengths {
            count[usize::from(*length)] += 1;
        }
        let mut left: i32 = 1;
        for slot in count.iter().skip(1) {
            left <<= 1;
            left -= i32::from(*slot);
            if left < 0 && check != Check::None {
                return Err(Stop::Malformed("invalid code lengths set"));
            }
        }
        let longest = lengths.iter().copied().max().unwrap_or(0);
        if left > 0 && (check == Check::CodeLengths || (check == Check::Symbols && longest != 1)) {
            return Err(Stop::Malformed("invalid code lengths set"));
        }
        let mut offsets = [0u16; MAX_BITS + 2];
        for length in 1..=MAX_BITS {
            offsets[length + 1] = offsets[length] + count[length];
        }
        let mut symbol = vec![0u16; lengths.len()];
        let mut fast = Box::new([INVALID; FAST_SIZE]);
        // The canonical code of each symbol, in symbol order within a length.
        let mut next_code = [0u32; MAX_BITS + 2];
        let mut code = 0u32;
        count[0] = 0;
        for length in 1..=MAX_BITS {
            code = (code + u32::from(count[length - 1])) << 1;
            next_code[length] = code;
        }
        for (value, length) in lengths.iter().enumerate() {
            let length = usize::from(*length);
            if length == 0 {
                continue;
            }
            let slot = &mut offsets[length];
            symbol[usize::from(*slot)] = value as u16;
            *slot += 1;
            let canonical = next_code[length];
            next_code[length] += 1;
            if length as u32 <= FAST_BITS {
                let reversed = (canonical.reverse_bits() >> (32 - length as u32)) as usize;
                let entry = (value as u32) | ((length as u32) << 16);
                let mut index = reversed;
                while index < FAST_SIZE {
                    fast[index] = entry;
                    index += 1 << length;
                }
            } else {
                // The first FAST_BITS bits of a longer code lead to the canonical decoder.
                let reversed = (canonical.reverse_bits() >> (32 - length as u32)) as usize & (FAST_SIZE - 1);
                fast[reversed] = 0;
            }
        }
        Ok(Huffman { fast, count, symbol })
    }

    #[inline(always)]
    fn decode<R: Read>(&self, bits: &mut Bits<R>) -> std::result::Result<u16, Stop> {
        if bits.count < MAX_BITS as u32 {
            bits.refill()?;
        }
        let entry = self.fast[(bits.hold as usize) & (FAST_SIZE - 1)];
        if entry != 0 && entry != INVALID {
            let length = entry >> 16;
            if length > bits.count {
                return Err(Stop::Truncated);
            }
            bits.hold >>= length;
            bits.count -= length;
            return Ok(entry as u16);
        }
        self.decode_slow(bits)
    }

    /// The canonical decoder (codes longer than the table, and codes that do not exist).
    fn decode_slow<R: Read>(&self, bits: &mut Bits<R>) -> std::result::Result<u16, Stop> {
        let mut code: i32 = 0;
        let mut first: i32 = 0;
        let mut index: i32 = 0;
        for length in 1..=MAX_BITS {
            if length as u32 > bits.count {
                return Err(if bits.input.eof { Stop::Truncated } else { Stop::Malformed("invalid code") });
            }
            code |= ((bits.hold >> (length - 1)) & 1) as i32;
            let count = i32::from(self.count[length]);
            if code - count < first {
                bits.hold >>= length;
                bits.count -= length as u32;
                return self
                    .symbol
                    .get((index + (code - first)) as usize)
                    .copied()
                    .ok_or(Stop::Malformed("invalid code"));
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err(Stop::Malformed("invalid code"))
    }
}

/// The output: a buffer written up to `pos` (kept `SLACK` bytes longer than needed, so a match is copied eight
/// bytes at a time), with the stop line past which decoding ends.
struct Output {
    buf: Vec<u8>,
    pos: usize,
    stop: usize,
}

const SLACK: usize = 32;
/// The most a fast step writes: one match (258 bytes) or three literals.
const FAST_ROOM: usize = 258;

impl Output {
    fn new(stop: usize) -> Self {
        Output {
            buf: vec![0; 64 * 1024 + SLACK],
            pos: 0,
            stop,
        }
    }

    /// Makes room for `more` bytes (refused past the stop line).
    #[inline]
    fn room(&mut self, more: usize) -> std::result::Result<(), Stop> {
        if self.pos + more > self.stop {
            return Err(Stop::Full);
        }
        if self.pos + more + SLACK > self.buf.len() {
            let wanted = (self.buf.len() * 2).max(self.pos + more + SLACK);
            self.buf.resize(wanted, 0);
        }
        Ok(())
    }

    fn bytes(&self) -> &[u8] {
        &self.buf[..self.pos]
    }

    fn into_vec(mut self) -> Vec<u8> {
        self.buf.truncate(self.pos);
        self.buf
    }

    /// Copies `length` bytes from `distance` back (room made, distance checked).
    #[inline(always)]
    fn copy_match(&mut self, distance: usize, length: usize) {
        let pos = self.pos;
        let from = pos - distance;
        if distance >= 16 {
            // Sixteen bytes at a time: each read lies before the bytes it writes; up to fifteen bytes past the
            // match are scratch (the slack).
            let mut done = 0;
            while done < length {
                self.buf.copy_within(from + done..from + done + 16, pos + done);
                done += 16;
            }
        } else if distance == 1 {
            let byte = self.buf[from];
            self.buf[pos..pos + length].fill(byte);
        } else {
            let buf = &mut self.buf[from..pos + length];
            for index in distance..distance + length {
                buf[index] = buf[index - distance];
            }
        }
        self.pos = pos + length;
    }
}

fn codes<R: Read>(bits: &mut Bits<R>, out: &mut Output, start: usize, lit: &Huffman, dist: &Huffman) -> std::result::Result<(), Stop> {
    loop {
        // The fast step: eight input bytes at hand and room for a whole match, so no check inside can fail.
        if bits.input.end - bits.input.start >= 8 && out.pos + FAST_ROOM <= out.stop && out.pos + FAST_ROOM + SLACK <= out.buf.len() {
            bits.refill()?;
            let entry = lit.fast[(bits.hold as usize) & (FAST_SIZE - 1)];
            if entry != 0 && entry != INVALID {
                let length_bits = entry >> 16;
                bits.hold >>= length_bits;
                bits.count -= length_bits;
                let symbol = entry as u16;
                if symbol < 256 {
                    out.buf[out.pos] = symbol as u8;
                    out.pos += 1;
                    // Up to two more literals from the bits at hand.
                    for _ in 0..2 {
                        if bits.count < MAX_BITS as u32 {
                            break;
                        }
                        let next = lit.fast[(bits.hold as usize) & (FAST_SIZE - 1)];
                        if next == 0 || next == INVALID || (next as u16) >= 256 {
                            break;
                        }
                        let used = next >> 16;
                        bits.hold >>= used;
                        bits.count -= used;
                        out.buf[out.pos] = next as u8;
                        out.pos += 1;
                    }
                    continue;
                }
                if symbol == 256 {
                    return Ok(());
                }
                if symbol > 285 {
                    return Err(Stop::Malformed("invalid literal/length code"));
                }
                let index = usize::from(symbol - 257);
                let extra = u32::from(LENGTH_EXTRA[index]);
                let length = usize::from(LENGTH_BASE[index]) + (bits.hold & ((1u64 << extra) - 1)) as usize;
                bits.hold >>= extra;
                bits.count -= extra;
                // At least 36 bits remain: enough for any distance code and its extra bits.
                let dentry = dist.fast[(bits.hold as usize) & (FAST_SIZE - 1)];
                let code = if dentry != 0 && dentry != INVALID {
                    let used = dentry >> 16;
                    bits.hold >>= used;
                    bits.count -= used;
                    usize::from(dentry as u16)
                } else {
                    usize::from(dist.decode_slow(bits)?)
                };
                if code >= 30 {
                    return Err(Stop::Malformed("invalid distance code"));
                }
                let dextra = u32::from(DIST_EXTRA[code]);
                if dextra > bits.count {
                    return Err(Stop::Truncated);
                }
                let distance = usize::from(DIST_BASE[code]) + (bits.hold & ((1u64 << dextra) - 1)) as usize;
                bits.hold >>= dextra;
                bits.count -= dextra;
                if distance > out.pos - start {
                    return Err(Stop::Malformed(TOO_FAR_BACK));
                }
                out.copy_match(distance, length);
                continue;
            }
        }
        // The careful step: one symbol, every check made.
        let symbol = lit.decode(bits)?;
        match symbol {
            0..=255 => {
                out.room(1)?;
                out.buf[out.pos] = symbol as u8;
                out.pos += 1;
            }
            256 => return Ok(()),
            257..=285 => {
                let index = usize::from(symbol - 257);
                let length = usize::from(LENGTH_BASE[index]) + bits.bits(u32::from(LENGTH_EXTRA[index]))? as usize;
                let code = usize::from(dist.decode(bits)?);
                if code >= 30 {
                    return Err(Stop::Malformed("invalid distance code"));
                }
                let distance = usize::from(DIST_BASE[code]) + bits.bits(u32::from(DIST_EXTRA[code]))? as usize;
                if distance > out.pos - start {
                    return Err(Stop::Malformed(TOO_FAR_BACK));
                }
                out.room(length)?;
                out.copy_match(distance, length);
            }
            _ => return Err(Stop::Malformed("invalid literal/length code")),
        }
    }
}

fn fixed_codes() -> &'static (Huffman, Huffman) {
    static FIXED: std::sync::OnceLock<(Huffman, Huffman)> = std::sync::OnceLock::new();
    FIXED.get_or_init(|| {
        let mut lengths = [0u8; 288];
        lengths[..144].fill(8);
        lengths[144..256].fill(9);
        lengths[256..280].fill(7);
        lengths[280..].fill(8);
        // Unchecked codes cannot fail.
        let lit = Huffman::new(&lengths, Check::None).unwrap_or_else(|_| unreachable_codes());
        let dist = Huffman::new(&[5u8; 30], Check::None).unwrap_or_else(|_| unreachable_codes());
        (lit, dist)
    })
}

/// An empty code (never used: building an unchecked code cannot fail).
fn unreachable_codes() -> Huffman {
    Huffman {
        fast: Box::new([INVALID; FAST_SIZE]),
        count: [0; MAX_BITS + 1],
        symbol: Vec::new(),
    }
}

/// Inflates one raw deflate stream from `input` into `out`; leaves `input` just after its last byte.
fn inflate_raw<R: Read>(input: &mut Input<R>, out: &mut Output) -> std::result::Result<(), Stop> {
    let start = out.pos;
    let mut bits = Bits::new(input);
    loop {
        let last = bits.bits(1)?;
        match bits.bits(2)? {
            0 => {
                bits.align_and_unload();
                let input = &mut *bits.input;
                let header = [input.need()?, input.need()?, input.need()?, input.need()?];
                let length = u16::from_le_bytes([header[0], header[1]]);
                let check = u16::from_le_bytes([header[2], header[3]]);
                if length != !check {
                    return Err(Stop::Malformed("invalid stored block lengths"));
                }
                let mut left = usize::from(length);
                while left > 0 {
                    if !input.more()? {
                        return Err(Stop::Truncated);
                    }
                    let piece = left.min(input.end - input.start);
                    out.room(piece)?;
                    out.buf[out.pos..out.pos + piece].copy_from_slice(&input.buffer[input.start..input.start + piece]);
                    out.pos += piece;
                    input.start += piece;
                    left -= piece;
                }
            }
            1 => {
                let (lit, dist) = fixed_codes();
                codes(&mut bits, out, start, lit, dist)?;
            }
            2 => {
                let nlen = bits.bits(5)? as usize + 257;
                let ndist = bits.bits(5)? as usize + 1;
                let ncode = bits.bits(4)? as usize + 4;
                if nlen > 286 || ndist > 30 {
                    return Err(Stop::Malformed("too many length or distance symbols"));
                }
                let mut code_lengths = [0u8; 19];
                for index in CODE_LENGTH_ORDER.iter().take(ncode) {
                    code_lengths[*index] = bits.bits(3)? as u8;
                }
                let lencode = Huffman::new(&code_lengths, Check::CodeLengths)?;
                let mut lengths = [0u8; 286 + 30];
                let total = nlen + ndist;
                let mut index = 0;
                while index < total {
                    let symbol = lencode.decode(&mut bits)?;
                    if symbol < 16 {
                        lengths[index] = symbol as u8;
                        index += 1;
                        continue;
                    }
                    let (value, repeat) = match symbol {
                        16 => {
                            if index == 0 {
                                return Err(Stop::Malformed("invalid bit length repeat"));
                            }
                            (lengths[index - 1], 3 + bits.bits(2)? as usize)
                        }
                        17 => (0, 3 + bits.bits(3)? as usize),
                        _ => (0, 11 + bits.bits(7)? as usize),
                    };
                    if index + repeat > total {
                        return Err(Stop::Malformed("invalid bit length repeat"));
                    }
                    lengths[index..index + repeat].fill(value);
                    index += repeat;
                }
                if lengths[256] == 0 {
                    return Err(Stop::Malformed("invalid code -- missing end-of-block"));
                }
                let lit = Huffman::new(&lengths[..nlen], Check::Symbols)?;
                let dist = Huffman::new(&lengths[nlen..total], Check::Symbols)?;
                codes(&mut bits, out, start, &lit, &dist)?;
            }
            _ => return Err(Stop::Malformed("invalid block type")),
        }
        if last == 1 {
            bits.align_and_unload();
            return Ok(());
        }
    }
}

// ------------------------------------------------------------------ checksums

#[cfg_attr(all(target_arch = "aarch64", target_feature = "crc"), allow(dead_code))]
fn crc_tables() -> &'static [[u32; 256]; 8] {
    static TABLES: std::sync::OnceLock<Box<[[u32; 256]; 8]>> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let mut tables = Box::new([[0u32; 256]; 8]);
        for index in 0..256 {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 == 1 { 0xedb8_8320 ^ (value >> 1) } else { value >> 1 };
            }
            tables[0][index] = value;
        }
        for index in 0..256 {
            for slice in 1..8 {
                let previous = tables[slice - 1][index];
                tables[slice][index] = (previous >> 8) ^ tables[0][(previous & 0xff) as usize];
            }
        }
        tables
    })
}

/// CRC-32 (IEEE) continued from `crc` (0 to start), as gzip's trailer carries it.
pub fn crc32_update(crc: u32, data: &[u8]) -> u32 {
    #[cfg(all(target_arch = "aarch64", target_feature = "crc"))]
    {
        crc32_arm(crc, data)
    }
    #[cfg(not(all(target_arch = "aarch64", target_feature = "crc")))]
    {
        crc32_tables(crc, data)
    }
}

/// The ARMv8 CRC32 instructions (the same polynomial, reflected, as gzip's).
#[cfg(all(target_arch = "aarch64", target_feature = "crc"))]
fn crc32_arm(crc: u32, data: &[u8]) -> u32 {
    use std::arch::aarch64::{__crc32b, __crc32d};
    let mut crc = !crc;
    let (words, rest) = data.as_chunks::<8>();
    for word in words {
        // SAFETY: the `crc` target feature is enabled for this build (the cfg above), which is all the intrinsic needs.
        crc = unsafe { __crc32d(crc, u64::from_le_bytes(*word)) };
    }
    for byte in rest {
        // SAFETY: as above.
        crc = unsafe { __crc32b(crc, *byte) };
    }
    !crc
}

#[cfg_attr(all(target_arch = "aarch64", target_feature = "crc"), allow(dead_code))]
fn crc32_tables(crc: u32, data: &[u8]) -> u32 {
    let tables = crc_tables();
    let mut crc = !crc;
    let (words, rest) = data.as_chunks::<8>();
    for word in words {
        let low = crc ^ u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        crc = tables[7][(low & 0xff) as usize]
            ^ tables[6][((low >> 8) & 0xff) as usize]
            ^ tables[5][((low >> 16) & 0xff) as usize]
            ^ tables[4][(low >> 24) as usize]
            ^ tables[3][usize::from(word[4])]
            ^ tables[2][usize::from(word[5])]
            ^ tables[1][usize::from(word[6])]
            ^ tables[0][usize::from(word[7])];
    }
    for byte in rest {
        crc = tables[0][((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

/// CRC-32 (IEEE) of `data`.
pub fn crc32(data: &[u8]) -> u32 {
    crc32_update(0, data)
}

/// Adler-32, as the zlib trailer carries it. A block of `k` runs of sixteen bytes `x[r][j]`, with `a` and `b`
/// before it, adds `sum x` to `a` and `16 k a + 16 sum_r T_r + sum_j (16 - j) X_j` to `b`, where `T_r` is the sum of
/// the runs before run `r` and `X_j` the sum of lane `j`: lane sums the compiler keeps in vector registers.
pub fn adler32(data: &[u8]) -> u32 {
    const MOD: u64 = 65521;
    let (mut a, mut b) = (1u64, 0u64);
    for block in data.chunks(5536) {
        let (runs, rest) = block.as_chunks::<16>();
        let mut lanes = [0u32; 16];
        let mut before = [0u32; 16];
        for run in runs {
            for lane in 0..16 {
                before[lane] += lanes[lane];
                lanes[lane] += u32::from(run[lane]);
            }
        }
        let total: u64 = lanes.iter().map(|sum| u64::from(*sum)).sum();
        let earlier: u64 = before.iter().map(|sum| u64::from(*sum)).sum();
        let weighted: u64 = lanes.iter().enumerate().map(|(lane, sum)| u64::from(*sum) * (16 - lane as u64)).sum();
        b = (b + 16 * runs.len() as u64 * a + 16 * earlier + weighted) % MOD;
        a = (a + total) % MOD;
        for byte in rest {
            a += u64::from(*byte);
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    ((b as u32) << 16) | a as u32
}

// ------------------------------------------------------------------ the wrappers

/// The stop line: past the limit by more than one piece, the answer is 413 whatever follows.
fn stop_line(limit: usize) -> usize {
    limit.saturating_add(PIECE)
}

fn zlib_stream<R: Read>(input: &mut Input<R>, out: &mut Output) -> std::result::Result<(), Stop> {
    let (cmf, flg) = (input.need()?, input.need()?);
    if (u16::from(cmf) * 256 + u16::from(flg)) % 31 != 0 {
        return Err(Stop::Malformed("incorrect header check"));
    }
    if cmf & 0x0f != 8 {
        return Err(Stop::Malformed("unknown compression method"));
    }
    if cmf >> 4 > 7 {
        return Err(Stop::Malformed("invalid window size"));
    }
    if flg & 0x20 != 0 {
        return Err(Stop::Malformed("Missing dictionary"));
    }
    inflate_raw(input, out)?;
    let trailer = [input.need()?, input.need()?, input.need()?, input.need()?];
    if u32::from_be_bytes(trailer) != adler32(out.bytes()) {
        return Err(Stop::Malformed("incorrect data check"));
    }
    Ok(())
}

/// `zlib.createInflate()` over `input`, with body-parser's `limit` (bytes after the stream are ignored and drained).
pub fn inflate_zlib_from<R: Read>(input: &mut Input<R>, limit: usize) -> Outcome {
    let mut out = Output::new(stop_line(limit));
    match zlib_stream(input, &mut out) {
        Ok(()) => match input.drain() {
            Ok(()) => finished(out.into_vec(), limit),
            Err(_) => Outcome::Broken,
        },
        Err(stop) => {
            let at = out.pos;
            settle(input, refusal(stop, at, limit))
        }
    }
}

/// A refusal is answered once the request has been read to its end (body-parser drains it first).
fn settle<R: Read>(input: &mut Input<R>, outcome: Outcome) -> Outcome {
    if outcome == Outcome::Broken {
        return outcome;
    }
    match input.drain() {
        Ok(()) => outcome,
        Err(_) => Outcome::Broken,
    }
}

fn gzip_member<R: Read>(input: &mut Input<R>, out: &mut Output) -> std::result::Result<(), Stop> {
    // zlib checks the magic once two bytes are in, the method and flags once two more are.
    let mut header = [0u8; 10];
    header[0] = input.need()?;
    header[1] = input.need()?;
    if header[0] != 0x1f || header[1] != 0x8b {
        return Err(Stop::Malformed("incorrect header check"));
    }
    header[2] = input.need()?;
    header[3] = input.need()?;
    if header[2] != 8 {
        return Err(Stop::Malformed("unknown compression method"));
    }
    let flags = header[3];
    if flags & 0xe0 != 0 {
        return Err(Stop::Malformed("unknown header flags set"));
    }
    for slot in &mut header[4..] {
        *slot = input.need()?;
    }
    let mut crc = crc32(&header);
    if flags & 0x04 != 0 {
        let length = [input.need()?, input.need()?];
        crc = crc32_update(crc, &length);
        for _ in 0..u16::from_le_bytes(length) {
            let byte = input.need()?;
            crc = crc32_update(crc, &[byte]);
        }
    }
    for flag in [0x08, 0x10] {
        if flags & flag != 0 {
            loop {
                let byte = input.need()?;
                crc = crc32_update(crc, &[byte]);
                if byte == 0 {
                    break;
                }
            }
        }
    }
    if flags & 0x02 != 0 {
        let check = [input.need()?, input.need()?];
        if u16::from_le_bytes(check) != (crc & 0xffff) as u16 {
            return Err(Stop::Malformed("header crc mismatch"));
        }
    }
    let begin = out.pos;
    inflate_raw(input, out)?;
    let mut trailer = [0u8; 8];
    for slot in &mut trailer {
        *slot = input.need()?;
    }
    let crc = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
    let size = u32::from_le_bytes([trailer[4], trailer[5], trailer[6], trailer[7]]);
    if crc != crc32(&out.buf[begin..out.pos]) {
        return Err(Stop::Malformed("incorrect data check"));
    }
    if size != (out.pos - begin) as u32 {
        return Err(Stop::Malformed("incorrect length check"));
    }
    Ok(())
}

/// `zlib.createGunzip()` over `input`, with body-parser's `limit`: one member or more, Node's rule for what follows.
pub fn gunzip_from<R: Read>(input: &mut Input<R>, limit: usize) -> Outcome {
    let mut out = Output::new(stop_line(limit));
    let mut first = true;
    loop {
        if !first {
            match input.peek() {
                Ok(None | Some(0)) => {
                    return match input.drain() {
                        Ok(()) => finished(out.into_vec(), limit),
                        Err(_) => Outcome::Broken,
                    };
                }
                Ok(Some(_)) => {}
                Err(stop) => {
                    let at = out.pos;
                    return refusal(stop, at, limit);
                }
            }
        }
        first = false;
        if let Err(stop) = gzip_member(input, &mut out) {
            let at = out.pos;
            return settle(input, refusal(stop, at, limit));
        }
        if crate::plant::on(crate::plant::Plant::GzipFirstMemberOnly) {
            return match input.drain() {
                Ok(()) => finished(out.into_vec(), limit),
                Err(_) => Outcome::Broken,
            };
        }
    }
}

/// `inflate_zlib_from` over bytes in memory.
pub fn inflate_zlib(data: &[u8], limit: usize) -> std::result::Result<Vec<u8>, InflateError> {
    as_result(inflate_zlib_from(&mut Input::new(data), limit))
}

/// `gunzip_from` over bytes in memory.
pub fn gunzip(data: &[u8], limit: usize) -> std::result::Result<Vec<u8>, InflateError> {
    as_result(gunzip_from(&mut Input::new(data), limit))
}

fn as_result(outcome: Outcome) -> Result<Vec<u8>> {
    match outcome {
        Outcome::Inflated(bytes) => Ok(bytes),
        Outcome::Refused(error) => Err(error),
        // Bytes in memory never fail to read.
        Outcome::Broken => Err(InflateError::Malformed("unexpected end of file")),
    }
}

// ------------------------------------------------------------------ brotli

/// Vec-backed cells for brotli-decompressor's allocator interface (safe code; what its `std` allocator does).
pub struct Cells<T>(Box<[T]>);

impl<T> Default for Cells<T> {
    fn default() -> Self {
        Cells(Vec::new().into_boxed_slice())
    }
}

impl<T> brotli_decompressor::SliceWrapper<T> for Cells<T> {
    fn slice(&self) -> &[T] {
        &self.0
    }
}

impl<T> brotli_decompressor::SliceWrapperMut<T> for Cells<T> {
    fn slice_mut(&mut self) -> &mut [T] {
        &mut self.0
    }
}

/// The allocator: every cell a zeroed (default) boxed slice.
#[derive(Default, Clone, Copy)]
pub struct Heap;

impl<T: Clone + Default> brotli_decompressor::Allocator<T> for Heap {
    type AllocatedMemory = Cells<T>;
    fn alloc_cell(&mut self, len: usize) -> Cells<T> {
        Cells(vec![T::default(); len].into_boxed_slice())
    }
    fn free_cell(&mut self, _data: Cells<T>) {}
}

/// `zlib.createBrotliDecompress()` over `input`, with body-parser's `limit`, output in Node's 16 KiB pieces.
/// Bytes after the end of the stream are ignored (Node pushes the end once the decoder stops taking input).
///
/// One known difference: brotli-decompressor 5.0.0 does not refuse a stream whose last byte has non-zero padding
/// bits (its `BROTLI_STATE_DONE` overwrites the `PADDING_2` error the C decoder returns), which Node refuses (400).
pub fn brotli_from<R: Read>(input: &mut Input<R>, limit: usize) -> Outcome {
    use brotli_decompressor::{BrotliDecompressStream, BrotliResult, BrotliState};
    let mut state = BrotliState::new(Heap, Heap, Heap);
    let mut out: Vec<u8> = Vec::new();
    let mut piece = vec![0u8; PIECE];
    loop {
        let more = match input.more() {
            Ok(more) => more,
            Err(_) => return Outcome::Broken,
        };
        let end = input.end;
        let (mut available_in, mut offset_in) = (end - input.start, input.start);
        loop {
            let (mut available_out, mut offset_out, mut total) = (PIECE, 0usize, 0usize);
            let result = BrotliDecompressStream(
                &mut available_in,
                &mut offset_in,
                &input.buffer[..end],
                &mut available_out,
                &mut offset_out,
                &mut piece,
                &mut total,
                &mut state,
            );
            match result {
                BrotliResult::ResultFailure => {
                    let at = out.len();
                    input.start = offset_in;
                    return settle(input, refusal(Stop::Malformed("Decompression failed"), at, limit));
                }
                BrotliResult::ResultSuccess => {
                    out.extend_from_slice(&piece[..offset_out]);
                    input.start = offset_in;
                    return match input.drain() {
                        Ok(()) => finished(out, limit),
                        Err(_) => Outcome::Broken,
                    };
                }
                BrotliResult::NeedsMoreOutput | BrotliResult::NeedsMoreInput => {
                    out.extend_from_slice(&piece[..offset_out]);
                    if out.len() > stop_line(limit) {
                        input.start = offset_in;
                        return settle(input, Outcome::Refused(InflateError::TooLarge));
                    }
                    if matches!(result, BrotliResult::NeedsMoreInput) {
                        break;
                    }
                }
            }
        }
        input.start = end;
        if !more {
            // The input ended inside the stream: "unexpected end of file".
            let at = out.len();
            return refusal(Stop::Truncated, at, limit);
        }
    }
}

/// `brotli_from` over bytes in memory.
pub fn brotli(data: &[u8], limit: usize) -> std::result::Result<Vec<u8>, InflateError> {
    as_result(brotli_from(&mut Input::new(data), limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &[u8] = b"{\"text\":\"inflated by the parser\"}";

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn stored_block() {
        let mut data = vec![0x78, 0x01, 0x01];
        data.extend_from_slice(&(TEXT.len() as u16).to_le_bytes());
        data.extend_from_slice(&(!(TEXT.len() as u16)).to_le_bytes());
        data.extend_from_slice(TEXT);
        data.extend_from_slice(&adler32(TEXT).to_be_bytes());
        assert_eq!(inflate_zlib(&data, 1 << 20).unwrap(), TEXT);
    }

    #[test]
    fn streams_from_node() {
        // zlib.deflateRawSync('abcabcabcabc')
        let mut out = Output::new(100);
        inflate_raw(&mut Input::new(hex("4b4c4a4e842100").as_slice()), &mut out).unwrap();
        assert_eq!(out.bytes(), b"abcabcabcabc");
        // zlib.deflateSync(TEXT) and zlib.gzipSync(TEXT)
        assert_eq!(
            inflate_zlib(
                &hex("789cab562a49ad2851b252cacc4bcb492c494d5148aa5428c9485528482c2a4e2d52aa0500c62d0bd0"),
                1 << 20
            )
            .unwrap(),
            TEXT
        );
        let gzip = hex("1f8b0800000000000013ab562a49ad2851b252cacc4bcb492c494d5148aa5428c9485528482c2a4e2d52aa05001a4e872821000000");
        assert_eq!(gunzip(&gzip, 1 << 20).unwrap(), TEXT);
        // Two members: both decoded, as Node's gunzip does.
        let two = [gzip.clone(), gzip.clone()].concat();
        assert_eq!(gunzip(&two, 1 << 20).unwrap(), [TEXT, TEXT].concat());
        // zlib.deflateSync('x'.repeat(300) + 'yzyzyzyzyzyz' + 'abc'.repeat(50), { level: 9 })
        let expected = ["x".repeat(300), "yzyzyzyzyzyz".to_owned(), "abc".repeat(50)].concat();
        assert_eq!(
            inflate_zlib(&hex("78daaba81805c482ca2a044c4c4a1e84080020a2cbbf"), 1 << 20).unwrap(),
            expected.as_bytes()
        );
    }

    #[test]
    fn what_follows_a_gzip_member() {
        let gzip = hex("1f8b0800000000000013ab562a49ad2851b252cacc4bcb492c494d5148aa5428c9485528482c2a4e2d52aa05001a4e872821000000");
        let after = |tail: &[u8]| gunzip(&[gzip.as_slice(), tail].concat(), 1 << 20);
        // Zero bytes are padding, and whatever follows a zero byte is ignored.
        assert_eq!(after(b"\0\0\0").unwrap(), TEXT);
        assert_eq!(after(b"\0junk").unwrap(), TEXT);
        // Any other byte starts a member, which must be valid (Node: "incorrect header check", "unexpected end of file").
        assert!(matches!(after(b"junk"), Err(InflateError::Malformed(_))));
        assert!(matches!(after(&[0x1f]), Err(InflateError::Malformed(_))));
        assert!(matches!(after(&[0x1f, 0x00]), Err(InflateError::Malformed(_))));
        assert!(matches!(after(&[0x1f, 0x8b, 0x08]), Err(InflateError::Malformed(_))));
        // Inflate ignores what follows its stream.
        let zlib = hex("789cab562a49ad2851b252cacc4bcb492c494d5148aa5428c9485528482c2a4e2d52aa0500c62d0bd0");
        assert_eq!(inflate_zlib(&[zlib.as_slice(), b"junk"].concat(), 1 << 20).unwrap(), TEXT);
    }

    #[test]
    fn limit_by_pieces() {
        // 40 000 zero bytes, stored uncompressed in a zlib stream with a wrong check: the failing call starts at 32 768.
        let zeros = vec![0u8; 40_000];
        let mut data = vec![0x78, 0x01];
        for (index, block) in zeros.chunks(20_000).enumerate() {
            data.push(u8::from(index == 1));
            data.extend_from_slice(&(block.len() as u16).to_le_bytes());
            data.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            data.extend_from_slice(block);
        }
        data.extend_from_slice(&[0, 0, 0, 0]);
        // Pieces handed on before the failure: 32 768 bytes.
        assert_eq!(inflate_zlib(&data, 32_767), Err(InflateError::TooLarge));
        assert!(matches!(inflate_zlib(&data, 32_768), Err(InflateError::Malformed(_))));
        // A stream that ends is refused when its whole output passes the limit.
        let last = data.len() - 4;
        data[last..].copy_from_slice(&adler32(&zeros).to_be_bytes());
        assert_eq!(inflate_zlib(&data, 39_999), Err(InflateError::TooLarge));
        assert_eq!(inflate_zlib(&data, 40_000).unwrap().len(), 40_000);
        // Cut short: everything decoded was handed on before the stream failed (Node: [16384, 788, Z_BUF_ERROR]).
        assert_eq!(inflate_zlib(&data[..data.len() - 6], 39_000), Err(InflateError::TooLarge));
        // A wrong check after exactly two pieces fails in the call that wrote the second (Node: [16384, Z_DATA_ERROR]).
        let zeros = vec![0u8; 32_768];
        let mut exact = vec![0x78, 0x01];
        for (index, block) in zeros.chunks(16_384).enumerate() {
            exact.push(u8::from(index == 1));
            exact.extend_from_slice(&(block.len() as u16).to_le_bytes());
            exact.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            exact.extend_from_slice(block);
        }
        exact.extend_from_slice(&[0, 0, 0, 0]);
        assert!(matches!(inflate_zlib(&exact, 16_384), Err(InflateError::Malformed(_))));
        assert_eq!(inflate_zlib(&exact, 16_383), Err(InflateError::TooLarge));
    }

    #[test]
    fn truncation_and_checksums() {
        let mut out = Output::new(100);
        assert_eq!(inflate_raw(&mut Input::new([0x4b, 0x4c, 0x4a].as_slice()), &mut out), Err(Stop::Truncated));
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32_update(crc32(b"1234"), b"56789"), 0xcbf4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
        assert!(matches!(gunzip(&[], 100), Err(InflateError::Malformed(_))));
        assert!(matches!(brotli(&[], 100), Err(InflateError::Malformed(_))));
    }

    #[test]
    fn brotli_from_node() {
        // zlib.brotliCompressSync(TEXT)
        let body = hex("0b10807b2274657874223a22696e666c617465642062792074686520706172736572227d03");
        assert_eq!(brotli(&body, 1 << 20).unwrap(), TEXT);
        assert_eq!(brotli(&[body.as_slice(), b"trailing"].concat(), 1 << 20).unwrap(), TEXT);
        assert!(matches!(brotli(&body[..body.len() - 1], 1 << 20), Err(InflateError::Malformed(_))));
        assert_eq!(brotli(&body, 10), Err(InflateError::TooLarge));
    }
}

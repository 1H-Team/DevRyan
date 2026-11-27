//! RFC 6455 frames for the tests' scripted peers: an encoder and an
//! incremental reader. The front forwards frames as bytes and decodes none.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub opcode: u8,
    pub masked: bool,
    /// The payload, unmasked.
    pub payload: Vec<u8>,
}

pub const TEXT: u8 = 0x1;
pub const BINARY: u8 = 0x2;
pub const CLOSE: u8 = 0x8;
pub const PING: u8 = 0x9;
pub const PONG: u8 = 0xA;

/// Largest payload the reader accepts.
const MAX_PAYLOAD: u64 = 64 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct FrameReader {
    buffer: Vec<u8>,
}

impl FrameReader {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        loop {
            match decode(&self.buffer)? {
                Some((length, frame)) => {
                    self.buffer.drain(..length);
                    frames.push(frame);
                }
                None => return Ok(frames),
            }
        }
    }
}

/// Decodes one frame from the front of `buffer`: `Ok(None)` when incomplete.
fn decode(buffer: &[u8]) -> Result<Option<(usize, Frame)>, String> {
    if buffer.len() < 2 {
        return Ok(None);
    }
    let fin = buffer[0] & 0x80 != 0;
    let opcode = buffer[0] & 0x0F;
    let masked = buffer[1] & 0x80 != 0;
    let mut length = u64::from(buffer[1] & 0x7F);
    let mut offset = 2;
    if length == 126 {
        if buffer.len() < 4 {
            return Ok(None);
        }
        length = u64::from(u16::from_be_bytes([buffer[2], buffer[3]]));
        offset = 4;
    } else if length == 127 {
        if buffer.len() < 10 {
            return Ok(None);
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&buffer[2..10]);
        length = u64::from_be_bytes(bytes);
        offset = 10;
    }
    if length > MAX_PAYLOAD {
        return Err("frame payload over the test reader's limit".into());
    }
    let mask = if masked {
        if buffer.len() < offset + 4 {
            return Ok(None);
        }
        let key = [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
        offset += 4;
        Some(key)
    } else {
        None
    };
    let end = offset + length as usize;
    if buffer.len() < end {
        return Ok(None);
    }
    let mut payload = buffer[offset..end].to_vec();
    if let Some(key) = mask {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[index % 4];
        }
    }
    Ok(Some((end, Frame { fin, opcode, masked, payload })))
}

/// Encodes a frame; a client passes a mask key, a server passes none.
pub fn encode(fin: bool, opcode: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(if fin { 0x80 } else { 0 } | (opcode & 0x0F));
    let mask_bit = if mask.is_some() { 0x80 } else { 0 };
    match payload.len() {
        length if length < 126 => out.push(mask_bit | length as u8),
        length if length <= 0xFFFF => {
            out.push(mask_bit | 126);
            out.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            out.push(mask_bit | 127);
            out.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    match mask {
        Some(key) => {
            out.extend_from_slice(&key);
            out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ key[index % 4]));
        }
        None => out.extend_from_slice(payload),
    }
    out
}

#[test]
fn round_trips_masked_and_long_frames_split_across_feeds() {
    let long = vec![7u8; 70_000];
    let mut bytes = encode(true, TEXT, b"hello", Some([1, 2, 3, 4]));
    bytes.extend(encode(false, BINARY, &long, None));
    bytes.extend(encode(true, CLOSE, &[0x03, 0xE8], Some([9, 9, 9, 9])));
    let mut reader = FrameReader::default();
    let mut frames = Vec::new();
    for piece in bytes.chunks(1000) {
        frames.extend(reader.feed(piece).unwrap());
    }
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[0].payload, b"hello");
    assert!(frames[0].masked);
    assert_eq!(frames[1].payload, long);
    assert!(!frames[1].fin);
    assert_eq!(frames[2].opcode, CLOSE);
}

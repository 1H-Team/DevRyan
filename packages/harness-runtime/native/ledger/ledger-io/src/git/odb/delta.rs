//! Git's delta format (`patch-delta.c`, `delta.h`): two sizes, then copy and
//! insert instructions, applied exactly as `patch_delta` applies them,
//! refusing what it refuses.
#![forbid(unsafe_code)]

/// `DELTA_SIZE_MIN`: the shortest delta `patch_delta` accepts.
const DELTA_SIZE_MIN: usize = 4;

/// `get_delta_hdr_size`: a little-endian base-128 number; it stops at the end
/// of the data even with the continuation bit set, as Git's does. `None` when
/// the data is empty or the number overflows 64 bits (Git dies there).
fn header_size(data: &[u8], at: &mut usize) -> Option<u64> {
    let mut size = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(*at)?;
        *at += 1;
        let bits = u64::from(byte & 0x7f);
        if shift >= 64 || (shift > 0 && bits >> (64 - shift) != 0) {
            return None;
        }
        size |= bits << shift;
        shift += 7;
        if byte & 0x80 == 0 || *at >= data.len() {
            return Some(size);
        }
    }
}

/// The base and result sizes a delta declares (from its first bytes; Git's
/// `get_size_from_delta` reads them from the first 20 inflated bytes).
pub(crate) fn sizes(delta: &[u8]) -> Option<(u64, u64)> {
    let mut at = 0;
    let source = header_size(delta, &mut at)?;
    let target = header_size(delta, &mut at)?;
    Some((source, target))
}

/// `patch_delta(base, delta)`: `None` wherever Git returns NULL (too short,
/// a base of another size, opcode 0, a copy outside the base, more output
/// than declared, instructions or output left over).
pub(crate) fn apply(base: &[u8], delta: &[u8]) -> Option<Vec<u8>> {
    if delta.len() < DELTA_SIZE_MIN {
        return None;
    }
    let mut at = 0;
    if header_size(delta, &mut at)? != base.len() as u64 {
        return None;
    }
    let declared = header_size(delta, &mut at)?;
    let mut remaining = usize::try_from(declared).ok()?;
    let mut out = Vec::with_capacity(remaining);
    while at < delta.len() {
        let command = delta[at];
        at += 1;
        if command & 0x80 != 0 {
            let mut offset = 0usize;
            let mut size = 0usize;
            for (bit, shift) in [(0x01u8, 0u32), (0x02, 8), (0x04, 16), (0x08, 24)] {
                if command & bit != 0 {
                    offset |= usize::from(*delta.get(at)?) << shift;
                    at += 1;
                }
            }
            for (bit, shift) in [(0x10u8, 0u32), (0x20, 8), (0x40, 16)] {
                if command & bit != 0 {
                    size |= usize::from(*delta.get(at)?) << shift;
                    at += 1;
                }
            }
            if size == 0 {
                size = 0x10000;
            }
            let end = offset.checked_add(size)?;
            if end > base.len() || size > remaining {
                return None;
            }
            out.extend_from_slice(&base[offset..end]);
            remaining -= size;
        } else if command != 0 {
            let size = usize::from(command);
            if size > remaining || size > delta.len() - at {
                return None;
            }
            out.extend_from_slice(&delta[at..at + size]);
            at += size;
            remaining -= size;
        } else {
            return None;
        }
    }
    if remaining != 0 {
        return None;
    }
    Some(out)
}

//! JavaScript strings (UTF-16 units) to and from UTF-8, and `JSON.stringify`
//! of a string written straight as UTF-8: the same results as
//! `devryan_config_text::js::{from_utf8, to_utf8, push_json_string}` (unit
//! tests below compare them), with runs of plain ASCII handled sixteen units
//! at a time, because the group's texts reach 200 000 units and the data file
//! holds many of them.

const RUN: usize = 16;

/// The length of the leading run of units for which `plain` holds, tested `RUN` units at a time.
#[inline]
fn run_of(units: &[u16], plain: impl Fn(u16) -> bool + Copy) -> usize {
    let mut length = 0;
    for chunk in units.as_chunks::<RUN>().0 {
        if !chunk.iter().fold(true, |all, unit| all & plain(*unit)) {
            break;
        }
        length += RUN;
    }
    length + units[length..].iter().position(|unit| !plain(*unit)).unwrap_or(units.len() - length)
}

/// The same for bytes.
#[inline]
pub fn byte_run(bytes: &[u8], plain: impl Fn(u8) -> bool + Copy) -> usize {
    let mut length = 0;
    for chunk in bytes.as_chunks::<RUN>().0 {
        if !chunk.iter().fold(true, |all, byte| all & plain(*byte)) {
            break;
        }
        length += RUN;
    }
    length + bytes[length..].iter().position(|byte| !plain(*byte)).unwrap_or(bytes.len() - length)
}

/// `buffer.toString('utf8')`: each maximal invalid subpart becomes U+FFFD; a byte-order mark is kept.
pub fn utf8_units(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(bytes.len());
    push_utf8_units(&mut out, bytes);
    out
}

/// Appends `buffer.toString('utf8')` of `bytes`.
pub fn push_utf8_units(out: &mut Vec<u16>, bytes: &[u8]) {
    let mut at = 0;
    while at < bytes.len() {
        let ascii = byte_run(&bytes[at..], |byte| byte < 0x80);
        out.extend(bytes[at..at + ascii].iter().map(|byte| u16::from(*byte)));
        at += ascii;
        if at == bytes.len() {
            break;
        }
        // A non-ASCII stretch, up to the next ASCII byte (which no invalid subpart can include).
        let stretch = byte_run(&bytes[at..], |byte| byte >= 0x80);
        out.extend(String::from_utf8_lossy(&bytes[at..at + stretch]).encode_utf16());
        at += stretch;
    }
}

fn push_char(out: &mut Vec<u8>, codepoint: u32) {
    let ch = char::from_u32(codepoint).unwrap_or('\u{fffd}');
    let mut buffer = [0u8; 4];
    out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
}

/// Decodes one character at `at` (a pair, a lone surrogate as U+FFFD, or a unit): the code point and the units used.
#[inline]
fn char_at(units: &[u16], at: usize) -> (u32, usize, bool) {
    let unit = units[at];
    match unit {
        0xd800..=0xdbff => match units.get(at + 1) {
            Some(low) if (0xdc00..=0xdfff).contains(low) => (0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(*low) - 0xdc00), 2, false),
            _ => (0xfffd, 1, true),
        },
        0xdc00..=0xdfff => (0xfffd, 1, true),
        _ => (u32::from(unit), 1, false),
    }
}

/// Appends `Buffer.from(text, 'utf8')` (lone surrogates as U+FFFD).
pub fn push_units_utf8(out: &mut Vec<u8>, units: &[u16]) {
    let mut at = 0;
    while at < units.len() {
        let ascii = run_of(&units[at..], |unit| unit < 0x80);
        out.extend(units[at..at + ascii].iter().map(|unit| *unit as u8));
        at += ascii;
        if at == units.len() {
            break;
        }
        let (codepoint, used, _) = char_at(units, at);
        push_char(out, codepoint);
        at += used;
    }
}

/// `Buffer.from(text, 'utf8')`.
pub fn units_utf8(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len());
    push_units_utf8(&mut out, units);
    out
}

/// Appends the UTF-8 of `JSON.stringify(text)` (well-formed: lone surrogates as `\udxxx`).
pub fn push_json_utf8(out: &mut Vec<u8>, units: &[u16]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let mut at = 0;
    while at < units.len() {
        let plain = run_of(&units[at..], |unit| (0x20..0x80).contains(&unit) && unit != 0x22 && unit != 0x5c);
        out.extend(units[at..at + plain].iter().map(|unit| *unit as u8));
        at += plain;
        if at == units.len() {
            break;
        }
        let unit = units[at];
        let escape: Option<&[u8]> = match unit {
            0x22 => Some(b"\\\""),
            0x5c => Some(b"\\\\"),
            0x08 => Some(b"\\b"),
            0x0c => Some(b"\\f"),
            0x0a => Some(b"\\n"),
            0x0d => Some(b"\\r"),
            0x09 => Some(b"\\t"),
            _ => None,
        };
        if let Some(escape) = escape {
            out.extend_from_slice(escape);
            at += 1;
            continue;
        }
        let (codepoint, used, lone) = char_at(units, at);
        if unit < 0x20 || lone {
            out.extend_from_slice(b"\\u");
            for shift in [12, 8, 4, 0] {
                out.push(HEX[usize::from((unit >> shift) & 0xf)]);
            }
        } else {
            push_char(out, codepoint);
        }
        at += used;
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use devryan_config_text::js;

    fn samples() -> Vec<Vec<u16>> {
        let mut samples: Vec<Vec<u16>> = [
            "",
            "plain",
            "quote \" back \\ slash / tab\t nl\n cr\r bs\u{8} ff\u{c} nul\u{0} us\u{1f} del\u{7f}",
            "é ü 中文 😀",
            &"x".repeat(100),
            &format!("{}é{}", "a".repeat(40), "b".repeat(33)),
        ]
        .iter()
        .map(|text| js::units(text))
        .collect();
        samples.push(vec![0xd800]);
        samples.push(vec![0x61, 0xdc00, 0x62]);
        samples.push(vec![0xd800, 0xd800, 0xdc00]);
        samples.push([js::units(&"y".repeat(31)), vec![0xd83d], js::units(&"z".repeat(17))].concat());
        samples
    }

    #[test]
    fn same_as_the_reference_helpers() {
        for units in samples() {
            assert_eq!(units_utf8(&units), js::to_utf8(&units), "{units:?}");
            let mut json = Vec::new();
            push_json_utf8(&mut json, &units);
            assert_eq!(json, js::to_utf8(&js::json_string(&units)), "{units:?}");
        }
        for bytes in [
            b"".as_slice(),
            b"plain ascii text that runs past sixteen bytes",
            "é ü 中文 😀".as_bytes(),
            b"\xef\xbb\xbf{}",
            b"bad \xff\xfe \xc3( \xe2\x82 \xf0\x9f\x98 end",
            b"\xc0\x80\xed\xa0\x80\xf4\x90\x80\x80 overlong, surrogate, too large",
        ] {
            assert_eq!(utf8_units(bytes), js::from_utf8(bytes), "{bytes:?}");
        }
    }
}

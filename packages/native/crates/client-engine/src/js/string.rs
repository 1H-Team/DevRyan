//! JavaScript string operations over UTF-16 code units (lengths, slices and
//! indices are code units; a lone surrogate is kept as it is).

use super::value::Str;

/// ECMAScript WhiteSpace or LineTerminator: what `trim` removes and `\s` matches.
pub fn is_space(unit: u16) -> bool {
    if crate::plant::on("rv-space-nel") && unit == 0x85 {
        return true;
    }
    if crate::plant::on("rv-space-no-feff") && unit == 0xfeff {
        return false;
    }
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `text.trim()`.
pub fn trim(text: &[u16]) -> &[u16] {
    let start = text.iter().position(|unit| !is_space(*unit)).unwrap_or(text.len());
    if crate::plant::on("rv-trim-start-only") {
        return &text[start..];
    }
    let end = text.iter().rposition(|unit| !is_space(*unit)).map_or(start, |at| at + 1);
    &text[start..end.max(start)]
}

/// `text.toLowerCase()`: full Unicode case mapping without a locale (what
/// JavaScriptCore and V8 do outside tr, az and lt), Final_Sigma included,
/// over each well-formed run; a lone surrogate maps to itself.
pub fn to_lower_case(text: &[u16]) -> Vec<u16> {
    if text.iter().all(|unit| !(0x41..=0x5a).contains(unit) && *unit < 0x80) {
        return text.to_vec();
    }
    if crate::plant::on("rv-lower-ascii") {
        return text.iter().map(|unit| if (0x41..=0x5a).contains(unit) { unit + 32 } else { *unit }).collect();
    }
    let mut out = Vec::with_capacity(text.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<u16>| {
        if !run.is_empty() {
            let lower = if crate::plant::on("rv-lower-no-final-sigma") {
                run.chars().flat_map(char::to_lowercase).collect()
            } else {
                run.to_lowercase()
            };
            out.extend(lower.encode_utf16());
            run.clear();
        }
    };
    for item in char::decode_utf16(text.iter().copied()) {
        match item {
            Ok(character) => run.push(character),
            Err(error) => {
                flush(&mut run, &mut out);
                out.push(if crate::plant::on("rv-lower-lone-fffd") {
                    0xfffd
                } else {
                    error.unpaired_surrogate()
                });
            }
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Concatenation.
pub fn concat(parts: &[&[u16]]) -> Str {
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn trim_is_javascript_white_space_and_line_terminators() {
        assert_eq!(trim(&units("\u{feff}\u{2028} a b\u{3000}\t")), units("a b"));
        // U+0085 and U+180E are no white space in JavaScript.
        assert_eq!(trim(&units("\u{85}a\u{180e}")), units("\u{85}a\u{180e}"));
        assert_eq!(trim(&units(" \n ")), units(""));
    }

    #[test]
    fn lower_case_is_full_unicode_mapping_without_a_locale() {
        assert_eq!(to_lower_case(&units("FAİLED")), units("fai\u{307}led"));
        assert_eq!(to_lower_case(&units("ΣΑΣ")), units("σας"));
        assert_eq!(to_lower_case(&units("ÉTAT")), units("état"));
        let lone = [u16::from(b'R'), 0xdc00, u16::from(b'X')];
        assert_eq!(to_lower_case(&lone), vec![u16::from(b'r'), 0xdc00, u16::from(b'x')]);
        assert_eq!(to_lower_case(&units("plain")), units("plain"));
    }
}

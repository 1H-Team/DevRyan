//! JavaScript strings and the few built-ins the two packages lean on.
//!
//! Every text here is a JavaScript string: a sequence of UTF-16 code units,
//! lone surrogates included, indexed by unit as `charCodeAt` and `substring`
//! index it. Offsets reported by jsonc-parser and by yaml are unit offsets.

/// UTF-16 units of Rust text.
pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// What `buffer.toString('utf8')` gives for these bytes: each maximal invalid
/// subpart becomes U+FFFD, and a byte-order mark is kept.
pub fn from_utf8(bytes: &[u8]) -> Vec<u16> {
    String::from_utf8_lossy(bytes).encode_utf16().collect()
}

/// What `Buffer.from(text, 'utf8')` (and so `writeFileSync(file, text, 'utf8')`)
/// writes: UTF-8, with every lone surrogate written as U+FFFD.
pub fn to_utf8(text: &[u16]) -> Vec<u8> {
    let mut out = String::with_capacity(text.len());
    for decoded in char::decode_utf16(text.iter().copied()) {
        out.push(decoded.unwrap_or('\u{fffd}'));
    }
    out.into_bytes()
}

/// Rust text for messages: lone surrogates become U+FFFD.
pub fn lossy(text: &[u16]) -> String {
    String::from_utf8(to_utf8(text)).unwrap_or_default()
}

/// `String(x)` for a JavaScript number (ECMA-262 `Number::toString`).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.to_owned();
    }
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    // Rust's `{:e}` prints the shortest digits that round-trip.
    let text = format!("{:e}", x.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exponent + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n - 1 < 0 { '-' } else { '+' });
        out.push_str(&(n - 1).unsigned_abs().to_string());
    }
    out
}

/// Appends `JSON.stringify(text)` (well-formed: lone surrogates as `\udxxx`).
pub fn push_json_string(out: &mut Vec<u16>, text: &[u16]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(u16::from(b'"'));
    let mut index = 0;
    while index < text.len() {
        let unit = text[index];
        index += 1;
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
            out.extend(escape.iter().map(|byte| u16::from(*byte)));
            continue;
        }
        let lone = match unit {
            0xd800..=0xdbff => {
                if text.get(index).is_some_and(|low| (0xdc00..=0xdfff).contains(low)) {
                    out.push(unit);
                    out.push(text[index]);
                    index += 1;
                    continue;
                }
                true
            }
            0xdc00..=0xdfff => true,
            _ => false,
        };
        if unit < 0x20 || lone {
            out.extend(b"\\u".iter().map(|byte| u16::from(*byte)));
            for shift in [12, 8, 4, 0] {
                out.push(u16::from(HEX[usize::from((unit >> shift) & 0xf)]));
            }
        } else {
            out.push(unit);
        }
    }
    out.push(u16::from(b'"'));
}

/// `JSON.stringify(text)` as Rust text (always well-formed: lone surrogates are escaped).
pub fn lossy_json(text: &[u16]) -> String {
    lossy(&json_string(text))
}

/// `JSON.stringify(text)`.
pub fn json_string(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len() + 2);
    push_json_string(&mut out, text);
    out
}

/// ECMAScript WhiteSpace or LineTerminator: what `trim` removes and `\s` matches.
pub fn is_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// ECMAScript LineTerminator: where `.` stops and `^`/`$` match under the `m` flag.
pub fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `text.trim()`.
pub fn trim(text: &[u16]) -> &[u16] {
    trim_end(trim_start(text))
}

/// `text.trimStart()`.
pub fn trim_start(text: &[u16]) -> &[u16] {
    let start = text.iter().position(|unit| !is_space(*unit)).unwrap_or(text.len());
    &text[start..]
}

/// `text.trimEnd()`.
pub fn trim_end(text: &[u16]) -> &[u16] {
    let end = text.iter().rposition(|unit| !is_space(*unit)).map_or(0, |index| index + 1);
    &text[..end]
}

/// `haystack.indexOf(needle, from)` (with `from` clamped like JavaScript).
pub fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    let from = from.min(haystack.len());
    if needle.is_empty() {
        return Some(from);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| &haystack[at..at + needle.len()] == needle)
}

/// `haystack.includes(needle)`.
pub fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    index_of(haystack, needle, 0).is_some()
}

/// `text.substring(start, end)` with JavaScript's clamping and ordering.
pub fn substring(text: &[u16], start: i64, end: i64) -> &[u16] {
    let clamp = |value: i64| value.clamp(0, text.len() as i64) as usize;
    let (a, b) = (clamp(start), clamp(end));
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    &text[a..b]
}

/// `text.substr(start, length)` for a non-negative start.
pub fn substr(text: &[u16], start: usize, length: usize) -> &[u16] {
    let start = start.min(text.len());
    let end = start.saturating_add(length).min(text.len());
    &text[start..end]
}

/// Concatenation helper.
pub fn concat(parts: &[&[u16]]) -> Vec<u16> {
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// `Number(text)` for a JavaScript StringNumericLiteral of plain decimal form
/// (`[+-]digits[.digits][e[+-]digits]`, either part may be empty around the
/// dot). Returns None when the text is not of that form.
pub fn parse_decimal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        at += 1;
    }
    let digits_start = at;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
    }
    let mut digits = at - digits_start;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let fraction = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        digits += at - fraction;
    }
    if digits == 0 {
        return None;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == exponent {
            return None;
        }
    }
    if at != bytes.len() {
        return None;
    }
    // Rust's parser is correctly rounded, as JavaScript's is; it rejects a
    // bare trailing or leading dot only in forms we normalise here.
    let mut normal = text.to_owned();
    if normal.contains('.') {
        let (head, tail) = normal.split_once('.').unwrap_or((&normal, ""));
        let sign_len = usize::from(head.starts_with(['+', '-']));
        let head = if head.len() == sign_len { format!("{head}0") } else { head.to_owned() };
        let tail = if tail.is_empty() || tail.starts_with(['e', 'E']) {
            format!("0{tail}")
        } else {
            tail.to_owned()
        };
        normal = format!("{head}.{tail}");
    }
    normal.parse::<f64>().ok()
}

/// `parseInt(digits, radix)` for a non-empty run of digits valid in a radix
/// that is a power of two (8 or 16): exact, rounded to nearest, ties to even,
/// as the specification requires for these radixes.
pub fn parse_int_power_of_two(digits: &[u16], radix: u32) -> f64 {
    let bits_per_digit = radix.trailing_zeros();
    // Collect the value's bits, most significant first, without leading zeros.
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit as usize);
    for unit in digits {
        let value = char::from_u32(u32::from(*unit)).and_then(|ch| ch.to_digit(radix)).unwrap_or(0);
        for shift in (0..bits_per_digit).rev() {
            let bit = (value >> shift) & 1 == 1;
            if bits.is_empty() && !bit {
                continue;
            }
            bits.push(bit);
        }
    }
    if bits.is_empty() {
        return 0.0;
    }
    if bits.len() <= 53 {
        let mut value = 0u64;
        for bit in &bits {
            value = value * 2 + u64::from(*bit);
        }
        return value as f64;
    }
    let mut mantissa = 0u64;
    for bit in &bits[..53] {
        mantissa = mantissa * 2 + u64::from(*bit);
    }
    let round = bits[53];
    let sticky = bits[54..].iter().any(|bit| *bit);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = (bits.len() - 53) as i32;
    if exponent > 1100 {
        return f64::INFINITY;
    }
    // mantissa < 2^54, exact; scaling by a power of two is exact until overflow.
    (mantissa as f64) * 2f64.powi(exponent)
}

/// `decodeURIComponent(text)`; `Err` carries what `String(error)` prints.
pub fn decode_uri_component(text: &[u16]) -> Result<Vec<u16>, &'static str> {
    const MALFORMED: &str = "URIError: URI malformed";
    let hex = |unit: u16| char::from_u32(u32::from(unit)).and_then(|ch| ch.to_digit(16));
    let byte_at = |at: usize| -> Option<u8> {
        if text.get(at) != Some(&u16::from(b'%')) {
            return None;
        }
        let high = hex(*text.get(at + 1)?)?;
        let low = hex(*text.get(at + 2)?)?;
        Some((high * 16 + low) as u8)
    };
    let mut out = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let unit = text[at];
        if unit != u16::from(b'%') {
            out.push(unit);
            at += 1;
            continue;
        }
        let first = byte_at(at).ok_or(MALFORMED)?;
        at += 3;
        if first < 0x80 {
            // decodeURIComponent has an empty reserved set: every byte decodes.
            out.push(u16::from(first));
            continue;
        }
        let count = match first {
            0xc0..=0xdf => 1,
            0xe0..=0xef => 2,
            0xf0..=0xf7 => 3,
            _ => return Err(MALFORMED),
        };
        let mut bytes = vec![first];
        for _ in 0..count {
            let next = byte_at(at).ok_or(MALFORMED)?;
            if next & 0xc0 != 0x80 {
                return Err(MALFORMED);
            }
            bytes.push(next);
            at += 3;
        }
        let decoded = std::str::from_utf8(&bytes).map_err(|_| MALFORMED)?;
        out.extend(decoded.encode_utf16());
    }
    Ok(out)
}

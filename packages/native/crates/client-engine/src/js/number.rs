//! JavaScript numbers: `Number::toString` and `StringToNumber` (what
//! `String(x)` and `Number(text)` do).

use super::string::{is_space, trim};

/// The ledger core's `Number::toString` (`packages/harness-runtime/native/ledger-core`, its `js` module), compiled
/// into this crate from its own source file: one implementation of the number layout for both Rust workspaces
/// (the C0i review's S1 and S6(b)). That file is proven against V8 by the ledger core's vectors, which
/// `tests/ledger_vectors.rs` also runs here. It is not a dependency on the ledger core's crate: that crate's
/// manifest and lockfile feed the provenance digest of its tracked WebAssembly module, and it declares no licence
/// (packages/native/DOCUMENTATION.md, "One JavaScript implementation"). Formatting is the ledger core's.
#[rustfmt::skip]
#[path = "../../../../../harness-runtime/native/ledger-core/src/js/number.rs"]
mod shared;

/// `String(x)` for a JavaScript number (ECMA-262 `Number::toString`, radix 10): the digits are the shortest that
/// round-trip and, on an exact tie, the even ones, as V8 and JavaScriptCore write them.
pub fn to_string(x: f64) -> String {
    if crate::plant::on("rv-num-exp-20") && x.is_finite() && x.abs() >= 1e20 && x.abs() < 1e21 {
        return format!("{x:e}").replace('e', "e+");
    }
    shared::number_to_string(x)
}

/// `Number(text)` for a string (ECMA-262 `StringToNumber`): surrounding
/// white space ignored, the empty string 0, `Infinity` with a sign, `0x`,
/// `0o` and `0b` integers without one, and decimal literals; anything else NaN.
pub fn from_string(text: &[u16]) -> f64 {
    let body = trim(text);
    if body.is_empty() {
        return if crate::plant::on("rv-num-empty-nan") { f64::NAN } else { 0.0 };
    }
    if body.iter().any(|unit| *unit >= 0x80 || is_space(*unit)) {
        return f64::NAN;
    }
    let ascii: String = body.iter().map(|unit| char::from(*unit as u8)).collect();
    if crate::plant::on("rv-num-signed-hex")
        && let Some(digits) = ascii.strip_prefix("-0x")
    {
        return -radix_integer(digits, 16);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = ascii.strip_prefix(prefix) {
            return radix_integer(digits, radix);
        }
    }
    let (sign, rest) = match ascii.as_bytes()[0] {
        b'+' => (1.0, &ascii[1..]),
        b'-' => (-1.0, &ascii[1..]),
        _ => (1.0, &ascii[..]),
    };
    if rest == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(rest) {
        if crate::plant::on("rv-num-lenient-suffix") {
            let prefix: String = rest.chars().take_while(|character| character.is_ascii_digit() || *character == '.').collect();
            if let Ok(value) = prefix.parse::<f64>() {
                return sign * value;
            }
        }
        return f64::NAN;
    }
    // Rust's parse is correctly rounded, as ECMA-262 requires; the syntax was checked above.
    rest.parse::<f64>().map_or(f64::NAN, |value| sign * value)
}

/// StrUnsignedDecimalLiteral without `Infinity`: digits with an optional
/// fraction (either part may be empty, not both) and an optional exponent.
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    let integer = bytes.iter().take_while(|byte| byte.is_ascii_digit()).count();
    at += integer;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        fraction = bytes[at..].iter().take_while(|byte| byte.is_ascii_digit()).count();
        at += fraction;
    }
    if integer == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = bytes[at..].iter().take_while(|byte| byte.is_ascii_digit()).count();
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

/// The exact value of a binary, octal or hexadecimal integer, rounded to
/// nearest with ties to even (NaN without digits or with a stray one).
fn radix_integer(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let bits_per_digit = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::new();
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else { return f64::NAN };
        for shift in (0..bits_per_digit).rev() {
            bits.push((digit >> shift) & 1 == 1);
        }
    }
    let first = match bits.iter().position(|bit| *bit) {
        Some(first) => first,
        None => return 0.0,
    };
    let bits = &bits[first..];
    if bits.len() <= 64 {
        let value = bits.iter().fold(0u64, |acc, bit| (acc << 1) | u64::from(*bit));
        // An integer-to-float conversion rounds to nearest, ties to even.
        return value as f64;
    }
    let mantissa = bits[..53].iter().fold(0u64, |acc, bit| (acc << 1) | u64::from(*bit));
    let round = bits[53];
    let sticky = bits[54..].iter().any(|bit| *bit);
    let mantissa = if round && (sticky || mantissa & 1 == 1) { mantissa + 1 } else { mantissa };
    let exponent = (bits.len() - 53) as i32;
    (mantissa as f64) * 2f64.powi(exponent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(text: &str) -> f64 {
        from_string(&text.encode_utf16().collect::<Vec<u16>>())
    }

    #[test]
    fn number_layout_follows_ecma_262() {
        for (value, text) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (1e-6, "0.000001"),
            (123.456, "123.456"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(to_string(value), text);
        }
    }

    #[test]
    fn string_to_number_follows_ecma_262() {
        assert_eq!(number(" 12 "), 12.0);
        assert_eq!(number(""), 0.0);
        assert_eq!(number("\u{feff}3\u{2029}"), 3.0);
        assert!(number("12px").is_nan());
        assert!(number("1e").is_nan());
        assert!(number(".").is_nan());
        assert_eq!(number(".5"), 0.5);
        assert_eq!(number("5."), 5.0);
        assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
        assert!(number("infinity").is_nan());
        assert!(number("-0x10").is_nan());
        assert_eq!(number("0x10"), 16.0);
        assert_eq!(number("0b101"), 5.0);
        assert!(number("0x").is_nan());
        assert!(number("1_000").is_nan());
        assert!(number("１").is_nan());
        assert_eq!(number("-0").to_bits(), (-0.0f64).to_bits());
        assert_eq!(number("0x20000000000001"), 9007199254740992.0);
        assert_eq!(number("0x1fffffffffffffffff"), 590295810358705700000.0);
    }
}

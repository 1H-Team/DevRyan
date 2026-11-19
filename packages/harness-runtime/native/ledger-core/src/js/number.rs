//! ECMAScript `Number::toString(10)`: what `String(x)` and `JSON.stringify`
//! write for a number.
//!
//! The digits are the shortest that round-trip, taken from Rust's shortest
//! formatting (`{:e}`); the layout is the specification's (ECMA-262,
//! `Number::toString`, steps 5 to 12), written here by hand.

/// `String(x)` for a JavaScript number.
pub fn number_to_string(x: f64) -> String {
    let mut out = String::new();
    write_number(&mut out, x);
    out
}

/// Appends `String(x)` to `out`.
pub fn write_number(out: &mut String, x: f64) {
    if x.is_nan() {
        out.push_str("NaN");
        return;
    }
    if x == 0.0 {
        // Both zeros: `String(-0)` is "0".
        out.push('0');
        return;
    }
    if x.is_infinite() {
        out.push_str(if x < 0.0 { "-Infinity" } else { "Infinity" });
        return;
    }
    if x < 0.0 {
        out.push('-');
    }
    let (digits, exponent) = shortest_digits(x.abs());
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
}

/// Significant digits and decimal exponent of `x` in `d.ddde<exp>` form.
fn scientific(text: &str) -> (String, i32) {
    let (mantissa, exponent) = text.split_once('e').expect("{:e} writes an exponent");
    let digits = mantissa.chars().filter(|c| *c != '.').collect();
    (
        digits,
        exponent.parse().expect("{:e} writes a decimal exponent"),
    )
}

/// The digits `s` (k of them) and exponent of `x = s[0].s[1..] * 10^exp`
/// that `Number::toString` uses, for a finite positive `x`; the
/// specification's n is exp + 1.
///
/// Rust's shortest formatting already gives the fewest digits that round
/// trip and, among those, the closest to `x`. It differs from V8 only when
/// two k-digit candidates are exactly equally close (x is exactly halfway,
/// e.g. 1000000000000042.25 between ...42.2 and ...42.3): Rust takes the
/// upper one, V8 the even one, as ECMA-262 recommends ("if there are two
/// such possible values of s, choose the one that is even"). This detects
/// the exact tie and takes the even candidate when it also round-trips.
fn shortest_digits(x: f64) -> (String, i32) {
    let (digits, exponent) = scientific(&format!("{x:e}"));
    let k = digits.len();
    // A tie needs x to be exactly a (k+1)-digit decimal ending in 5. The
    // correctly rounded (k+1)-digit form is a cheap filter; 767 places
    // after the point hold every finite double exactly.
    let (rounded, _) = scientific(&format!("{x:.k$e}"));
    if !rounded.ends_with('5') {
        return (digits, exponent);
    }
    let (exact, exact_exponent) = scientific(&format!("{x:.767e}"));
    if exact_exponent != exponent
        || exact.as_bytes()[k] != b'5'
        || exact.as_bytes()[k + 1..].iter().any(|&digit| digit != b'0')
    {
        return (digits, exponent);
    }
    let lower = exact[..k].to_string();
    let other = if digits == lower {
        match increment(&lower) {
            Some(upper) => upper,
            None => return (digits, exponent),
        }
    } else {
        lower
    };
    let even = (other.as_bytes()[k - 1] - b'0').is_multiple_of(2);
    let round_trips = format!("{}e{}", other, exponent - (k as i32 - 1)).parse::<f64>() == Ok(x);
    if even && round_trips {
        (other, exponent)
    } else {
        (digits, exponent)
    }
}

/// A decimal digit string plus one in its last place, if it keeps its length.
fn increment(digits: &str) -> Option<String> {
    let mut bytes = digits.as_bytes().to_vec();
    for byte in bytes.iter_mut().rev() {
        if *byte == b'9' {
            *byte = b'0';
        } else {
            *byte += 1;
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::number_to_string as s;

    #[test]
    // The literals are the exact halfway values, written out in full.
    #[allow(clippy::excessive_precision)]
    fn exact_ties_take_the_even_digit_as_v8_does() {
        // Both seen in Node 26.13 and Electron's Node 24.22.
        assert_eq!(s(1000000000000042.25), "1000000000000042.2");
        assert_eq!(s(83176082636972.125), "83176082636972.12");
        assert_eq!(s(999999973283321.25), "999999973283321.2");
    }

    #[test]
    fn the_layout_boundaries() {
        assert_eq!(s(1e21), "1e+21");
        assert_eq!(s(1e20), "100000000000000000000");
        assert_eq!(s(123456789012345680000.0), "123456789012345680000");
        assert_eq!(s(1e-7), "1e-7");
        assert_eq!(s(1e-6), "0.000001");
        assert_eq!(s(1.5e-7), "1.5e-7");
        assert_eq!(s(123e-20), "1.23e-18");
        assert_eq!(s(-0.0), "0");
        assert_eq!(s(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(s(5e-324), "5e-324");
        assert_eq!(s(f64::MAX), "1.7976931348623157e+308");
        assert_eq!(s(9007199254740992.0), "9007199254740992");
        assert_eq!(s(-12.5), "-12.5");
        assert_eq!(s(f64::NAN), "NaN");
        assert_eq!(s(f64::NEG_INFINITY), "-Infinity");
    }
}

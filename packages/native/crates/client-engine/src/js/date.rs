//! A Date's text: `Date.prototype.toString` and `toISOString` (what `String(date)`, a template literal and
//! `JSON.stringify` write), in UTC. The harness runs every engine with `TZ=UTC`, and V8 and JavaScriptCore write
//! the same text there; a family that formats a date in the product's own time zone would take the zone as an input.

/// Days since 1970-01-01 to (year, month 1..12, day 1..31), proleptic Gregorian (Howard Hinnant's civil_from_days).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

struct Parts {
    year: i64,
    month: i64,
    day: i64,
    weekday: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millisecond: i64,
}

fn parts(time: f64) -> Parts {
    let ms = time as i64;
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil(days);
    Parts {
        year,
        month,
        day,
        weekday: (days + 4).rem_euclid(7),
        hour: in_day / 3_600_000,
        minute: in_day / 60_000 % 60,
        second: in_day / 1000 % 60,
        millisecond: in_day % 1000,
    }
}

/// The largest time value a Date holds (ECMA-262 TimeClip).
const MAX_TIME: f64 = 8.64e15;

fn valid(time: f64) -> bool {
    time.is_finite() && time.abs() <= MAX_TIME
}

/// `String(date)`: `Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)`, or `Invalid Date`.
pub fn to_string(time: f64) -> String {
    if !valid(time) {
        return "Invalid Date".to_owned();
    }
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let p = parts(time);
    let year = if p.year < 0 { format!("-{:06}", -p.year) } else { format!("{:04}", p.year) };
    format!(
        "{} {} {:02} {year} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[p.weekday as usize],
        MONTHS[(p.month - 1) as usize],
        p.day,
        p.hour,
        p.minute,
        p.second
    )
}

/// `date.toJSON()`: `toISOString()` for a valid date (`2023-11-14T22:13:20.000Z`, six-digit signed years outside
/// 0 to 9999), `None` (JSON `null`) for an invalid one.
pub fn to_json(time: f64) -> Option<String> {
    if !valid(time) {
        return None;
    }
    let p = parts(time);
    let year = if (0..=9999).contains(&p.year) {
        format!("{:04}", p.year)
    } else if p.year < 0 {
        format!("-{:06}", -p.year)
    } else {
        format!("+{:06}", p.year)
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        p.month, p.day, p.hour, p.minute, p.second, p.millisecond
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_written_as_the_engines_write_them_in_utc() {
        assert_eq!(to_string(1_700_000_000_000.0), "Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(to_string(0.0), "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(to_string(-1.0), "Wed Dec 31 1969 23:59:59 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(to_string(f64::NAN), "Invalid Date");
        assert_eq!(to_json(1_700_000_000_000.0).as_deref(), Some("2023-11-14T22:13:20.000Z"));
        assert_eq!(to_json(8.64e15).as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(to_json(-8.64e15).as_deref(), Some("-271821-04-20T00:00:00.000Z"));
        assert_eq!(to_json(f64::NAN), None);
    }
}

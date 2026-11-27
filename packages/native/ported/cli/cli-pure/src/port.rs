//! The pure part of the `devryan` CLI, ported from `packages/web/bin/cli.js`.
//!
//! `answer` mirrors `parseArgs` and the first steps of `main()` and answers only what needs no
//! file, process or network: `--version`, `--help`, removed and unknown flags, the parser's
//! argument errors, unknown commands, unknown tunnel subcommands, `tunnel completion` and the
//! argument checks of `runtime bundle resume`. Every other path returns `None` and the original
//! answers (serve, stop, restart, status, logs, update, enroll-owner, tunnel profile and the
//! tunnel network commands, a valid `runtime bundle resume`).
//!
//! JavaScript rules kept on purpose: `String.prototype.trim` whitespace, `parseInt` and
//! `Number` on digit strings (f64), `Number#toString` for the port error, UTF-16 lengths and
//! edit distances, `JSON.stringify(value, null, 2)` escaping, and object-prototype names
//! (`toString`, `__proto__`, ...) that `commands[command]` finds.

const HELP: &str = include_str!("../texts/help.txt");
const TUNNEL_HELP: &str = include_str!("../texts/tunnel-help.txt");
const COMPLETION_BASH: &str = include_str!("../texts/completion-bash.txt");
const COMPLETION_ZSH: &str = include_str!("../texts/completion-zsh.txt");
const COMPLETION_FISH: &str = include_str!("../texts/completion-fish.txt");

const EXIT_GENERAL_ERROR: u8 = 1;
const EXIT_USAGE_ERROR: u8 = 2;

/// What the original reads besides its arguments.
pub struct Context<'a> {
    /// `version` of packages/web/package.json; `None` when it could not be read as a string.
    pub version: Option<&'a str>,
    /// `migrateDataRootAtStartup` would neither move nor write anything.
    pub migration_quiet: bool,
    /// `process.stdout.isTTY`: errors from `main().catch` are drawn with clack then.
    pub stdout_is_tty: bool,
}

/// The whole observable result of one run.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub stdout: String,
    pub stderr: String,
    pub code: u8,
}

/// Answers `devryan <args>` (without the program name), or `None` when the original must.
pub fn answer(args: &[String], ctx: &Context) -> Option<Answer> {
    let has_plain_flag = args.iter().any(|a| a == "--plain");
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        // Thrown before `activeCommandOptions` is set: never JSON.
        Err(message) => return caught(&message, EXIT_USAGE_ERROR, false, has_plain_flag, ctx),
    };

    if parsed.version {
        let version = ctx.version?;
        let stdout = if parsed.json {
            print_json(vec![
                ("status", Json::str("ok")),
                ("version", Json::str(version)),
            ])
        } else {
            format!("{version}\n")
        };
        return Some(Answer {
            stdout,
            stderr: String::new(),
            code: 0,
        });
    }

    // The data-root migration runs here; only a run where it does nothing is answered.
    if !ctx.migration_quiet {
        return None;
    }

    if !parsed.removed.is_empty() {
        if parsed.json {
            let details = parsed.removed.iter().map(|e| Json::str(e)).collect();
            let error = Json::Obj(vec![
                ("message", Json::str(&parsed.removed[0])),
                ("details", Json::Arr(details)),
            ]);
            return Some(out(
                print_json(vec![("status", Json::str("error")), ("error", error)]),
                EXIT_GENERAL_ERROR,
            ));
        }
        let stderr = parsed
            .removed
            .iter()
            .map(|e| format!("Error: {e}\n"))
            .collect();
        return Some(Answer {
            stdout: String::new(),
            stderr,
            code: EXIT_GENERAL_ERROR,
        });
    }

    let command = parsed.command();
    if parsed.help {
        return Some(out(
            if command == "tunnel" {
                TUNNEL_HELP
            } else {
                HELP
            }
            .to_string(),
            0,
        ));
    }

    match command {
        "tunnel" => tunnel(&parsed, has_plain_flag, ctx),
        "runtime" => runtime(&parsed),
        "enroll-owner" | "serve" | "stop" | "restart" | "status" | "logs" | "update" => None,
        // `commands[command]` finds these on Object.prototype and calls (or fails to call) them.
        name if OBJECT_PROTOTYPE_NAMES.contains(&name) => None,
        unknown => {
            let known = [
                "serve",
                "stop",
                "restart",
                "status",
                "tunnel",
                "logs",
                "update",
                "enroll-owner",
            ];
            let hint = suggestion_hint(unknown, &known);
            let message = format!("Unknown command '{unknown}'.{hint}");
            if parsed.json {
                let error = Json::Obj(vec![("message", Json::str(&message))]);
                let help = Json::Obj(vec![
                    ("level", Json::str("info")),
                    ("code", Json::str("USAGE_HELP")),
                    ("message", Json::str("Use --help to see available commands")),
                ]);
                let payload = vec![
                    ("status", Json::str("error")),
                    ("error", error),
                    ("messages", Json::Arr(vec![help])),
                ];
                return Some(out(print_json(payload), EXIT_USAGE_ERROR));
            }
            let stderr = format!("Error: {message}\nUse --help to see available commands\n");
            Some(Answer {
                stdout: String::new(),
                stderr,
                code: EXIT_USAGE_ERROR,
            })
        }
    }
}

const OBJECT_PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn out(stdout: String, code: u8) -> Answer {
    Answer {
        stdout,
        stderr: String::new(),
        code,
    }
}

/// `main().catch`: JSON when the options are known and ask for it, clack frames on a TTY
/// without `--plain` (left to the original), else `Error: <message>` on stderr.
fn caught(
    message: &str,
    code: u8,
    json: bool,
    has_plain_flag: bool,
    ctx: &Context,
) -> Option<Answer> {
    if json {
        let error = Json::Obj(vec![("message", Json::str(message))]);
        return Some(out(
            print_json(vec![("status", Json::str("error")), ("error", error)]),
            code,
        ));
    }
    if ctx.stdout_is_tty && !has_plain_flag {
        return None;
    }
    Some(Answer {
        stdout: String::new(),
        stderr: format!("Error: {message}\n"),
        code,
    })
}

fn tunnel(parsed: &Parsed, has_plain_flag: bool, ctx: &Context) -> Option<Answer> {
    let subcommand = parsed.positional_or(1).unwrap_or("help");
    match subcommand {
        "help" => Some(out(TUNNEL_HELP.to_string(), 0)),
        "completion" => {
            let shell = parsed.positional_or(2).unwrap_or("bash");
            let script = match js_trim(shell).to_lowercase().as_str() {
                "bash" => COMPLETION_BASH,
                "zsh" => COMPLETION_ZSH,
                "fish" => COMPLETION_FISH,
                _ => {
                    let message =
                        format!("Unsupported shell '{shell}'. Supported: bash, zsh, fish.");
                    return caught(&message, EXIT_USAGE_ERROR, parsed.json, has_plain_flag, ctx);
                }
            };
            Some(out(script.to_string(), 0))
        }
        "profile" | "providers" | "ready" | "doctor" | "status" | "start" | "stop" => None,
        unknown => {
            let known = [
                "help",
                "providers",
                "ready",
                "doctor",
                "status",
                "start",
                "stop",
                "profile",
                "completion",
            ];
            let hint = suggestion_hint(unknown, &known);
            let message =
                format!("Unknown tunnel subcommand '{unknown}'.{hint} Use 'devryan tunnel help'.");
            caught(&message, EXIT_USAGE_ERROR, parsed.json, has_plain_flag, ctx)
        }
    }
}

/// `runRuntimeBundleCommand`'s checks; a request that passes them is the original's to carry out.
fn runtime(parsed: &Parsed) -> Option<Answer> {
    const ALLOWED: [&str; 5] = ["expected-revision", "json", "quiet", "q", "plain"];
    let names = &parsed.option_names;
    let code = if names.iter().any(|n| !ALLOWED.contains(&n.as_str()))
        || names.iter().filter(|n| *n == "expected-revision").count() > 1
        || parsed.positionals.len() != 3
        || parsed.positionals.join(" ") != "runtime bundle resume"
    {
        "bundle_command_invalid"
    } else {
        let valid = parsed.expected_revision.as_deref().is_some_and(|text| {
            !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) && {
                (1.0..=9_007_199_254_740_991.0).contains(&digits_to_f64(text))
            }
        });
        if valid {
            return None;
        }
        "bundle_selection_revision_conflict"
    };
    if parsed.json {
        let error = Json::Obj(vec![
            ("code", Json::str(code)),
            ("message", Json::str(code)),
        ]);
        return Some(out(
            print_json(vec![("status", Json::str("error")), ("error", error)]),
            EXIT_USAGE_ERROR,
        ));
    }
    Some(Answer {
        stdout: String::new(),
        stderr: format!("{code}\n"),
        code: EXIT_USAGE_ERROR,
    })
}

// ── parseArgs ────────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Parsed {
    positionals: Vec<String>,
    option_names: Vec<String>,
    expected_revision: Option<String>,
    json: bool,
    removed: Vec<String>,
    help: bool,
    version: bool,
}

impl Parsed {
    /// `positional[i] || fallback`: an empty word counts as missing.
    fn positional_or(&self, index: usize) -> Option<&str> {
        self.positionals
            .get(index)
            .map(String::as_str)
            .filter(|w| !w.is_empty())
    }

    fn command(&self) -> &str {
        self.positional_or(0).unwrap_or("serve")
    }
}

/// `splitOptionToken`: `(name, inline value, long)`.
fn split_option(arg: &str) -> Option<(&str, Option<&str>, bool)> {
    if !arg.starts_with('-') {
        return None;
    }
    if let Some(rest) = arg.strip_prefix("--") {
        return Some(match rest.find('=') {
            Some(eq) => (&rest[..eq], Some(&rest[eq + 1..]), true),
            None => (rest, None, true),
        });
    }
    Some((&arg[1..], None, false))
}

/// `parseArgs`; `Err` is the message of the `TunnelCliError` it throws (always a usage error).
fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    // `consumeValue`: a non-empty inline value, else the next word unless it starts with `-`.
    let consume = |index: usize, inline: Option<&str>| -> (Option<String>, usize) {
        if let Some(value) = inline.filter(|v| !v.is_empty()) {
            return (Some(value.to_string()), index);
        }
        match args.get(index + 1) {
            Some(candidate) if !candidate.starts_with('-') => (Some(candidate.clone()), index + 1),
            _ => (None, index),
        }
    };
    // Ports also take `-<digits>` as the next word, to report the range error.
    let consume_number = |index: usize, inline: Option<&str>| -> (Option<String>, usize) {
        let (value, next) = consume(index, inline);
        if value.is_none()
            && inline.is_none()
            && let Some(candidate) = args.get(index + 1).filter(|c| is_negative_digits(c))
        {
            return (Some(candidate.clone()), index + 1);
        }
        (value, next)
    };

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let Some((name, inline, long)) = split_option(arg) else {
            parsed.positionals.push(arg.clone());
            i += 1;
            continue;
        };
        parsed.option_names.push(name.to_string());
        match name {
            "expected-revision" => {
                let (value, next) = consume(i, inline);
                i = next;
                parsed.expected_revision = value;
            }
            "port" | "p" => {
                let (value, next) = consume_number(i, inline);
                i = next;
                let value = match value {
                    Some(v) if !js_trim(&v).is_empty() => v,
                    _ => return Err("Missing value for --port.".to_string()),
                };
                if !is_integer_text(js_trim(&value)) {
                    return Err(format!("Invalid port value: {value}"));
                }
                let port = js_parse_int(&value);
                if !(1.0..=65535.0).contains(&port) {
                    return Err(format!("Invalid port value: {}", js_number_to_string(port)));
                }
            }
            "host" => {
                let (value, next) = consume(i, inline);
                i = next;
                if value.as_deref().is_none_or(|v| js_trim(v).is_empty()) {
                    return Err("Missing value for --host.".to_string());
                }
            }
            "origin-port" => {
                let (value, next) = consume_number(i, inline);
                i = next;
                let Some(value) = value.filter(|v| is_integer_text(js_trim(v))) else {
                    return Err("Missing or invalid value for --origin-port.".to_string());
                };
                let port = js_parse_int(&value);
                // assertManagedRemoteOriginPort: Number.isInteger and 1024..=65535.
                if !(port.is_finite() && port.fract() == 0.0 && (1024.0..=65535.0).contains(&port)) {
                    return Err("Managed remote origin port must be an integer between 1024 and 65535.".to_string());
                }
            }
            "ui-password" | "provider" | "mode" | "profile" | "name" | "config" | "token" | "token-file" | "hostname"
            | "connect-ttl" | "session-ttl" | "lines" => {
                i = consume(i, inline).1;
            }
            "json" => parsed.json = true,
            "help" | "h" => parsed.help = true,
            "version" | "v" => parsed.version = true,
            "token-stdin" | "all" | "no-follow" | "qr" | "no-qr" | "force" | "show-secrets" | "dry-run" | "plain"
            | "quiet" | "q" | "foreground" | "no-daemon" | "daemon" | "d" => {}
            "try-cf-tunnel" => parsed
                .removed
                .push("`--try-cf-tunnel` was removed. Use: devryan tunnel start --provider cloudflare --mode quick".to_string()),
            "tunnel-qr" => parsed.removed.push("`--tunnel-qr` was removed. Use: devryan tunnel start ... --qr".to_string()),
            "tunnel-password-url" => parsed
                .removed
                .push("`--tunnel-password-url` was removed. Use UI password auth directly after tunnel start.".to_string()),
            "tunnel-provider" | "tunnel-mode" | "tunnel-config" | "tunnel-token" | "tunnel-hostname" | "tunnel" => parsed
                .removed
                .push(format!("`--{name}` was removed from top-level serve flow. Use: devryan tunnel start ...")),
            _ => {
                if !long && name.encode_utf16().count() == 1 {
                    parsed.removed.push(format!("Unknown option: -{name}"));
                } else {
                    parsed.removed.push(format!("Unknown option: --{name}"));
                }
            }
        }
        i += 1;
    }

    if parsed.command() != "runtime" && parsed.option_names.iter().any(|n| n == "expected-revision")
    {
        parsed
            .removed
            .push("`--expected-revision` requires: devryan runtime bundle resume".to_string());
    }
    Ok(parsed)
}

// ── JavaScript rules ─────────────────────────────────────────────────────────────────────────

/// `/^-\d+$/`
fn is_negative_digits(text: &str) -> bool {
    text.strip_prefix('-')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// `/^-?\d+$/`
fn is_integer_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// WhiteSpace and LineTerminator as `String.prototype.trim` and `parseInt` know them.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}'
            | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// A string of ASCII digits as the nearest f64 (`Number`, and `parseInt` in V8).
fn digits_to_f64(digits: &str) -> f64 {
    digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `parseInt(text, 10)` for text whose trimmed form is `-?\d+`.
fn js_parse_int(text: &str) -> f64 {
    let rest = text.trim_start_matches(is_js_whitespace);
    let (negative, rest) = match rest.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, rest.strip_prefix('+').unwrap_or(rest)),
    };
    let end = rest
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return f64::NAN;
    }
    let value = digits_to_f64(&rest[..end]);
    if negative { -value } else { value }
}

/// `Number.prototype.toString()` for a finite number.
fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Shortest round-trip digits: `d.ddde<exp>`.
    let exp_form = format!("{:e}", value.abs());
    let (mantissa, exponent) = exp_form.split_once('e').unwrap_or((&exp_form, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_sign = if e < 0 { "-" } else { "+" };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// `findClosestMatch(input, candidates)` as the ` Did you mean '<x>'?` suffix, or empty.
fn suggestion_hint(input: &str, candidates: &[&str]) -> String {
    if input.is_empty() {
        return String::new();
    }
    let normalized: Vec<u16> = input.to_lowercase().encode_utf16().collect();
    let max_distance = 3;
    let mut best: Option<&str> = None;
    let mut best_distance = max_distance + 1;
    for candidate in candidates {
        let target: Vec<u16> = candidate.to_lowercase().encode_utf16().collect();
        let distance = levenshtein(&normalized, &target);
        if distance < best_distance {
            best_distance = distance;
            best = Some(candidate);
        }
    }
    match best {
        Some(candidate) if best_distance <= max_distance => format!(" Did you mean '{candidate}'?"),
        _ => String::new(),
    }
}

/// Edit distance over UTF-16 code units, as `levenshteinDistance` indexes JS strings.
fn levenshtein(a: &[u16], b: &[u16]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut current = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            current[j] = if a[i - 1] == b[j - 1] {
                previous[j - 1]
            } else {
                1 + previous[j].min(current[j - 1]).min(previous[j - 1])
            };
        }
        previous = current;
    }
    previous[b.len()]
}

// ── printJson ────────────────────────────────────────────────────────────────────────────────

enum Json {
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    fn str(text: &str) -> Json {
        Json::Str(text.to_string())
    }
}

/// `printJson(payload)` for a payload whose `status` is already first and valid.
fn print_json(fields: Vec<(&'static str, Json)>) -> String {
    let mut text = String::new();
    write_json(&Json::Obj(fields), 0, &mut text);
    text.push('\n');
    text
}

/// `JSON.stringify(value, null, 2)`.
fn write_json(value: &Json, depth: usize, text: &mut String) {
    let indent = |level: usize| "  ".repeat(level);
    match value {
        Json::Str(s) => write_json_string(s, text),
        Json::Arr(items) if items.is_empty() => text.push_str("[]"),
        Json::Obj(fields) if fields.is_empty() => text.push_str("{}"),
        Json::Arr(items) => {
            text.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                text.push_str(&indent(depth + 1));
                write_json(item, depth + 1, text);
                text.push_str(if index + 1 < items.len() { ",\n" } else { "\n" });
            }
            text.push_str(&indent(depth));
            text.push(']');
        }
        Json::Obj(fields) => {
            text.push_str("{\n");
            for (index, (key, item)) in fields.iter().enumerate() {
                text.push_str(&indent(depth + 1));
                write_json_string(key, text);
                text.push_str(": ");
                write_json(item, depth + 1, text);
                text.push_str(if index + 1 < fields.len() {
                    ",\n"
                } else {
                    "\n"
                });
            }
            text.push_str(&indent(depth));
            text.push('}');
        }
    }
}

fn write_json_string(s: &str, text: &mut String) {
    text.push('"');
    for c in s.chars() {
        match c {
            '"' => text.push_str("\\\""),
            '\\' => text.push_str("\\\\"),
            '\u{8}' => text.push_str("\\b"),
            '\u{c}' => text.push_str("\\f"),
            '\n' => text.push_str("\\n"),
            '\r' => text.push_str("\\r"),
            '\t' => text.push_str("\\t"),
            c if (c as u32) < 0x20 => text.push_str(&format!("\\u{:04x}", c as u32)),
            c => text.push(c),
        }
    }
    text.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_follows_javascript() {
        assert_eq!(js_number_to_string(1e23), "1e+23");
        assert_eq!(
            js_number_to_string(-1.2345678901234569e23),
            "-1.2345678901234569e+23"
        );
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(70000.0), "70000");
    }

    #[test]
    fn closest_match_counts_utf16_units() {
        assert_eq!(
            suggestion_hint("stätus", &["status"]),
            " Did you mean 'status'?"
        );
        assert_eq!(suggestion_hint("zzzzzzz", &["list"]), "");
    }
}

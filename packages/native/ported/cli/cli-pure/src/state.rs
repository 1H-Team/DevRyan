//! The commands that read the data root: `status`, `logs` and `tunnel profile`, ported from
//! `discoverRunningInstances`, `discoverDesktopInstance`, `commands.status`, `commands.logs` and
//! `handleTunnelProfileSubcommand` in `packages/web/bin/cli.js`.
//!
//! Each command first looks at everything it would read and returns `None` (the original runs)
//! before it changes or prints anything when the original would signal a process, open a
//! connection, run `ps`, or write a file other than these two, which it does too:
//! - `<data>/run` is created (0700, as `getRunDir`), and
//! - pid records whose pid is not a positive number are removed with their `.json` (as
//!   `validatePidFileIdentity` → `removePidFile`/`removeInstanceFile`). A positive pid would get
//!   `process.kill(pid, 0)`, then an HTTP probe of its port and `ps`: such a run is the original's.
//!
//! clack 1.7.0 output (`intro`, `outro`, `log.*`) is written here as clack writes it without colour.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::port::{
    Answer, Context, EXIT_GENERAL_ERROR, EXIT_USAGE_ERROR, Json, Parsed, caught,
    js_number_to_string, js_parse_int, js_trim, out, print_json, suggestion_hint,
};

// ── status and logs ──────────────────────────────────────────────────────────────────────────

/// What `discoverRunningInstances` would do when no record can be a running instance.
struct RunScan {
    run_dir: PathBuf,
    /// Records to remove: the `.pid` file and, when it exists, its `.json`.
    stale: Vec<(PathBuf, Option<PathBuf>)>,
}

/// `(devryan|openchamber)-<port>.pid` with a safe integer port in 1..=65535 (`daemonRecordPort`).
fn is_record_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix("devryan-")
        .or_else(|| name.strip_prefix("openchamber-"))
    else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(".pid") else {
        return false;
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let port = crate::port::digits_to_f64(digits);
    (1.0..=65535.0).contains(&port)
}

fn is_regular_file(path: &Path) -> Option<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Some(meta.file_type().is_file()),
        Err(e) if e.kind() == ErrorKind::NotFound => Some(false),
        Err(_) => None,
    }
}

/// `None` when the original must run: a record that is not a plain file, a positive pid, a run
/// folder that is not a plain folder, a name that is not UTF-8.
fn scan_run_dir(data_root: &Path) -> Option<RunScan> {
    let run_dir = data_root.join("run");
    // `mkdirSync(recursive)` over a non-folder throws; a link is left to the original.
    for dir in [data_root, run_dir.as_path()] {
        match fs::symlink_metadata(dir) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            _ => return None,
        }
    }
    let mut stale = Vec::new();
    let entries = match fs::read_dir(&run_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(RunScan { run_dir, stale }),
        Err(_) => return None,
    };
    for entry in entries {
        let name = entry.ok()?.file_name().into_string().ok()?;
        if !is_record_name(&name) {
            continue;
        }
        let pid_path = run_dir.join(&name);
        if is_regular_file(&pid_path) != Some(true) {
            return None;
        }
        // readPidFile: utf8 (lossy), trim, parseInt; a positive pid is checked with a signal.
        let bytes = fs::read(&pid_path).ok()?;
        let pid = js_parse_int(js_trim(&String::from_utf8_lossy(&bytes)));
        if pid.is_finite() && pid > 0.0 {
            return None;
        }
        let instance = run_dir.join(format!("{}.json", name.strip_suffix(".pid")?));
        let instance = match fs::symlink_metadata(&instance) {
            Ok(meta) if meta.file_type().is_file() => Some(instance),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            _ => return None,
        };
        stale.push((pid_path, instance));
    }
    Some(RunScan { run_dir, stale })
}

/// `getRunDir()` and the removal of the stale records, as the original does them.
fn apply_run_scan(scan: &RunScan) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&scan.run_dir);
    }
    #[cfg(not(unix))]
    let _ = fs::create_dir_all(&scan.run_dir);
    for (pid_path, instance) in &scan.stale {
        let _ = fs::remove_file(pid_path);
        if let Some(instance) = instance {
            let _ = fs::remove_file(instance);
        }
    }
}

/// `readDesktopLocalPortFromSettings()` finds a port (the original then probes it): `None` = no port.
fn desktop_port_configured(data_root: &Path) -> Option<bool> {
    let Ok(bytes) = fs::read(data_root.join("settings.json")) else {
        return Some(false);
    };
    match parse_json(&String::from_utf8_lossy(&bytes)) {
        Ok(value) => Some(
            value
                .get("desktopLocalPort")
                .and_then(Value::number)
                .is_some_and(|port| port.is_finite() && port > 0.0 && port <= 65535.0),
        ),
        Err(JsonError::Syntax) => Some(false),
        Err(JsonError::Unsupported) => None,
    }
}

pub(crate) fn status(parsed: &Parsed, ctx: &Context) -> Option<Answer> {
    let data_root = ctx.data_root?;
    let scan = scan_run_dir(data_root)?;
    if desktop_port_configured(data_root)? {
        return None;
    }
    let human = !parsed.json && !parsed.quiet;
    if human && !ctx.plain_styles {
        return None;
    }
    apply_run_scan(&scan);
    if parsed.json {
        let payload = vec![
            ("status", Json::str("ok")),
            ("state", Json::str("stopped")),
            ("runningCount", Json::Num(0.0)),
            ("instances", Json::Arr(Vec::new())),
        ];
        return Some(out(print_json(payload), 0));
    }
    if parsed.quiet {
        return Some(out("stopped\n".to_string(), 0));
    }
    let clack = Clack::new(ctx);
    let mut text = clack.intro("DevRyan Status");
    text.push_str(&clack.log(Symbol::Warn, "stopped"));
    text.push_str(&clack.outro("no running instances"));
    Some(out(text, 0))
}

pub(crate) fn logs(parsed: &Parsed, has_plain_flag: bool, ctx: &Context) -> Option<Answer> {
    let scan = scan_run_dir(ctx.data_root?)?;
    // No instance: the command throws before it reads or follows any log.
    let message = match parsed.explicit_port {
        Some(port) if !parsed.all => format!(
            "No running DevRyan instance found on port {}.",
            js_number_to_string(port)
        ),
        _ => "No running DevRyan instance found.".to_string(),
    };
    let answer = caught(
        &message,
        EXIT_GENERAL_ERROR,
        parsed.json,
        has_plain_flag,
        ctx,
    )?;
    apply_run_scan(&scan);
    Some(answer)
}

// ── tunnel profile ───────────────────────────────────────────────────────────────────────────

/// A profile as `sanitizeTunnelProfilesData` keeps it. `None` for a value the original makes up
/// (`crypto.randomUUID()`, `Date.now()`).
struct Profile {
    id: Option<String>,
    name: String,
    provider: String,
    mode: String,
    hostname: String,
    origin_port: f64,
    token: String,
    created_at: Option<f64>,
    updated_at: Option<f64>,
}

impl Profile {
    fn token_status(&self, show_secrets: bool) -> String {
        if show_secrets {
            format!("token:{}", self.token)
        } else {
            "token:present".to_string()
        }
    }

    /// `redactProfileForOutput`; `None` when a field is made up or the mask could split a pair.
    fn json(&self, show_secrets: bool) -> Option<Json> {
        let token = if show_secrets {
            self.token.clone()
        } else {
            mask_token(&self.token)?
        };
        Some(Json::Obj(vec![
            ("id", Json::str(self.id.as_deref()?)),
            ("name", Json::str(&self.name)),
            ("provider", Json::str(&self.provider)),
            ("mode", Json::str(&self.mode)),
            ("hostname", Json::str(&self.hostname)),
            ("originPort", Json::Num(self.origin_port)),
            ("token", Json::Str(token)),
            ("createdAt", Json::Num(self.created_at?)),
            ("updatedAt", Json::Num(self.updated_at?)),
        ]))
    }

    fn quiet_line(&self) -> String {
        format!(
            "{} {}/{} {} origin:{}",
            self.name,
            self.provider,
            self.mode,
            self.hostname,
            js_number_to_string(self.origin_port)
        )
    }

    fn human_lines(&self, show_secrets: bool) -> String {
        format!(
            "{} ({}/{})\n{} origin:{} {}",
            self.name,
            self.provider,
            self.mode,
            self.hostname,
            js_number_to_string(self.origin_port),
            self.token_status(show_secrets)
        )
    }
}

/// `maskToken` (UTF-16 lengths and `slice(-4)`); `None` for a token with surrogate pairs.
fn mask_token(token: &str) -> Option<String> {
    if token.chars().any(|c| c.len_utf16() > 1) {
        return None;
    }
    let chars: Vec<char> = token.chars().collect();
    if chars.is_empty() {
        return Some("***".to_string());
    }
    if chars.len() <= 4 {
        return Some("*".repeat(chars.len()));
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("{}{tail}", "*".repeat((chars.len() - 4).max(4))))
}

/// `normalizeProfile*`: a string trimmed (and lower-cased for provider and mode), else empty.
fn field(entry: &Value, key: &str, lower: bool) -> String {
    match entry.get(key) {
        Some(Value::Str(s)) if lower => js_trim(s).to_lowercase(),
        Some(Value::Str(s)) => js_trim(s).to_string(),
        _ => String::new(),
    }
}

/// `normalizeManagedRemoteOriginPort`: an integer 1024..=65535 (a string through `Number`), else 3000.
fn origin_port(value: Option<&Value>) -> f64 {
    let candidate = match value {
        Some(Value::Str(s)) if !js_trim(s).is_empty() => js_string_to_number(js_trim(s)),
        Some(Value::Num(n)) => *n,
        _ => f64::NAN,
    };
    if candidate.is_finite() && candidate.fract() == 0.0 && (1024.0..=65535.0).contains(&candidate)
    {
        candidate
    } else {
        3000.0
    }
}

/// `Number(text)` for already trimmed, non-empty text.
fn js_string_to_number(text: &str) -> f64 {
    let radix = |digits: &str, base: u32| -> f64 {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(base)) {
            return f64::NAN;
        }
        digits.chars().fold(0.0, |acc, c| {
            acc * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
        })
    };
    let lower_prefix = text.get(..2).map(str::to_ascii_lowercase);
    match lower_prefix.as_deref() {
        Some("0x") => return radix(&text[2..], 16),
        Some("0o") => return radix(&text[2..], 8),
        Some("0b") => return radix(&text[2..], 2),
        _ => {}
    }
    let (sign, unsigned) = match text.as_bytes()[0] {
        b'-' => (-1.0, &text[1..]),
        b'+' => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [e [+-] digits] | . digits [e ...]
    let bytes = unsigned.as_bytes();
    let mut i = 0;
    let int_digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        frac_digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        if exp_digits == 0 {
            return f64::NAN;
        }
        i += exp_digits;
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    unsigned
        .parse::<f64>()
        .map(|v| sign * v)
        .unwrap_or(f64::NAN)
}

/// `sanitizeTunnelProfilesData(parsed).profiles`.
fn sanitize(parsed: &Value) -> Vec<Profile> {
    let Some(Value::Arr(list)) = parsed.get("profiles") else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    let mut profiles = Vec::new();
    for entry in list {
        if !matches!(entry, Value::Obj(_)) {
            continue;
        }
        let id = match entry.get("id") {
            Some(Value::Str(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
            _ => None,
        };
        let provider = field(entry, "provider", true);
        let mode = field(entry, "mode", true);
        let name = field(entry, "name", false);
        let hostname = field(entry, "hostname", false);
        let token = field(entry, "token", false);
        let origin_port = origin_port(entry.get("originPort"));
        if provider.is_empty()
            || mode.is_empty()
            || name.is_empty()
            || hostname.is_empty()
            || token.is_empty()
        {
            continue;
        }
        let key = format!("{provider}::{}", name.to_lowercase());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let finite = |key: &str| {
            entry
                .get(key)
                .and_then(Value::number)
                .filter(|n| n.is_finite())
        };
        profiles.push(Profile {
            id,
            name,
            provider,
            mode,
            hostname,
            origin_port,
            token,
            created_at: finite("createdAt"),
            updated_at: finite("updatedAt"),
        });
    }
    profiles
}

/// `readLegacyManagedRemoteEntries().length > 0`: the original would then migrate (write).
fn legacy_has_entries(data_root: &Path) -> Option<bool> {
    let Ok(bytes) = fs::read(data_root.join("cloudflare-managed-remote-tunnels.json")) else {
        return Some(false);
    };
    let parsed = match parse_json(&String::from_utf8_lossy(&bytes)) {
        Ok(value) => value,
        Err(JsonError::Syntax) => return Some(false),
        Err(JsonError::Unsupported) => return None,
    };
    let Some(Value::Arr(tunnels)) = parsed.get("tunnels") else {
        return Some(false);
    };
    Some(tunnels.iter().any(|entry| {
        matches!(entry, Value::Obj(_))
            && ["name", "hostname", "token"]
                .iter()
                .all(|key| !field(entry, key, false).is_empty())
    }))
}

/// `ensureTunnelProfilesMigrated()` when it writes nothing: the profiles and the stderr warning.
fn load_store(data_root: &Path, parsed: &Parsed) -> Option<(Vec<Profile>, String)> {
    let path = data_root.join("tunnel-profiles.json");
    let mut warning = String::new();
    // warnIfUnsafeFilePermissions (text output only; follows links, as fs.statSync does).
    if !parsed.json && !parsed.quiet {
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&path) {
            use std::os::unix::fs::PermissionsExt;
            let perms = meta.permissions().mode() & 0o777;
            if perms & 0o077 != 0 {
                let shown = path.to_str()?;
                warning = format!(
                    "Warning: Profile file '{shown}' has permissions {perms:03o} (should be 600). Other users may be able to read tunnel tokens. Fix with: chmod 600 '{shown}'\n"
                );
            }
        }
    }
    let profiles = match fs::read(&path) {
        Err(_) => Vec::new(),
        Ok(bytes) => match parse_json(&String::from_utf8_lossy(&bytes)) {
            Err(JsonError::Syntax) => Vec::new(),
            Err(JsonError::Unsupported) => return None,
            Ok(value) => {
                // Any other version is rewritten by the original.
                if value.get("version").and_then(Value::number) != Some(2.0) {
                    return None;
                }
                sanitize(&value)
            }
        },
    };
    if profiles.is_empty() && legacy_has_entries(data_root)? {
        return None;
    }
    Some((profiles, warning))
}

/// `resolveProfileByName(profiles, name, provider)`.
fn resolve<'p>(
    profiles: &'p [Profile],
    name: &str,
    provider: Option<&str>,
) -> Result<&'p Profile, String> {
    let wanted = js_trim(name).to_lowercase();
    let provider = provider
        .map(|p| js_trim(p).to_lowercase())
        .unwrap_or_default();
    let matches: Vec<&Profile> = profiles
        .iter()
        .filter(|p| {
            p.name.to_lowercase() == wanted && (provider.is_empty() || p.provider == provider)
        })
        .collect();
    match matches.as_slice() {
        [] => Err(format!(
            "No tunnel profile found for name '{name}'. Run 'devryan tunnel profile list'."
        )),
        [one] => Ok(one),
        _ => Err(format!(
            "Profile name '{name}' exists for multiple providers. Use --provider <id>."
        )),
    }
}

pub(crate) fn profile(parsed: &Parsed, has_plain_flag: bool, ctx: &Context) -> Option<Answer> {
    let sub = parsed
        .positional_or(2)
        .map(|a| js_trim(a).to_lowercase())
        .unwrap_or_default();
    if sub == "add" {
        return None;
    }
    let human = !parsed.json && !parsed.quiet;
    if human && !ctx.plain_styles {
        return None;
    }
    let (profiles, warning) = load_store(ctx.data_root?, parsed)?;
    let with_warning = |mut answer: Answer| {
        answer.stderr.insert_str(0, &warning);
        answer
    };
    let error = |message: String, code: u8| {
        caught(&message, code, parsed.json, has_plain_flag, ctx).map(with_warning)
    };
    let clack = Clack::new(ctx);
    let name = parsed.name.as_deref().map(js_trim).unwrap_or("");
    match sub.as_str() {
        "" => {
            if parsed.json {
                let subcommands = ["list", "show", "add", "remove"]
                    .iter()
                    .map(|s| Json::str(s))
                    .collect();
                let payload = vec![
                    ("status", Json::str("ok")),
                    ("command", Json::str("tunnel profile")),
                    ("subcommands", Json::Arr(subcommands)),
                ];
                return Some(with_warning(out(print_json(payload), 0)));
            }
            if parsed.quiet {
                return Some(with_warning(out(String::new(), 0)));
            }
            let mut text = clack.intro("Tunnel Profile");
            text.push_str(&clack.log(
                Symbol::Info,
                "Available subcommands\nlist, show, add, remove",
            ));
            for step in [
                "List profiles: `devryan tunnel profile list`",
                "Show one profile: `devryan tunnel profile show --name <name>`",
                "Add profile: `devryan tunnel profile add --provider cloudflare --mode managed-remote --name <name> --hostname <host> --origin-port 3000 --token <token>`",
                "Remove profile: `devryan tunnel profile remove --name <name>`",
            ] {
                text.push_str(&clack.log(Symbol::Step, step));
            }
            text.push_str(&clack.outro("Choose a subcommand"));
            Some(with_warning(out(text, 0)))
        }
        "list" => {
            let filter = parsed
                .provider
                .as_deref()
                .map(|p| js_trim(p).to_lowercase())
                .unwrap_or_default();
            let listed: Vec<&Profile> = profiles
                .iter()
                .filter(|p| filter.is_empty() || p.provider == filter)
                .collect();
            if parsed.json {
                let items = listed
                    .iter()
                    .map(|p| p.json(parsed.show_secrets))
                    .collect::<Option<Vec<Json>>>()?;
                let payload = vec![("status", Json::str("ok")), ("profiles", Json::Arr(items))];
                return Some(with_warning(out(print_json(payload), 0)));
            }
            if parsed.quiet {
                let text = listed
                    .iter()
                    .map(|p| format!("{}\n", p.quiet_line()))
                    .collect();
                return Some(with_warning(out(text, 0)));
            }
            let mut text = clack.intro("Tunnel Profiles");
            for p in &listed {
                text.push_str(&clack.log(Symbol::Success, &p.human_lines(parsed.show_secrets)));
            }
            text.push_str(&clack.outro(&format!("{} profile(s)", listed.len())));
            Some(with_warning(out(text, 0)))
        }
        "show" | "remove" => {
            if name.is_empty() {
                return error(
                    format!("`tunnel profile {sub}` requires --name <name>."),
                    EXIT_GENERAL_ERROR,
                );
            }
            let found = match resolve(&profiles, name, parsed.provider.as_deref()) {
                Ok(found) => found,
                Err(message) => return error(message, EXIT_GENERAL_ERROR),
            };
            if sub == "remove" {
                // Removing writes the store: the original's.
                return None;
            }
            if parsed.json {
                let payload = vec![
                    ("status", Json::str("ok")),
                    ("profile", found.json(parsed.show_secrets)?),
                ];
                return Some(with_warning(out(print_json(payload), 0)));
            }
            if parsed.quiet {
                let line = format!(
                    "{} {}\n",
                    found.quiet_line(),
                    found.token_status(parsed.show_secrets)
                );
                return Some(with_warning(out(line, 0)));
            }
            let mut text = clack.intro("Tunnel Profile");
            text.push_str(&clack.log(Symbol::Success, &found.human_lines(parsed.show_secrets)));
            text.push_str(&clack.outro("show complete"));
            Some(with_warning(out(text, 0)))
        }
        unknown => {
            let hint = suggestion_hint(unknown, &["list", "show", "add", "remove"]);
            error(
                format!(
                    "Unknown tunnel profile subcommand '{unknown}'.{hint} Use 'devryan tunnel help'."
                ),
                EXIT_USAGE_ERROR,
            )
        }
    }
}

// ── clack ────────────────────────────────────────────────────────────────────────────────────

enum Symbol {
    Info,
    Success,
    Step,
    Warn,
}

struct Clack {
    ascii: bool,
}

impl Clack {
    fn new(ctx: &Context) -> Self {
        Clack {
            ascii: ctx.ascii_symbols,
        }
    }

    fn pick(&self, unicode: &'static str, ascii: &'static str) -> &'static str {
        if self.ascii { ascii } else { unicode }
    }

    fn bar(&self) -> &'static str {
        self.pick("\u{2502}", "|")
    }

    fn intro(&self, title: &str) -> String {
        format!("{}  {title}\n", self.pick("\u{250C}", "T"))
    }

    fn outro(&self, message: &str) -> String {
        format!(
            "{}\n{}  {message}\n\n",
            self.bar(),
            self.pick("\u{2514}", "\u{2014}")
        )
    }

    /// `log.message(message, { symbol })` with the default spacing of one bar line.
    fn log(&self, symbol: Symbol, message: &str) -> String {
        let symbol = match symbol {
            Symbol::Info => self.pick("\u{25CF}", "\u{2022}"),
            Symbol::Success => self.pick("\u{25C6}", "*"),
            Symbol::Step => self.pick("\u{25C7}", "o"),
            Symbol::Warn => self.pick("\u{25B2}", "!"),
        };
        let mut lines = vec![self.bar().to_string()];
        for (index, line) in message.split('\n').enumerate() {
            let lead = if index == 0 { symbol } else { self.bar() };
            lines.push(if line.is_empty() {
                lead.to_string()
            } else {
                format!("{lead}  {line}")
            });
        }
        format!("{}\n", lines.join("\n"))
    }
}

// ── JSON.parse ───────────────────────────────────────────────────────────────────────────────

enum Value {
    Null,
    Bool,
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

enum JsonError {
    /// `JSON.parse` throws.
    Syntax,
    /// It parses, but to something Rust strings cannot hold (a lone surrogate) or too deep.
    Unsupported,
}

impl Value {
    /// A property of an object (the last duplicate, as `JSON.parse` keeps it); nothing otherwise.
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(fields) => fields.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn number(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }
}

fn parse_json(text: &str) -> Result<Value, JsonError> {
    let mut parser = JsonParser {
        bytes: text.as_bytes(),
        at: 0,
    };
    parser.space();
    let value = parser.value(0)?;
    parser.space();
    if parser.at != parser.bytes.len() {
        return Err(JsonError::Syntax);
    }
    Ok(value)
}

struct JsonParser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl JsonParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, JsonError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(JsonError::Syntax)
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > 256 {
            return Err(JsonError::Unsupported);
        }
        match self.peek().ok_or(JsonError::Syntax)? {
            b'{' => {
                self.at += 1;
                let mut fields = Vec::new();
                self.space();
                if self.peek() == Some(b'}') {
                    self.at += 1;
                    return Ok(Value::Obj(fields));
                }
                loop {
                    self.space();
                    if self.peek() != Some(b'"') {
                        return Err(JsonError::Syntax);
                    }
                    let key = self.string()?;
                    self.space();
                    if self.peek() != Some(b':') {
                        return Err(JsonError::Syntax);
                    }
                    self.at += 1;
                    self.space();
                    let value = self.value(depth + 1)?;
                    fields.push((key, value));
                    self.space();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Value::Obj(fields));
                        }
                        _ => return Err(JsonError::Syntax),
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.peek() == Some(b']') {
                    self.at += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    self.space();
                    items.push(self.value(depth + 1)?);
                    self.space();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return Err(JsonError::Syntax),
                    }
                }
            }
            b'"' => Ok(Value::Str(self.string()?)),
            b't' => self.literal("true", Value::Bool),
            b'f' => self.literal("false", Value::Bool),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(JsonError::Syntax),
        }
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.at;
        let digits = |p: &mut Self| {
            let n = p.bytes[p.at..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            p.at += n;
            n
        };
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(JsonError::Syntax),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if digits(self) == 0 {
                return Err(JsonError::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if digits(self) == 0 {
                return Err(JsonError::Syntax);
            }
        }
        let text =
            std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| JsonError::Syntax)?;
        text.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| JsonError::Syntax)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.at += 1; // the opening quote
        let mut units: Vec<u16> = Vec::new();
        let mut start = self.at;
        loop {
            let byte = self.peek().ok_or(JsonError::Syntax)?;
            match byte {
                b'"' | b'\\' => {
                    let plain = std::str::from_utf8(&self.bytes[start..self.at])
                        .map_err(|_| JsonError::Syntax)?;
                    units.extend(plain.encode_utf16());
                    self.at += 1;
                    if byte == b'"' {
                        return String::from_utf16(&units).map_err(|_| JsonError::Unsupported);
                    }
                    let escape = self.peek().ok_or(JsonError::Syntax)?;
                    self.at += 1;
                    let unit = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5C,
                        b'/' => 0x2F,
                        b'b' => 0x08,
                        b'f' => 0x0C,
                        b'n' => 0x0A,
                        b'r' => 0x0D,
                        b't' => 0x09,
                        b'u' => {
                            let hex = self
                                .bytes
                                .get(self.at..self.at + 4)
                                .ok_or(JsonError::Syntax)?;
                            if !hex.iter().all(u8::is_ascii_hexdigit) {
                                return Err(JsonError::Syntax);
                            }
                            self.at += 4;
                            let hex = std::str::from_utf8(hex).map_err(|_| JsonError::Syntax)?;
                            u16::from_str_radix(hex, 16).map_err(|_| JsonError::Syntax)?
                        }
                        _ => return Err(JsonError::Syntax),
                    };
                    units.push(unit);
                    start = self.at;
                }
                0x00..=0x1F => return Err(JsonError::Syntax),
                _ => self.at += 1,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_of_a_string_follows_javascript() {
        assert_eq!(js_string_to_number("0x400"), 1024.0);
        assert_eq!(js_string_to_number("1024."), 1024.0);
        assert_eq!(js_string_to_number(".5e4"), 5000.0);
        assert!(js_string_to_number("1_024").is_nan());
        assert!(js_string_to_number("inf").is_nan());
        assert_eq!(js_string_to_number("-Infinity"), f64::NEG_INFINITY);
    }

    #[test]
    fn json_parse_is_strict_and_keeps_the_last_duplicate() {
        assert!(matches!(parse_json("{\"a\":1,}"), Err(JsonError::Syntax)));
        assert!(matches!(parse_json("\u{feff}{}"), Err(JsonError::Syntax)));
        assert!(matches!(
            parse_json("\"\\ud800\""),
            Err(JsonError::Unsupported)
        ));
        let value = parse_json("{\"v\":1,\"v\":2}")
            .ok()
            .and_then(|v| v.get("v").and_then(Value::number));
        assert_eq!(value, Some(2.0));
    }

    #[test]
    fn mask_counts_characters() {
        assert_eq!(mask_token("tökén-ßß").as_deref(), Some("****n-ßß"));
        assert_eq!(mask_token("x").as_deref(), Some("*"));
        assert_eq!(mask_token("😀abcd"), None);
    }
}

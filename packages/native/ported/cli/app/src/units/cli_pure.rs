//! Glue from the front door to `cli-pure`: read what the original reads besides its arguments
//! (package.json's version, whether the data-root migration has anything to do, the data root,
//! whether stdout is a terminal and clack would colour or use ASCII), call `cli_pure::answer`,
//! print its answer and return its exit code. Anything
//! the port does not answer goes back with `crate::original::run(&argv[1..])`.

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::ArgMatches;

/// packages/web/package.json, which `cli.js` reads its version from (`<bin>/../package.json`).
const PACKAGE_JSON: &str = match option_env!("RA_CLI_PACKAGE_JSON") {
    Some(path) => path,
    None => concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../web/package.json"),
};

pub fn run(_command: &str, _matches: &ArgMatches) -> ExitCode {
    let argv: Vec<OsString> = std::env::args_os().collect();
    let Some(args) = argv[1..]
        .iter()
        .map(|a| a.to_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()
    else {
        return crate::original::run(&argv[1..]);
    };
    let version = std::fs::read_to_string(PACKAGE_JSON)
        .ok()
        .and_then(|text| top_level_string(&text, "version"));
    let stdout_is_tty = std::io::stdout().is_terminal();
    let data_root = data_root();
    let context = cli_pure::Context {
        version: version.as_deref(),
        migration_quiet: migration_quiet(),
        stdout_is_tty,
        data_root: data_root.as_deref(),
        plain_styles: !stdout_is_tty && std::env::var_os("FORCE_COLOR").is_none(),
        ascii_symbols: std::env::var_os("TERM").is_some_and(|term| term == "linux"),
    };
    let Some(answer) = cli_pure::answer(&args, &context) else {
        return crate::original::run(&argv[1..]);
    };
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(answer.stdout.as_bytes());
    let _ = stdout.flush();
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(answer.stderr.as_bytes());
    let _ = stderr.flush();
    ExitCode::from(answer.code)
}

/// True when `migrateDataRootAtStartup` (packages/web/server/lib/opencode/runtime-host/
/// data-root-startup.js and harness-runtime's data-root-migration.js) would return without
/// touching anything: under a test runner, or with no `~/.config/openchamber` and either no
/// `~/.config/devryan` or one without a migration marker. Anything else (an explicit data
/// root, a legacy folder or link, a marker) is left to the original.
fn migration_quiet() -> bool {
    let env_set = |name: &str| std::env::var_os(name).is_some();
    if std::env::var("NODE_ENV").is_ok_and(|v| v == "test")
        || env_set("VITEST")
        || env_set("NODE_TEST_CONTEXT")
    {
        return true;
    }
    if ["DEVRYAN_DATA_DIR", "OPENCHAMBER_DATA_DIR"]
        .iter()
        .any(|name| env_set(name))
    {
        return false;
    }
    let Some(home) = std::env::var_os("HOME").filter(|h| Path::new(h).is_absolute()) else {
        return false;
    };
    let config = PathBuf::from(home).join(".config");
    let missing = |path: &Path| matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    let root = config.join("devryan");
    missing(&config.join("openchamber"))
        && (missing(&root) || missing(&root.join(".devryan-migration.json")))
}

/// `resolveDevRyanDataRoot()` when it is surely `<HOME>/.config/devryan`, as `path.join` writes it:
/// no explicit data root, no `~/.config/openchamber` (folder or link), and a HOME that is absolute,
/// UTF-8 and already normalized (no empty, `.` or `..` component, no trailing slash).
fn data_root() -> Option<PathBuf> {
    if ["DEVRYAN_DATA_DIR", "OPENCHAMBER_DATA_DIR"]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        return None;
    }
    let home = std::env::var("HOME").ok()?;
    let normalized = home.starts_with('/')
        && home.len() > 1
        && home[1..]
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !normalized {
        return None;
    }
    let config = Path::new(&home).join(".config");
    let legacy_missing = matches!(std::fs::symlink_metadata(config.join("openchamber")), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    legacy_missing.then(|| config.join("devryan"))
}

/// The last top-level `"<key>": "<string>"` of a JSON object (as `JSON.parse` keeps the last),
/// or `None` when the text is not such an object.
fn top_level_string(text: &str, key: &str) -> Option<String> {
    let mut reader = Reader {
        bytes: text.as_bytes(),
        at: 0,
    };
    reader.space();
    reader.expect(b'{')?;
    let mut found = None;
    reader.space();
    if reader.peek() == Some(b'}') {
        return None;
    }
    loop {
        reader.space();
        let name = reader.string()?;
        reader.space();
        reader.expect(b':')?;
        reader.space();
        if name == key && reader.peek() == Some(b'"') {
            found = Some(reader.string()?);
        } else {
            if name == key {
                found = None;
            }
            reader.skip_value()?;
        }
        reader.space();
        match reader.next()? {
            b',' => continue,
            b'}' => return found,
            _ => return None,
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }
    fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }
    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.next()? == byte).then_some(())
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }
    fn string(&mut self) -> Option<String> {
        self.expect(b'"')?;
        let mut units: Vec<u16> = Vec::new();
        let mut plain: Vec<u8> = Vec::new();
        loop {
            match self.next()? {
                b'"' => break,
                b'\\' => {
                    units.extend(std::str::from_utf8(&plain).ok()?.encode_utf16());
                    plain.clear();
                    let unit = match self.next()? {
                        b'"' => b'"' as u16,
                        b'\\' => b'\\' as u16,
                        b'/' => b'/' as u16,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let hex =
                                std::str::from_utf8(self.bytes.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            u16::from_str_radix(hex, 16).ok()?
                        }
                        _ => return None,
                    };
                    units.push(unit);
                }
                byte if byte < 0x20 => return None,
                byte => plain.push(byte),
            }
        }
        units.extend(std::str::from_utf8(&plain).ok()?.encode_utf16());
        String::from_utf16(&units).ok()
    }
    fn skip_value(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => self.string().map(|_| ()),
            b'{' | b'[' => {
                let mut depth = 0usize;
                loop {
                    match self.peek()? {
                        b'"' => {
                            self.string()?;
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                self.at += 1;
                                return Some(());
                            }
                        }
                        _ => {}
                    }
                    self.at += 1;
                }
            }
            _ => {
                while !matches!(
                    self.peek(),
                    None | Some(b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
                ) {
                    self.at += 1;
                }
                Some(())
            }
        }
    }
}

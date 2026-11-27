//! The group's runtime (packages/web/server/lib/magic-prompts/runtime.js):
//! the data file `<data root>/magic-prompts.json`, read again on every call,
//! sanitised on read, validated before a write, and written in place
//! (`fsPromises.writeFile`: open with truncation, mode 0666 before the umask,
//! no temporary file) as `JSON.stringify(state, null, 2)` with no final
//! newline. Writes are serialised as the JavaScript promise chain serialises
//! them: each takes the lock, reads the file, computes the next state, writes
//! it (even when nothing changed) and answers that state; a failed write lets
//! the next one go on. Reads do not take the lock.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use devryan_config_text::js;
use devryan_config_text::value::{Graph, Node, Val};

use crate::json;
use crate::order::Ticket;
use crate::plant::{self, Plant};
use crate::props::Props;
use crate::uv;

pub const FILE_VERSION: u32 = 1;
pub const MAX_PROMPT_TEXT_LENGTH: usize = 200_000;
pub const DEPRECATED_PROMPT_IDS: [&str; 4] = [
    "git.commit.draft.visible",
    "git.commit.draft.instructions",
    "git.commit.plan.visible",
    "git.commit.plan.instructions",
];

/// The state the group answers and writes: `{ version: 1, overrides }`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub overrides: Props<Vec<u16>>,
}

/// `/^[a-z0-9._-]{1,160}$/.test(id)`.
pub fn is_prompt_id(id: &[u16]) -> bool {
    let longest = if plant::on(Plant::IdLimit159) { 159 } else { 160 };
    (1..=longest).contains(&id.len()) && id.iter().all(|unit| matches!(*unit, 0x61..=0x7a | 0x30..=0x39 | 0x2e | 0x5f | 0x2d))
}

fn is_deprecated(id: &[u16]) -> bool {
    DEPRECATED_PROMPT_IDS.iter().any(|deprecated| js::units(deprecated) == id)
}

/// `sanitizeOverrides(parsed?.overrides)` of a parsed data file.
fn sanitize(graph: &Graph, root: &Val) -> Props<Vec<u16>> {
    let mut next = Props::new();
    let Val::Ref(root) = root else { return next };
    let Node::Object(object) = graph.node(*root) else { return next };
    let Some(Val::Ref(overrides)) = object.get(&js::units("overrides")) else {
        return next;
    };
    let Node::Object(overrides) = graph.node(*overrides) else { return next };
    for (key, entry) in overrides.entries() {
        let Val::String(entry) = entry else { continue };
        if !is_prompt_id(&key) || is_deprecated(&key) {
            continue;
        }
        // `next[key] = entry`: "__proto__" reaches Object.prototype's setter, which ignores a string.
        if key == js::units("__proto__") && !plant::on(Plant::ProtoKeptOnRead) {
            continue;
        }
        next.define(key, entry.clone());
    }
    next
}

/// `JSON.stringify(state)` (`indent` 0) or `JSON.stringify(state, null, 2)`.
pub fn stringify(state: &State, indented: bool) -> Vec<u16> {
    let mut out = Vec::new();
    let text = |out: &mut Vec<u16>, text: &str| out.extend(text.encode_utf16());
    let entries = state.overrides.entries();
    let version_text = if plant::on(Plant::VersionString) { "\"1\"" } else { "1" };
    if indented {
        text(&mut out, "{\n  \"version\": ");
        text(&mut out, version_text);
        text(&mut out, ",\n  \"overrides\": ");
        if entries.is_empty() {
            text(&mut out, "{}");
        } else {
            text(&mut out, "{");
            for (index, (key, value)) in entries.iter().enumerate() {
                text(&mut out, if index == 0 { "\n    " } else { ",\n    " });
                js::push_json_string(&mut out, key);
                text(&mut out, ": ");
                js::push_json_string(&mut out, value);
            }
            text(&mut out, "\n  }");
        }
        text(&mut out, "\n}");
    } else {
        text(&mut out, "{\"version\":");
        text(&mut out, version_text);
        text(&mut out, ",\"overrides\":{");
        for (index, (key, value)) in entries.iter().enumerate() {
            if index > 0 {
                text(&mut out, ",");
            }
            js::push_json_string(&mut out, key);
            text(&mut out, ":");
            js::push_json_string(&mut out, value);
        }
        text(&mut out, "}}");
    }
    out
}

/// The UTF-8 bytes of [`stringify`] (what `res.json` sends and `writeFile` writes), made directly.
pub fn stringify_utf8(state: &State, indented: bool) -> Vec<u8> {
    let entries = state.overrides.entries();
    let mut out = Vec::with_capacity(64 + entries.iter().map(|(key, value)| key.len() + value.len() + 8).sum::<usize>());
    let version_text: &[u8] = if plant::on(Plant::VersionString) { b"\"1\"" } else { b"1" };
    if indented {
        out.extend_from_slice(b"{\n  \"version\": ");
        out.extend_from_slice(version_text);
        out.extend_from_slice(b",\n  \"overrides\": ");
        if entries.is_empty() {
            out.extend_from_slice(b"{}");
        } else {
            out.push(b'{');
            for (index, (key, value)) in entries.iter().enumerate() {
                out.extend_from_slice(if index == 0 { b"\n    " } else { b",\n    " });
                crate::text::push_json_utf8(&mut out, key);
                out.extend_from_slice(b": ");
                crate::text::push_json_utf8(&mut out, value);
            }
            out.extend_from_slice(b"\n  }");
        }
        out.extend_from_slice(b"\n}");
    } else {
        out.extend_from_slice(b"{\"version\":");
        out.extend_from_slice(version_text);
        out.extend_from_slice(b",\"overrides\":{");
        for (index, (key, value)) in entries.iter().enumerate() {
            if index > 0 {
                out.push(b',');
            }
            crate::text::push_json_utf8(&mut out, key);
            out.push(b':');
            crate::text::push_json_utf8(&mut out, value);
        }
        out.extend_from_slice(b"}}");
    }
    out
}

/// Node's `path.join(dir, name)` for an absolute POSIX directory: the normalised path.
pub fn join(dir: &str, name: &str) -> String {
    let joined = format!("{dir}/{name}");
    let absolute = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    if absolute { format!("/{body}") } else { body }
}

pub struct Runtime {
    pub file_path: String,
    lock: Mutex<()>,
    /// The stale-cache plant's memory of the state.
    cached: Mutex<Option<State>>,
}

/// What a write call threw: the Error's message.
pub type Thrown = String;

impl Runtime {
    pub fn new(data_root: &str) -> Self {
        Runtime {
            file_path: join(data_root, "magic-prompts.json"),
            lock: Mutex::new(()),
            cached: Mutex::new(None),
        }
    }

    /// `readPromptState()`: never fails; a missing, unreadable or malformed file reads as empty.
    pub fn read_prompt_state(&self) -> State {
        if plant::on(Plant::StaleCache) {
            let mut cached = self.cached.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            return cached.get_or_insert_with(|| self.read_file()).clone();
        }
        self.read_file()
    }

    fn read_file(&self) -> State {
        let raw = match fs::read(&self.file_path) {
            Ok(raw) => raw,
            Err(error) => {
                if error.kind() != ErrorKind::NotFound {
                    eprintln!("Failed to read magic prompts file: {}", uv::fs_message(&error, "open", Some(&self.file_path)));
                }
                return State::default();
            }
        };
        let raw = if plant::on(Plant::ReadBomStripped) {
            raw.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(&raw).to_vec()
        } else {
            raw
        };
        match json::parse(&crate::text::utf8_units(&raw)) {
            Ok((graph, root)) => State {
                overrides: sanitize(&graph, &root),
            },
            Err(_) => {
                eprintln!("Failed to read magic prompts file: SyntaxError");
                State::default()
            }
        }
    }

    /// `writePromptState(state)`.
    fn write_prompt_state(&self, state: &State) -> Result<(), Thrown> {
        if plant::on(Plant::StaleCache) {
            *self.cached.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(state.clone());
        }
        if plant::on(Plant::AnsweredBeforeDurable) {
            let path = self.file_path.clone();
            let bytes = stringify_utf8(state, true);
            plant::defer(Box::new(move || {
                let _ = fs::write(&path, &bytes);
            }));
            return Ok(());
        }
        let fs_message = |error: &std::io::Error, syscall: &str, path: Option<&str>| {
            if plant::on(Plant::RustErrorText) {
                error.to_string()
            } else {
                uv::fs_message(error, syscall, path)
            }
        };
        let dir = std::path::Path::new(&self.file_path).parent().map(PathBuf::from).unwrap_or_default();
        if !plant::on(Plant::NoMkdir) {
            fs::create_dir_all(&dir).map_err(|error| fs_message(&error, "mkdir", Some(&dir.to_string_lossy())))?;
        }
        let mut bytes = stringify_utf8(state, true);
        if plant::on(Plant::TrailingNewline) {
            bytes.push(b'\n');
        }
        if plant::on(Plant::ReplacedNotInPlace) {
            let temporary = format!("{}.tmp", self.file_path);
            fs::write(&temporary, &bytes).map_err(|error| fs_message(&error, "open", Some(&temporary)))?;
            return fs::rename(&temporary, &self.file_path).map_err(|error| fs_message(&error, "rename", Some(&temporary)));
        }
        if plant::on(Plant::TemporaryLeftBehind) {
            let temporary = format!("{}.tmp", self.file_path);
            let _ = fs::write(&temporary, &bytes);
        }
        let mode = if plant::on(Plant::FileMode600) { 0o600 } else { 0o666 };
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&self.file_path)
            .map_err(|error| fs_message(&error, "open", Some(&self.file_path)))?;
        if plant::on(Plant::ModeFixed644) {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o644));
        }
        file.write_all(&bytes).map_err(|error| fs_message(&error, "write", None))?;
        Ok(())
    }

    /// `persist(mutator)`: in `ticket`'s turn, read, mutate and write under the write lock; answers the next state.
    /// The turn ends when the write has ended, failed or not.
    fn persist(&self, ticket: &Ticket, mutate: impl FnOnce(State) -> State) -> Result<State, Thrown> {
        let _held = if plant::on(Plant::NoWriteLock) || plant::on(Plant::NoWriteLockPlain) {
            None
        } else {
            ticket.wait();
            Some(self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
        };
        let result = self.persist_held(mutate);
        ticket.release();
        result
    }

    fn persist_held(&self, mutate: impl FnOnce(State) -> State) -> Result<State, Thrown> {
        let current = self.read_prompt_state();
        if plant::on(Plant::NoWriteLock) {
            plant::rendezvous();
        }
        let next = mutate(current);
        if !plant::on(Plant::MissingWrite) {
            self.write_prompt_state(&next)?;
        }
        Ok(next)
    }

    /// `setOverride(id, text)`.
    pub fn set_override(&self, ticket: &Ticket, id: &[u16], text: &[u16]) -> Result<State, Thrown> {
        let normalized = js::trim(id).to_vec();
        if !is_prompt_id(&normalized) {
            return Err("Invalid prompt id".to_owned());
        }
        if is_deprecated(&normalized) {
            return Err("Deprecated prompt id".to_owned());
        }
        let blank = if plant::on(Plant::VisibleAsciiTrim) {
            text.iter().all(|unit| matches!(*unit, 0x20 | 0x09 | 0x0a | 0x0b | 0x0c | 0x0d))
        } else {
            js::trim(text).is_empty()
        };
        if normalized.ends_with(&js::units(".visible")) && blank {
            return Err("Visible prompt text cannot be empty".to_owned());
        }
        let length = if plant::on(Plant::LengthInUtf8Bytes) {
            crate::text::units_utf8(text).len()
        } else {
            text.len()
        };
        if length > MAX_PROMPT_TEXT_LENGTH || (plant::on(Plant::TextLimitOffByOne) && length == MAX_PROMPT_TEXT_LENGTH) {
            return Err("Prompt text is too long".to_owned());
        }
        let text = text.to_vec();
        self.persist(ticket, move |state| {
            let mut overrides = state.overrides;
            overrides.define(normalized, text);
            State { overrides }
        })
    }

    /// `resetOverride(id)`.
    pub fn reset_override(&self, ticket: &Ticket, id: &[u16]) -> Result<State, Thrown> {
        let normalized = if plant::on(Plant::NoTrimDelete) { id.to_vec() } else { js::trim(id).to_vec() };
        if !is_prompt_id(&normalized) {
            return Err("Invalid prompt id".to_owned());
        }
        self.persist(ticket, move |state| {
            if !state.overrides.has(&normalized) {
                return state;
            }
            let mut overrides = state.overrides;
            overrides.remove(&normalized);
            State { overrides }
        })
    }

    /// `resetAllOverrides()`.
    pub fn reset_all_overrides(&self, ticket: &Ticket) -> Result<State, Thrown> {
        self.persist(ticket, |_| State::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devryan_config_text::js::units;

    fn state(pairs: &[(&str, &str)]) -> State {
        let mut overrides = Props::new();
        for (key, value) in pairs {
            overrides.define(units(key), units(value));
        }
        State { overrides }
    }

    #[test]
    fn stringify_as_javascript() {
        assert_eq!(
            String::from_utf16_lossy(&stringify(&State::default(), true)),
            "{\n  \"version\": 1,\n  \"overrides\": {}\n}"
        );
        assert_eq!(
            String::from_utf16_lossy(&stringify(&State::default(), false)),
            "{\"version\":1,\"overrides\":{}}"
        );
        let two = state(&[("b", "x\"\n"), ("a", "y")]);
        assert_eq!(
            String::from_utf16_lossy(&stringify(&two, true)),
            "{\n  \"version\": 1,\n  \"overrides\": {\n    \"b\": \"x\\\"\\n\",\n    \"a\": \"y\"\n  }\n}"
        );
        assert_eq!(
            String::from_utf16_lossy(&stringify(&two, false)),
            "{\"version\":1,\"overrides\":{\"b\":\"x\\\"\\n\",\"a\":\"y\"}}"
        );
        let mut odd = state(&[("9", "é 😀"), ("b", "\u{1}")]);
        odd.overrides.define(units("c"), vec![0xd800, 0x61]);
        for value in [State::default(), two, odd] {
            for indented in [false, true] {
                assert_eq!(stringify_utf8(&value, indented), js::to_utf8(&stringify(&value, indented)));
            }
        }
    }

    #[test]
    fn ids() {
        assert!(is_prompt_id(&units(&"a".repeat(160))));
        assert!(!is_prompt_id(&units(&"a".repeat(161))));
        assert!(!is_prompt_id(&units("")));
        assert!(!is_prompt_id(&units("Git.pr")));
        assert!(is_prompt_id(&units("__proto__")));
    }

    #[test]
    fn joins_like_node() {
        assert_eq!(join("/a/b/", "x.json"), "/a/b/x.json");
        assert_eq!(join("/a//b/./c/..", "x.json"), "/a/b/x.json");
        assert_eq!(join("/", "x.json"), "/x.json");
    }

    #[test]
    fn sanitizes_on_read() {
        let text = units("{\"overrides\":{\"__proto__\":\"p\",\"b\":\"1\",\"B\":\"2\",\"9\":\"n\",\"git.commit.plan.visible\":\"d\",\"c\":3,\"b\":\"4\"}}");
        let (graph, root) = json::parse(&text).unwrap();
        let read = State {
            overrides: sanitize(&graph, &root),
        };
        assert_eq!(
            String::from_utf16_lossy(&stringify(&read, false)),
            "{\"version\":1,\"overrides\":{\"9\":\"n\",\"b\":\"4\"}}"
        );
        for text in [
            "null",
            "[]",
            "{\"overrides\":[\"a\"]}",
            "{\"overrides\":\"s\"}",
            "{\"__proto__\":{\"overrides\":{\"a\":\"b\"}}}",
        ] {
            let (graph, root) = json::parse(&units(text)).unwrap();
            assert!(sanitize(&graph, &root).is_empty(), "{text}");
        }
    }
}

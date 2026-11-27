//! The group's two routes (packages/web/server/lib/session-folders/routes.js) as Express 5's router dispatches
//! them (case-insensitive, an optional trailing slash, the query ignored, HEAD answered by GET), and its save
//! queue:
//!
//! - `GET /api/session-folders`: `readFile(filePath, 'utf8')`; ENOENT, an empty file or a text JSON.parse refuses
//!   answer the empty document; another read error answers 500 with Node's text; otherwise the parsed value,
//!   re-serialised (res.json's JSON.stringify has no replacer and no gap: V8's iterative path, any depth).
//! - `POST /api/session-folders`: `req.body` must be an object that is not an array (400 `Body must be an
//!   object`); `JSON.stringify(body, null, 2)` over 4 MiB in UTF-8 bytes is 413 `Payload too large`; otherwise
//!   the save: one at a time, in the order the handlers called `persist` (the request's ticket), each doing
//!   `mkdir -p` of the folder, harness-runtime's stale-file cleanup (its failure ignored), the write of
//!   `<file>.tmp-<pid>-<UUID>` and its rename over the file; a failure removes the temporary file and answers
//!   500 with Node's text; then `{"success":true}`.
//!
//! A GET never waits for a save; it keeps its ticket until it has read, so a later save's rename cannot come
//! before its read opened the file (in Node the read is on the thread pool before that save's mkdir, cleanup,
//! write and rename are).

use std::sync::Mutex;

use devryan_route_common::answer::{self, page};
use devryan_route_common::body::{self, Body, JsonReader};
use devryan_route_common::fsjs;
use devryan_route_common::http::{Headers, Response, pathname};
use devryan_route_common::json::Thrown;
use devryan_route_common::order::Ticket;
use devryan_route_common::plant as shared_plant;
use devryan_route_common::server::{Exchange, Group};
use devryan_route_common::value::{self, V};

use crate::plant::{self, Plant};

const FILE_NAME: &str = "sessions-directories.json";
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const EMPTY_DOCUMENT: &[u8] = br#"{"version":1,"foldersMap":{},"collapsedFolderIds":[],"updatedAt":0}"#;

/// What GET answers when there is nothing to read.
fn empty_document() -> Vec<u8> {
    if plant::on(Plant::RvEmptyDocOrder) {
        return br#"{"version":1,"collapsedFolderIds":[],"foldersMap":{},"updatedAt":0}"#.to_vec();
    }
    EMPTY_DOCUMENT.to_vec()
}
const ROUTE: &str = "/api/session-folders";

/// What the group reads of a JSON body: the value, or (nested past what `JSON.stringify(body, null, 2)` can write
/// before V8's stack runs out) only whether it is an object.
#[derive(Debug)]
pub enum Document {
    /// The value, for the caller to write.
    Value(V),
    /// The document `JSON.stringify(body, null, 2)` writes, already written (cut off once over the limit).
    Written {
        out: Vec<u8>,
        over: bool,
        object: bool,
    },
    TooDeep {
        object: bool,
    },
}

pub struct DocumentReader;

fn document(parsed: value::Parsed) -> Document {
    match parsed.value {
        Some(value) => Document::Value(value),
        None => Document::TooDeep { object: parsed.object },
    }
}

/// The one pass's document (`None`: the tree decides, under a planted variant).
fn written(done: Option<value::Transcoded>, limit: usize) -> Option<Document> {
    let done = done?;
    Some(if done.depth > limit {
        Document::TooDeep { object: done.object }
    } else {
        Document::Written {
            out: done.out,
            over: done.over,
            object: done.object,
        }
    })
}

/// The one pass is taken unless a planted change of the document's size is on.
fn one_pass_allowed() -> bool {
    !plant::on(Plant::Indent4) && !plant::on(Plant::LimitInUtf16Units)
}

impl JsonReader for DocumentReader {
    type Value = Document;
    fn utf8(bytes: &[u8]) -> Result<Self::Value, Thrown> {
        let limit = value::depth_limit();
        if one_pass_allowed()
            && let Some(document) = written(value::transcode(bytes, 2, MAX_BODY_BYTES, limit).map_err(|_| Thrown)?, limit)
        {
            return Ok(document);
        }
        value::parse_limited(bytes, false, Some(limit)).map(document).map_err(|_| Thrown)
    }
    fn units(text: &[u16]) -> Result<Self::Value, Thrown> {
        let limit = value::depth_limit();
        if one_pass_allowed()
            && let Some(document) = written(value::transcode_units(text, 2, MAX_BODY_BYTES, limit).map_err(|_| Thrown)?, limit)
        {
            return Ok(document);
        }
        value::from_units(text, Some(limit)).map(document).map_err(|_| Thrown)
    }
    fn empty() -> Self::Value {
        Document::Value(V::Obj(Box::default()))
    }
}

/// `^\/api\/session-folders\/?$`, case-insensitively.
pub fn is_route(path: &str) -> bool {
    let path = path.strip_suffix('/').unwrap_or(path);
    if plant::on(Plant::CaseSensitiveRoutes) {
        return path == ROUTE;
    }
    path.len() == ROUTE.len() && path.eq_ignore_ascii_case(ROUTE)
}

pub struct SessionFolders {
    file_path: String,
    /// The stale-cache plant's first read.
    cache: Mutex<Option<Vec<u8>>>,
}

fn plant_variant() {
    use devryan_route_common::value::Variant;
    let variant = Variant {
        replacement_per_byte: plant::on(Plant::ReplacementPerByte),
        lone_surrogate_raw: plant::on(Plant::LoneSurrogateRaw),
        index_keys_in_place: plant::on(Plant::IndexKeysInPlace),
        duplicate_last_place: plant::on(Plant::DuplicateKeyLastPlace),
        proto_dropped: plant::on(Plant::ProtoDropped),
        negative_zero_kept: plant::on(Plant::NegativeZeroKept),
        form_holes_kept: plant::on(Plant::FormHolesKept),
        depth_limit: None,
    };
    value::plant_variant(variant);
}

impl Group for SessionFolders {
    type Reader = DocumentReader;
    const COMMAND: &'static str = "devryan-route-session-folders";

    fn plant_ids() -> Vec<&'static str> {
        plant::ids()
    }

    fn new(data_root: &str) -> Self {
        plant_variant();
        SessionFolders {
            file_path: fsjs::join(data_root, FILE_NAME),
            cache: Mutex::new(None),
        }
    }

    fn handle(&self, exchange: &Exchange, body: Result<Body<Document>, body::Refusal>, envelope: Result<(), String>, ticket: &Ticket) -> Response {
        let response = self.route(exchange, body, envelope, ticket);
        ticket.release();
        response
    }
}

impl SessionFolders {
    fn route(&self, exchange: &Exchange, body: Result<Body<Document>, body::Refusal>, envelope: Result<(), String>, ticket: &Ticket) -> Response {
        let Exchange { method, target, headers } = *exchange;
        let path = pathname(target);
        let decoded = match body {
            Ok(decoded) => decoded,
            Err(refusal) => return page(method, refusal.status, &refusal.message),
        };
        if let Err(message) = envelope {
            return answer::json(method, headers, 400, answer::error_body(&message));
        }
        if !is_route(path) {
            return page(method, 404, &format!("Cannot {method} {path}"));
        }
        match method {
            "GET" | "HEAD" => self.get(method, headers, ticket),
            "POST" => self.post(method, headers, decoded, ticket),
            _ => page(method, 404, &format!("Cannot {method} {path}")),
        }
    }

    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        if plant::on(Plant::StaleCache)
            && let Some(cached) = self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
        {
            return Ok(Some(cached));
        }
        let read = fsjs::read_file(&self.file_path).map_err(|(_, message)| message)?;
        if plant::on(Plant::StaleCache)
            && let Some(bytes) = &read
        {
            *self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bytes.clone());
        }
        Ok(read)
    }

    fn get(&self, method: &str, headers: &Headers, ticket: &Ticket) -> Response {
        if plant::on(Plant::GetWaitsForTurn) {
            ticket.wait();
        }
        if plant::on(Plant::RvCleanupOnGet) {
            let _ = fsjs::cleanup_stale_atomic_files(&self.file_path, fsjs::STALE_TMP_AGE_MS, fsjs::now_ms);
        }
        let read = self.read();
        ticket.release();
        let raw = match read {
            Ok(raw) => raw,
            Err(_) if plant::on(Plant::ReadErrorsAsEmpty) => None,
            Err(message) if plant::on(Plant::RvGetLoopEmpty) && message.starts_with("ELOOP") => None,
            Err(message) if plant::on(Plant::RvGetTextNoPath) => {
                let short = message.rsplit_once(" '").map_or(message.as_str(), |(head, _)| head);
                return answer::json(method, headers, 500, answer::error_body(short));
            }
            Err(message) => return answer::json(method, headers, 500, answer::error_body(&message)),
        };
        let Some(mut raw) = raw.filter(|raw| !raw.is_empty()) else {
            return answer::json(method, headers, 200, empty_document());
        };
        if plant::on(Plant::ReadBomStripped) && raw.starts_with(&[0xef, 0xbb, 0xbf]) {
            raw.drain(..3);
        }
        let too_deep = |depth: usize| plant::on(Plant::DepthLimit100) && depth > 100;
        let written = match value::transcode(&raw, 0, usize::MAX, usize::MAX) {
            Ok(Some(done)) if !too_deep(done.depth) => Some(done.out),
            Ok(Some(_)) | Err(_) => None,
            Ok(None) => match value::parse(&raw, false) {
                Ok(value::Parsed {
                    value: Some(parsed), depth, ..
                }) if !too_deep(depth) => Some(value::stringify(&parsed, 0, usize::MAX)),
                _ => None,
            },
        };
        let written = if plant::on(Plant::RvGetPretty) {
            value::parse(&raw, false)
                .ok()
                .and_then(|parsed| parsed.value)
                .map(|parsed| value::stringify(&parsed, 2, usize::MAX))
        } else {
            written
        };
        let written = if plant::on(Plant::RvGetNonObjectEmpty) {
            written.filter(|bytes| bytes.first() == Some(&b'{'))
        } else {
            written
        };
        let mut written = if plant::on(Plant::RvGetRawBytes) {
            written.map(|_| raw.clone())
        } else {
            written
        };
        if plant::on(Plant::RvGetTrailingNewline)
            && let Some(bytes) = written.as_mut()
        {
            bytes.push(b'\n');
        }
        // None: JSON.parse threw (the inner catch).
        answer::json(method, headers, 200, written.unwrap_or_else(empty_document))
    }

    fn post(&self, method: &str, headers: &Headers, decoded: Body<Document>, ticket: &Ticket) -> Response {
        let refuse = |status: u16| {
            let message = if plant::on(Plant::ErrorText) {
                "Body must be an object."
            } else {
                "Body must be an object"
            };
            let status = if plant::on(Plant::Status422) { 422 } else { status };
            answer::json(method, headers, status, answer::error_body(message))
        };
        let document = match decoded {
            Body::Unparsed => return refuse(400),
            Body::Json(Document::TooDeep { object: true }) => {
                // JSON.stringify(body, null, 2) ran out of stack in the handler: Express's error handler answers (in
                // the reference a page with the stack, which the harness classes unrecordable and never judges).
                ticket.release();
                return page(method, 500, "RangeError: Maximum call stack size exceeded");
            }
            Body::Json(Document::Written { object: false, over: true, .. }) if plant::on(Plant::RvSizeBeforeType) => {
                return answer::json(method, headers, 413, answer::error_body("Payload too large"));
            }
            Body::Json(Document::Written { object: false, out, over }) if plant::on(Plant::RvPostAcceptsArray) => {
                return self.save(method, headers, out, over, ticket);
            }
            Body::Json(Document::Written { object: false, .. }) => return refuse(400),
            Body::Json(Document::Written { out, over, .. }) => return self.save(method, headers, out, over, ticket),
            Body::Json(Document::Value(document @ V::Obj(_))) => document,
            Body::Json(_) => return refuse(400),
            Body::Form(form) => value::from_form(&form),
        };
        let gap = if plant::on(Plant::Indent4) { 4 } else { 2 };
        let stop = if plant::on(Plant::LimitInUtf16Units) { usize::MAX } else { MAX_BODY_BYTES };
        let serialized = value::stringify(&document, gap, stop);
        drop(document);
        self.save(method, headers, serialized, false, ticket)
    }

    /// The handler after `JSON.stringify(body, null, 2)`: the size check, then the save in its turn.
    fn save(&self, method: &str, headers: &Headers, mut serialized: Vec<u8>, over: bool, ticket: &Ticket) -> Response {
        if plant::on(Plant::EmptyJsonRefused) && serialized == b"{}" {
            let message = if plant::on(Plant::ErrorText) {
                "Body must be an object."
            } else {
                "Body must be an object"
            };
            return answer::json(method, headers, 400, answer::error_body(message));
        }
        let size = if over {
            MAX_BODY_BYTES + 1
        } else if plant::on(Plant::LimitInUtf16Units) {
            value::units_of_wtf8(&serialized).len()
        } else if plant::on(Plant::RvLimitIgnoresNewlines) {
            serialized.iter().filter(|byte| **byte != b'\n').count()
        } else {
            serialized.len()
        };
        if size > MAX_BODY_BYTES || (plant::on(Plant::LimitOffByOne) && size == MAX_BODY_BYTES) {
            return answer::json(method, headers, 413, answer::error_body("Payload too large"));
        }
        if plant::on(Plant::TrailingNewline) {
            serialized.push(b'\n');
        }
        if !plant::on(Plant::RvNoSaveLock) {
            ticket.wait();
        }
        if plant::on(Plant::AnsweredBeforeDurable) {
            let file_path = self.file_path.clone();
            shared_plant::defer(Box::new(move || {
                let _ = persist(&file_path, &serialized);
            }));
            return answer::json(method, headers, 200, br#"{"success":true}"#.to_vec());
        }
        let saved = if plant::on(Plant::MissingWrite) {
            Ok(())
        } else {
            persist(&self.file_path, &serialized)
        };
        ticket.release();
        match saved {
            Ok(()) if plant::on(Plant::RvSuccessExtraKey) => answer::json(method, headers, 200, br#"{"success":true,"saved":true}"#.to_vec()),
            Ok(()) => answer::json(method, headers, 200, br#"{"success":true}"#.to_vec()),
            Err(message) if plant::on(Plant::RvErrorKeyMessage) => {
                let body = answer::error_body(&message);
                answer::json(method, headers, 500, [b"{\"message\"".as_slice(), &body[8..]].concat())
            }
            Err(message) => answer::json(method, headers, 500, answer::error_body(&message)),
        }
    }
}

/// A save's stale-file cleanup (harness-runtime's `cleanupStaleAtomicFiles(filePath, { fs })`) with the clock `now`,
/// its failure ignored (`.catch(() => undefined)`): the save's own, and tests/vectors.rs's with a given clock.
pub fn stale_cleanup(file_path: &str, now: impl Fn() -> f64) {
    if plant::on(Plant::NoCleanup) {
        return;
    }
    let age = if plant::on(Plant::CleanupIgnoresAge) {
        f64::NEG_INFINITY
    } else {
        fsjs::STALE_TMP_AGE_MS
    };
    let _ = fsjs::cleanup_stale_atomic_files_with(file_path, age, &now, plant::on(Plant::CleanupFollowsLinks));
    if plant::on(Plant::RvCleanupRecurses)
        && let Ok(entries) = std::fs::read_dir(fsjs::dirname(file_path))
    {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                let inner = format!("{}/{FILE_NAME}", entry.path().to_string_lossy());
                let _ = fsjs::cleanup_stale_atomic_files_with(&inner, age, &now, false);
            }
        }
    }
}

/// `persist(serialized)`'s run, for a save whose turn has come.
fn persist(file_path: &str, serialized: &[u8]) -> Result<(), String> {
    let mode = if plant::on(Plant::FileMode600) {
        0o600
    } else if plant::on(Plant::RvModeSix40) {
        0o640
    } else {
        0o666
    };
    if !plant::on(Plant::RvNoMkdir) {
        fsjs::mkdir_recursive(fsjs::dirname(file_path))?;
    }
    let cleanup = || stale_cleanup(file_path, fsjs::now_ms);
    if plant::on(Plant::WrittenInPlace) {
        return fsjs::write_file(file_path, serialized, mode).map_err(rust_text);
    }
    if !plant::on(Plant::CleanupAfterWrite) {
        cleanup();
    }
    let tmp = if plant::on(Plant::SharedTemporaryName) {
        format!("{file_path}.tmp")
    } else if plant::on(Plant::TemporaryNameWithoutPid) {
        format!("{file_path}.tmp-{}", fsjs::random_uuid())
    } else if plant::on(Plant::RvTmpInSubdir) {
        let dir = format!("{}/.tmp", fsjs::dirname(file_path));
        let _ = std::fs::create_dir_all(&dir);
        format!("{dir}/{FILE_NAME}.tmp-{}-{}", std::process::id(), fsjs::random_uuid())
    } else if plant::on(Plant::RvTmpInOsTmpdir) {
        format!(
            "{}/{FILE_NAME}.tmp-{}-{}",
            std::env::temp_dir().to_string_lossy().trim_end_matches('/'),
            std::process::id(),
            fsjs::random_uuid()
        )
    } else {
        format!("{file_path}.tmp-{}-{}", std::process::id(), fsjs::random_uuid())
    };
    let target = match std::fs::read_link(file_path) {
        Ok(link) if plant::on(Plant::RvRenameThroughLink) => fsjs::join(fsjs::dirname(file_path), &link.to_string_lossy()),
        _ => file_path.to_owned(),
    };
    let saved = fsjs::write_file(&tmp, serialized, mode).and_then(|()| fsjs::rename(&tmp, &target));
    if let Err(message) = saved {
        if !plant::on(Plant::TemporaryLeftBehind) {
            let _ = fsjs::rm_force(&tmp);
        }
        return Err(rust_text(message));
    }
    if plant::on(Plant::CleanupAfterWrite) {
        cleanup();
    }
    Ok(())
}

/// The rust-error-text plant: the error as Rust would print it (`Is a directory (os error 21)`), not Node's.
fn rust_text(message: String) -> String {
    if !plant::on(Plant::RustErrorText) {
        return message;
    }
    let code = message.split(':').next().unwrap_or("");
    let errno = devryan_route_common::uv::errno_of(code).unwrap_or(0);
    std::io::Error::from_raw_os_error(errno).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_like_express() {
        assert!(is_route("/api/session-folders"));
        assert!(is_route("/API/Session-Folders/"));
        assert!(!is_route("/api/session-folders//"));
        assert!(!is_route("/api/session-folders/x"));
        assert!(!is_route("/api/session%2Dfolders"));
        assert!(!is_route("//api/session-folders"));
    }

    #[test]
    fn documents_as_v8_writes_them() {
        let parsed = value::parse(br#"{"b":1,"2":"x","a":[1.0,-0,1e400],"b":2,"1":true,"__proto__":{}}"#, false)
            .unwrap()
            .value
            .unwrap();
        assert_eq!(
            value::stringify(&parsed, 0, usize::MAX),
            br#"{"1":true,"2":"x","b":2,"a":[1,0,null],"__proto__":{}}"#
        );
        assert_eq!(
            value::stringify(&parsed, 2, usize::MAX),
            b"{\n  \"1\": true,\n  \"2\": \"x\",\n  \"b\": 2,\n  \"a\": [\n    1,\n    0,\n    null\n  ],\n  \"__proto__\": {}\n}"
        );
        let text = value::parse(br#""\ud800\ud83d\ude00\u0001\/""#, false).unwrap().value.unwrap();
        assert_eq!(value::stringify(&text, 0, usize::MAX), "\"\\ud800\u{1f600}\\u0001/\"".as_bytes());
        let replaced = value::parse(b"\"\xff\xc3(\xed\xa0\x80\xf0\x9f\x98\"", false).unwrap().value.unwrap();
        assert_eq!(
            value::stringify(&replaced, 0, usize::MAX),
            "\"\u{fffd}\u{fffd}(\u{fffd}\u{fffd}\u{fffd}\u{fffd}\"".as_bytes()
        );
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        let parsed = value::parse_limited(deep.as_bytes(), false, Some(value::DEPTH_LIMIT)).unwrap();
        assert!(parsed.value.is_none() && parsed.depth == 100_000 && !parsed.object);
        let whole = value::parse(deep.as_bytes(), false).unwrap().value.unwrap();
        assert_eq!(value::stringify(&whole, 0, usize::MAX).len(), 200_000);
        assert!(value::parse(b"\xef\xbb\xbf{}", false).is_err());
        assert!(value::parse(b"[1,]", false).is_err());
    }
}

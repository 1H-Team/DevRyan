//! Runs every row of the tracked vectors (tests/generate-vectors.mjs made them by running the JavaScript this crate
//! ports) through the crate and requires the same bytes: each request's answer, the data file after it and the
//! temporary files left (`requests.tsv`; for a JSON document, through both parsing paths: the group's one pass and
//! the tree), and what the stale-file cleanup leaves with a given clock (`cleanup.tsv`: a day before the clock
//! exactly, and a millisecond either side).
//!
//! With the `plants` feature and `ROUTE_PLANT=<id>`, the rows run with that planted change switched on: the plants
//! these vectors must catch fail here (scripts/backend-conformance/rust-plants.mjs names them).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use devryan_route_common::answer::base64_decode;
use devryan_route_common::body::{self, Body};
use devryan_route_common::http::{Headers, pathname};
use devryan_route_common::order::Ticket;
use devryan_route_common::server::{Exchange, Group};
use devryan_route_common::value;
use devryan_route_session_folders::group::{self, Document, DocumentReader, SessionFolders};

const FILE: &str = "sessions-directories.json";
const EMPTY: &[u8] = br#"{"version":1,"foldersMap":{},"collapsedFolderIds":[],"updatedAt":0}"#;

fn rows(name: &str) -> Vec<(Vec<String>, Vec<String>)> {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join(name);
    let text = std::fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
    let rows: Vec<(Vec<String>, Vec<String>)> = text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<String> = line.split('\t').map(str::to_owned).collect();
            let at = fields.iter().position(|field| field == "=>").expect("a row has its => field");
            (fields[..at].to_vec(), fields[at + 1..].to_vec())
        })
        .collect();
    assert!(rows.len() >= 100, "{name} holds {} rows", rows.len());
    rows
}

fn b64(field: &str) -> Vec<u8> {
    base64_decode(field.as_bytes())
}

fn text(field: &str) -> String {
    String::from_utf8(b64(field)).expect("UTF-8")
}

/// A private folder under the OS temp dir, removed when dropped (a failing assertion included).
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("devryan-session-folders-vectors-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch folder");
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The planted change `ROUTE_PLANT` names, switched on once (a build with the `plants` feature only).
fn plant() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if let Ok(id) = std::env::var("ROUTE_PLANT")
            && !id.is_empty()
        {
            devryan_route_common::plant::choose(&id, &devryan_route_session_folders::plant::ids()).expect("a known plant, in a build with the plants feature");
        }
    });
}

fn set_state(root: &Path, state: &str) {
    for entry in std::fs::read_dir(root).expect("the data root") {
        let path = entry.expect("an entry").path();
        if path.is_dir() && !path.is_symlink() {
            std::fs::remove_dir_all(&path).expect("remove a folder");
        } else {
            std::fs::remove_file(&path).expect("remove a file");
        }
    }
    if state == "dir" {
        std::fs::create_dir(root.join(FILE)).expect("a folder at the file's path");
    } else if let Some(bytes) = state.strip_prefix("f:") {
        std::fs::write(root.join(FILE), b64(bytes)).expect("the data file");
    }
}

fn after_state(root: &Path) -> Vec<String> {
    let file = root.join(FILE);
    let shown = match std::fs::symlink_metadata(&file) {
        Ok(meta) if meta.is_file() => devryan_route_common::answer::base64(&std::fs::read(&file).expect("the data file")),
        Ok(_) => "dir".to_owned(),
        Err(_) => "-".to_owned(),
    };
    let prefix = format!("{FILE}.tmp-");
    let left = std::fs::read_dir(root)
        .expect("the data root")
        .filter(|entry| entry.as_ref().is_ok_and(|entry| entry.file_name().to_string_lossy().starts_with(&prefix)))
        .count();
    vec![shown, left.to_string()]
}

/// `<file>.tmp-<pid>-<UUID v4>` written `<tmp>`, the data root `<root>` (the generator's rule).
fn shown(body: &[u8], root: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(body).replace(root, "<root>");
    let marker = format!("{FILE}.tmp-");
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find(&marker) {
        out.push_str(&rest[..at]);
        let tail = &rest[at + marker.len()..];
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        let uuid = tail.get(digits + 1..digits + 37);
        if digits > 0 && tail.as_bytes().get(digits) == Some(&b'-') && uuid.is_some_and(|uuid| uuid.len() == 36) {
            out.push_str("<tmp>");
            rest = &tail[digits + 37..];
        } else {
            out.push_str(&marker);
            rest = tail;
        }
    }
    out.push_str(rest);
    out.into_bytes()
}

#[test]
fn requests_match_the_javascript() {
    plant();
    let scratch = Scratch::new("requests");
    let root = scratch.0.join("data");
    std::fs::create_dir_all(&root).expect("the data root");
    let root_text = root.to_str().expect("a UTF-8 path").to_owned();
    let group = SessionFolders::new(&root_text);
    let mut failures = Vec::new();
    let (mut one_pass, mut tree_checked) = (0, 0);
    for (index, (input, output)) in rows("requests.tsv").into_iter().enumerate() {
        let [state, method, target, content_type, encoding, body] = &input[..] else {
            panic!("row {}: six input fields", index + 1)
        };
        set_state(&root, state);
        let (method, target) = (text(method), text(target));
        let bytes = b64(body);
        let length = bytes.len().to_string();
        let content_type = (content_type != "-").then(|| text(content_type));
        let encoding = (encoding != "-").then(|| text(encoding));
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        if let Some(value) = &content_type {
            pairs.push(("content-type", value));
        }
        if let Some(value) = &encoding {
            pairs.push(("content-encoding", value));
        }
        if !bytes.is_empty() {
            pairs.push(("content-length", &length));
        }
        let headers = Headers::from_pairs(&pairs);
        let path = pathname(&target);
        let decoded = body::decode_with::<DocumentReader>(&headers, &bytes, path);
        if matches!(decoded, Ok(Body::Json(Document::Written { .. }))) {
            one_pass += 1;
        }
        let refused = decoded.as_ref().err().map(|refusal| refusal.status);
        let exchange = Exchange {
            method: &method,
            target: &target,
            headers: &headers,
        };
        let answer = group.handle(&exchange, decoded, Ok(()), &Ticket::alone());
        let page = answer
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.starts_with("text/html"));
        let mut actual = match refused {
            Some(status) => vec![format!("refused:{status}"), String::new()],
            None if page => vec![format!("refused:{}", answer.status), String::new()],
            None => vec![
                answer.status.to_string(),
                devryan_route_common::answer::base64(&shown(&answer.body, &root_text)),
            ],
        };
        actual.extend(after_state(&root));
        if actual != output {
            failures.push(format!(
                "row {} ({method} {target} {content_type:?} {encoding:?} state {}): JavaScript {output:?}, Rust {actual:?}",
                index + 1,
                &state[..state.len().min(40)]
            ));
            continue;
        }
        // The tree path on the same text: a stored UTF-8 document, and a GET's file.
        let utf8 = content_type
            .as_deref()
            .is_some_and(|kind| kind.starts_with("application/json") && !kind.contains("utf-16"))
            && encoding.is_none()
            && path.eq_ignore_ascii_case("/api/session-folders");
        if method == "POST" && utf8 && output[0] == "200" {
            let parsed = value::parse(&bytes, false)
                .ok()
                .and_then(|parsed| parsed.value)
                .map(|parsed| value::stringify(&parsed, 2, usize::MAX));
            if parsed.as_deref() != Some(b64(&output[2]).as_slice()) {
                failures.push(format!("row {}: the tree writes another document", index + 1));
            }
            tree_checked += 1;
        }
        if method == "GET"
            && output[0] == "200"
            && let Some(file) = state.strip_prefix("f:")
        {
            let parsed = value::parse(&b64(file), false)
                .ok()
                .and_then(|parsed| parsed.value)
                .map(|parsed| value::stringify(&parsed, 0, usize::MAX));
            let wanted = b64(&output[1]);
            if parsed.as_deref().unwrap_or(EMPTY) != wanted.as_slice() && !(file.is_empty() && wanted == EMPTY) {
                failures.push(format!("row {}: the tree reads the file otherwise", index + 1));
            }
            tree_checked += 1;
        }
    }
    assert!(
        one_pass >= 200 && tree_checked >= 200,
        "{one_pass} documents on the one pass, {tree_checked} through the tree"
    );
    assert!(
        failures.is_empty(),
        "{} rows differ:\n{}",
        failures.len(),
        failures[..failures.len().min(8)].join("\n")
    );
}

#[test]
fn the_stale_cleanup_matches_the_javascript_at_the_day_boundary() {
    plant();
    let mut failures = Vec::new();
    let mut boundary = 0;
    for (index, (input, output)) in rows("cleanup.tsv").into_iter().enumerate() {
        let scratch = Scratch::new(&format!("cleanup-{index}"));
        let now: f64 = input[0].parse().expect("a clock");
        for entry in &input[1..] {
            let fields: Vec<&str> = entry.split(':').collect();
            let [kind, name, ms, ns] = fields[..] else {
                panic!("row {}: an entry has four fields", index + 1)
            };
            let path = scratch.0.join(text(name));
            match kind {
                "d" => std::fs::create_dir(&path).expect("a folder"),
                "l" => {
                    let target = format!("{}.target", path.display());
                    std::fs::write(&target, "x").expect("a link's target");
                    std::os::unix::fs::symlink(Path::new(&target).file_name().expect("a name"), &path).expect("a link");
                }
                _ => std::fs::write(&path, "partial").expect("a file"),
            }
            if kind != "l" {
                let nanos: u64 = ns.parse().expect("nanoseconds");
                std::fs::File::open(&path)
                    .expect("open")
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_nanos(nanos))
                    .expect("set the mtime");
                if ms.parse::<f64>().expect("milliseconds") == now - devryan_route_common::fsjs::STALE_TMP_AGE_MS {
                    boundary += 1;
                }
            }
        }
        group::stale_cleanup(&format!("{}/{FILE}", scratch.0.display()), || now);
        let mut left: Vec<Vec<u8>> = std::fs::read_dir(&scratch.0)
            .expect("the folder")
            .map(|entry| entry.expect("an entry").file_name().into_encoded_bytes())
            .filter(|name| !name.ends_with(b".target"))
            .collect();
        left.sort();
        let actual = if left.is_empty() {
            "-".to_owned()
        } else {
            left.iter().map(|name| devryan_route_common::answer::base64(name)).collect::<Vec<_>>().join(",")
        };
        if actual != output[0] {
            failures.push(format!("row {}: JavaScript {}, Rust {actual}", index + 1, output[0]));
        }
    }
    assert!(boundary >= 20, "{boundary} files exactly a day before the clock");
    assert!(
        failures.is_empty(),
        "{} rows differ:\n{}",
        failures.len(),
        failures[..failures.len().min(8)].join("\n")
    );
}

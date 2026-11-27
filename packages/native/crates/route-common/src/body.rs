//! What the product's request decoding (`registerCommonRequestMiddleware` in
//! packages/web/server/lib/opencode/core-routes.js) leaves in `req.body` before
//! the group's handlers run, for a request the candidate is given the raw body
//! of: the shared JSON parser (body-parser 2.2.2 `json`, with the limit the
//! path's prefix chooses, or none at all for an unlisted `/api` path, which is
//! case-sensitive), then the extended URL-encoded parser (50 MB). Each reads
//! the body only when it has one (Transfer-Encoding or a numeric
//! Content-Length) and its type matches (type-is 2.0.1 over content-type
//! 1.0.5's parse), checks the charset (`utf-*` for JSON; UTF-8 or ISO-8859-1
//! for forms), inflates `deflate`, `gzip` and `br`, holds the limit, decodes
//! the charset as iconv-lite 0.7.2 does (dropping a leading byte-order mark),
//! and parses (an empty body is `{}`; JSON must start with `{` or `[`).
//!
//! A refusal is what the edge answers in the reference (the error handler
//! after these parsers: 400, 413 or 415); the harness never sends such a
//! request to a candidate, so its text is not Express's.

use devryan_config_text::js;
use devryan_config_text::value::{Graph, Val};

use crate::http::Headers;
use crate::plant::{self, Plant};
use crate::{inflate, json, qs};

/// `req.body` as a group's handlers see it: `J` is what the group reads of a JSON value (its [`JsonReader`]).
#[derive(Debug)]
pub enum Body<J = Option<Vec<u16>>> {
    /// `undefined`: no parser read the body.
    Unparsed,
    /// The JSON parser's value, as the group's reader takes it.
    Json(J),
    /// The URL-encoded parser's object.
    Form(qs::Q),
}

/// What a group reads of the JSON parser's value, made from the body's text without the edge's own errors:
/// `utf8` from UTF-8 bytes (a byte-order mark already removed), `units` from text another charset decoded,
/// `empty` for an empty body (body-parser's `{}`). An `Err` is a body JSON.parse refuses (the edge's 400).
pub trait JsonReader {
    type Value: Send + std::fmt::Debug + 'static;
    fn utf8(bytes: &[u8]) -> Result<Self::Value, json::Thrown>;
    fn units(text: &[u16]) -> Result<Self::Value, json::Thrown>;
    fn empty() -> Self::Value;
}

/// The first group's reader: `req.body?.text` when it is a string (json::text_of_utf8 says how it reads bytes).
#[derive(Debug)]
pub struct TopLevelText;

impl JsonReader for TopLevelText {
    type Value = Option<Vec<u16>>;
    fn utf8(bytes: &[u8]) -> Result<Self::Value, json::Thrown> {
        json::text_of_utf8(bytes)
    }
    fn units(text: &[u16]) -> Result<Self::Value, json::Thrown> {
        json::parse(text).map(|(graph, value)| json_text(&graph, &value))
    }
    fn empty() -> Self::Value {
        None
    }
}

/// The edge's answer instead of the group's: status and message.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

fn refuse<T>(status: u16, message: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal {
        status,
        message: message.into(),
    })
}

const SHARED_JSON_16KB_PREFIXES: &[&str] = &["/api/desktop/browser-leases", "/api/browser/agent-leases", "/api/config/apply", "/api/preview"];
const SHARED_JSON_50MB_PREFIXES: &[&str] = &[
    "/api/config/agents",
    "/api/config/commands",
    "/api/config/mcp",
    "/api/config/settings",
    "/api/config/skills",
    "/api/config/plugins",
    "/api/admin",
    "/api/analytics",
    "/api/bug-reports",
    "/api/error-logs",
    "/api/client-errors",
    "/api/auth",
    "/api/diagnostics",
    "/api/evidence",
    "/api/projects",
    "/api/fs",
    "/api/git",
    "/api/magic-prompts",
    "/api/prompts",
    "/api/terminal",
    "/api/opencode",
    "/api/push",
    "/api/provider",
    "/api/notifications",
    "/api/session/",
    "/api/session-folders",
    "/api/text",
    "/api/tts",
    "/api/devryan/tunnel",
];
const KB: usize = 1024;
const MB: usize = 1024 * 1024;

fn is_openai_oauth_path(pathname: &str) -> bool {
    let prefix = "/api/provider/openai/oauth";
    pathname.len() >= prefix.len()
        && pathname.is_char_boundary(prefix.len())
        && pathname[..prefix.len()].eq_ignore_ascii_case(prefix)
        && matches!(pathname.as_bytes().get(prefix.len()), None | Some(b'/'))
}

/// `resolveSharedJsonBodyLimit(req.path)`: the JSON parser's limit in bytes, or None when the path is left unparsed.
pub fn shared_json_limit(pathname: &str) -> Option<usize> {
    if is_openai_oauth_path(pathname) {
        return None;
    }
    if pathname.starts_with("/api/behavior") {
        return Some(MB);
    }
    if SHARED_JSON_16KB_PREFIXES.iter().any(|prefix| pathname.starts_with(prefix)) {
        return Some(16 * KB);
    }
    if SHARED_JSON_50MB_PREFIXES.iter().any(|prefix| pathname.starts_with(prefix)) {
        return Some(50 * MB);
    }
    if pathname.starts_with("/api") {
        return None;
    }
    Some(50 * MB)
}

fn is_token(unit: u16) -> bool {
    matches!(unit, 0x21 | 0x23..=0x27 | 0x2a | 0x2b | 0x2d | 0x2e | 0x30..=0x39 | 0x41..=0x5a | 0x5e..=0x7a | 0x7c | 0x7e)
}

/// A parsed Content-Type: the type in lower case and the parameters (names in lower case, values unquoted).
pub type ContentType = (String, Vec<(String, Vec<u16>)>);

/// content-type 1.0.5's `parse(header)`, or None where it throws.
pub fn parse_content_type(header: &[u16]) -> Option<ContentType> {
    if header.is_empty() {
        return None;
    }
    let semicolon = header.iter().position(|unit| *unit == u16::from(b';'));
    let kind = js::trim(&header[..semicolon.unwrap_or(header.len())]);
    let slash = kind.iter().position(|unit| *unit == u16::from(b'/'))?;
    if slash == 0 || slash + 1 == kind.len() || !kind[..slash].iter().all(|unit| is_token(*unit)) || !kind[slash + 1..].iter().all(|unit| is_token(*unit)) {
        return None;
    }
    let kind: String = kind.iter().map(|unit| char::from(*unit as u8).to_ascii_lowercase()).collect();
    let mut parameters = Vec::new();
    let Some(mut at) = semicolon else { return Some((kind, parameters)) };
    let spaces = |at: &mut usize| {
        while header.get(*at) == Some(&0x20) {
            *at += 1;
        }
    };
    while at < header.len() {
        if header[at] != u16::from(b';') {
            return None;
        }
        at += 1;
        spaces(&mut at);
        let start = at;
        while header.get(at).is_some_and(|unit| is_token(*unit)) {
            at += 1;
        }
        if at == start {
            return None;
        }
        let key: String = header[start..at].iter().map(|unit| char::from(*unit as u8).to_ascii_lowercase()).collect();
        spaces(&mut at);
        if header.get(at) != Some(&u16::from(b'=')) {
            return None;
        }
        at += 1;
        spaces(&mut at);
        let value = if header.get(at) == Some(&u16::from(b'"')) {
            at += 1;
            let mut value = Vec::new();
            loop {
                match header.get(at).copied() {
                    Some(0x22) => {
                        at += 1;
                        break;
                    }
                    Some(0x5c) => match header.get(at + 1).copied() {
                        Some(next) if next == 0x0b || (0x20..=0xff).contains(&next) => {
                            value.push(next);
                            at += 2;
                        }
                        _ => return None,
                    },
                    Some(unit)
                        if unit == 0x0b
                            || unit == 0x20
                            || unit == 0x21
                            || (0x23..=0x5b).contains(&unit)
                            || (0x5d..=0x7e).contains(&unit)
                            || (0x80..=0xff).contains(&unit) =>
                    {
                        value.push(unit);
                        at += 1;
                    }
                    _ => return None,
                }
            }
            value
        } else {
            let start = at;
            while header.get(at).is_some_and(|unit| is_token(*unit)) {
                at += 1;
            }
            if at == start {
                return None;
            }
            header[start..at].to_vec()
        };
        spaces(&mut at);
        match parameters.iter_mut().find(|(name, _): &&mut (String, Vec<u16>)| *name == key) {
            Some((_, existing)) => *existing = value,
            None => parameters.push((key, value)),
        }
    }
    Some((kind, parameters))
}

/// media-typer 1.1.0's `test(type)` on a type content-type already accepted (trimmed, lower case).
fn media_type_ok(kind: &str) -> bool {
    let Some((top, sub)) = kind.split_once('/') else { return false };
    let part_ok = |part: &str, extra: &[u8]| {
        (1..=127).contains(&part.len())
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || extra.contains(&byte))
    };
    part_ok(top, b"!#$&^_-") && part_ok(sub, b"!#$&^_.+-")
}

/// type-is 2.0.1 `typeis(req, [expected])` for an expected type with no wildcard.
fn type_is(headers: &Headers, expected: &str) -> bool {
    let Some(value) = headers.get("content-type").filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some((kind, _)) = parse_content_type(value) else { return false };
    media_type_ok(&kind) && kind == expected
}

/// type-is 2.0.1 `hasBody(req)`.
fn has_body(headers: &Headers) -> bool {
    if headers.get("transfer-encoding").is_some() {
        return true;
    }
    // `!isNaN(req.headers['content-length'])`: Node's parser only lets digits through (and `Number('')` is 0).
    headers.text("content-length").is_some_and(|value| {
        let trimmed = value.trim();
        trimmed.is_empty() || devryan_config_text::js::parse_decimal(trimmed).is_some()
    })
}

/// body-parser's `getCharset(req)`, lower case ("" when absent; None where the header does not parse).
fn charset(headers: &Headers) -> Option<String> {
    let value = headers.get("content-type")?;
    let (_, parameters) = parse_content_type(value)?;
    Some(
        parameters
            .iter()
            .find(|(name, _)| name == "charset")
            .map(|(_, value)| value.iter().map(|unit| char::from(*unit as u8).to_lowercase().collect::<String>()).collect())
            .unwrap_or_default(),
    )
}

/// A body's Content-Encoding, as body-parser's `contentstream` reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Identity,
    Deflate,
    Gzip,
    Brotli,
}

fn encoding_of(headers: &Headers) -> Result<Encoding, Refusal> {
    let encoding = headers
        .text("content-encoding")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "identity".to_owned())
        .to_lowercase();
    match encoding.as_str() {
        "identity" => Ok(Encoding::Identity),
        "deflate" => Ok(Encoding::Deflate),
        "gzip" => Ok(Encoding::Gzip),
        "br" if !plant::on(Plant::BrotliUnsupported) => Ok(Encoding::Brotli),
        other => refuse(415, format!("unsupported content encoding \"{other}\"")),
    }
}

/// The content stream: the body (read from `body`) inflated as its encoding says, held to `limit`. Identity
/// bodies are given whole (`Collected`), so their limit was already held while they were read.
pub fn inflate_content<R: std::io::Read>(encoding: Encoding, mut body: R, limit: usize) -> inflate::Outcome {
    use std::io::Read;
    if encoding == Encoding::Identity {
        let mut out = Vec::new();
        let read = (&mut body)
            .take(limit as u64 + 1)
            .read_to_end(&mut out)
            .and_then(|_| std::io::copy(&mut body, &mut std::io::sink()));
        return match read {
            Err(_) => inflate::Outcome::Broken,
            Ok(_) if out.len() > limit => inflate::Outcome::Refused(inflate::InflateError::TooLarge),
            Ok(_) => inflate::Outcome::Inflated(out),
        };
    }
    let mut input = inflate::Input::new(body);
    match encoding {
        Encoding::Identity | Encoding::Deflate => inflate::inflate_zlib_from(&mut input, limit),
        Encoding::Gzip => inflate::gunzip_from(&mut input, limit),
        Encoding::Brotli => inflate::brotli_from(&mut input, limit),
    }
}

/// The content of a read body as the parsers see it: the bytes, or the edge's refusal (413 or 400).
pub type Content = Result<Vec<u8>, Refusal>;

/// An inflate outcome as content (None: the request broke off, nothing is answered).
pub fn content_of(outcome: inflate::Outcome) -> Option<Content> {
    match outcome {
        inflate::Outcome::Inflated(bytes) => Some(Ok(bytes)),
        inflate::Outcome::Refused(inflate::InflateError::TooLarge) => Some(refuse(413, "request entity too large")),
        inflate::Outcome::Refused(inflate::InflateError::Malformed(why)) => Some(refuse(400, why)),
        inflate::Outcome::Broken => None,
    }
}

/// The content of an identity body of `length` bytes against `limit` (raw-body refuses a declared or counted length over it).
pub fn identity_content(bytes: Vec<u8>, over: bool) -> Content {
    if over { refuse(413, "request entity too large") } else { Ok(bytes) }
}

/// iconv-lite's canonical name of a charset.
fn canonical(charset: &str) -> String {
    let lower = charset.to_lowercase();
    let stripped = match lower.len().checked_sub(5) {
        Some(at) if lower.as_bytes()[at] == b':' && lower[at + 1..].bytes().all(|byte| byte.is_ascii_digit()) => &lower[..at],
        _ => lower.as_str(),
    };
    stripped.chars().filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit()).collect()
}

fn strip_bom(mut text: Vec<u16>) -> Vec<u16> {
    if text.first() == Some(&0xfeff) && !crate::plant::named("rv-bom-kept") {
        text.remove(0);
    }
    text
}

fn utf16(bytes: &[u8], little: bool) -> Vec<u16> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| if little { u16::from_le_bytes(*pair) } else { u16::from_be_bytes(*pair) })
        .collect()
}

fn utf32(bytes: &[u8], little: bool) -> Vec<u16> {
    let mut out = Vec::new();
    for quad in bytes.as_chunks::<4>().0 {
        let [a, b, c, d] = [i32::from(quad[0]), i32::from(quad[1]), i32::from(quad[2]), i32::from(quad[3])];
        let mut codepoint = if little {
            a | (b << 8) | (c << 16) | (d.wrapping_shl(24))
        } else {
            d | (c << 8) | (b << 16) | (a.wrapping_shl(24))
        };
        if !(0..=0x10ffff).contains(&codepoint) {
            codepoint = 0xfffd;
        }
        if codepoint >= 0x10000 {
            let value = codepoint - 0x10000;
            out.push((0xd800 | (value >> 10)) as u16);
            out.push((0xdc00 | (value & 0x3ff)) as u16);
        } else {
            out.push(codepoint as u16);
        }
    }
    out
}

fn detect_utf16(bytes: &[u8]) -> bool {
    let (mut le, mut be) = (0, 0);
    for (index, pair) in bytes.as_chunks::<2>().0.iter().take(100).enumerate() {
        if index == 0 {
            if *pair == [0xff, 0xfe] {
                return true;
            }
            if *pair == [0xfe, 0xff] {
                return false;
            }
        }
        if pair[0] == 0 && pair[1] != 0 {
            be += 1;
        }
        if pair[0] != 0 && pair[1] == 0 {
            le += 1;
        }
    }
    be <= le
}

fn detect_utf32(bytes: &[u8]) -> bool {
    let (mut invalid_le, mut invalid_be, mut bmp_le, mut bmp_be) = (0i32, 0i32, 0i32, 0i32);
    for (index, b) in bytes.as_chunks::<4>().0.iter().take(100).enumerate() {
        if index == 0 {
            if *b == [0xff, 0xfe, 0, 0] {
                return true;
            }
            if *b == [0, 0, 0xfe, 0xff] {
                return false;
            }
        }
        if b[0] != 0 || b[1] > 0x10 {
            invalid_be += 1;
        }
        if b[3] != 0 || b[2] > 0x10 {
            invalid_le += 1;
        }
        if b[0] == 0 && b[1] == 0 && (b[2] != 0 || b[3] != 0) {
            bmp_be += 1;
        }
        if (b[0] != 0 || b[1] != 0) && b[2] == 0 && b[3] == 0 {
            bmp_le += 1;
        }
    }
    bmp_be - invalid_be <= bmp_le - invalid_le
}

/// iconv-lite 0.7.2 `decode(bytes, charset)` for the charsets the parsers let through; None where iconv-lite has
/// no such encoding (the parser answers 415). UTF-7 and UTF-7-IMAP are not reproduced: refused as unknown.
pub fn decode_charset(bytes: &[u8], charset: &str) -> Option<Vec<u16>> {
    Some(match canonical(charset).as_str() {
        "utf8" | "unicode11utf8" => strip_bom(js::from_utf8(bytes)),
        "ucs2" | "utf16le" => strip_bom(utf16(bytes, true)),
        "utf16be" => strip_bom(utf16(bytes, false)),
        "utf16" => strip_bom(utf16(bytes, detect_utf16(bytes))),
        "utf32le" | "ucs4le" => strip_bom(utf32(bytes, true)),
        "utf32be" | "ucs4be" => strip_bom(utf32(bytes, false)),
        "utf32" | "ucs4" => strip_bom(utf32(bytes, detect_utf32(bytes))),
        "iso88591" | "latin1" | "l1" | "csisolatin1" | "isoir100" | "cp819" | "ibm819" => bytes.iter().map(|byte| u16::from(*byte)).collect(),
        _ => return None,
    })
}

/// Which parser reads a body, and its charset (lower case, the default given).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reader {
    Json(String),
    Form(String),
}

/// What the product's request decoding does with a request, decided from its head alone (as the parsers decide).
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// No parser reads the body: the group's handlers run at once, the body unread.
    Unread,
    /// The edge refuses before reading the body.
    Refuse(Refusal),
    /// A parser reads the body (to `limit` after decoding), then the handlers run.
    Read { limit: usize, encoding: Encoding, reader: Reader },
}

fn json_plan(headers: &Headers, limit: usize) -> Option<Plan> {
    if !has_body(headers) || !type_is(headers, "application/json") {
        return None;
    }
    let charset = charset(headers).filter(|value| !value.is_empty()).unwrap_or_else(|| "utf-8".to_owned());
    if !charset.starts_with("utf-") {
        return Some(Plan::Refuse(Refusal {
            status: 415,
            message: format!("unsupported charset \"{}\"", charset.to_uppercase()),
        }));
    }
    Some(match encoding_of(headers) {
        Ok(encoding) => Plan::Read {
            limit,
            encoding,
            reader: Reader::Json(charset),
        },
        Err(refusal) => Plan::Refuse(refusal),
    })
}

fn form_plan(headers: &Headers) -> Option<Plan> {
    if !has_body(headers) || !type_is(headers, "application/x-www-form-urlencoded") {
        return None;
    }
    let charset = charset(headers).filter(|value| !value.is_empty()).unwrap_or_else(|| "utf-8".to_owned());
    if charset != "utf-8" && charset != "iso-8859-1" {
        return Some(Plan::Refuse(Refusal {
            status: 415,
            message: format!("unsupported charset \"{}\"", charset.to_uppercase()),
        }));
    }
    Some(match encoding_of(headers) {
        Ok(encoding) => Plan::Read {
            limit: 50 * MB,
            encoding,
            reader: Reader::Form(charset),
        },
        Err(refusal) => Plan::Refuse(refusal),
    })
}

/// The plan for a request with these headers on this path.
pub fn plan(headers: &Headers, pathname: &str) -> Plan {
    if let Some(limit) = shared_json_limit(pathname) {
        if pathname.starts_with("/api/behavior") && headers.text("content-length").and_then(|value| value.trim().parse::<u64>().ok()).unwrap_or(0) > MB as u64 {
            return Plan::Refuse(Refusal {
                status: 413,
                message: "Content exceeds maximum size of 1048576 bytes".to_owned(),
            });
        }
        if let Some(plan) = json_plan(headers, limit) {
            return plan;
        }
    }
    if !is_openai_oauth_path(pathname)
        && let Some(plan) = form_plan(headers)
    {
        return plan;
    }
    Plan::Unread
}

fn parse_json<R: JsonReader>(content: &[u8], charset: &str) -> Result<Body<R::Value>, Refusal> {
    let canonical_name = canonical(charset);
    if canonical_name == "utf8" || canonical_name == "unicode11utf8" {
        // The UTF-8 path on the bytes (json::text_of_utf8 says why it is the same as decoding first).
        let bytes = content.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(content);
        let first = bytes.iter().find(|byte| !matches!(**byte, b' ' | b'\t' | b'\n' | b'\r'));
        if bytes.is_empty() {
            return Ok(Body::Json(R::empty()));
        }
        if !matches!(first, Some(b'{' | b'[')) {
            return refuse(400, "strict violation");
        }
        return match R::utf8(bytes) {
            Ok(value) => Ok(Body::Json(value)),
            Err(_) => refuse(400, "Unexpected token in JSON"),
        };
    }
    let Some(text) = decode_charset(content, charset) else {
        return refuse(415, format!("unsupported charset \"{}\"", charset.to_uppercase()));
    };
    if text.is_empty() {
        return Ok(Body::Json(R::empty()));
    }
    let first = text.iter().find(|unit| !matches!(**unit, 0x20 | 0x09 | 0x0a | 0x0d));
    if !matches!(first, Some(0x7b | 0x5b)) {
        return refuse(400, "strict violation");
    }
    match R::units(&text) {
        Ok(value) => Ok(Body::Json(value)),
        Err(_) => refuse(400, "Unexpected token in JSON"),
    }
}

/// `value?.text` when it is a string.
fn json_text(graph: &Graph, value: &Val) -> Option<Vec<u16>> {
    let Val::Ref(id) = value else { return None };
    match graph.node(*id) {
        devryan_config_text::value::Node::Object(object) => match object.get(&js::units("text")) {
            Some(Val::String(text)) => Some(text.clone()),
            _ => None,
        },
        devryan_config_text::value::Node::Array(_) => None,
    }
}

fn parse_form<J>(content: &[u8], charset: &str) -> Result<Body<J>, Refusal> {
    let text = decode_charset(content, charset).unwrap_or_default();
    if text.is_empty() {
        return Ok(Body::Form(qs::Q::Obj(crate::props::Props::new(), None)));
    }
    let Some(count) = qs::parameter_count(&text) else {
        return refuse(413, "too many parameters");
    };
    match qs::parse(&text, charset == "iso-8859-1", count.max(100)) {
        Ok(object) => Ok(Body::Form(object)),
        Err(_) => refuse(400, "The input exceeded the depth"),
    }
}

/// `req.body` once the parser has the content (or the edge's refusal), the JSON value read by `R`.
pub fn parse_with<R: JsonReader>(reader: &Reader, content: Content) -> Result<Body<R::Value>, Refusal> {
    let content = content?;
    match reader {
        Reader::Json(charset) => parse_json::<R>(&content, charset),
        Reader::Form(charset) => parse_form(&content, charset),
    }
}

/// [`parse_with`] for the first group's reader.
pub fn parse(reader: &Reader, content: Content) -> Result<Body, Refusal> {
    parse_with::<TopLevelText>(reader, content)
}

/// `req.body` after the product's request decoding of a whole body in memory, or the edge's refusal (the
/// JSON value read by `R`).
pub fn decode_with<R: JsonReader>(headers: &Headers, raw: &[u8], pathname: &str) -> Result<Body<R::Value>, Refusal> {
    match plan(headers, pathname) {
        Plan::Unread => Ok(Body::Unparsed),
        Plan::Refuse(refusal) => Err(refusal),
        Plan::Read { limit, encoding, reader } => {
            let content = if encoding == Encoding::Identity {
                identity_content(raw.to_vec(), raw.len() > limit)
            } else {
                content_of(inflate_content(encoding, raw, limit)).unwrap_or_else(|| refuse(400, "unexpected end of file"))
            };
            parse_with::<R>(&reader, content)
        }
    }
}

/// [`decode_with`] for the first group's reader.
pub fn decode(headers: &Headers, raw: &[u8], pathname: &str) -> Result<Body, Refusal> {
    decode_with::<TopLevelText>(headers, raw, pathname)
}

/// `req.body?.text` when it is a string.
pub fn text_field(body: &Body) -> Option<Vec<u16>> {
    match body {
        Body::Unparsed => None,
        Body::Json(text) => text.clone(),
        Body::Form(object) => qs::text_of(object),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        js::units(text)
    }

    #[test]
    fn content_types() {
        assert_eq!(
            parse_content_type(&units("Application/JSON; Charset=\"UTF-8\"")).unwrap(),
            ("application/json".to_owned(), vec![("charset".to_owned(), units("UTF-8"))])
        );
        assert!(parse_content_type(&units("application/json;")).is_none());
        assert!(parse_content_type(&units("application/json; charset")).is_none());
        assert!(parse_content_type(&units("application json")).is_none());
        assert!(parse_content_type(&units(" text/plain ")).is_some());
        let headers = Headers::from_pairs(&[("content-type", "application/merge-patch+json"), ("content-length", "2")]);
        assert!(!type_is(&headers, "application/json"));
    }

    #[test]
    fn limits_by_path() {
        assert_eq!(shared_json_limit("/api/magic-prompts/x"), Some(50 * MB));
        assert_eq!(shared_json_limit("/api/Magic-Prompts/x"), None);
        assert_eq!(shared_json_limit("/API/MAGIC-PROMPTS/x"), Some(50 * MB));
        assert_eq!(shared_json_limit("/api/preview/x"), Some(16 * KB));
        assert_eq!(shared_json_limit("/api/provider/OpenAI/oauth"), None);
    }

    #[test]
    fn charsets() {
        assert_eq!(decode_charset(b"\xef\xbb\xbf{}", "utf-8").unwrap(), units("{}"));
        assert_eq!(decode_charset(b"\xff\xfe{\x00}\x00", "utf-16").unwrap(), units("{}"));
        assert_eq!(decode_charset(b"\x00{\x00}", "UTF-16"), Some(units("{}")));
        assert_eq!(decode_charset(b"\xef\xbb\xbf", "iso-8859-1").unwrap().len(), 3);
        assert_eq!(decode_charset(b"{}", "utf-7"), None);
        assert_eq!(canonical("UTF-8:1234"), "utf8");
    }

    #[test]
    fn bodies() {
        let json = Headers::from_pairs(&[("content-type", "application/json"), ("content-length", "0")]);
        assert!(matches!(decode(&json, b"", "/api/magic-prompts/x").unwrap(), Body::Json(..)));
        assert_eq!(
            text_field(&decode(&json, b"{\"text\":\"a\",\"text\":\"b\"}", "/api/magic-prompts/x").unwrap()),
            Some(units("b"))
        );
        assert!(matches!(decode(&json, b"{\"text\":\"a\"}", "/api/Magic-Prompts/x").unwrap(), Body::Unparsed));
        assert_eq!(decode(&json, b"null", "/api/magic-prompts/x").unwrap_err().status, 400);
        let plain = Headers::from_pairs(&[("content-type", "text/plain"), ("content-length", "12")]);
        assert!(matches!(decode(&plain, b"{\"text\":\"a\"}", "/api/magic-prompts/x").unwrap(), Body::Unparsed));
        let form = Headers::from_pairs(&[("content-type", "application/x-www-form-urlencoded"), ("content-length", "6")]);
        assert_eq!(text_field(&decode(&form, b"text=a", "/api/Magic-Prompts/x").unwrap()), Some(units("a")));
        let latin1 = Headers::from_pairs(&[("content-type", "application/json; charset=latin1"), ("content-length", "2")]);
        assert_eq!(decode(&latin1, b"{}", "/api/magic-prompts/x").unwrap_err().status, 415);
    }
}

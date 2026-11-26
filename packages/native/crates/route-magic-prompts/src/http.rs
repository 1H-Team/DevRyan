//! HTTP/1.1 as Node's server hands a request to Express, and as Node writes
//! the answer: one request per connection (the harness always sends
//! `Connection: close`), the head parsed with httparse, `req.headers` built
//! with Node's rules (names in lower case; a repeated header that Node keeps
//! once keeps its first value, `set-cookie` is a list, `cookie` is joined with
//! `; `, every other one with `, `; values are latin1 text), the body read by
//! Content-Length or chunked coding. The answer carries the group's headers,
//! then the transport's `Date` and `Connection: close`.

use std::io::{self, Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// Node's `req.headers`: each name once, in the order first seen.
#[derive(Clone, Debug, Default)]
pub struct Headers {
    entries: Vec<(String, Vec<u16>)>,
}

/// Headers whose repeats Node drops (`matchKnownFields` in `_http_incoming`).
const KEPT_ONCE: &[&str] = &[
    "content-type",
    "content-length",
    "user-agent",
    "referer",
    "host",
    "authorization",
    "proxy-authorization",
    "if-modified-since",
    "if-unmodified-since",
    "from",
    "location",
    "max-forwards",
    "retry-after",
    "etag",
    "last-modified",
    "server",
    "age",
    "expires",
];

fn latin1(bytes: &[u8]) -> Vec<u16> {
    bytes.iter().map(|byte| u16::from(*byte)).collect()
}

impl Headers {
    /// From raw lines as sent (name, value), with Node's rules.
    pub fn from_raw(raw: &[(String, Vec<u8>)]) -> Self {
        let mut headers = Headers::default();
        for (name, value) in raw {
            let name = name.to_ascii_lowercase();
            let value = latin1(value);
            match headers.entries.iter_mut().find(|(key, _)| *key == name) {
                None => headers.entries.push((name, value)),
                Some((_, existing)) => {
                    if KEPT_ONCE.contains(&name.as_str()) {
                        continue;
                    }
                    let separator: &[u16] = if name == "cookie" { &[0x3b, 0x20] } else { &[0x2c, 0x20] };
                    existing.extend_from_slice(separator);
                    existing.extend_from_slice(&value);
                }
            }
        }
        headers
    }

    /// For tests: lower-case names and ASCII values.
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let raw: Vec<(String, Vec<u8>)> = pairs.iter().map(|(name, value)| ((*name).to_owned(), value.as_bytes().to_vec())).collect();
        Headers::from_raw(&raw)
    }

    pub fn get(&self, name: &str) -> Option<&[u16]> {
        self.entries.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_slice())
    }

    /// The value as Rust text (latin1 characters).
    pub fn text(&self, name: &str) -> Option<String> {
        self.get(name).map(|value| value.iter().map(|unit| char::from(*unit as u8)).collect())
    }
}

/// How a request's body is framed (llhttp's strict rules, as Node's server runs it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    /// No body.
    None,
    /// Content-Length bytes.
    Length(u64),
    /// Transfer-Encoding with `chunked` last.
    Chunked,
}

/// A request head as Node's server parsed it.
#[derive(Debug)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub raw_headers: Vec<(String, Vec<u8>)>,
    pub framing: Framing,
}

/// A request with its whole body (the control port's, and tests').
#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub raw_headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

/// An answer to write.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// HEAD: the headers as for GET, no body.
    pub head_only: bool,
}

/// Why no request could be read.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    /// The connection ended (or broke) before a request: nothing to answer.
    Closed,
    /// A head or body Node's parser refuses (Node answers 400 without the group).
    Malformed,
    /// A head over Node's 16 KiB (Node answers 431).
    TooLarge,
}

/// Node's `--max-http-header-size`: the bytes of the target, the header names and the header values
/// (`TrackHeader` in node_http_parser.cc) must stay below it.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;

/// What Node's parser has counted towards the header limit in an incomplete head: the target and every name
/// and value byte so far (an approximation of llhttp's spans for a head that is still arriving).
fn counted_so_far(buffer: &[u8]) -> usize {
    let mut lines = buffer.split(|byte| *byte == b'\n');
    let first = lines.next().unwrap_or_default();
    let mut parts = first.splitn(3, |byte| *byte == b' ');
    let _method = parts.next();
    let mut count = parts.next().map_or(0, <[u8]>::len);
    for line in lines {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let colon = line.iter().position(|byte| *byte == b':').unwrap_or(line.len());
        let value = line.get(colon + 1..).unwrap_or_default();
        let leading = value.iter().take_while(|byte| matches!(byte, b' ' | b'\t')).count();
        count += colon + value.len() - leading;
    }
    count
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

/// The framing of a parsed head, with llhttp's strict refusals: a Content-Length that is not all digits, too
/// large, or given twice; Content-Length together with Transfer-Encoding; a Transfer-Encoding whose last coding
/// is not `chunked`, or that names `chunked` before the last.
fn framing_of(raw: &[(String, Vec<u8>)]) -> Result<Framing, ReadError> {
    let lengths: Vec<&Vec<u8>> = raw
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value)
        .collect();
    let codings: Vec<&Vec<u8>> = raw
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
        .map(|(_, value)| value)
        .collect();
    if !codings.is_empty() {
        if !lengths.is_empty() {
            return Err(ReadError::Malformed);
        }
        let joined: Vec<String> = codings
            .iter()
            .flat_map(|value| {
                value
                    .split(|byte| *byte == b',')
                    .map(|part| String::from_utf8_lossy(part).trim().to_ascii_lowercase())
                    .collect::<Vec<_>>()
            })
            .collect();
        let chunked_at: Vec<usize> = joined
            .iter()
            .enumerate()
            .filter(|(_, coding)| *coding == "chunked")
            .map(|(index, _)| index)
            .collect();
        return match chunked_at.as_slice() {
            [last] if *last + 1 == joined.len() => Ok(Framing::Chunked),
            _ => Err(ReadError::Malformed),
        };
    }
    match lengths.as_slice() {
        [] => Ok(Framing::None),
        [value] => {
            if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
                return Err(ReadError::Malformed);
            }
            let mut length: u64 = 0;
            for digit in value.iter() {
                length = length
                    .checked_mul(10)
                    .and_then(|tens| tens.checked_add(u64::from(digit - b'0')))
                    .ok_or(ReadError::Malformed)?;
            }
            Ok(if length == 0 { Framing::Length(0) } else { Framing::Length(length) })
        }
        _ => Err(ReadError::Malformed),
    }
}

/// One complete request head at the start of `buffer` and its length, `Ok(None)` while more bytes are needed.
pub fn parse_head(buffer: &[u8]) -> Result<Option<(Head, usize)>, ReadError> {
    let mut slots = [httparse::EMPTY_HEADER; 256];
    let mut parsed = httparse::Request::new(&mut slots);
    let head_length = match parsed.parse(buffer) {
        Ok(httparse::Status::Complete(length)) => length,
        Ok(httparse::Status::Partial) if counted_so_far(buffer) >= MAX_HEADER_BYTES => return Err(ReadError::TooLarge),
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(httparse::Error::TooManyHeaders) => return Err(ReadError::TooLarge),
        Err(_) => return Err(ReadError::Malformed),
    };
    let method = parsed.method.unwrap_or_default().to_owned();
    let target = parsed.path.unwrap_or_default().to_owned();
    let mut counted = target.len();
    let raw_headers: Vec<(String, Vec<u8>)> = parsed
        .headers
        .iter()
        .map(|header| {
            let value = header.value;
            let start = value.iter().position(|byte| *byte != b' ' && *byte != b'\t').unwrap_or(value.len());
            let end = value.iter().rposition(|byte| *byte != b' ' && *byte != b'\t').map_or(start, |index| index + 1);
            counted += header.name.len() + value.len() - start;
            (header.name.to_owned(), value[start..end.max(start)].to_vec())
        })
        .collect();
    if counted >= MAX_HEADER_BYTES {
        return Err(ReadError::TooLarge);
    }
    let framing = framing_of(&raw_headers)?;
    Ok(Some((
        Head {
            method,
            target,
            raw_headers,
            framing,
        },
        head_length,
    )))
}

/// The body of a framed request, decoded as its bytes arrive (fed in any pieces): Content-Length counted
/// down, or chunked coding with llhttp's strict syntax (hex sizes that fit in 64 bits, optional extensions,
/// CRLF after each chunk, trailers up to an empty line). Sizes are u64 and every step is checked arithmetic.
#[derive(Debug)]
pub struct BodyDecoder {
    state: BodyState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyState {
    Length(u64),
    Size { size: u64, digits: u32 },
    Extension { size: u64 },
    SizeLf { size: u64 },
    Data(u64),
    DataCr,
    DataLf,
    TrailerStart,
    TrailerLine,
    TrailerLf { empty: bool },
    Done,
}

impl BodyDecoder {
    pub fn new(framing: Framing) -> Self {
        BodyDecoder {
            state: match framing {
                Framing::None | Framing::Length(0) => BodyState::Done,
                Framing::Length(length) => BodyState::Length(length),
                Framing::Chunked => BodyState::Size { size: 0, digits: 0 },
            },
        }
    }

    pub fn done(&self) -> bool {
        self.state == BodyState::Done
    }

    /// Takes `input`, handing each piece of body to `sink`; returns how many bytes belonged to the request
    /// (the rest, after the end of the body, is not the request's).
    pub fn feed(&mut self, input: &[u8], sink: &mut impl FnMut(&[u8])) -> Result<usize, ReadError> {
        let mut at = 0;
        while at < input.len() {
            match self.state {
                BodyState::Done => return Ok(at),
                BodyState::Length(left) | BodyState::Data(left) => {
                    let available = (input.len() - at) as u64;
                    let take = left.min(available) as usize;
                    sink(&input[at..at + take]);
                    at += take;
                    let left = left - take as u64;
                    self.state = match self.state {
                        BodyState::Length(_) if left == 0 => BodyState::Done,
                        BodyState::Length(_) => BodyState::Length(left),
                        _ if left == 0 => BodyState::DataCr,
                        _ => BodyState::Data(left),
                    };
                }
                BodyState::Size { size, digits } => {
                    let byte = input[at];
                    at += 1;
                    if is_hex(byte) {
                        let digit = u64::from(char::from(byte).to_digit(16).unwrap_or(0));
                        // A size that does not fit in 64 bits: llhttp's "Chunk size overflow".
                        let next = size.checked_mul(16).and_then(|value| value.checked_add(digit)).ok_or(ReadError::Malformed)?;
                        self.state = BodyState::Size {
                            size: next,
                            digits: digits + 1,
                        };
                    } else if digits == 0 {
                        return Err(ReadError::Malformed);
                    } else if byte == b';' {
                        self.state = BodyState::Extension { size };
                    } else if byte == b'\r' {
                        self.state = BodyState::SizeLf { size };
                    } else {
                        return Err(ReadError::Malformed);
                    }
                }
                BodyState::Extension { size } => {
                    let byte = input[at];
                    at += 1;
                    if byte == b'\r' {
                        self.state = BodyState::SizeLf { size };
                    } else if byte == b'\n' || (byte < 0x20 && byte != b'\t') || byte == 0x7f {
                        return Err(ReadError::Malformed);
                    }
                }
                BodyState::SizeLf { size } => {
                    if input[at] != b'\n' {
                        return Err(ReadError::Malformed);
                    }
                    at += 1;
                    self.state = if size == 0 { BodyState::TrailerStart } else { BodyState::Data(size) };
                }
                BodyState::DataCr => {
                    if input[at] != b'\r' {
                        return Err(ReadError::Malformed);
                    }
                    at += 1;
                    self.state = BodyState::DataLf;
                }
                BodyState::DataLf => {
                    if input[at] != b'\n' {
                        return Err(ReadError::Malformed);
                    }
                    at += 1;
                    self.state = BodyState::Size { size: 0, digits: 0 };
                }
                BodyState::TrailerStart => {
                    let byte = input[at];
                    at += 1;
                    self.state = if byte == b'\r' {
                        BodyState::TrailerLf { empty: true }
                    } else if byte == b'\n' {
                        return Err(ReadError::Malformed);
                    } else {
                        BodyState::TrailerLine
                    };
                }
                BodyState::TrailerLine => {
                    let byte = input[at];
                    at += 1;
                    if byte == b'\r' {
                        self.state = BodyState::TrailerLf { empty: false };
                    } else if byte == b'\n' {
                        return Err(ReadError::Malformed);
                    }
                }
                BodyState::TrailerLf { empty } => {
                    if input[at] != b'\n' {
                        return Err(ReadError::Malformed);
                    }
                    at += 1;
                    self.state = if empty { BodyState::Done } else { BodyState::TrailerStart };
                }
            }
        }
        Ok(at)
    }
}

/// Parses one complete request (head and body) at the start of `buffer`; `Ok(None)` while more is needed.
pub fn parse_request(buffer: &[u8]) -> Result<Option<Request>, ReadError> {
    let Some((head, head_length)) = parse_head(buffer)? else { return Ok(None) };
    let mut decoder = BodyDecoder::new(head.framing);
    let mut body = Vec::new();
    decoder.feed(&buffer[head_length..], &mut |piece| body.extend_from_slice(piece))?;
    if !decoder.done() {
        return Ok(None);
    }
    Ok(Some(Request {
        method: head.method,
        target: head.target,
        raw_headers: head.raw_headers,
        body,
    }))
}

/// Reads one request (head and body, the body at most `limit` bytes) from a blocking `stream`.
pub fn read_request(stream: &mut impl Read, limit: usize) -> Result<Request, ReadError> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if let Some(request) = parse_request(&buffer)? {
            return Ok(request);
        }
        if buffer.len() > MAX_HEADER_BYTES + limit {
            return Err(ReadError::TooLarge);
        }
        match stream.read(&mut chunk) {
            Ok(0) if buffer.is_empty() => return Err(ReadError::Closed),
            Ok(0) => return Err(ReadError::Malformed),
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ReadError::Closed),
        }
    }
}

/// Node's reason phrase (`http.STATUS_CODES`) for the statuses the candidate writes.
pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

/// The IMF-fixdate of now, as Node's `Date` header writes it.
pub fn http_date(now: SystemTime) -> String {
    let seconds = now.duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0) as i64;
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let day_of_year = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WEEKDAYS[days.rem_euclid(7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// Writes `response` with the transport's headers (`Date`, `Connection: close`) after the group's.
pub fn write_response(stream: &mut impl Write, response: &Response, extra: &[(String, String)]) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, reason(response.status));
    for (name, value) in response.headers.iter().chain(extra) {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str(&format!("Date: {}\r\nConnection: close\r\n\r\n", http_date(SystemTime::now())));
    let mut bytes = head.into_bytes();
    if !response.head_only {
        bytes.extend_from_slice(&response.body);
    }
    stream.write_all(&bytes)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn node_header_rules() {
        let headers = Headers::from_pairs(&[
            ("Content-Type", "a"),
            ("content-type", "b"),
            ("If-None-Match", "x"),
            ("if-none-match", "y"),
            ("Cookie", "c=1"),
            ("cookie", "d=2"),
        ]);
        assert_eq!(headers.text("content-type").as_deref(), Some("a"));
        assert_eq!(headers.text("if-none-match").as_deref(), Some("x, y"));
        assert_eq!(headers.text("cookie").as_deref(), Some("c=1; d=2"));
    }

    #[test]
    fn reads_bodies() {
        let mut wire: &[u8] = b"PUT /x HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabcEXTRA";
        let request = read_request(&mut wire, 100).unwrap();
        assert_eq!(
            (request.method.as_str(), request.target.as_str(), request.body.as_slice()),
            ("PUT", "/x", b"abc".as_slice())
        );
        let mut wire: &[u8] = b"PUT /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\nT: 1\r\n\r\n";
        assert_eq!(read_request(&mut wire, 100).unwrap().body, b"abcde");
        let mut idle: &[u8] = b"";
        assert!(matches!(read_request(&mut idle, 100), Err(ReadError::Closed)));
    }

    #[test]
    fn strict_framing_as_node() {
        let head = |extra: &str| format!("PUT /x HTTP/1.1\r\nHost: h\r\n{extra}\r\n");
        let refused = |text: &str| matches!(parse_request(text.as_bytes()), Err(ReadError::Malformed));
        // Node: 400 for each (scratchpad probe of fix round 1).
        for extra in [
            "Content-Length: +1\r\n",
            "Content-Length: 1, 1\r\n",
            "Content-Length: 1\r\nContent-Length: 1\r\n",
            "Content-Length: -1\r\n",
            "Content-Length: 18446744073709551616\r\n",
            "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n",
            "Transfer-Encoding: chunked, gzip\r\n",
            "Transfer-Encoding: identity\r\n",
        ] {
            assert!(refused(&format!("{}x", head(extra))), "{extra}");
        }
        let chunked = head("Transfer-Encoding: chunked\r\n");
        for body in ["c \r\n", "\r\n", "g\r\n", "1\r\nxYY", "10000000000000000\r\n"] {
            assert!(refused(&format!("{chunked}{body}")), "{body:?}");
        }
        // A size that fits in 64 bits waits for its data (Node waits too), with no overflow anywhere.
        for size in ["fffffffffffffffe", "ffffffffffffffff", "0fffffffffffffffe", "7fffffffffffffff"] {
            assert!(
                matches!(
                    parse_request(format!("{chunked}{size}\r\n{{\"text\":\"x\"}}\r\n0\r\n\r\n").as_bytes()),
                    Ok(None)
                ),
                "{size}"
            );
        }
        assert!(matches!(
            parse_request(format!("{}x", head("Content-Length: 18446744073709551615\r\n")).as_bytes()),
            Ok(None)
        ));
        let accepted = |text: &str| parse_request(text.as_bytes()).ok().flatten().map(|request| request.body);
        assert_eq!(
            accepted(&format!("{}c\r\n{{\"text\":\"x\"}}\r\n0\r\n\r\n", head("Transfer-Encoding: gzip, chunked\r\n"))).as_deref(),
            Some(b"{\"text\":\"x\"}".as_slice())
        );
        assert_eq!(
            accepted(&format!("{}1\r\nx\r\n0\r\n\r\n", head("Transfer-Encoding: CHUNKED\r\n"))).as_deref(),
            Some(b"x".as_slice())
        );
    }

    #[test]
    fn header_limit_as_node() {
        // Node: 200 when the target, names and values hold 16 383 bytes, 431 at 16 384 (scratchpad probe).
        let request = |pad: usize| format!("GET /x HTTP/1.1\r\nHost: h\r\nX-Pad: {}\r\n\r\n", "p".repeat(pad));
        let fixed = "/x".len() + "Host".len() + 1 + "X-Pad".len();
        assert!(parse_request(request(MAX_HEADER_BYTES - 1 - fixed).as_bytes()).unwrap().is_some());
        assert_eq!(parse_request(request(MAX_HEADER_BYTES - fixed).as_bytes()).unwrap_err(), ReadError::TooLarge);
        let partial = format!("GET /x HTTP/1.1\r\nX-Pad: {}", "p".repeat(MAX_HEADER_BYTES));
        assert_eq!(parse_request(partial.as_bytes()).unwrap_err(), ReadError::TooLarge);
    }

    #[test]
    fn dates() {
        assert_eq!(http_date(UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(UNIX_EPOCH + Duration::from_secs(1_795_000_000)), "Wed, 18 Nov 2026 11:06:40 GMT");
        assert_eq!(http_date(UNIX_EPOCH + Duration::from_secs(951_782_400)), "Tue, 29 Feb 2000 00:00:00 GMT");
    }
}

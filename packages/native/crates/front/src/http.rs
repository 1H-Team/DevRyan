//! HTTP/1.1 response framing for the supervisor's health probe
//! (`supervise::probe`). The proxy never uses this: it forwards bytes unparsed.

pub type Headers = Vec<(String, String)>;

const MAX_HEADERS: usize = 256;

/// A parsed response head.
#[derive(Clone, Debug, Default)]
pub struct Head {
    pub status: u16,
    pub headers: Headers,
}

fn collect_headers(raw: &[httparse::Header<'_>]) -> Headers {
    raw.iter()
        .map(|header| (header.name.to_string(), String::from_utf8_lossy(header.value).into_owned()))
        .collect()
}

/// `Ok(None)` while the head is incomplete; `Ok(Some((length, head)))` once it is.
pub fn parse_response_head(buffer: &[u8]) -> Result<Option<(usize, Head)>, String> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut response = httparse::Response::new(&mut headers);
    match response.parse(buffer) {
        Ok(httparse::Status::Partial) => Ok(None),
        Ok(httparse::Status::Complete(length)) => Ok(Some((
            length,
            Head {
                status: response.code.unwrap_or_default(),
                headers: collect_headers(response.headers),
            },
        ))),
        Err(error) => Err(format!("response head: {error}")),
    }
}

/// The first value of header `name` (case-insensitive).
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Fixed(u64),
    Chunked,
    UntilClose,
}

fn content_length(headers: &[(String, String)]) -> Option<u64> {
    header(headers, "content-length").and_then(|value| value.trim().parse().ok())
}

fn is_chunked(headers: &[(String, String)]) -> bool {
    headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|(_, value)| value.split(','))
        .map(str::trim)
        .next_back()
        .is_some_and(|coding| coding.eq_ignore_ascii_case("chunked"))
}

/// RFC 9112 section 6.3 for a final response to `method`.
pub fn response_body(method: &str, head: &Head) -> BodyKind {
    if method.eq_ignore_ascii_case("HEAD") || head.status == 204 || head.status == 304 || head.status < 200 {
        return BodyKind::None;
    }
    if method.eq_ignore_ascii_case("CONNECT") && (200..300).contains(&head.status) {
        return BodyKind::UntilClose;
    }
    if is_chunked(&head.headers) {
        return BodyKind::Chunked;
    }
    match content_length(&head.headers) {
        Some(0) => BodyKind::None,
        Some(length) => BodyKind::Fixed(length),
        None => BodyKind::UntilClose,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ChunkState {
    Size,
    Extension,
    SizeLf,
    Data(u64),
    DataCr,
    DataLf,
    TrailerLine,
    Done,
}

/// An incremental decoder for `Transfer-Encoding: chunked`.
#[derive(Debug)]
pub struct ChunkDecoder {
    state: ChunkState,
    size: u64,
    digits: usize,
    line: Vec<u8>,
    pub trailers: Headers,
}

impl Default for ChunkDecoder {
    fn default() -> Self {
        Self {
            state: ChunkState::Size,
            size: 0,
            digits: 0,
            line: Vec::new(),
            trailers: Vec::new(),
        }
    }
}

impl ChunkDecoder {
    pub fn done(&self) -> bool {
        self.state == ChunkState::Done
    }

    /// Decodes from `input` into `output`; returns how many input bytes it
    /// consumed. It stops at the end of the message, leaving the rest.
    pub fn feed(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<usize, String> {
        let mut index = 0;
        while index < input.len() && self.state != ChunkState::Done {
            let byte = input[index];
            match self.state {
                ChunkState::Size => {
                    match byte {
                        b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F' => {
                            let digit = (byte as char).to_digit(16).unwrap_or(0) as u64;
                            self.digits += 1;
                            if self.digits > 16 {
                                return Err("chunk size too long".into());
                            }
                            self.size = self.size * 16 + digit;
                        }
                        b';' | b' ' | b'\t' => self.state = ChunkState::Extension,
                        b'\r' => self.state = ChunkState::SizeLf,
                        b'\n' => self.end_size_line(),
                        _ => return Err("bad chunk size byte".into()),
                    }
                    index += 1;
                }
                ChunkState::Extension => {
                    if byte == b'\r' {
                        self.state = ChunkState::SizeLf;
                    } else if byte == b'\n' {
                        self.end_size_line();
                    }
                    index += 1;
                }
                ChunkState::SizeLf => {
                    if byte != b'\n' {
                        return Err("chunk size line without LF".into());
                    }
                    self.end_size_line();
                    index += 1;
                }
                ChunkState::Data(remaining) => {
                    let take = remaining.min((input.len() - index) as u64) as usize;
                    output.extend_from_slice(&input[index..index + take]);
                    index += take;
                    let left = remaining - take as u64;
                    self.state = if left == 0 { ChunkState::DataCr } else { ChunkState::Data(left) };
                }
                ChunkState::DataCr => {
                    self.state = match byte {
                        b'\r' => ChunkState::DataLf,
                        b'\n' => ChunkState::Size,
                        _ => return Err("chunk data without CRLF".into()),
                    };
                    index += 1;
                }
                ChunkState::DataLf => {
                    if byte != b'\n' {
                        return Err("chunk data without LF".into());
                    }
                    self.state = ChunkState::Size;
                    index += 1;
                }
                ChunkState::TrailerLine => {
                    index += 1;
                    if byte == b'\n' {
                        let line = std::mem::take(&mut self.line);
                        let line = line.strip_suffix(b"\r").unwrap_or(&line);
                        if line.is_empty() {
                            self.state = ChunkState::Done;
                        } else if let Some(colon) = line.iter().position(|&b| b == b':') {
                            self.trailers.push((
                                String::from_utf8_lossy(&line[..colon]).trim().to_string(),
                                String::from_utf8_lossy(&line[colon + 1..]).trim().to_string(),
                            ));
                        }
                    } else {
                        self.line.push(byte);
                        if self.line.len() > 64 * 1024 {
                            return Err("trailer line too long".into());
                        }
                    }
                }
                ChunkState::Done => {}
            }
        }
        Ok(index)
    }

    fn end_size_line(&mut self) {
        // An empty size line is malformed; it is read as the last chunk so a
        // broken peer cannot stall the probe (forwarding never depends on it).
        if self.digits == 0 || self.size == 0 {
            self.state = ChunkState::TrailerLine;
        } else {
            self.state = ChunkState::Data(self.size);
        }
        self.size = 0;
        self.digits = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_decoding_stops_at_the_end_of_the_message() {
        let mut decoder = ChunkDecoder::default();
        let mut output = Vec::new();
        let input = b"5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: yes\r\n\r\nNEXT";
        let consumed = decoder.feed(input, &mut output).unwrap();
        assert_eq!(output, b"hello world");
        assert!(decoder.done());
        assert_eq!(&input[consumed..], b"NEXT");
        assert_eq!(decoder.trailers, vec![("X-Trailer".to_string(), "yes".to_string())]);
    }

    #[test]
    fn chunked_decoding_accepts_one_byte_at_a_time() {
        let input = b"3\r\nabc\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n";
        let mut decoder = ChunkDecoder::default();
        let mut output = Vec::new();
        for byte in input {
            decoder.feed(std::slice::from_ref(byte), &mut output).unwrap();
        }
        assert!(decoder.done());
        assert_eq!(output, b"abc0123456789abcdef");
    }

    #[test]
    fn response_framing_follows_the_method_and_status() {
        let head = |status: u16, headers: &[(&str, &str)]| Head {
            status,
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        };
        assert_eq!(response_body("HEAD", &head(200, &[("Content-Length", "10")])), BodyKind::None);
        assert_eq!(response_body("GET", &head(204, &[])), BodyKind::None);
        assert_eq!(response_body("GET", &head(304, &[("Content-Length", "10")])), BodyKind::None);
        assert_eq!(response_body("GET", &head(200, &[("Transfer-Encoding", "gzip, chunked")])), BodyKind::Chunked);
        assert_eq!(response_body("GET", &head(200, &[])), BodyKind::UntilClose);
        assert_eq!(response_body("GET", &head(200, &[("content-length", "7")])), BodyKind::Fixed(7));
    }
}

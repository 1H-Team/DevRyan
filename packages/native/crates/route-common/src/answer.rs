//! What Express 5.2.1 writes for the group's `res.json(value)` and
//! `res.status(n).json(value)`: `Content-Type: application/json;
//! charset=utf-8`, `Content-Length`, a weak ETag (etag 1.8.1: the length in
//! hex and the first 27 characters of the body's SHA-1 in base64), then the
//! freshness test of a GET or HEAD (fresh 2.0.0: 304 without Content-Type,
//! Content-Length or body), and no body for HEAD. No `X-Powered-By` (off in
//! the candidate's composition) and no `Vary` (the edge's).

use crate::http::{Headers, Response};
use crate::plant::{self, Plant};

/// SHA-1 of `data` (Express's ETag hashes every answer body, which can hold 200 000-character prompts): the
/// ARMv8 SHA-1 instructions where the build has them, the portable rounds otherwise (tests compare the two).
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
    let (blocks, rest) = data.as_chunks::<64>();
    compress(&mut state, blocks);
    // The padding: 0x80, zeros, the length in bits (one block or two).
    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let used = if rest.len() < 56 { 64 } else { 128 };
    tail[used - 8..used].copy_from_slice(&(data.len() as u64).wrapping_mul(8).to_be_bytes());
    compress(&mut state, tail[..used].as_chunks::<64>().0);
    let mut out = [0u8; 20];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn compress(state: &mut [u32; 5], blocks: &[[u8; 64]]) {
    #[cfg(all(target_arch = "aarch64", target_feature = "sha2"))]
    {
        compress_arm(state, blocks);
    }
    #[cfg(not(all(target_arch = "aarch64", target_feature = "sha2")))]
    {
        compress_portable(state, blocks);
    }
}

#[cfg_attr(all(target_arch = "aarch64", target_feature = "sha2"), allow(dead_code))]
fn compress_portable(state: &mut [u32; 5], blocks: &[[u8; 64]]) {
    for block in blocks {
        let mut w = [0u32; 80];
        for (index, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[index] = u32::from_be_bytes(*word);
        }
        for index in 16..80 {
            w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = *state;
        for (index, word) in w.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | (!b & d), 0x5a82_7999),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }
}

/// Twenty groups of four rounds with SHA1C, SHA1P, SHA1M, SHA1P; the schedule four words at a time
/// (group n + 4 = SHA1SU1(SHA1SU0(n, n + 1, n + 2), n + 3)).
#[cfg(all(target_arch = "aarch64", target_feature = "sha2"))]
fn compress_arm(state: &mut [u32; 5], blocks: &[[u8; 64]]) {
    use std::arch::aarch64::{
        vaddq_u32, vdupq_n_u32, vgetq_lane_u32, vld1q_u32, vsha1cq_u32, vsha1h_u32, vsha1mq_u32, vsha1pq_u32, vsha1su0q_u32, vsha1su1q_u32, vst1q_u32,
    };
    const K: [u32; 4] = [0x5a82_7999, 0x6ed9_eba1, 0x8f1b_bcdc, 0xca62_c1d6];
    let first = [state[0], state[1], state[2], state[3]];
    // SAFETY: the `sha2` target feature (the SHA-1 instructions) is enabled for this build (the cfg above); every
    // load reads four u32 from a local array and the store writes four into one.
    unsafe {
        let mut abcd = vld1q_u32(first.as_ptr());
        let mut e0 = state[4];
        for block in blocks {
            let (saved_abcd, saved_e) = (abcd, e0);
            let mut msg = [vdupq_n_u32(0); 4];
            for (group, slot) in msg.iter_mut().enumerate() {
                let words: [u32; 4] = std::array::from_fn(|index| {
                    let at = group * 16 + index * 4;
                    u32::from_be_bytes([block[at], block[at + 1], block[at + 2], block[at + 3]])
                });
                *slot = vld1q_u32(words.as_ptr());
            }
            let mut e = e0;
            for group in 0..20 {
                let wk = vaddq_u32(msg[group % 4], vdupq_n_u32(K[group / 5]));
                let next_e = vsha1h_u32(vgetq_lane_u32::<0>(abcd));
                abcd = match group / 5 {
                    0 => vsha1cq_u32(abcd, e, wk),
                    2 => vsha1mq_u32(abcd, e, wk),
                    _ => vsha1pq_u32(abcd, e, wk),
                };
                e = next_e;
                if group < 16 {
                    msg[group % 4] = vsha1su1q_u32(vsha1su0q_u32(msg[group % 4], msg[(group + 1) % 4], msg[(group + 2) % 4]), msg[(group + 3) % 4]);
                }
            }
            abcd = vaddq_u32(abcd, saved_abcd);
            e0 = e.wrapping_add(saved_e);
        }
        let mut out = [0u32; 4];
        vst1q_u32(out.as_mut_ptr(), abcd);
        state[..4].copy_from_slice(&out);
        state[4] = e0;
    }
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 with padding (`buffer.toString('base64')`).
pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let value = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[((value >> (18 - 6 * index)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `Buffer.from(text, 'base64')`: lenient, as Node is (characters outside the alphabet are skipped, `-` and `_` read as `+` and `/`, decoding stops at `=`).
pub fn base64_decode(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut count = 0;
    for byte in text {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(value);
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(buffer >> 16) as u8, (buffer >> 8) as u8, buffer as u8]);
            buffer = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((buffer >> 4) as u8),
        3 => out.extend_from_slice(&[(buffer >> 10) as u8, (buffer >> 2) as u8]),
        _ => {}
    }
    out
}

/// Express's default ETag of a body: `W/"<length in hex>-<27 characters of base64 SHA-1>"`.
pub fn weak_etag(body: &[u8]) -> String {
    if body.is_empty() {
        return "W/\"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk\"".to_owned();
    }
    let hash = base64(&sha1(body));
    format!("W/\"{:x}-{}\"", body.len(), &hash[..27])
}

/// fresh 2.0.0's token list of If-None-Match.
fn token_list(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let (mut start, mut end) = (0, 0);
    let mut list = Vec::new();
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b' ' => {
                if start == end {
                    start = index + 1;
                    end = index + 1;
                }
            }
            b',' => {
                list.push(&text[start..end]);
                start = index + 1;
                end = index + 1;
            }
            _ => end = index + 1,
        }
    }
    list.push(&text[start..end]);
    list
}

/// `/(?:^|,)\s*?no-cache\s*?(?:,|$)/` on Cache-Control.
fn says_no_cache(text: &[u16]) -> bool {
    let no_cache: Vec<u16> = "no-cache".encode_utf16().collect();
    text.split(|unit| *unit == u16::from(b','))
        .any(|part| devryan_config_text::js::trim(part) == no_cache.as_slice())
}

/// fresh(req.headers, { etag, 'last-modified': undefined }).
pub fn fresh(headers: &Headers, etag: &str) -> bool {
    let modified_since = headers.get("if-modified-since").filter(|value| !value.is_empty());
    let none_match = headers.get("if-none-match").filter(|value| !value.is_empty());
    if modified_since.is_none() && none_match.is_none() {
        return false;
    }
    if headers.get("cache-control").is_some_and(|value| !value.is_empty() && says_no_cache(value)) {
        return false;
    }
    let Some(none_match) = none_match else {
        // If-Modified-Since alone: the group sets no Last-Modified, so the answer is stale.
        return false;
    };
    let none_match = String::from_utf16_lossy(none_match);
    if none_match == "*" {
        return true;
    }
    token_list(&none_match)
        .iter()
        .any(|token| *token == etag || format!("W/{etag}") == *token || format!("W/{token}") == etag)
}

/// `res.status(status).json(...)` of a JSON text already made (UTF-8 bytes).
pub fn json(method: &str, request: &Headers, status: u16, body: Vec<u8>) -> Response {
    let etag = weak_etag(&body);
    let mut status = status;
    if !plant::on(Plant::NeverNotModified) && (method == "GET" || method == "HEAD") && ((200..300).contains(&status) || status == 304) && fresh(request, &etag)
    {
        status = 304;
    }
    let content_type = if plant::on(Plant::ContentTypeNoCharset) {
        "application/json"
    } else {
        "application/json; charset=utf-8"
    };
    let length = if plant::on(Plant::ContentLengthOffByOne) {
        body.len() + 1
    } else {
        body.len()
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    if plant::on(Plant::ExtraHeader) {
        headers.push(("X-Powered-By".to_owned(), "Express".to_owned()));
    }
    if plant::on(Plant::HeadersReordered) {
        headers.push(("ETag".to_owned(), etag.clone()));
    }
    headers.push(("Content-Type".to_owned(), content_type.to_owned()));
    headers.push(("Content-Length".to_owned(), length.to_string()));
    if !plant::on(Plant::EtagDropped) && !plant::on(Plant::HeadersReordered) {
        headers.push(("ETag".to_owned(), etag));
    }
    let mut body = body;
    if status == 304 {
        headers.retain(|(name, _)| name != "Content-Type" && name != "Content-Length");
        body.clear();
    }
    let head_only = method == "HEAD" && !plant::on(Plant::HeadWithBody);
    Response {
        status,
        headers,
        body,
        head_only,
    }
}

/// The JSON text of `{ error: message }`.
pub fn error_body(message: &str) -> Vec<u8> {
    let units: Vec<u16> = message.encode_utf16().collect();
    let mut out: Vec<u16> = "{\"error\":".encode_utf16().collect();
    devryan_config_text::js::push_json_string(&mut out, &units);
    out.push(u16::from(b'}'));
    devryan_config_text::js::to_utf8(&out)
}

/// Express's final handler page (finalhandler 2.1.1), for what the group does not answer (no body for HEAD,
/// as Node's server writes none).
pub fn page(method: &str, status: u16, message: &str) -> Response {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{escaped}</pre>\n</body>\n</html>\n"
    )
    .into_bytes();
    Response {
        status,
        headers: vec![
            ("Content-Security-Policy".to_owned(), "default-src 'none'".to_owned()),
            ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
            ("Content-Type".to_owned(), "text/html; charset=utf-8".to_owned()),
            ("Content-Length".to_owned(), body.len().to_string()),
        ],
        body,
        head_only: method == "HEAD",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_and_tags() {
        let hex: String = sha1(b"abc").iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(base64(b"any carnal pleas"), "YW55IGNhcm5hbCBwbGVhcw==");
        assert_eq!(base64_decode(b"YW55IGNhcm5hbCBwbGVhcw=="), b"any carnal pleas");
        assert_eq!(base64_decode(b"YW5 5\nIGNhcm5hbCBwbGVhcw"), b"any carnal pleas");
        // Express's ETag of the empty state (node: etag('{"version":1,"overrides":{}}', { weak: true })).
        assert_eq!(weak_etag(b"{\"version\":1,\"overrides\":{}}"), "W/\"1c-6Aa9gYo6XdlCcEbGlu1hyPIy8Xs\"");
    }

    #[test]
    fn sha1_paths_agree() {
        for length in [0usize, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 200_003] {
            let data: Vec<u8> = (0..length).map(|index| (index * 31 + 7) as u8).collect();
            let mut portable: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
            let mut fast = portable;
            let blocks = data.as_chunks::<64>().0;
            compress_portable(&mut portable, blocks);
            compress(&mut fast, blocks);
            assert_eq!(portable, fast, "{length}");
        }
        let hex = |bytes: [u8; 20]| bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(sha1(&[b'a'; 1_000_000])), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
        assert_eq!(
            hex(sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn freshness() {
        let etag = "W/\"1c-abc\"";
        let headers = |pairs: &[(&str, &str)]| Headers::from_pairs(pairs);
        assert!(fresh(&headers(&[("if-none-match", etag)]), etag));
        assert!(fresh(&headers(&[("if-none-match", "\"x\", W/\"1c-abc\"")]), etag));
        assert!(fresh(&headers(&[("if-none-match", "\"1c-abc\"")]), etag));
        assert!(fresh(&headers(&[("if-none-match", "*")]), etag));
        assert!(!fresh(&headers(&[("if-none-match", etag), ("cache-control", "max-age=0, no-cache")]), etag));
        assert!(fresh(&headers(&[("if-none-match", etag), ("cache-control", "no-cache-x")]), etag));
        assert!(!fresh(&headers(&[("if-modified-since", "Tue, 01 Jan 2030 00:00:00 GMT")]), etag));
        assert!(!fresh(&headers(&[("if-none-match", "W/\"other\"")]), etag));
    }
}

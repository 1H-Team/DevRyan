//! Scalar values of yaml 2.9.0: `resolve-flow-scalar.js`,
//! `resolve-block-scalar.js`, and the core schema's scalar tags
//! (`schema/core/*.js`, `schema/common/*.js`).

use super::cst::{SourceToken, Token, Ty};
use crate::js;

/// A position as `getErrorPos` receives it.
#[derive(Clone, Copy, Debug)]
pub enum At {
    /// A number: `[n, n + 1]`.
    Offset(usize),
    /// A range: `[start, end]`.
    Range(usize, usize),
}

/// A composition error or warning before it is prettified.
#[derive(Clone, Debug)]
pub struct Problem {
    pub start: usize,
    pub end: usize,
    pub code: &'static str,
    pub message: Vec<u16>,
}

/// `onError(source, code, message, warning)`.
pub type OnError<'a> = dyn FnMut(At, &'static str, String, bool) + 'a;

/// `getErrorPos(token)` for a CST token.
pub fn token_at(token: &Token) -> At {
    let offset = token.offset();
    match token.source() {
        Some(source) => At::Range(offset, offset + source.len()),
        None => At::Range(offset, offset + 1),
    }
}

pub fn source_at(token: &SourceToken) -> At {
    At::Range(token.offset, token.offset + token.source.len())
}

/// A block scalar's style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Literal,
    Folded,
}

/// `foldLines(source)`.
pub fn fold_lines(source: &[u16]) -> Vec<u16> {
    let is_ws = |unit: u16| unit == 0x20 || unit == 0x09;
    let Some(first_nl) = source.iter().position(|unit| *unit == 0x0a) else {
        return source.to_vec();
    };
    let mut q = first_nl;
    if q > 0 && source[q - 1] == 0x0d {
        q -= 1;
    }
    while q > 0 && is_ws(source[q - 1]) {
        q -= 1;
    }
    let mut res = source[..q].to_vec();
    let mut sep: Vec<u16> = vec![0x20];
    let mut pos = first_nl + 1;
    loop {
        let mut s = pos;
        while s < source.len() && is_ws(source[s]) {
            s += 1;
        }
        let Some(p) = source[s.min(source.len())..].iter().position(|unit| *unit == 0x0a).map(|at| at + s) else {
            break;
        };
        let mut e = p;
        if e > s && source[e - 1] == 0x0d {
            e -= 1;
        }
        while e > s && is_ws(source[e - 1]) {
            e -= 1;
        }
        let content = &source[s..e];
        if content.is_empty() {
            if sep == [0x0a] {
                res.extend_from_slice(&sep);
            } else {
                sep = vec![0x0a];
            }
        } else {
            res.extend_from_slice(&sep);
            res.extend_from_slice(content);
            sep = vec![0x20];
        }
        pos = p + 1;
    }
    let mut s = pos.min(source.len());
    while s < source.len() && is_ws(source[s]) {
        s += 1;
    }
    res.extend_from_slice(&sep);
    res.extend_from_slice(&source[s..]);
    res
}

/// `plainValue(source, onError)` with offsets relative to the scalar.
pub fn plain_value(source: &[u16], on_error: &mut dyn FnMut(usize, &'static str, String)) -> Vec<u16> {
    let bad = match source.first() {
        Some(0x09) => Some("a tab character".to_owned()),
        Some(0x2c) => Some("flow indicator character ,".to_owned()),
        Some(0x25) => Some("directive indicator character %".to_owned()),
        Some(0x7c) => Some("block scalar indicator |".to_owned()),
        Some(0x3e) => Some("block scalar indicator >".to_owned()),
        Some(0x40) => Some("reserved character @".to_owned()),
        Some(0x60) => Some("reserved character `".to_owned()),
        _ => None,
    };
    if let Some(bad) = bad {
        on_error(0, "BAD_SCALAR_START", format!("Plain value cannot start with {bad}"));
    }
    fold_lines(source)
}

pub fn single_quoted_value(source: &[u16], on_error: &mut dyn FnMut(usize, &'static str, String)) -> Vec<u16> {
    if source.last() != Some(&0x27) || source.len() == 1 {
        on_error(source.len(), "MISSING_CHAR", "Missing closing 'quote".to_owned());
    }
    let inner: &[u16] = if source.len() >= 2 { &source[1..source.len() - 1] } else { &[] };
    let folded = fold_lines(inner);
    let mut out = Vec::with_capacity(folded.len());
    let mut at = 0;
    while at < folded.len() {
        if folded[at] == 0x27 && folded.get(at + 1) == Some(&0x27) {
            out.push(0x27);
            at += 2;
        } else {
            out.push(folded[at]);
            at += 1;
        }
    }
    out
}

fn escape_code(unit: u16) -> Option<u16> {
    Some(match unit {
        0x30 => 0x00,
        0x61 => 0x07,
        0x62 => 0x08,
        0x65 => 0x1b,
        0x66 => 0x0c,
        0x6e => 0x0a,
        0x72 => 0x0d,
        0x74 => 0x09,
        0x76 => 0x0b,
        0x4e => 0x85,
        0x5f => 0xa0,
        0x4c => 0x2028,
        0x50 => 0x2029,
        0x20 => 0x20,
        0x22 => 0x22,
        0x2f => 0x2f,
        0x5c => 0x5c,
        0x09 => 0x09,
        _ => return None,
    })
}

fn parse_char_code(source: &[u16], offset: usize, length: usize, on_error: &mut dyn FnMut(usize, &'static str, String)) -> Vec<u16> {
    let cc = js::substr(source, offset, length);
    let ok = cc.len() == length && cc.iter().all(|unit| matches!(unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66));
    let code = if ok { u32::from_str_radix(&js::lossy(cc), 16).ok() } else { None };
    match code {
        Some(code) if code <= 0x10ffff => {
            if code < 0x10000 {
                vec![code as u16]
            } else {
                let value = code - 0x10000;
                vec![0xd800 + (value >> 10) as u16, 0xdc00 + (value & 0x3ff) as u16]
            }
        }
        _ => {
            let raw = js::substr(source, offset.saturating_sub(2), length + 2).to_vec();
            on_error(offset - 2, "BAD_DQ_ESCAPE", format!("Invalid escape sequence {}", js::lossy(&raw)));
            raw
        }
    }
}

pub fn double_quoted_value(source: &[u16], on_error: &mut dyn FnMut(usize, &'static str, String)) -> Vec<u16> {
    let mut res = Vec::new();
    let at = |i: usize| source.get(i).copied();
    let mut i = 1;
    while i + 1 < source.len() {
        let ch = source[i];
        if ch == 0x0d && at(i + 1) == Some(0x0a) {
            i += 1;
            continue;
        }
        if ch == 0x0a {
            // foldNewline(source, i)
            let mut fold = Vec::new();
            let mut offset = i;
            let mut next = at(offset + 1);
            while matches!(next, Some(0x20 | 0x09 | 0x0a | 0x0d)) {
                if next == Some(0x0d) && at(offset + 2) != Some(0x0a) {
                    break;
                }
                if next == Some(0x0a) {
                    fold.push(0x0a);
                }
                offset += 1;
                next = at(offset + 1);
            }
            if fold.is_empty() {
                fold.push(0x20);
            }
            res.extend(fold);
            i = offset;
        } else if ch == 0x5c {
            i += 1;
            let next = at(i);
            if let Some(code) = next.and_then(escape_code) {
                res.push(code);
            } else if next == Some(0x0a) {
                let mut n = at(i + 1);
                while n == Some(0x20) || n == Some(0x09) {
                    i += 1;
                    n = at(i + 1);
                }
            } else if next == Some(0x0d) && at(i + 1) == Some(0x0a) {
                i += 1;
                let mut n = at(i + 1);
                while n == Some(0x20) || n == Some(0x09) {
                    i += 1;
                    n = at(i + 1);
                }
            } else if matches!(next, Some(0x78 | 0x75 | 0x55)) {
                let length = match next {
                    Some(0x78) => 2,
                    Some(0x75) => 4,
                    _ => 8,
                };
                res.extend(parse_char_code(source, i + 1, length, on_error));
                i += length;
            } else {
                let raw = js::substr(source, i - 1, 2).to_vec();
                on_error(i - 1, "BAD_DQ_ESCAPE", format!("Invalid escape sequence {}", js::lossy(&raw)));
                res.extend(raw);
            }
        } else if ch == 0x20 || ch == 0x09 {
            let ws_start = i;
            let mut next = at(i + 1);
            while next == Some(0x20) || next == Some(0x09) {
                i += 1;
                next = at(i + 1);
            }
            if next != Some(0x0a) && !(next == Some(0x0d) && at(i + 2) == Some(0x0a)) {
                if i > ws_start {
                    res.extend_from_slice(&source[ws_start..=i]);
                } else {
                    res.push(ch);
                }
            }
        } else {
            res.push(ch);
        }
        i += 1;
    }
    if source.last() != Some(&0x22) || source.len() == 1 {
        on_error(source.len(), "MISSING_CHAR", "Missing closing \"quote".to_owned());
    }
    res
}

/// The result of resolving a scalar token's text.
pub struct Resolved {
    pub value: Vec<u16>,
    pub range: [usize; 3],
}

/// `resolveEnd(end, offset, reqSpace, onError)`: the end offset.
pub fn resolve_end(end: Option<&[SourceToken]>, mut offset: usize, req_space: bool, on_error: &mut OnError) -> usize {
    if let Some(end) = end {
        let mut has_space = false;
        for token in end {
            match token.ty {
                Ty::Space => has_space = true,
                Ty::Comment => {
                    if req_space && !has_space {
                        on_error(
                            source_at(token),
                            "MISSING_CHAR",
                            "Comments must be separated from other tokens by white space characters".to_owned(),
                            false,
                        );
                    }
                }
                Ty::Newline => has_space = true,
                other => on_error(source_at(token), "UNEXPECTED_TOKEN", format!("Unexpected {} at node end", other.name()), false),
            }
            offset += token.source.len();
        }
    }
    offset
}

/// `resolveFlowScalar(scalar, strict, onError)` (strict is the default true).
pub fn resolve_flow_scalar(token: &Token, on_error: &mut OnError) -> Resolved {
    let Token::FlowScalar { kind, offset, source, end, .. } = token else {
        let offset = token.offset();
        let length = token.source().map_or(0, <[u16]>::len);
        on_error(
            token_at(token),
            "UNEXPECTED_TOKEN",
            format!("Expected a flow scalar value, but found: {}", token.type_name()),
            false,
        );
        return Resolved {
            value: Vec::new(),
            range: [offset, offset + length, offset + length],
        };
    };
    let offset = *offset;
    let mut relative = |rel: usize, code: &'static str, message: String| on_error(At::Offset(offset + rel), code, message, false);
    let value = match kind {
        super::cst::FlowKind::Plain => plain_value(source, &mut relative),
        super::cst::FlowKind::Single => single_quoted_value(source, &mut relative),
        super::cst::FlowKind::Double => double_quoted_value(source, &mut relative),
        super::cst::FlowKind::Alias => {
            on_error(
                token_at(token),
                "UNEXPECTED_TOKEN",
                "Expected a flow scalar value, but found: alias".to_owned(),
                false,
            );
            let end = offset + source.len();
            return Resolved {
                value: Vec::new(),
                range: [offset, end, end],
            };
        }
    };
    let value_end = offset + source.len();
    let re = resolve_end(end.as_deref(), value_end, true, on_error);
    Resolved {
        value,
        range: [offset, value_end, re],
    }
}

struct Header {
    folded: bool,
    indent: i64,
    chomp: u16,
    length: usize,
}

fn parse_block_scalar_header(offset: usize, props: &[Token], on_error: &mut OnError) -> Option<Header> {
    let first = props.first()?;
    let Token::Source(SourceToken {
        ty: Ty::BlockScalarHeader,
        source,
        ..
    }) = first
    else {
        on_error(token_at(first), "IMPOSSIBLE", "Block scalar header not found".to_owned(), false);
        return None;
    };
    let folded = source.first() == Some(&0x3e);
    let mut indent: i64 = 0;
    let mut chomp: u16 = 0;
    let mut error: Option<usize> = None;
    for (i, ch) in source.iter().enumerate().skip(1) {
        if chomp == 0 && (*ch == 0x2d || *ch == 0x2b) {
            chomp = *ch;
        } else {
            // Number(ch) of one character: a digit, or 0 for whitespace, else NaN.
            let n = match ch {
                0x30..=0x39 => i64::from(ch - 0x30),
                _ if js::is_space(*ch) => 0,
                _ => -1,
            };
            if indent == 0 && n > 0 {
                indent = n;
            } else if error.is_none() {
                error = Some(offset + i);
            }
        }
    }
    if let Some(error) = error {
        on_error(
            At::Offset(error),
            "UNEXPECTED_TOKEN",
            format!("Block scalar header includes extra characters: {}", js::lossy(source)),
            false,
        );
    }
    let mut has_space = false;
    let mut length = source.len();
    for token in &props[1..] {
        match token {
            Token::Source(st) if st.ty == Ty::Space => {
                has_space = true;
                length += st.source.len();
            }
            Token::Source(st) if st.ty == Ty::Newline => length += st.source.len(),
            Token::Source(st) if st.ty == Ty::Comment => {
                if !has_space {
                    on_error(
                        source_at(st),
                        "MISSING_CHAR",
                        "Comments must be separated from other tokens by white space characters".to_owned(),
                        false,
                    );
                }
                length += st.source.len();
            }
            Token::Error { message, source, .. } => {
                on_error(token_at(token), "UNEXPECTED_TOKEN", js::lossy(message), false);
                length += source.len();
            }
            other => {
                on_error(
                    token_at(other),
                    "UNEXPECTED_TOKEN",
                    format!("Unexpected token in block scalar header: {}", other.type_name()),
                    false,
                );
                if let Some(source) = other.source() {
                    length += source.len();
                }
            }
        }
    }
    Some(Header { folded, indent, chomp, length })
}

/// `resolveBlockScalar(ctx, scalar, onError)`.
pub fn resolve_block_scalar(token: &Token, at_root: bool, on_error: &mut OnError) -> Resolved {
    let Token::BlockScalar {
        offset,
        indent: scalar_indent,
        props,
        source,
    } = token
    else {
        return Resolved {
            value: Vec::new(),
            range: [0, 0, 0],
        };
    };
    let start = *offset;
    let Some(header) = parse_block_scalar_header(start, props, on_error) else {
        return Resolved {
            value: Vec::new(),
            range: [start, start, start],
        };
    };
    let style = if header.folded { Style::Folded } else { Style::Literal };
    // splitLines: [indent, content] per line.
    let lines: Vec<(&[u16], &[u16])> = if source.is_empty() {
        Vec::new()
    } else {
        source
            .split(|unit| *unit == 0x0a)
            .map(|line| {
                let spaces = line.iter().take_while(|unit| **unit == 0x20).count();
                (&line[..spaces], &line[spaces..])
            })
            .collect()
    };
    let is_blank = |content: &[u16]| content.is_empty() || content == [0x0d];
    let mut chomp_start = lines.len();
    for i in (0..lines.len()).rev() {
        if is_blank(lines[i].1) {
            chomp_start = i;
        } else {
            break;
        }
    }
    if chomp_start == 0 {
        let value = if header.chomp == 0x2b && !lines.is_empty() {
            vec![0x0a; (lines.len() as i64 - 1).max(1) as usize]
        } else {
            Vec::new()
        };
        let end = start + header.length + source.len();
        return Resolved {
            value,
            range: [start, end, end],
        };
    }
    let mut trim_indent = *scalar_indent + header.indent;
    let mut offset = start + header.length;
    let mut content_start = 0;
    for (i, (indent, content)) in lines.iter().enumerate().take(chomp_start) {
        if is_blank(content) {
            if header.indent == 0 && indent.len() as i64 > trim_indent {
                trim_indent = indent.len() as i64;
            }
        } else {
            if (indent.len() as i64) < trim_indent {
                on_error(
                    At::Offset(offset + indent.len()),
                    "MISSING_CHAR",
                    "Block scalars with more-indented leading empty lines must use an explicit indentation indicator".to_owned(),
                    false,
                );
            }
            if header.indent == 0 {
                trim_indent = indent.len() as i64;
            }
            content_start = i;
            if trim_indent == 0 && !at_root {
                on_error(
                    At::Offset(offset),
                    "BAD_INDENT",
                    "Block scalar values in collections must be indented".to_owned(),
                    false,
                );
            }
            break;
        }
        offset += indent.len() + content.len() + 1;
    }
    // The loop's bound is re-read each step, as in the JavaScript: once a
    // trailing line is found more indented, the lines before it stay content.
    let mut i = lines.len() as i64 - 1;
    while i >= chomp_start as i64 {
        if lines[i as usize].0.len() as i64 > trim_indent {
            chomp_start = i as usize + 1;
        }
        i -= 1;
    }
    let slice_from = |text: &[u16]| -> Vec<u16> { text.get(trim_indent.max(0) as usize..).unwrap_or_default().to_vec() };
    let mut value: Vec<u16> = Vec::new();
    let mut sep: Vec<u16> = Vec::new();
    let mut prev_more_indented = false;
    for line in lines.iter().take(content_start) {
        value.extend(slice_from(line.0));
        value.push(0x0a);
    }
    for line in lines.iter().take(chomp_start).skip(content_start) {
        let (mut indent, mut content) = *line;
        offset += indent.len() + content.len() + 1;
        let crlf = content.last() == Some(&0x0d);
        if crlf {
            content = &content[..content.len() - 1];
        }
        if !content.is_empty() && (indent.len() as i64) < trim_indent {
            let what = if header.indent != 0 { "explicit indentation indicator" } else { "first line" };
            on_error(
                At::Offset(offset - content.len() - if crlf { 2 } else { 1 }),
                "BAD_INDENT",
                format!("Block scalar lines must not be less indented than their {what}"),
                false,
            );
            indent = &[];
        }
        if style == Style::Literal {
            value.extend_from_slice(&sep);
            value.extend(slice_from(indent));
            value.extend_from_slice(content);
            sep = vec![0x0a];
        } else if indent.len() as i64 > trim_indent || content.first() == Some(&0x09) {
            if sep == [0x20] {
                sep = vec![0x0a];
            } else if !prev_more_indented && sep == [0x0a] {
                sep = vec![0x0a, 0x0a];
            }
            value.extend_from_slice(&sep);
            value.extend(slice_from(indent));
            value.extend_from_slice(content);
            sep = vec![0x0a];
            prev_more_indented = true;
        } else if content.is_empty() {
            if sep == [0x0a] {
                value.push(0x0a);
            } else {
                sep = vec![0x0a];
            }
        } else {
            value.extend_from_slice(&sep);
            value.extend_from_slice(content);
            sep = vec![0x20];
            prev_more_indented = false;
        }
    }
    match header.chomp {
        0x2d => {}
        0x2b => {
            for line in lines.iter().skip(chomp_start) {
                value.push(0x0a);
                value.extend(slice_from(line.0));
            }
            if value.last() != Some(&0x0a) {
                value.push(0x0a);
            }
        }
        _ => value.push(0x0a),
    }
    let end = start + header.length + source.len();
    Resolved {
        value,
        range: [start, end, end],
    }
}

fn strip_sign(s: &[u8]) -> &[u8] {
    if matches!(s.first(), Some(b'+' | b'-')) { &s[1..] } else { s }
}

/// A scalar's JavaScript value.
#[derive(Clone, Debug, PartialEq)]
pub enum ScalarValue {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
}

/// The scalar tags of the core schema, in `schema.tags` order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoreTag {
    Str,
    Null,
    Bool,
    IntOct,
    Int,
    IntHex,
    FloatNaN,
    FloatExp,
    Float,
}

pub const TAG_PREFIX: &str = "tag:yaml.org,2002:";

impl CoreTag {
    pub const TESTED: [CoreTag; 8] = [
        CoreTag::Null,
        CoreTag::Bool,
        CoreTag::IntOct,
        CoreTag::Int,
        CoreTag::IntHex,
        CoreTag::FloatNaN,
        CoreTag::FloatExp,
        CoreTag::Float,
    ];

    pub fn tag(self) -> String {
        let name = match self {
            CoreTag::Str => "str",
            CoreTag::Null => "null",
            CoreTag::Bool => "bool",
            CoreTag::IntOct | CoreTag::Int | CoreTag::IntHex => "int",
            CoreTag::FloatNaN | CoreTag::FloatExp | CoreTag::Float => "float",
        };
        format!("{TAG_PREFIX}{name}")
    }

    /// `tag.test.test(value)`.
    pub fn test(self, value: &[u16]) -> bool {
        let text = match String::from_utf16(value) {
            Ok(text) => text,
            Err(_) => return false,
        };
        let b = text.as_bytes();
        let digits = |s: &[u8]| !s.is_empty() && s.iter().all(u8::is_ascii_digit);
        match self {
            CoreTag::Str => false,
            CoreTag::Null => matches!(text.as_str(), "" | "~" | "null" | "Null" | "NULL"),
            CoreTag::Bool => matches!(text.as_str(), "true" | "True" | "TRUE" | "false" | "False" | "FALSE"),
            CoreTag::IntOct => b.len() > 2 && b.starts_with(b"0o") && b[2..].iter().all(|c| (b'0'..=b'7').contains(c)),
            CoreTag::Int => digits(strip_sign(b)),
            CoreTag::IntHex => b.len() > 2 && b.starts_with(b"0x") && b[2..].iter().all(u8::is_ascii_hexdigit),
            CoreTag::FloatNaN => {
                let unsigned = strip_sign(b);
                matches!(unsigned, b".inf" | b".Inf" | b".INF") || matches!(b, b".nan" | b".NaN" | b".NAN")
            }
            CoreTag::FloatExp => {
                let s = strip_sign(b);
                let Some(e) = s.iter().position(|c| *c == b'e' || *c == b'E') else {
                    return false;
                };
                let (mantissa, exponent) = (&s[..e], &s[e + 1..]);
                let mantissa_ok = if let Some(rest) = mantissa.strip_prefix(b".") {
                    digits(rest)
                } else {
                    match mantissa.iter().position(|c| *c == b'.') {
                        Some(dot) => digits(&mantissa[..dot]) && mantissa[dot + 1..].iter().all(u8::is_ascii_digit),
                        None => digits(mantissa),
                    }
                };
                mantissa_ok && digits(strip_sign(exponent))
            }
            CoreTag::Float => {
                let s = strip_sign(b);
                if let Some(rest) = s.strip_prefix(b".") {
                    return digits(rest);
                }
                match s.iter().position(|c| *c == b'.') {
                    Some(dot) => digits(&s[..dot]) && s[dot + 1..].iter().all(u8::is_ascii_digit),
                    None => false,
                }
            }
        }
    }

    /// `tag.resolve(value)`.
    pub fn resolve(self, value: &[u16]) -> ScalarValue {
        let text = js::lossy(value);
        match self {
            CoreTag::Str => ScalarValue::String(value.to_vec()),
            CoreTag::Null => ScalarValue::Null,
            CoreTag::Bool => ScalarValue::Bool(matches!(value.first(), Some(0x74 | 0x54))),
            CoreTag::IntOct => ScalarValue::Number(js::parse_int_power_of_two(&value[2..], 8)),
            CoreTag::IntHex => ScalarValue::Number(js::parse_int_power_of_two(&value[2..], 16)),
            CoreTag::Int => ScalarValue::Number(js::parse_decimal(&text).unwrap_or(f64::NAN)),
            CoreTag::FloatNaN => {
                let lower = text.to_ascii_lowercase();
                ScalarValue::Number(if lower.ends_with("nan") {
                    f64::NAN
                } else if text.starts_with('-') {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                })
            }
            CoreTag::FloatExp | CoreTag::Float => ScalarValue::Number(js::parse_decimal(&text).unwrap_or(f64::NAN)),
        }
    }
}

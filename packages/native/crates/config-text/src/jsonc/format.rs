//! `format` of jsonc-parser 3.3.1 (`lib/umd/impl/format.js`), for the
//! options `modify` passes it: a range, `insertSpaces: true`, `tabSize: 2`,
//! `keepLines: false`, no final newline, and the caller's `eol`.

use super::scanner::{Kind, Scanner};
use crate::js;

/// `{ offset, length, content }`. `content` is `None` where the JavaScript
/// produces `undefined` (the line-break cache has 200 entries, 0 to 199, so an
/// indentation of exactly 200 spaces reads past it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatEdit {
    pub offset: usize,
    pub length: usize,
    pub content: Option<Vec<u16>>,
}

const TAB_SIZE: usize = 2;
const MAX_CACHED: usize = 200;

/// `isEOL(text, offset)`: also true past the end, where `charAt` is `''`.
pub fn is_eol(text: &[u16], offset: usize) -> bool {
    match text.get(offset) {
        Some(unit) => *unit == 0x0d || *unit == 0x0a,
        None => true,
    }
}

fn get_eol(text: &[u16], fallback: &[u16]) -> Vec<u16> {
    for (index, unit) in text.iter().enumerate() {
        if *unit == 0x0d {
            if text.get(index + 1) == Some(&0x0a) {
                return vec![0x0d, 0x0a];
            }
            return vec![0x0d];
        } else if *unit == 0x0a {
            return vec![0x0a];
        }
    }
    if fallback.is_empty() { vec![0x0a] } else { fallback.to_vec() }
}

fn compute_indent_level(content: &[u16]) -> usize {
    let mut chars = 0;
    for unit in content {
        match unit {
            0x20 => chars += 1,
            0x09 => chars += TAB_SIZE,
            _ => break,
        }
    }
    chars / TAB_SIZE
}

fn spaces(count: i64) -> Vec<u16> {
    vec![0x20; count.max(0) as usize]
}

/// `format(documentText, { offset, length }, options)`.
pub fn format(document: &[u16], range_offset: usize, range_length: usize, eol_option: &[u16]) -> Vec<FormatEdit> {
    let range_start = range_offset;
    let range_end = range_start + range_length;
    let mut format_start = range_start;
    while format_start > 0 && !is_eol(document, format_start - 1) {
        format_start -= 1;
    }
    let mut end_offset = range_end;
    while end_offset < document.len() && !is_eol(document, end_offset) {
        end_offset += 1;
    }
    let format_text = js::substring(document, format_start as i64, end_offset as i64);
    let initial_indent_level = compute_indent_level(format_text) as i64;
    let eol = get_eol(document, eol_option);
    let indent_value_len = TAB_SIZE as i64;

    let mut scanner = Scanner::new(format_text);
    let mut has_error = false;
    let mut number_line_breaks = 0;
    let mut indent_level: i64 = 0;
    let mut edits: Vec<FormatEdit> = Vec::new();

    let new_lines_and_indent = |indent_level: i64| -> Option<Vec<u16>> {
        let amount = indent_value_len * (initial_indent_level + indent_level);
        if amount > MAX_CACHED as i64 {
            let mut out = eol.clone();
            out.extend(spaces(amount));
            return Some(out);
        }
        if amount <= 0 {
            return Some(eol.clone());
        }
        if amount == MAX_CACHED as i64 {
            return None;
        }
        let mut out = eol.clone();
        out.extend(spaces(amount));
        Some(out)
    };

    let scan_next = |scanner: &mut Scanner, number_line_breaks: &mut usize, has_error: &mut bool| -> Kind {
        let mut token = scanner.scan();
        *number_line_breaks = 0;
        while token == Kind::Trivia || token == Kind::LineBreak {
            if token == Kind::LineBreak {
                *number_line_breaks = 1;
            }
            token = scanner.scan();
        }
        *has_error = token == Kind::Unknown || scanner.error() != super::scanner::ScanError::None;
        token
    };

    let add_edit = |edits: &mut Vec<FormatEdit>, has_error: bool, text: Option<Vec<u16>>, start: usize, end: usize| {
        if has_error || !(start < range_end && end > range_start) {
            return;
        }
        if let Some(text) = &text
            && js::substring(document, start as i64, end as i64) == text.as_slice()
        {
            return;
        }
        edits.push(FormatEdit {
            offset: start,
            length: end - start,
            content: text,
        });
    };

    let mut first_token = scan_next(&mut scanner, &mut number_line_breaks, &mut has_error);
    if first_token != Kind::Eof {
        let first_token_start = scanner.token_offset() + format_start;
        let initial_indent = spaces(indent_value_len * initial_indent_level);
        add_edit(&mut edits, has_error, Some(initial_indent), format_start, first_token_start);
    }
    while first_token != Kind::Eof {
        let mut first_token_end = scanner.token_offset() + scanner.token_length() + format_start;
        let mut second_token = scan_next(&mut scanner, &mut number_line_breaks, &mut has_error);
        let mut replace: Option<Vec<u16>> = Some(Vec::new());
        let mut needs_line_break = false;
        while number_line_breaks == 0 && (second_token == Kind::LineComment || second_token == Kind::BlockComment) {
            let comment_start = scanner.token_offset() + format_start;
            add_edit(&mut edits, has_error, Some(vec![0x20]), first_token_end, comment_start);
            first_token_end = scanner.token_offset() + scanner.token_length() + format_start;
            needs_line_break = second_token == Kind::LineComment;
            replace = if needs_line_break {
                new_lines_and_indent(indent_level)
            } else {
                Some(Vec::new())
            };
            second_token = scan_next(&mut scanner, &mut number_line_breaks, &mut has_error);
        }
        if second_token == Kind::CloseBrace {
            if first_token != Kind::OpenBrace {
                indent_level -= 1;
            }
            if first_token != Kind::OpenBrace {
                replace = new_lines_and_indent(indent_level);
            }
        } else if second_token == Kind::CloseBracket {
            if first_token != Kind::OpenBracket {
                indent_level -= 1;
            }
            if first_token != Kind::OpenBracket {
                replace = new_lines_and_indent(indent_level);
            }
        } else {
            match first_token {
                Kind::OpenBracket | Kind::OpenBrace => {
                    indent_level += 1;
                    replace = new_lines_and_indent(indent_level);
                }
                Kind::Comma => replace = new_lines_and_indent(indent_level),
                Kind::LineComment => replace = new_lines_and_indent(indent_level),
                Kind::BlockComment => {
                    if number_line_breaks > 0 {
                        replace = new_lines_and_indent(indent_level);
                    } else if !needs_line_break {
                        replace = Some(vec![0x20]);
                    }
                }
                Kind::Colon => {
                    if !needs_line_break {
                        replace = Some(vec![0x20]);
                    }
                }
                Kind::String => {
                    if second_token == Kind::Colon && !needs_line_break {
                        replace = Some(Vec::new());
                    }
                }
                Kind::Null | Kind::True | Kind::False | Kind::Number | Kind::CloseBrace | Kind::CloseBracket => {
                    if (second_token == Kind::LineComment || second_token == Kind::BlockComment) && !needs_line_break {
                        replace = Some(vec![0x20]);
                    } else if second_token != Kind::Comma && second_token != Kind::Eof {
                        has_error = true;
                    }
                }
                Kind::Unknown => has_error = true,
                _ => {}
            }
            if number_line_breaks > 0 && (second_token == Kind::LineComment || second_token == Kind::BlockComment) {
                replace = new_lines_and_indent(indent_level);
            }
        }
        if second_token == Kind::Eof {
            replace = Some(Vec::new());
        }
        let second_token_start = scanner.token_offset() + format_start;
        add_edit(&mut edits, has_error, replace, first_token_end, second_token_start);
        first_token = second_token;
    }
    edits
}

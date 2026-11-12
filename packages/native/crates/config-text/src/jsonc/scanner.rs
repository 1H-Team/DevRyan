//! `createScanner` of jsonc-parser 3.3.1 (`lib/umd/impl/scanner.js`).

use crate::js;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    OpenBrace = 1,
    CloseBrace = 2,
    OpenBracket = 3,
    CloseBracket = 4,
    Comma = 5,
    Colon = 6,
    Null = 7,
    True = 8,
    False = 9,
    String = 10,
    Number = 11,
    LineComment = 12,
    BlockComment = 13,
    LineBreak = 14,
    Trivia = 15,
    Unknown = 16,
    Eof = 17,
}

/// `ScanError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    None = 0,
    UnexpectedEndOfComment = 1,
    UnexpectedEndOfString = 2,
    UnexpectedEndOfNumber = 3,
    InvalidUnicode = 4,
    InvalidEscapeCharacter = 5,
    InvalidCharacter = 6,
}

pub struct Scanner<'a> {
    text: &'a [u16],
    /// May pass the end by one after an unclosed block comment, as in JavaScript.
    pos: usize,
    value: Vec<u16>,
    token_offset: usize,
    token: Kind,
    error: ScanError,
}

fn is_white_space(ch: Option<u16>) -> bool {
    matches!(ch, Some(0x20 | 0x09))
}

fn is_line_break(ch: Option<u16>) -> bool {
    matches!(ch, Some(0x0a | 0x0d))
}

fn is_digit(ch: Option<u16>) -> bool {
    matches!(ch, Some(0x30..=0x39))
}

fn is_unknown_content(ch: Option<u16>) -> bool {
    if is_white_space(ch) || is_line_break(ch) {
        return false;
    }
    !matches!(ch, Some(0x7d | 0x5d | 0x7b | 0x5b | 0x22 | 0x3a | 0x2c | 0x2f))
}

impl<'a> Scanner<'a> {
    pub fn new(text: &'a [u16]) -> Self {
        Scanner {
            text,
            pos: 0,
            value: Vec::new(),
            token_offset: 0,
            token: Kind::Unknown,
            error: ScanError::None,
        }
    }

    fn at(&self, index: usize) -> Option<u16> {
        self.text.get(index).copied()
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn token(&self) -> Kind {
        self.token
    }

    pub fn value(&self) -> &[u16] {
        &self.value
    }

    pub fn token_offset(&self) -> usize {
        self.token_offset
    }

    pub fn token_length(&self) -> usize {
        self.pos - self.token_offset
    }

    pub fn error(&self) -> ScanError {
        self.error
    }

    fn sub(&self, start: usize, end: usize) -> &'a [u16] {
        js::substring(self.text, start as i64, end as i64)
    }

    fn scan_hex_digits(&mut self, count: usize) -> i64 {
        let mut digits = 0;
        let mut value: i64 = 0;
        while digits < count {
            let Some(ch) = self.at(self.pos) else { break };
            let digit = match ch {
                0x30..=0x39 => ch - 0x30,
                0x41..=0x46 => ch - 0x41 + 10,
                0x61..=0x66 => ch - 0x61 + 10,
                _ => break,
            };
            value = value * 16 + i64::from(digit);
            self.pos += 1;
            digits += 1;
        }
        if digits < count { -1 } else { value }
    }

    fn scan_number(&mut self) -> Vec<u16> {
        let start = self.pos;
        let len = self.text.len();
        if self.at(self.pos) == Some(0x30) {
            self.pos += 1;
        } else {
            self.pos += 1;
            while self.pos < len && is_digit(self.at(self.pos)) {
                self.pos += 1;
            }
        }
        if self.pos < len && self.at(self.pos) == Some(0x2e) {
            self.pos += 1;
            if self.pos < len && is_digit(self.at(self.pos)) {
                self.pos += 1;
                while self.pos < len && is_digit(self.at(self.pos)) {
                    self.pos += 1;
                }
            } else {
                self.error = ScanError::UnexpectedEndOfNumber;
                return self.sub(start, self.pos).to_vec();
            }
        }
        let mut end = self.pos;
        if self.pos < len && matches!(self.at(self.pos), Some(0x45 | 0x65)) {
            self.pos += 1;
            if matches!(self.at(self.pos), Some(0x2b | 0x2d)) {
                self.pos += 1;
            }
            if self.pos < len && is_digit(self.at(self.pos)) {
                self.pos += 1;
                while self.pos < len && is_digit(self.at(self.pos)) {
                    self.pos += 1;
                }
                end = self.pos;
            } else {
                self.error = ScanError::UnexpectedEndOfNumber;
            }
        }
        self.sub(start, end).to_vec()
    }

    fn scan_string(&mut self) -> Vec<u16> {
        let len = self.text.len();
        let mut result = Vec::new();
        let mut start = self.pos;
        loop {
            if self.pos >= len {
                result.extend_from_slice(self.sub(start, self.pos));
                self.error = ScanError::UnexpectedEndOfString;
                break;
            }
            let ch = self.text[self.pos];
            if ch == 0x22 {
                result.extend_from_slice(self.sub(start, self.pos));
                self.pos += 1;
                break;
            }
            if ch == 0x5c {
                result.extend_from_slice(self.sub(start, self.pos));
                self.pos += 1;
                if self.pos >= len {
                    self.error = ScanError::UnexpectedEndOfString;
                    break;
                }
                let ch2 = self.text[self.pos];
                self.pos += 1;
                match ch2 {
                    0x22 => result.push(0x22),
                    0x5c => result.push(0x5c),
                    0x2f => result.push(0x2f),
                    0x62 => result.push(0x08),
                    0x66 => result.push(0x0c),
                    0x6e => result.push(0x0a),
                    0x72 => result.push(0x0d),
                    0x74 => result.push(0x09),
                    0x75 => {
                        let ch3 = self.scan_hex_digits(4);
                        if ch3 >= 0 {
                            result.push(ch3 as u16);
                        } else {
                            self.error = ScanError::InvalidUnicode;
                        }
                    }
                    _ => self.error = ScanError::InvalidEscapeCharacter,
                }
                start = self.pos;
                continue;
            }
            if ch <= 0x1f {
                if is_line_break(Some(ch)) {
                    result.extend_from_slice(self.sub(start, self.pos));
                    self.error = ScanError::UnexpectedEndOfString;
                    break;
                }
                self.error = ScanError::InvalidCharacter;
            }
            self.pos += 1;
        }
        result
    }

    /// `scan()` of a scanner created with `ignoreTrivia` false.
    pub fn scan(&mut self) -> Kind {
        self.token = self.scan_next();
        self.token
    }

    fn scan_next(&mut self) -> Kind {
        let len = self.text.len();
        self.value.clear();
        self.error = ScanError::None;
        self.token_offset = self.pos;
        if self.pos >= len {
            self.token_offset = len;
            return Kind::Eof;
        }
        let mut code = self.at(self.pos);
        if is_white_space(code) {
            while is_white_space(code) {
                self.pos += 1;
                self.value.push(code.unwrap_or(0));
                code = self.at(self.pos);
            }
            return Kind::Trivia;
        }
        if is_line_break(code) {
            self.pos += 1;
            self.value.push(code.unwrap_or(0));
            if code == Some(0x0d) && self.at(self.pos) == Some(0x0a) {
                self.pos += 1;
                self.value.push(0x0a);
            }
            return Kind::LineBreak;
        }
        let code = code.unwrap_or(0);
        match code {
            0x7b => {
                self.pos += 1;
                Kind::OpenBrace
            }
            0x7d => {
                self.pos += 1;
                Kind::CloseBrace
            }
            0x5b => {
                self.pos += 1;
                Kind::OpenBracket
            }
            0x5d => {
                self.pos += 1;
                Kind::CloseBracket
            }
            0x3a => {
                self.pos += 1;
                Kind::Colon
            }
            0x2c => {
                self.pos += 1;
                Kind::Comma
            }
            0x22 => {
                self.pos += 1;
                self.value = self.scan_string();
                Kind::String
            }
            0x2f => {
                let start = self.pos;
                if self.at(self.pos + 1) == Some(0x2f) {
                    self.pos += 2;
                    while self.pos < len {
                        if is_line_break(self.at(self.pos)) {
                            break;
                        }
                        self.pos += 1;
                    }
                    self.value = self.sub(start, self.pos).to_vec();
                    return Kind::LineComment;
                }
                if self.at(self.pos + 1) == Some(0x2a) {
                    self.pos += 2;
                    let safe_length = len.saturating_sub(1);
                    let mut closed = false;
                    while self.pos < safe_length {
                        let ch = self.text[self.pos];
                        if ch == 0x2a && self.at(self.pos + 1) == Some(0x2f) {
                            self.pos += 2;
                            closed = true;
                            break;
                        }
                        self.pos += 1;
                        if is_line_break(Some(ch)) && ch == 0x0d && self.at(self.pos) == Some(0x0a) {
                            self.pos += 1;
                        }
                    }
                    if !closed {
                        self.pos += 1;
                        self.error = ScanError::UnexpectedEndOfComment;
                    }
                    self.value = self.sub(start, self.pos).to_vec();
                    return Kind::BlockComment;
                }
                self.value.push(code);
                self.pos += 1;
                Kind::Unknown
            }
            0x2d | 0x30..=0x39 => {
                if code == 0x2d {
                    self.value.push(code);
                    self.pos += 1;
                    if self.pos == len || !is_digit(self.at(self.pos)) {
                        return Kind::Unknown;
                    }
                }
                let number = self.scan_number();
                self.value.extend(number);
                Kind::Number
            }
            _ => {
                let mut ch = Some(code);
                while self.pos < len && is_unknown_content(ch) {
                    self.pos += 1;
                    ch = self.at(self.pos);
                }
                if self.token_offset != self.pos {
                    self.value = self.sub(self.token_offset, self.pos).to_vec();
                    return match self.value.as_slice() {
                        [0x74, 0x72, 0x75, 0x65] => Kind::True,
                        [0x66, 0x61, 0x6c, 0x73, 0x65] => Kind::False,
                        [0x6e, 0x75, 0x6c, 0x6c] => Kind::Null,
                        _ => Kind::Unknown,
                    };
                }
                self.value.push(code);
                self.pos += 1;
                Kind::Unknown
            }
        }
    }
}

//! `Lexer` of yaml 2.9.0 (`dist/parse/lexer.js`) for complete input (the
//! only way `yaml.parse` uses it: `atEnd` is always true, so no state is ever
//! buffered for more input).

pub const BOM: u16 = 0xfeff;
pub const DOCUMENT: u16 = 0x02;
pub const FLOW_END: u16 = 0x18;
pub const SCALAR: u16 = 0x1f;

/// One lexeme: a control character, or a slice `start..end` of the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lexeme {
    Control(u16),
    Text(usize, usize),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Stream,
    BlockStart,
    Doc,
    Flow,
}

fn is_empty(ch: Option<u16>) -> bool {
    matches!(ch, None | Some(0x20 | 0x0a | 0x0d | 0x09))
}

fn is_hex(ch: Option<u16>) -> bool {
    matches!(ch, Some(0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66))
}

fn is_tag_char(ch: u16) -> bool {
    matches!(ch, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
        || matches!(
            ch,
            0x2d | 0x23 | 0x3b | 0x2f | 0x3f | 0x3a | 0x40 | 0x26 | 0x3d | 0x2b | 0x24 | 0x5f | 0x2e | 0x21 | 0x7e | 0x2a | 0x27 | 0x28 | 0x29
        )
}

fn is_flow_indicator(ch: Option<u16>) -> bool {
    matches!(ch, Some(0x2c | 0x5b | 0x5d | 0x7b | 0x7d))
}

fn is_not_anchor_char(ch: Option<u16>) -> bool {
    match ch {
        None => true,
        Some(ch) => matches!(ch, 0x20 | 0x2c | 0x5b | 0x5d | 0x7b | 0x7d | 0x0a | 0x0d | 0x09),
    }
}

pub struct Lexer<'a> {
    buffer: &'a [u16],
    block_scalar_indent: i64,
    block_scalar_keep: bool,
    flow_key: bool,
    flow_level: i64,
    indent_next: i64,
    indent_value: i64,
    pos: usize,
    /// `lineEndPos`: the next line feed's index, -1 for none.
    line_end_pos: Option<i64>,
    out: Vec<Lexeme>,
}

impl<'a> Lexer<'a> {
    pub fn lex(source: &'a [u16]) -> Vec<Lexeme> {
        let mut lexer = Lexer {
            buffer: source,
            block_scalar_indent: -1,
            block_scalar_keep: false,
            flow_key: false,
            flow_level: 0,
            indent_next: 0,
            indent_value: 0,
            pos: 0,
            line_end_pos: None,
            out: Vec::new(),
        };
        let mut next = State::Stream;
        while lexer.pos < lexer.buffer.len() {
            next = lexer.parse_next(next);
        }
        lexer.out
    }

    fn ch(&self, index: i64) -> Option<u16> {
        if index < 0 {
            return None;
        }
        self.buffer.get(index as usize).copied()
    }

    fn char_at(&self, n: i64) -> Option<u16> {
        self.ch(self.pos as i64 + n)
    }

    fn emit(&mut self, start: usize, end: usize) {
        self.out.push(Lexeme::Text(start, end));
    }

    fn parse_next(&mut self, next: State) -> State {
        match next {
            State::Stream => self.parse_stream(),
            State::BlockStart => self.parse_block_start(),
            State::Doc => self.parse_document(),
            State::Flow => self.parse_flow_collection(),
        }
    }

    fn at_line_end(&self) -> bool {
        let mut i = self.pos as i64;
        let mut ch = self.ch(i);
        while ch == Some(0x20) || ch == Some(0x09) {
            i += 1;
            ch = self.ch(i);
        }
        if ch.is_none() || ch == Some(0x23) || ch == Some(0x0a) {
            return true;
        }
        if ch == Some(0x0d) {
            return self.ch(i + 1) == Some(0x0a);
        }
        false
    }

    fn continue_scalar(&self, offset: i64) -> i64 {
        let mut ch = self.ch(offset);
        if self.indent_next > 0 {
            let mut indent = 0;
            while ch == Some(0x20) {
                indent += 1;
                ch = self.ch(indent + offset);
            }
            if ch == Some(0x0d) {
                let next = self.ch(indent + offset + 1);
                if next == Some(0x0a) {
                    return offset + indent + 1;
                }
            }
            return if ch == Some(0x0a) || indent >= self.indent_next {
                offset + indent
            } else {
                -1
            };
        }
        if ch == Some(0x2d) || ch == Some(0x2e) {
            let dt: Vec<Option<u16>> = (0..3).map(|k| self.ch(offset + k)).collect();
            let dashes = dt.iter().all(|c| *c == Some(0x2d));
            let dots = dt.iter().all(|c| *c == Some(0x2e));
            if (dashes || dots) && is_empty(self.ch(offset + 3)) {
                return -1;
            }
        }
        offset
    }

    /// `getLine()`: the rest of the current line, without its line break, as
    /// bounds into the buffer (`substring` swaps reversed bounds).
    fn get_line(&mut self) -> (usize, usize) {
        let start = self.pos.min(self.buffer.len());
        let end = match self.line_end_pos {
            Some(end) if end == -1 || end >= self.pos as i64 => end,
            _ => {
                let found = self.buffer[start..].iter().position(|unit| *unit == 0x0a).map_or(-1, |at| (at + start) as i64);
                self.line_end_pos = Some(found);
                found
            }
        };
        if end == -1 {
            return (start, self.buffer.len());
        }
        let mut end = end as usize;
        if end > 0 && self.buffer[end - 1] == 0x0d {
            end -= 1;
        }
        if end < start { (end, start) } else { (start, end) }
    }

    fn push_count(&mut self, n: i64) -> i64 {
        if n > 0 {
            let start = self.pos;
            let end = (start + n as usize).min(self.buffer.len());
            self.emit(start, end);
            self.pos += n as usize;
            return n;
        }
        0
    }

    fn push_to_index(&mut self, i: i64, allow_empty: bool) -> i64 {
        let end = (i.max(0) as usize).min(self.buffer.len());
        if end > self.pos {
            let length = end - self.pos;
            self.emit(self.pos, end);
            self.pos += length;
            return length as i64;
        }
        if allow_empty {
            self.emit(self.pos, self.pos);
        }
        0
    }

    fn push_spaces(&mut self, allow_tabs: bool) -> i64 {
        let mut i = self.pos as i64 - 1;
        loop {
            i += 1;
            let ch = self.ch(i);
            if !(ch == Some(0x20) || (allow_tabs && ch == Some(0x09))) {
                break;
            }
        }
        let n = i - self.pos as i64;
        if n > 0 {
            self.emit(self.pos, i as usize);
            self.pos = i as usize;
        }
        n
    }

    fn push_until(&mut self, test: impl Fn(Option<u16>) -> bool) -> i64 {
        let mut i = self.pos as i64;
        while !test(self.ch(i)) {
            i += 1;
        }
        self.push_to_index(i, false)
    }

    fn push_newline(&mut self) -> i64 {
        let ch = self.ch(self.pos as i64);
        if ch == Some(0x0a) {
            self.push_count(1)
        } else if ch == Some(0x0d) && self.char_at(1) == Some(0x0a) {
            self.push_count(2)
        } else {
            0
        }
    }

    fn push_tag(&mut self) -> i64 {
        if self.char_at(1) == Some(0x3c) {
            let mut i = self.pos as i64 + 2;
            let mut ch = self.ch(i);
            while !is_empty(ch) && ch != Some(0x3e) {
                i += 1;
                ch = self.ch(i);
            }
            self.push_to_index(if ch == Some(0x3e) { i + 1 } else { i }, false)
        } else {
            let mut i = self.pos as i64 + 1;
            let mut ch = self.ch(i);
            while let Some(c) = ch {
                if is_tag_char(c) {
                    i += 1;
                    ch = self.ch(i);
                } else if c == 0x25 && is_hex(self.ch(i + 1)) && is_hex(self.ch(i + 2)) {
                    i += 3;
                    ch = self.ch(i);
                } else {
                    break;
                }
            }
            self.push_to_index(i, false)
        }
    }

    fn push_indicators(&mut self) -> i64 {
        let mut n = 0;
        loop {
            match self.char_at(0) {
                Some(0x21) => {
                    n += self.push_tag();
                    n += self.push_spaces(true);
                    continue;
                }
                Some(0x26) => {
                    n += self.push_until(is_not_anchor_char);
                    n += self.push_spaces(true);
                    continue;
                }
                Some(0x2d | 0x3f | 0x3a) => {
                    let in_flow = self.flow_level > 0;
                    let ch1 = self.char_at(1);
                    if is_empty(ch1) || (in_flow && is_flow_indicator(ch1)) {
                        if !in_flow {
                            self.indent_next = self.indent_value + 1;
                        } else if self.flow_key {
                            self.flow_key = false;
                        }
                        n += self.push_count(1);
                        n += self.push_spaces(true);
                        continue;
                    }
                }
                _ => {}
            }
            break;
        }
        n
    }

    fn parse_stream(&mut self) -> State {
        let (mut line_start, line_end) = self.get_line();
        if self.buffer.get(line_start) == Some(&BOM) && line_start < line_end {
            self.push_count(1);
            line_start += 1;
        }
        let line = &self.buffer[line_start..line_end.max(line_start)];
        if line.first() == Some(&0x25) {
            let mut dir_end = line.len() as i64;
            let mut cs = line.iter().position(|unit| *unit == 0x23).map(|at| at as i64);
            while let Some(at) = cs {
                let ch = if at > 0 { line.get(at as usize - 1).copied() } else { None };
                if ch == Some(0x20) || ch == Some(0x09) {
                    dir_end = at - 1;
                    break;
                }
                cs = line[(at as usize + 1)..].iter().position(|unit| *unit == 0x23).map(|p| p as i64 + at + 1);
            }
            loop {
                let ch = if dir_end > 0 { line.get(dir_end as usize - 1).copied() } else { None };
                if ch == Some(0x20) || ch == Some(0x09) {
                    dir_end -= 1;
                } else {
                    break;
                }
            }
            let line_len = line.len() as i64;
            let n = self.push_count(dir_end) + self.push_spaces(true);
            self.push_count(line_len - n);
            // `this.pushNewline()` without `yield*` pushes nothing.
            return State::Stream;
        }
        if self.at_line_end() {
            let line_len = line.len() as i64;
            let sp = self.push_spaces(true);
            self.push_count(line_len - sp);
            self.push_newline();
            return State::Stream;
        }
        self.out.push(Lexeme::Control(DOCUMENT));
        self.parse_line_start()
    }

    fn parse_line_start(&mut self) -> State {
        let ch = self.char_at(0);
        if ch == Some(0x2d) || ch == Some(0x2e) {
            let s: Vec<Option<u16>> = (0..3).map(|k| self.char_at(k)).collect();
            let dashes = s.iter().all(|c| *c == Some(0x2d));
            let dots = s.iter().all(|c| *c == Some(0x2e));
            if (dashes || dots) && is_empty(self.char_at(3)) {
                self.push_count(3);
                self.indent_value = 0;
                self.indent_next = 0;
                return if dashes { State::Doc } else { State::Stream };
            }
        }
        self.indent_value = self.push_spaces(false);
        if self.indent_next > self.indent_value && !is_empty(self.char_at(1)) {
            self.indent_next = self.indent_value;
        }
        self.parse_block_start()
    }

    fn parse_block_start(&mut self) -> State {
        let ch0 = self.char_at(0);
        let ch1 = self.char_at(1);
        if matches!(ch0, Some(0x2d | 0x3f | 0x3a)) && is_empty(ch1) {
            let n = self.push_count(1) + self.push_spaces(true);
            self.indent_next = self.indent_value + 1;
            self.indent_value += n;
            return State::BlockStart;
        }
        State::Doc
    }

    fn parse_document(&mut self) -> State {
        self.push_spaces(true);
        let (line_start, line_end) = self.get_line();
        let line_len = (line_end - line_start) as i64;
        let mut n = self.push_indicators();
        let at = |n: i64| if n < line_len { Some(self.buffer[line_start + n as usize]) } else { None };
        match at(n) {
            Some(0x23) => {
                self.push_count(line_len - n);
                self.push_newline();
                self.parse_line_start()
            }
            None => {
                self.push_newline();
                self.parse_line_start()
            }
            Some(0x7b | 0x5b) => {
                self.push_count(1);
                self.flow_key = false;
                self.flow_level = 1;
                State::Flow
            }
            Some(0x7d | 0x5d) => {
                self.push_count(1);
                State::Doc
            }
            Some(0x2a) => {
                self.push_until(is_not_anchor_char);
                State::Doc
            }
            Some(0x22 | 0x27) => self.parse_quoted_scalar(),
            Some(0x7c | 0x3e) => {
                n += self.parse_block_scalar_header();
                n += self.push_spaces(true);
                self.push_count(line_len - n);
                self.push_newline();
                self.parse_block_scalar()
            }
            _ => self.parse_plain_scalar(),
        }
    }

    fn parse_flow_collection(&mut self) -> State {
        let mut indent: i64 = -1;
        loop {
            let nl = self.push_newline();
            let mut sp;
            if nl > 0 {
                sp = self.push_spaces(false);
                self.indent_value = sp;
                indent = sp;
            } else {
                sp = 0;
            }
            sp += self.push_spaces(true);
            if nl + sp <= 0 {
                break;
            }
        }
        let (line_start, line_end) = self.get_line();
        let line = &self.buffer[line_start..line_end];
        let first = line.first().copied();
        let starts_marker = line.len() >= 3 && (line[..3] == [0x2d, 0x2d, 0x2d] || line[..3] == [0x2e, 0x2e, 0x2e]);
        if (indent != -1 && indent < self.indent_next && first != Some(0x23)) || (indent == 0 && starts_marker && is_empty(line.get(3).copied())) {
            let at_flow_end_marker = indent == self.indent_next - 1 && self.flow_level == 1 && (first == Some(0x5d) || first == Some(0x7d));
            if !at_flow_end_marker {
                self.flow_level = 0;
                self.out.push(Lexeme::Control(FLOW_END));
                return self.parse_line_start();
            }
        }
        let line_len = line.len() as i64;
        let mut n: i64 = 0;
        let at = |buffer: &[u16], n: i64| if n < line_len { Some(buffer[line_start + n as usize]) } else { None };
        while at(self.buffer, n) == Some(0x2c) {
            n += self.push_count(1);
            n += self.push_spaces(true);
            self.flow_key = false;
        }
        n += self.push_indicators();
        match at(self.buffer, n) {
            None => State::Flow,
            Some(0x23) => {
                self.push_count(line_len - n);
                State::Flow
            }
            Some(0x7b | 0x5b) => {
                self.push_count(1);
                self.flow_key = false;
                self.flow_level += 1;
                State::Flow
            }
            Some(0x7d | 0x5d) => {
                self.push_count(1);
                self.flow_key = true;
                self.flow_level -= 1;
                if self.flow_level != 0 { State::Flow } else { State::Doc }
            }
            Some(0x2a) => {
                self.push_until(is_not_anchor_char);
                State::Flow
            }
            Some(0x22 | 0x27) => {
                self.flow_key = true;
                self.parse_quoted_scalar()
            }
            Some(0x3a) => {
                let next = self.char_at(1);
                if self.flow_key || is_empty(next) || next == Some(0x2c) {
                    self.flow_key = false;
                    self.push_count(1);
                    self.push_spaces(true);
                    return State::Flow;
                }
                self.flow_key = false;
                self.parse_plain_scalar()
            }
            _ => {
                self.flow_key = false;
                self.parse_plain_scalar()
            }
        }
    }

    fn index_of(&self, unit: u16, from: i64) -> i64 {
        let from = from.max(0) as usize;
        if from >= self.buffer.len() {
            return -1;
        }
        self.buffer[from..].iter().position(|u| *u == unit).map_or(-1, |at| (at + from) as i64)
    }

    fn parse_quoted_scalar(&mut self) -> State {
        let quote = self.char_at(0).unwrap_or(0);
        let mut end = self.index_of(quote, self.pos as i64 + 1);
        if quote == 0x27 {
            while end != -1 && self.ch(end + 1) == Some(0x27) {
                end = self.index_of(0x27, end + 2);
            }
        } else {
            while end != -1 {
                let mut n = 0;
                while self.ch(end - 1 - n) == Some(0x5c) {
                    n += 1;
                }
                if n % 2 == 0 {
                    break;
                }
                end = self.index_of(0x22, end + 1);
            }
        }
        // qb = buffer.substring(0, end): with end -1 that is ''.
        let qb_len = end.max(0);
        let qb_index_of_nl = |from: i64| -> i64 {
            let from = from.max(0);
            if from >= qb_len {
                return -1;
            }
            self.buffer[from as usize..qb_len as usize]
                .iter()
                .position(|u| *u == 0x0a)
                .map_or(-1, |at| at as i64 + from)
        };
        let mut nl = qb_index_of_nl(self.pos as i64);
        if nl != -1 {
            while nl != -1 {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = qb_index_of_nl(cs);
            }
            if nl != -1 {
                end = nl - if self.ch(nl - 1) == Some(0x0d) { 2 } else { 1 };
            }
        }
        if end == -1 {
            end = self.buffer.len() as i64;
        }
        self.push_to_index(end + 1, false);
        if self.flow_level != 0 { State::Flow } else { State::Doc }
    }

    fn parse_block_scalar_header(&mut self) -> i64 {
        self.block_scalar_indent = -1;
        self.block_scalar_keep = false;
        let mut i = self.pos as i64;
        loop {
            i += 1;
            let ch = self.ch(i);
            if ch == Some(0x2b) {
                self.block_scalar_keep = true;
            } else if let Some(digit @ 0x31..=0x39) = ch {
                self.block_scalar_indent = i64::from(digit - 0x30) - 1;
            } else if ch != Some(0x2d) {
                break;
            }
        }
        self.push_until(|ch| is_empty(ch) || ch == Some(0x23))
    }

    fn parse_block_scalar(&mut self) -> State {
        let mut nl = self.pos as i64 - 1;
        let mut indent: i64 = 0;
        let mut i = self.pos as i64;
        while let Some(ch) = self.ch(i) {
            match ch {
                0x20 => indent += 1,
                0x0a => {
                    nl = i;
                    indent = 0;
                }
                0x0d if self.ch(i + 1) == Some(0x0a) => {}
                _ => break,
            }
            i += 1;
        }
        if indent >= self.indent_next {
            if self.block_scalar_indent == -1 {
                self.indent_next = indent;
            } else {
                self.indent_next = self.block_scalar_indent + if self.indent_next == 0 { 1 } else { self.indent_next };
            }
            loop {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = self.index_of(0x0a, cs);
                if nl == -1 {
                    break;
                }
            }
            if nl == -1 {
                nl = self.buffer.len() as i64;
            }
        }
        let mut i = nl + 1;
        let mut ch = self.ch(i);
        while ch == Some(0x20) {
            i += 1;
            ch = self.ch(i);
        }
        if ch == Some(0x09) {
            while matches!(ch, Some(0x09 | 0x20 | 0x0d | 0x0a)) {
                i += 1;
                ch = self.ch(i);
            }
            nl = i - 1;
        } else if !self.block_scalar_keep {
            loop {
                let mut i = nl - 1;
                let mut ch = self.ch(i);
                if ch == Some(0x0d) {
                    i -= 1;
                    ch = self.ch(i);
                }
                let last_char = i;
                while ch == Some(0x20) {
                    i -= 1;
                    ch = self.ch(i);
                }
                if ch == Some(0x0a) && i >= self.pos as i64 && i + 1 + indent > last_char {
                    nl = i;
                } else {
                    break;
                }
            }
        }
        self.out.push(Lexeme::Control(SCALAR));
        self.push_to_index(nl + 1, true);
        self.parse_line_start()
    }

    fn parse_plain_scalar(&mut self) -> State {
        let in_flow = self.flow_level > 0;
        let mut end = self.pos as i64 - 1;
        let mut i = self.pos as i64 - 1;
        loop {
            i += 1;
            let Some(mut ch) = self.ch(i) else { break };
            if ch == 0x3a {
                let next = self.ch(i + 1);
                if is_empty(next) || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                end = i;
            } else if is_empty(Some(ch)) {
                let mut next = self.ch(i + 1);
                if ch == 0x0d {
                    if next == Some(0x0a) {
                        i += 1;
                        ch = 0x0a;
                        next = self.ch(i + 1);
                    } else {
                        end = i;
                    }
                }
                if next == Some(0x23) || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                if ch == 0x0a {
                    let cs = self.continue_scalar(i + 1);
                    if cs == -1 {
                        break;
                    }
                    i = i.max(cs - 2);
                }
            } else {
                if in_flow && is_flow_indicator(Some(ch)) {
                    break;
                }
                end = i;
            }
        }
        self.out.push(Lexeme::Control(SCALAR));
        self.push_to_index(end + 1, true);
        if in_flow { State::Flow } else { State::Doc }
    }
}

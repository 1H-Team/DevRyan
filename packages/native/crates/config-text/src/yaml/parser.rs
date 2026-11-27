//! `Parser` of yaml 2.9.0 (`dist/parse/parser.js`): lexemes to CST tokens,
//! recording line starts as the `LineCounter` passed by `yaml.parse` does.

use super::cst::{Document, FlowKind, Item, SourceToken, Token, Ty, token_type};
use super::lexer::{Lexeme, Lexer};
use crate::js;

fn includes_token(list: &[SourceToken], ty: Ty) -> bool {
    list.iter().any(|token| token.ty == ty)
}

fn find_non_empty_index(list: &[SourceToken]) -> Option<usize> {
    list.iter().position(|token| !matches!(token.ty, Ty::Space | Ty::Comment | Ty::Newline))
}

/// `getFirstKeyStartProps(prev)`: splices the trailing key properties off `prev`.
fn first_key_start_props(prev: &mut Vec<SourceToken>) -> Vec<SourceToken> {
    if prev.is_empty() {
        return Vec::new();
    }
    let mut i = prev.len() as i64;
    loop {
        i -= 1;
        if i < 0 {
            break;
        }
        if matches!(
            prev[i as usize].ty,
            Ty::DocStart | Ty::ExplicitKeyInd | Ty::MapValueInd | Ty::SeqItemInd | Ty::Newline
        ) {
            break;
        }
    }
    loop {
        i += 1;
        if prev.get(i as usize).map(|token| token.ty) != Some(Ty::Space) {
            break;
        }
    }
    let at = (i.max(0) as usize).min(prev.len());
    prev.split_off(at)
}

/// `getPrevProps(parent)`, or `None` for the fresh empty array of the default case.
fn prev_props(parent: &mut Token) -> Option<&mut Vec<SourceToken>> {
    match parent {
        Token::Document(document) => Some(&mut document.start),
        Token::BlockMap { items, .. } => {
            let it = items.last_mut()?;
            if it.sep.is_some() { it.sep.as_mut() } else { Some(&mut it.start) }
        }
        Token::BlockSeq { items, .. } => items.last_mut().map(|it| &mut it.start),
        _ => None,
    }
}

fn take_first_key_start_props(parent: Option<&mut Token>) -> Vec<SourceToken> {
    match parent.and_then(prev_props) {
        Some(prev) => first_key_start_props(prev),
        None => Vec::new(),
    }
}

/// `fixFlowSeqItems(fc)`.
fn fix_flow_seq_items(token: &mut Token) {
    let Token::FlowCollection { start, items, .. } = token else { return };
    if start.ty != Ty::FlowSeqStart {
        return;
    }
    for it in items.iter_mut() {
        let Some(sep) = &it.sep else { continue };
        if it.value.is_some() || includes_token(&it.start, Ty::ExplicitKeyInd) || includes_token(sep, Ty::MapValueInd) {
            continue;
        }
        if let Some(key) = it.key.take() {
            it.value = Some(key);
        }
        let sep = it.sep.take().unwrap_or_default();
        match it.value.as_deref_mut() {
            Some(value) if value.is_flow_token() => match value {
                Token::FlowCollection { end, .. } => end.extend(sep),
                Token::FlowScalar { end, .. } => match end {
                    Some(end) => end.extend(sep),
                    None => *end = Some(sep),
                },
                _ => {}
            },
            _ => it.start.extend(sep),
        }
    }
}

fn push_end(token: &mut Token, source: SourceToken) {
    match token {
        Token::FlowScalar { end, .. } | Token::DocEnd { end, .. } => end.get_or_insert_with(Vec::new).push(source),
        Token::Document(document) => document.end.get_or_insert_with(Vec::new).push(source),
        Token::FlowCollection { end, .. } => end.push(source),
        _ => {}
    }
}

fn block_map(offset: usize, indent: i64, item: Item) -> Token {
    Token::BlockMap {
        offset,
        indent,
        items: vec![item],
    }
}

pub struct Parser {
    at_new_line: bool,
    at_scalar: bool,
    indent: i64,
    offset: usize,
    on_key_line: bool,
    stack: Vec<Token>,
    again: bool,
    source: Vec<u16>,
    ty: Ty,
    pub line_starts: Vec<usize>,
    pub out: Vec<Token>,
}

impl Parser {
    /// `new Parser(lineCounter.addNewLine).parse(source)`, run to the end.
    pub fn parse(source: &[u16]) -> Parser {
        let mut parser = Parser {
            at_new_line: true,
            at_scalar: false,
            indent: 0,
            offset: 0,
            on_key_line: false,
            stack: Vec::new(),
            again: false,
            source: Vec::new(),
            ty: Ty::Newline,
            line_starts: vec![0],
            out: Vec::new(),
        };
        for lexeme in Lexer::lex(source) {
            let text = match lexeme {
                Lexeme::Control(unit) => vec![unit],
                Lexeme::Text(start, end) => source[start..end].to_vec(),
            };
            parser.next(text);
        }
        while !parser.stack.is_empty() {
            parser.pop(None);
        }
        parser
    }

    fn source_token(&self) -> SourceToken {
        SourceToken {
            ty: self.ty,
            offset: self.offset,
            indent: self.indent,
            source: self.source.clone(),
        }
    }

    fn error(&self, message: String) -> Token {
        Token::Error {
            offset: self.offset,
            message: js::units(&message),
            source: self.source.clone(),
        }
    }

    fn next(&mut self, source: Vec<u16>) {
        let length = source.len();
        self.source = source;
        if self.at_scalar {
            self.at_scalar = false;
            self.step();
            self.offset += length;
            return;
        }
        let Some(ty) = token_type(&self.source) else {
            let message = format!("Not a YAML token: {}", js::lossy(&self.source));
            let error = Token::Error {
                offset: self.offset,
                message: js::units(&message),
                source: self.source.clone(),
            };
            self.pop(Some(error));
            self.offset += length;
            return;
        };
        if ty == Ty::Scalar {
            self.at_new_line = false;
            self.at_scalar = true;
            self.ty = Ty::Scalar;
            return;
        }
        self.ty = ty;
        self.step();
        match ty {
            Ty::Newline => {
                self.at_new_line = true;
                self.indent = 0;
                self.line_starts.push(self.offset + length);
            }
            Ty::Space => {
                if self.at_new_line && self.source.first() == Some(&0x20) {
                    self.indent += length as i64;
                }
            }
            Ty::ExplicitKeyInd | Ty::MapValueInd | Ty::SeqItemInd => {
                if self.at_new_line {
                    self.indent += length as i64;
                }
            }
            Ty::DocMode | Ty::FlowErrorEnd => return,
            _ => self.at_new_line = false,
        }
        self.offset += length;
    }

    /// `step()`: a handler that ends with `pop(); step()` sets `again`, and
    /// the loop runs the next step, so closing many levels at once does not
    /// recurse.
    fn step(&mut self) {
        loop {
            self.again = false;
            self.step_once();
            if !self.again {
                return;
            }
        }
    }

    fn step_once(&mut self) {
        let top_is_doc_end = matches!(self.stack.last(), Some(Token::DocEnd { .. }));
        if self.ty == Ty::DocEnd && !top_is_doc_end {
            while !self.stack.is_empty() {
                self.pop(None);
            }
            self.stack.push(Token::DocEnd {
                offset: self.offset,
                source: self.source.clone(),
                end: None,
            });
            return;
        }
        match self.stack.last() {
            None => self.stream(),
            Some(Token::Document(_)) => self.document(),
            Some(Token::FlowScalar { .. }) => self.scalar(),
            Some(Token::BlockScalar { .. }) => self.block_scalar(),
            Some(Token::BlockMap { .. }) => self.block_map_step(),
            Some(Token::BlockSeq { .. }) => self.block_sequence(),
            Some(Token::FlowCollection { .. }) => self.flow_collection(),
            Some(Token::DocEnd { .. }) => self.document_end(),
            Some(_) => self.pop(None),
        }
    }

    /// The last item of a block collection with only empty lines and
    /// comments moves to the parent (the second half of `pop`).
    fn trailing_start(token: &mut Token) -> Option<Vec<SourceToken>> {
        let (indent, items) = match token {
            Token::BlockMap { indent, items, .. } | Token::BlockSeq { indent, items, .. } => (*indent, items),
            _ => return None,
        };
        let last = items.last()?;
        if last.sep.is_none()
            && last.value.is_none()
            && !last.start.is_empty()
            && find_non_empty_index(&last.start).is_none()
            && (indent == 0 || last.start.iter().all(|st| st.ty != Ty::Comment || st.indent < indent))
        {
            return items.pop().map(|item| item.start);
        }
        None
    }

    fn pop(&mut self, error: Option<Token>) {
        let token = match error {
            Some(token) => token,
            None => match self.stack.pop() {
                Some(token) => token,
                None => {
                    self.out.push(Token::Error {
                        offset: self.offset,
                        message: js::units("Tried to pop an empty stack"),
                        source: Vec::new(),
                    });
                    return;
                }
            },
        };
        let Some(top) = self.stack.last() else {
            self.out.push(token);
            return;
        };
        let mut token = token;
        let top_indent = top.indent();
        let top_is_document = matches!(top, Token::Document(_));
        match &mut token {
            Token::BlockScalar { indent, .. } => *indent = top_indent.unwrap_or(0),
            Token::FlowCollection { indent, .. } if top_is_document => *indent = 0,
            _ => {}
        }
        if matches!(token, Token::FlowCollection { .. }) {
            fix_flow_seq_items(&mut token);
        }
        let len = self.stack.len();
        match &mut self.stack[len - 1] {
            Token::Document(document) => {
                let moved = Self::trailing_start(&mut token);
                document.value = Some(Box::new(token));
                if let Some(start) = moved {
                    document.end = Some(start);
                }
            }
            Token::BlockScalar { props, .. } => props.push(token),
            Token::BlockMap { items, .. } => {
                let Some(it) = items.last_mut() else { return };
                if it.value.is_some() {
                    items.push(Item {
                        key: Some(Box::new(token)),
                        sep: Some(Vec::new()),
                        ..Item::default()
                    });
                    self.on_key_line = true;
                } else if it.sep.is_some() {
                    let moved = Self::trailing_start(&mut token);
                    it.value = Some(Box::new(token));
                    if let Some(start) = moved {
                        items.push(Item { start, ..Item::default() });
                    }
                } else {
                    it.key = Some(Box::new(token));
                    it.sep = Some(Vec::new());
                    self.on_key_line = !it.explicit_key;
                }
            }
            Token::BlockSeq { items, .. } => {
                let moved = Self::trailing_start(&mut token);
                match items.last_mut() {
                    Some(it) if it.value.is_none() => it.value = Some(Box::new(token)),
                    _ => items.push(Item {
                        value: Some(Box::new(token)),
                        ..Item::default()
                    }),
                }
                if let Some(start) = moved {
                    items.push(Item { start, ..Item::default() });
                }
            }
            Token::FlowCollection { items, .. } => match items.last_mut() {
                Some(it) if it.value.is_none() => {
                    if it.sep.is_some() {
                        it.value = Some(Box::new(token));
                    } else {
                        it.key = Some(Box::new(token));
                        it.sep = Some(Vec::new());
                    }
                }
                _ => items.push(Item {
                    key: Some(Box::new(token)),
                    sep: Some(Vec::new()),
                    ..Item::default()
                }),
            },
            _ => {
                self.pop(None);
                self.pop(Some(token));
            }
        }
    }

    fn stream(&mut self) {
        match self.ty {
            Ty::DirectiveLine => {
                self.out.push(Token::Directive {
                    offset: self.offset,
                    source: self.source.clone(),
                });
                return;
            }
            Ty::ByteOrderMark | Ty::Space | Ty::Comment | Ty::Newline => {
                self.out.push(Token::Source(self.source_token()));
                return;
            }
            Ty::DocMode | Ty::DocStart => {
                let mut start = Vec::new();
                if self.ty == Ty::DocStart {
                    start.push(self.source_token());
                }
                self.stack.push(Token::Document(Box::new(Document {
                    offset: self.offset,
                    start,
                    value: None,
                    end: None,
                })));
                return;
            }
            _ => {}
        }
        let error = self.error(format!("Unexpected {} token in YAML stream", self.ty.name()));
        self.out.push(error);
    }

    fn document(&mut self) {
        let len = self.stack.len();
        let token = self.source_token();
        let Token::Document(document) = &mut self.stack[len - 1] else { return };
        if document.value.is_some() {
            self.line_end();
            return;
        }
        match self.ty {
            Ty::DocStart => {
                if find_non_empty_index(&document.start).is_some() {
                    self.pop(None);
                    self.again = true;
                } else {
                    document.start.push(token);
                }
                return;
            }
            Ty::Anchor | Ty::Tag | Ty::Space | Ty::Comment | Ty::Newline => {
                document.start.push(token);
                return;
            }
            _ => {}
        }
        match self.start_block_value() {
            Some(value) => self.stack.push(value),
            None => {
                let error = self.error(format!("Unexpected {} token in YAML document", self.ty.name()));
                self.out.push(error);
            }
        }
    }

    fn scalar(&mut self) {
        if self.ty != Ty::MapValueInd {
            self.line_end();
            return;
        }
        let len = self.stack.len();
        let start = if len >= 2 {
            take_first_key_start_props(self.stack.get_mut(len - 2))
        } else {
            Vec::new()
        };
        let Some(mut scalar) = self.stack.pop() else { return };
        let mut sep = match &mut scalar {
            Token::FlowScalar { end, .. } => end.take().unwrap_or_default(),
            _ => Vec::new(),
        };
        sep.push(self.source_token());
        let (offset, indent) = (scalar.offset(), scalar.indent().unwrap_or(0));
        let map = block_map(
            offset,
            indent,
            Item {
                start,
                key: Some(Box::new(scalar)),
                sep: Some(sep),
                ..Item::default()
            },
        );
        self.on_key_line = true;
        self.stack.push(map);
    }

    fn block_scalar(&mut self) {
        match self.ty {
            Ty::Space | Ty::Comment | Ty::Newline => {
                let token = self.source_token();
                if let Some(Token::BlockScalar { props, .. }) = self.stack.last_mut() {
                    props.push(Token::Source(token));
                }
            }
            Ty::Scalar => {
                let text = self.source.clone();
                if let Some(Token::BlockScalar { source, .. }) = self.stack.last_mut() {
                    *source = text.clone();
                }
                self.at_new_line = true;
                self.indent = 0;
                self.record_newlines(&text);
                self.pop(None);
            }
            _ => {
                self.pop(None);
                self.again = true;
            }
        }
    }

    fn record_newlines(&mut self, text: &[u16]) {
        for (index, unit) in text.iter().enumerate() {
            if *unit == 0x0a {
                self.line_starts.push(self.offset + index + 1);
            }
        }
    }

    fn at_indented_comment(&self, start: &[SourceToken], indent: i64) -> bool {
        if self.ty != Ty::Comment || self.indent <= indent {
            return false;
        }
        start.iter().all(|st| st.ty == Ty::Newline || st.ty == Ty::Space)
    }

    /// The newline, space and comment cases shared by block maps and
    /// sequences; true when handled.
    fn block_trivia(&mut self, is_map: bool) -> bool {
        let len = self.stack.len();
        let token = self.source_token();
        let ty = self.ty;
        let at_indented = {
            let (Token::BlockMap { items, indent, .. } | Token::BlockSeq { items, indent, .. }) = &self.stack[len - 1] else {
                return false;
            };
            let it = &items[items.len() - 1];
            self.at_indented_comment(&it.start, *indent)
        };
        let (Token::BlockMap { items, .. } | Token::BlockSeq { items, .. }) = &mut self.stack[len - 1] else {
            return false;
        };
        let count = items.len();
        match ty {
            Ty::Newline => {
                if is_map {
                    self.on_key_line = false;
                }
                let it = &mut items[count - 1];
                if let Some(value) = it.value.as_deref_mut() {
                    let end = value.end_mut();
                    match end {
                        Some(end) if end.last().map(|st| st.ty) == Some(Ty::Comment) => end.push(token),
                        _ => items.push(Item {
                            start: vec![token],
                            ..Item::default()
                        }),
                    }
                } else if is_map && it.sep.is_some() {
                    it.sep.get_or_insert_with(Vec::new).push(token);
                } else {
                    it.start.push(token);
                }
                true
            }
            Ty::Space | Ty::Comment => {
                let it = &mut items[count - 1];
                if it.value.is_some() {
                    items.push(Item {
                        start: vec![token],
                        ..Item::default()
                    });
                } else if is_map && it.sep.is_some() {
                    it.sep.get_or_insert_with(Vec::new).push(token);
                } else {
                    if at_indented && count >= 2 {
                        let moved = std::mem::take(&mut items[count - 1].start);
                        let previous = &mut items[count - 2];
                        if let Some(end) = previous.value.as_deref_mut().and_then(Token::end_mut) {
                            end.extend(moved);
                            end.push(token);
                            items.pop();
                            return true;
                        }
                        items[count - 1].start = moved;
                    }
                    items[count - 1].start.push(token);
                }
                true
            }
            _ => false,
        }
    }

    fn block_map_step(&mut self) {
        if self.block_trivia(true) {
            return;
        }
        let len = self.stack.len();
        let token = self.source_token();
        let Token::BlockMap {
            indent: map_indent,
            offset: _,
            items,
        } = &mut self.stack[len - 1]
        else {
            return;
        };
        let map_indent = *map_indent;
        if self.indent >= map_indent {
            let at_map_indent = !self.on_key_line && self.indent == map_indent;
            let last = items.len() - 1;
            let at_next_item = at_map_indent && (items[last].sep.is_some() || items[last].explicit_key) && self.ty != Ty::SeqItemInd;
            let mut start: Vec<SourceToken> = Vec::new();
            if at_next_item
                && items[last].value.is_none()
                && let Some(sep) = items[last].sep.as_mut()
            {
                let mut nl: Vec<usize> = Vec::new();
                for (i, st) in sep.iter().enumerate() {
                    match st.ty {
                        Ty::Newline => nl.push(i),
                        Ty::Space => {}
                        Ty::Comment => {
                            if st.indent > map_indent {
                                nl.clear();
                            }
                        }
                        _ => nl.clear(),
                    }
                }
                if nl.len() >= 2 {
                    start = sep.split_off(nl[1]);
                }
            }
            match self.ty {
                Ty::Anchor | Ty::Tag => {
                    let it = &mut items[last];
                    if at_next_item || it.value.is_some() {
                        start.push(token);
                        items.push(Item { start, ..Item::default() });
                        self.on_key_line = true;
                    } else if let Some(sep) = it.sep.as_mut() {
                        sep.push(token);
                    } else {
                        it.start.push(token);
                    }
                    return;
                }
                Ty::ExplicitKeyInd => {
                    let it = &mut items[last];
                    if it.sep.is_none() && !it.explicit_key {
                        it.start.push(token);
                        it.explicit_key = true;
                    } else if at_next_item || it.value.is_some() {
                        start.push(token);
                        items.push(Item {
                            start,
                            explicit_key: true,
                            ..Item::default()
                        });
                    } else {
                        let map = block_map(
                            self.offset,
                            self.indent,
                            Item {
                                start: vec![token],
                                explicit_key: true,
                                ..Item::default()
                            },
                        );
                        self.stack.push(map);
                    }
                    self.on_key_line = true;
                    return;
                }
                Ty::MapValueInd => {
                    let (offset, indent) = (self.offset, self.indent);
                    let it = &mut items[last];
                    if it.explicit_key {
                        if it.sep.is_none() {
                            if includes_token(&it.start, Ty::Newline) {
                                it.key = None;
                                it.sep = Some(vec![token]);
                            } else {
                                let start = first_key_start_props(&mut it.start);
                                self.stack.push(block_map(
                                    offset,
                                    indent,
                                    Item {
                                        start,
                                        key: None,
                                        sep: Some(vec![token]),
                                        ..Item::default()
                                    },
                                ));
                            }
                        } else if it.value.is_some() {
                            items.push(Item {
                                key: None,
                                sep: Some(vec![token]),
                                ..Item::default()
                            });
                        } else if includes_token(it.sep.as_deref().unwrap_or_default(), Ty::MapValueInd) {
                            self.stack.push(block_map(
                                offset,
                                indent,
                                Item {
                                    start,
                                    key: None,
                                    sep: Some(vec![token]),
                                    ..Item::default()
                                },
                            ));
                        } else if it.key.as_deref().is_some_and(Token::is_flow_token) && !includes_token(it.sep.as_deref().unwrap_or_default(), Ty::Newline) {
                            let start = first_key_start_props(&mut it.start);
                            let key = it.key.take();
                            let mut sep = it.sep.take().unwrap_or_default();
                            sep.push(token);
                            self.stack.push(block_map(
                                offset,
                                indent,
                                Item {
                                    start,
                                    key,
                                    sep: Some(sep),
                                    ..Item::default()
                                },
                            ));
                        } else if !start.is_empty() {
                            let sep = it.sep.get_or_insert_with(Vec::new);
                            sep.extend(start);
                            sep.push(token);
                        } else {
                            it.sep.get_or_insert_with(Vec::new).push(token);
                        }
                    } else if it.sep.is_none() {
                        it.key = None;
                        it.sep = Some(vec![token]);
                    } else if it.value.is_some() || at_next_item {
                        items.push(Item {
                            start,
                            key: None,
                            sep: Some(vec![token]),
                            ..Item::default()
                        });
                    } else if includes_token(it.sep.as_deref().unwrap_or_default(), Ty::MapValueInd) {
                        self.stack.push(block_map(
                            offset,
                            indent,
                            Item {
                                key: None,
                                sep: Some(vec![token]),
                                ..Item::default()
                            },
                        ));
                    } else {
                        it.sep.get_or_insert_with(Vec::new).push(token);
                    }
                    self.on_key_line = true;
                    return;
                }
                Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar => {
                    let fs = self.flow_scalar();
                    let len = self.stack.len();
                    let Token::BlockMap { items, .. } = &mut self.stack[len - 1] else { return };
                    let it = &mut items[last];
                    if at_next_item || it.value.is_some() {
                        items.push(Item {
                            start,
                            key: Some(Box::new(fs)),
                            sep: Some(Vec::new()),
                            ..Item::default()
                        });
                        self.on_key_line = true;
                    } else if it.sep.is_some() {
                        self.stack.push(fs);
                    } else {
                        it.key = Some(Box::new(fs));
                        it.sep = Some(Vec::new());
                        self.on_key_line = true;
                    }
                    return;
                }
                _ => {
                    if let Some(bv) = self.start_block_value() {
                        let len = self.stack.len();
                        let Token::BlockMap { items, .. } = &mut self.stack[len - 1] else { return };
                        if matches!(bv, Token::BlockSeq { .. }) {
                            let it = &items[last];
                            if !it.explicit_key && it.sep.as_deref().is_some_and(|sep| !includes_token(sep, Ty::Newline)) {
                                let error = self.error("Unexpected block-seq-ind on same line with key".to_owned());
                                self.pop(Some(error));
                                return;
                            }
                        } else if at_map_indent {
                            items.push(Item { start, ..Item::default() });
                        }
                        self.stack.push(bv);
                        return;
                    }
                }
            }
        }
        self.pop(None);
        self.again = true;
    }

    fn block_sequence(&mut self) {
        if self.block_trivia(false) {
            return;
        }
        let len = self.stack.len();
        let token = self.source_token();
        let Token::BlockSeq { indent: seq_indent, items, .. } = &mut self.stack[len - 1] else {
            return;
        };
        let seq_indent = *seq_indent;
        let last = items.len() - 1;
        match self.ty {
            Ty::Anchor | Ty::Tag => {
                if !(items[last].value.is_some() || self.indent <= seq_indent) {
                    items[last].start.push(token);
                    return;
                }
            }
            Ty::SeqItemInd if self.indent == seq_indent => {
                let it = &mut items[last];
                if it.value.is_some() || includes_token(&it.start, Ty::SeqItemInd) {
                    items.push(Item {
                        start: vec![token],
                        ..Item::default()
                    });
                } else {
                    it.start.push(token);
                }
                return;
            }
            _ => {}
        }
        if self.indent > seq_indent
            && let Some(bv) = self.start_block_value()
        {
            self.stack.push(bv);
            return;
        }
        self.pop(None);
        self.again = true;
    }

    fn flow_collection(&mut self) {
        let len = self.stack.len();
        if self.ty == Ty::FlowErrorEnd {
            loop {
                self.pop(None);
                if !matches!(self.stack.last(), Some(Token::FlowCollection { .. })) {
                    break;
                }
            }
            return;
        }
        let token = self.source_token();
        let Token::FlowCollection { items, end, .. } = &mut self.stack[len - 1] else {
            return;
        };
        if end.is_empty() {
            let it = items.last_mut();
            match self.ty {
                Ty::Comma | Ty::ExplicitKeyInd => {
                    match it {
                        Some(it) if it.sep.is_none() => it.start.push(token),
                        _ => items.push(Item {
                            start: vec![token],
                            ..Item::default()
                        }),
                    }
                    return;
                }
                Ty::MapValueInd => {
                    match it {
                        Some(it) if it.value.is_none() => {
                            if let Some(sep) = it.sep.as_mut() {
                                sep.push(token);
                            } else {
                                it.key = None;
                                it.sep = Some(vec![token]);
                            }
                        }
                        _ => items.push(Item {
                            key: None,
                            sep: Some(vec![token]),
                            ..Item::default()
                        }),
                    }
                    return;
                }
                Ty::Space | Ty::Comment | Ty::Newline | Ty::Anchor | Ty::Tag => {
                    match it {
                        Some(it) if it.value.is_none() => {
                            if let Some(sep) = it.sep.as_mut() {
                                sep.push(token);
                            } else {
                                it.start.push(token);
                            }
                        }
                        _ => items.push(Item {
                            start: vec![token],
                            ..Item::default()
                        }),
                    }
                    return;
                }
                Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar => {
                    let fs = self.flow_scalar();
                    let Token::FlowCollection { items, .. } = &mut self.stack[len - 1] else {
                        return;
                    };
                    match items.last_mut() {
                        Some(it) if it.value.is_none() => {
                            if it.sep.is_some() {
                                self.stack.push(fs);
                            } else {
                                it.key = Some(Box::new(fs));
                                it.sep = Some(Vec::new());
                            }
                        }
                        _ => items.push(Item {
                            key: Some(Box::new(fs)),
                            sep: Some(Vec::new()),
                            ..Item::default()
                        }),
                    }
                    return;
                }
                Ty::FlowMapEnd | Ty::FlowSeqEnd => {
                    end.push(token);
                    return;
                }
                _ => {}
            }
            match self.start_block_value() {
                Some(bv) => self.stack.push(bv),
                None => {
                    self.pop(None);
                    self.again = true;
                }
            }
            return;
        }
        let (fc_indent, fc_offset) = match &self.stack[len - 1] {
            Token::FlowCollection { indent, offset, .. } => (*indent, *offset),
            _ => return,
        };
        let parent = if len >= 2 { self.stack.get(len - 2) } else { None };
        let parent_is_map = matches!(parent, Some(Token::BlockMap { .. }));
        let parent_indent = parent.and_then(Token::indent);
        let parent_last_has_sep = match parent {
            Some(Token::BlockMap { items, .. }) => items.last().is_some_and(|it| it.sep.is_some()),
            _ => false,
        };
        let parent_is_flow = matches!(parent, Some(Token::FlowCollection { .. }));
        if parent_is_map && ((self.ty == Ty::MapValueInd && parent_indent == Some(fc_indent)) || (self.ty == Ty::Newline && !parent_last_has_sep)) {
            self.pop(None);
            self.again = true;
        } else if self.ty == Ty::MapValueInd && !parent_is_flow {
            let start = if len >= 2 {
                take_first_key_start_props(self.stack.get_mut(len - 2))
            } else {
                Vec::new()
            };
            let Some(mut fc) = self.stack.pop() else { return };
            fix_flow_seq_items(&mut fc);
            let mut sep = match &mut fc {
                Token::FlowCollection { end, .. } => {
                    if end.len() > 1 {
                        end.split_off(1)
                    } else {
                        Vec::new()
                    }
                }
                _ => Vec::new(),
            };
            sep.push(token);
            let map = block_map(
                fc_offset,
                fc_indent,
                Item {
                    start,
                    key: Some(Box::new(fc)),
                    sep: Some(sep),
                    ..Item::default()
                },
            );
            self.on_key_line = true;
            self.stack.push(map);
        } else {
            self.line_end();
        }
    }

    fn flow_scalar(&mut self) -> Token {
        let text = self.source.clone();
        self.record_newlines(&text);
        let kind = match self.ty {
            Ty::Alias => FlowKind::Alias,
            Ty::SingleQuotedScalar => FlowKind::Single,
            Ty::DoubleQuotedScalar => FlowKind::Double,
            _ => FlowKind::Plain,
        };
        Token::FlowScalar {
            kind,
            offset: self.offset,
            indent: self.indent,
            source: text,
            end: None,
        }
    }

    /// `startBlockValue(parent)` where `parent` is the stack top.
    fn start_block_value(&mut self) -> Option<Token> {
        match self.ty {
            Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar => Some(self.flow_scalar()),
            Ty::BlockScalarHeader => Some(Token::BlockScalar {
                offset: self.offset,
                indent: self.indent,
                props: vec![Token::Source(self.source_token())],
                source: Vec::new(),
            }),
            Ty::FlowMapStart | Ty::FlowSeqStart => Some(Token::FlowCollection {
                offset: self.offset,
                indent: self.indent,
                start: self.source_token(),
                items: Vec::new(),
                end: Vec::new(),
            }),
            Ty::SeqItemInd => Some(Token::BlockSeq {
                offset: self.offset,
                indent: self.indent,
                items: vec![Item {
                    start: vec![self.source_token()],
                    ..Item::default()
                }],
            }),
            Ty::ExplicitKeyInd => {
                self.on_key_line = true;
                let mut start = take_first_key_start_props(self.stack.last_mut());
                start.push(self.source_token());
                Some(block_map(
                    self.offset,
                    self.indent,
                    Item {
                        start,
                        explicit_key: true,
                        ..Item::default()
                    },
                ))
            }
            Ty::MapValueInd => {
                self.on_key_line = true;
                let start = take_first_key_start_props(self.stack.last_mut());
                let sep = vec![self.source_token()];
                Some(block_map(
                    self.offset,
                    self.indent,
                    Item {
                        start,
                        key: None,
                        sep: Some(sep),
                        ..Item::default()
                    },
                ))
            }
            _ => None,
        }
    }

    fn document_end(&mut self) {
        if self.ty == Ty::DocMode {
            return;
        }
        let token = self.source_token();
        if let Some(top) = self.stack.last_mut() {
            push_end(top, token);
        }
        if self.ty == Ty::Newline {
            self.pop(None);
        }
    }

    fn line_end(&mut self) {
        match self.ty {
            Ty::Comma | Ty::DocStart | Ty::DocEnd | Ty::FlowSeqEnd | Ty::FlowMapEnd | Ty::MapValueInd => {
                self.pop(None);
                self.again = true;
            }
            _ => {
                if self.ty == Ty::Newline {
                    self.on_key_line = false;
                }
                let token = self.source_token();
                if let Some(top) = self.stack.last_mut() {
                    push_end(top, token);
                }
                if self.ty == Ty::Newline {
                    self.pop(None);
                }
            }
        }
    }
}

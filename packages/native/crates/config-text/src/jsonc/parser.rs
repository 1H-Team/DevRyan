//! `visit`, `parse` and `parseTree` of jsonc-parser 3.3.1
//! (`lib/umd/impl/parser.js`), for the options the server and `modify` pass:
//! comments allowed, empty content refused, trailing commas as given.

use super::scanner::{Kind, ScanError, Scanner};
use crate::Refused;
use crate::value::{Graph, Val};

/// A literal the scanner produced.
#[derive(Clone, Debug)]
pub enum Literal {
    String(Vec<u16>),
    Number(f64),
    Null,
    Bool(bool),
}

/// The callbacks `visit` makes, with the token's offset and length.
pub trait Visitor {
    fn object_begin(&mut self, offset: usize, length: usize);
    fn object_property(&mut self, name: &[u16], offset: usize, length: usize);
    fn object_end(&mut self, offset: usize, length: usize);
    fn array_begin(&mut self, offset: usize, length: usize);
    fn array_end(&mut self, offset: usize, length: usize);
    fn literal(&mut self, value: Literal, offset: usize, length: usize);
    fn separator(&mut self, separator: u8, offset: usize, length: usize);
    fn error(&mut self, code: u32, offset: usize, length: usize);
}

struct Visit<'a, 'v, V: Visitor> {
    scanner: Scanner<'a>,
    visitor: &'v mut V,
    allow_trailing_comma: bool,
}

impl<V: Visitor> Visit<'_, '_, V> {
    fn on_error(&mut self, code: u32) {
        let (offset, length) = (self.scanner.token_offset(), self.scanner.token_length());
        self.visitor.error(code, offset, length);
    }

    fn scan_next(&mut self) -> Kind {
        loop {
            let token = self.scanner.scan();
            match self.scanner.error() {
                ScanError::InvalidUnicode => self.handle_error(14, &[], &[]),
                ScanError::InvalidEscapeCharacter => self.handle_error(15, &[], &[]),
                ScanError::UnexpectedEndOfNumber => self.handle_error(13, &[], &[]),
                ScanError::UnexpectedEndOfComment => self.handle_error(11, &[], &[]),
                ScanError::UnexpectedEndOfString => self.handle_error(12, &[], &[]),
                ScanError::InvalidCharacter => self.handle_error(16, &[], &[]),
                ScanError::None => {}
            }
            match token {
                Kind::LineComment | Kind::BlockComment => {}
                Kind::Unknown => self.handle_error(1, &[], &[]),
                Kind::Trivia | Kind::LineBreak => {}
                _ => return token,
            }
        }
    }

    fn handle_error(&mut self, code: u32, skip_until_after: &[Kind], skip_until: &[Kind]) {
        self.on_error(code);
        if skip_until_after.len() + skip_until.len() > 0 {
            let mut token = self.scanner.token();
            while token != Kind::Eof {
                if skip_until_after.contains(&token) {
                    self.scan_next();
                    break;
                } else if skip_until.contains(&token) {
                    break;
                }
                token = self.scan_next();
            }
        }
    }

    fn offsets(&self) -> (usize, usize) {
        (self.scanner.token_offset(), self.scanner.token_length())
    }

    fn parse_string(&mut self, is_value: bool) -> bool {
        let value = self.scanner.value().to_vec();
        let (offset, length) = self.offsets();
        if is_value {
            self.visitor.literal(Literal::String(value), offset, length);
        } else {
            self.visitor.object_property(&value, offset, length);
        }
        self.scan_next();
        true
    }

    fn parse_literal(&mut self) -> bool {
        let (offset, length) = self.offsets();
        match self.scanner.token() {
            Kind::Number => {
                let text = crate::js::lossy(self.scanner.value());
                let value = match crate::js::parse_decimal(&text) {
                    Some(value) => value,
                    None => {
                        self.handle_error(2, &[], &[]);
                        0.0
                    }
                };
                self.visitor.literal(Literal::Number(value), offset, length);
            }
            Kind::Null => self.visitor.literal(Literal::Null, offset, length),
            Kind::True => self.visitor.literal(Literal::Bool(true), offset, length),
            Kind::False => self.visitor.literal(Literal::Bool(false), offset, length),
            _ => return false,
        }
        self.scan_next();
        true
    }

    fn parse_property(&mut self) -> bool {
        if self.scanner.token() != Kind::String {
            self.handle_error(3, &[], &[Kind::CloseBrace, Kind::Comma]);
            return false;
        }
        self.parse_string(false);
        if self.scanner.token() == Kind::Colon {
            let (offset, length) = self.offsets();
            self.visitor.separator(b':', offset, length);
            self.scan_next();
            if !self.parse_value() {
                self.handle_error(4, &[], &[Kind::CloseBrace, Kind::Comma]);
            }
        } else {
            self.handle_error(5, &[], &[Kind::CloseBrace, Kind::Comma]);
        }
        true
    }

    fn parse_object(&mut self) -> bool {
        let (offset, length) = self.offsets();
        self.visitor.object_begin(offset, length);
        self.scan_next();
        let mut needs_comma = false;
        while self.scanner.token() != Kind::CloseBrace && self.scanner.token() != Kind::Eof {
            if self.scanner.token() == Kind::Comma {
                if !needs_comma {
                    self.handle_error(4, &[], &[]);
                }
                let (offset, length) = self.offsets();
                self.visitor.separator(b',', offset, length);
                self.scan_next();
                if self.scanner.token() == Kind::CloseBrace && self.allow_trailing_comma {
                    break;
                }
            } else if needs_comma {
                self.handle_error(6, &[], &[]);
            }
            if !self.parse_property() {
                self.handle_error(4, &[], &[Kind::CloseBrace, Kind::Comma]);
            }
            needs_comma = true;
        }
        let (offset, length) = self.offsets();
        self.visitor.object_end(offset, length);
        if self.scanner.token() != Kind::CloseBrace {
            self.handle_error(7, &[Kind::CloseBrace], &[]);
        } else {
            self.scan_next();
        }
        true
    }

    fn parse_array(&mut self) -> bool {
        let (offset, length) = self.offsets();
        self.visitor.array_begin(offset, length);
        self.scan_next();
        let mut needs_comma = false;
        while self.scanner.token() != Kind::CloseBracket && self.scanner.token() != Kind::Eof {
            if self.scanner.token() == Kind::Comma {
                if !needs_comma {
                    self.handle_error(4, &[], &[]);
                }
                let (offset, length) = self.offsets();
                self.visitor.separator(b',', offset, length);
                self.scan_next();
                if self.scanner.token() == Kind::CloseBracket && self.allow_trailing_comma {
                    break;
                }
            } else if needs_comma {
                self.handle_error(6, &[], &[]);
            }
            if !self.parse_value() {
                self.handle_error(4, &[], &[Kind::CloseBracket, Kind::Comma]);
            }
            needs_comma = true;
        }
        let (offset, length) = self.offsets();
        self.visitor.array_end(offset, length);
        if self.scanner.token() != Kind::CloseBracket {
            self.handle_error(8, &[Kind::CloseBracket], &[]);
        } else {
            self.scan_next();
        }
        true
    }

    fn parse_value(&mut self) -> bool {
        match self.scanner.token() {
            Kind::OpenBracket => self.parse_array(),
            Kind::OpenBrace => self.parse_object(),
            Kind::String => self.parse_string(true),
            _ => self.parse_literal(),
        }
    }
}

/// `visit(text, visitor, { allowTrailingComma })`.
///
/// The recursion follows the nesting of the text, as the JavaScript does;
/// `parse` and `parse_tree` refuse texts nested deeper than `MAX_DEPTH`
/// before they get here, so no input exhausts the stack.
pub fn visit<V: Visitor>(text: &[u16], visitor: &mut V, allow_trailing_comma: bool) {
    let mut state = Visit {
        scanner: Scanner::new(text),
        visitor,
        allow_trailing_comma,
    };
    state.scan_next();
    if state.scanner.token() == Kind::Eof {
        state.handle_error(4, &[], &[]);
        return;
    }
    if !state.parse_value() {
        state.handle_error(4, &[], &[]);
        return;
    }
    if state.scanner.token() != Kind::Eof {
        state.handle_error(9, &[], &[]);
    }
}

/// The deepest nesting `parse`, `parse_tree` and the edits accept. Node's own
/// limit is its stack (about ten thousand levels); deeper texts are refused
/// here (`TOO_DEEP`) rather than reproduced.
pub const MAX_DEPTH: usize = 512;

/// The most `{` and `[` tokens open at once, as the scanner sees them.
pub fn nesting_depth(text: &[u16]) -> usize {
    let mut scanner = Scanner::new(text);
    let (mut depth, mut deepest) = (0usize, 0usize);
    loop {
        match scanner.scan() {
            Kind::OpenBrace | Kind::OpenBracket => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            Kind::CloseBrace | Kind::CloseBracket => depth = depth.saturating_sub(1),
            Kind::Eof => return deepest,
            _ => {}
        }
    }
}

/// One entry of the `errors` array: `{ error, offset, length }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub error: u32,
    pub offset: usize,
    pub length: usize,
}

struct ParseVisitor<'g> {
    graph: &'g mut Graph,
    /// `currentParent`: `None` is the artificial root array.
    current: Option<usize>,
    property: Option<Vec<u16>>,
    parents: Vec<Option<usize>>,
    root: Val,
    root_set: bool,
    errors: Vec<ParseError>,
}

impl ParseVisitor<'_> {
    fn on_value(&mut self, value: Val) {
        match self.current {
            None => {
                // The root array keeps only its first element (`currentParent[0]`).
                if !self.root_set {
                    self.root = value;
                    self.root_set = true;
                }
            }
            Some(id) => match self.graph.node(id) {
                crate::value::Node::Array(_) => self.graph.push(id, value),
                crate::value::Node::Object(_) => {
                    if let Some(property) = self.property.clone() {
                        self.graph.assign(id, property, value);
                    }
                }
            },
        }
    }
}

impl Visitor for ParseVisitor<'_> {
    fn object_begin(&mut self, _offset: usize, _length: usize) {
        let id = self.graph.object();
        self.on_value(Val::Ref(id));
        self.parents.push(self.current);
        self.current = Some(id);
        self.property = None;
    }
    fn object_property(&mut self, name: &[u16], _offset: usize, _length: usize) {
        self.property = Some(name.to_vec());
    }
    fn object_end(&mut self, _offset: usize, _length: usize) {
        self.current = self.parents.pop().unwrap_or(None);
    }
    fn array_begin(&mut self, _offset: usize, _length: usize) {
        let id = self.graph.array();
        self.on_value(Val::Ref(id));
        self.parents.push(self.current);
        self.current = Some(id);
        self.property = None;
    }
    fn array_end(&mut self, _offset: usize, _length: usize) {
        self.current = self.parents.pop().unwrap_or(None);
    }
    fn literal(&mut self, value: Literal, _offset: usize, _length: usize) {
        let value = match value {
            Literal::String(text) => Val::String(text),
            Literal::Number(x) => Val::Number(x),
            Literal::Null => Val::Null,
            Literal::Bool(flag) => Val::Bool(flag),
        };
        self.on_value(value);
    }
    fn separator(&mut self, _separator: u8, _offset: usize, _length: usize) {}
    fn error(&mut self, code: u32, offset: usize, length: usize) {
        self.errors.push(ParseError { error: code, offset, length });
    }
}

/// The refusal for a text nested deeper than `MAX_DEPTH`.
pub const TOO_DEEP: Refused = Refused("JSONC nested deeper than jsonc::MAX_DEPTH");

/// `parse(text, errors, { allowTrailingComma })`: the value (undefined when
/// the text holds none) in `graph`, and the errors in order.
pub fn parse(text: &[u16], graph: &mut Graph, allow_trailing_comma: bool) -> Result<(Val, Vec<ParseError>), Refused> {
    if nesting_depth(text) > MAX_DEPTH {
        return Err(TOO_DEEP);
    }
    let mut visitor = ParseVisitor {
        graph,
        current: None,
        property: None,
        parents: Vec::new(),
        root: Val::Undefined,
        errors: Vec::new(),
        root_set: false,
    };
    visit(text, &mut visitor, allow_trailing_comma);
    Ok((visitor.root, visitor.errors))
}

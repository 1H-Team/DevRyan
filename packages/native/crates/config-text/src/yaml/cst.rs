//! The concrete syntax tree of yaml 2.9.0 (`dist/parse/cst.js`, the token
//! objects `dist/parse/parser.js` builds).

/// `tokenType(source)` and the CST token types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    ByteOrderMark,
    DocMode,
    FlowErrorEnd,
    Scalar,
    DocStart,
    DocEnd,
    Newline,
    SeqItemInd,
    ExplicitKeyInd,
    MapValueInd,
    FlowMapStart,
    FlowMapEnd,
    FlowSeqStart,
    FlowSeqEnd,
    Comma,
    Space,
    Comment,
    DirectiveLine,
    Alias,
    Anchor,
    Tag,
    SingleQuotedScalar,
    DoubleQuotedScalar,
    BlockScalarHeader,
}

impl Ty {
    pub fn name(self) -> &'static str {
        match self {
            Ty::ByteOrderMark => "byte-order-mark",
            Ty::DocMode => "doc-mode",
            Ty::FlowErrorEnd => "flow-error-end",
            Ty::Scalar => "scalar",
            Ty::DocStart => "doc-start",
            Ty::DocEnd => "doc-end",
            Ty::Newline => "newline",
            Ty::SeqItemInd => "seq-item-ind",
            Ty::ExplicitKeyInd => "explicit-key-ind",
            Ty::MapValueInd => "map-value-ind",
            Ty::FlowMapStart => "flow-map-start",
            Ty::FlowMapEnd => "flow-map-end",
            Ty::FlowSeqStart => "flow-seq-start",
            Ty::FlowSeqEnd => "flow-seq-end",
            Ty::Comma => "comma",
            Ty::Space => "space",
            Ty::Comment => "comment",
            Ty::DirectiveLine => "directive-line",
            Ty::Alias => "alias",
            Ty::Anchor => "anchor",
            Ty::Tag => "tag",
            Ty::SingleQuotedScalar => "single-quoted-scalar",
            Ty::DoubleQuotedScalar => "double-quoted-scalar",
            Ty::BlockScalarHeader => "block-scalar-header",
        }
    }
}

/// `tokenType(source)`.
pub fn token_type(source: &[u16]) -> Option<Ty> {
    match source {
        [0xfeff] => return Some(Ty::ByteOrderMark),
        [0x02] => return Some(Ty::DocMode),
        [0x18] => return Some(Ty::FlowErrorEnd),
        [0x1f] => return Some(Ty::Scalar),
        [0x2d, 0x2d, 0x2d] => return Some(Ty::DocStart),
        [0x2e, 0x2e, 0x2e] => return Some(Ty::DocEnd),
        [] | [0x0a] | [0x0d, 0x0a] => return Some(Ty::Newline),
        [0x2d] => return Some(Ty::SeqItemInd),
        [0x3f] => return Some(Ty::ExplicitKeyInd),
        [0x3a] => return Some(Ty::MapValueInd),
        [0x7b] => return Some(Ty::FlowMapStart),
        [0x7d] => return Some(Ty::FlowMapEnd),
        [0x5b] => return Some(Ty::FlowSeqStart),
        [0x5d] => return Some(Ty::FlowSeqEnd),
        [0x2c] => return Some(Ty::Comma),
        _ => {}
    }
    Some(match source.first()? {
        0x20 | 0x09 => Ty::Space,
        0x23 => Ty::Comment,
        0x25 => Ty::DirectiveLine,
        0x2a => Ty::Alias,
        0x26 => Ty::Anchor,
        0x21 => Ty::Tag,
        0x27 => Ty::SingleQuotedScalar,
        0x22 => Ty::DoubleQuotedScalar,
        0x7c | 0x3e => Ty::BlockScalarHeader,
        _ => return None,
    })
}

/// `{ type, offset, indent, source }`.
#[derive(Clone, Debug)]
pub struct SourceToken {
    pub ty: Ty,
    pub offset: usize,
    pub indent: i64,
    pub source: Vec<u16>,
}

/// A collection item: `{ start, explicitKey?, key?, sep?, value? }`.
#[derive(Debug, Default)]
pub struct Item {
    pub start: Vec<SourceToken>,
    pub explicit_key: bool,
    pub key: Option<Box<Token>>,
    pub sep: Option<Vec<SourceToken>>,
    pub value: Option<Box<Token>>,
}

/// The flow scalar kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowKind {
    Alias,
    Plain,
    Single,
    Double,
}

impl FlowKind {
    pub fn ty(self) -> Ty {
        match self {
            FlowKind::Alias => Ty::Alias,
            FlowKind::Plain => Ty::Scalar,
            FlowKind::Single => Ty::SingleQuotedScalar,
            FlowKind::Double => Ty::DoubleQuotedScalar,
        }
    }
}

#[derive(Debug)]
pub struct Document {
    pub offset: usize,
    pub start: Vec<SourceToken>,
    pub value: Option<Box<Token>>,
    pub end: Option<Vec<SourceToken>>,
}

/// Every token the parser yields or nests.
#[derive(Debug)]
pub enum Token {
    /// A plain source token (byte-order mark, space, comment, newline).
    Source(SourceToken),
    Error {
        offset: usize,
        message: Vec<u16>,
        source: Vec<u16>,
    },
    Directive {
        offset: usize,
        source: Vec<u16>,
    },
    Document(Box<Document>),
    DocEnd {
        offset: usize,
        source: Vec<u16>,
        end: Option<Vec<SourceToken>>,
    },
    FlowScalar {
        kind: FlowKind,
        offset: usize,
        indent: i64,
        source: Vec<u16>,
        end: Option<Vec<SourceToken>>,
    },
    BlockScalar {
        offset: usize,
        indent: i64,
        props: Vec<Token>,
        source: Vec<u16>,
    },
    BlockMap {
        offset: usize,
        indent: i64,
        items: Vec<Item>,
    },
    BlockSeq {
        offset: usize,
        indent: i64,
        items: Vec<Item>,
    },
    FlowCollection {
        offset: usize,
        indent: i64,
        start: SourceToken,
        items: Vec<Item>,
        end: Vec<SourceToken>,
    },
}

impl Token {
    /// `token.type`, as the composer and parser read it.
    pub fn type_name(&self) -> &'static str {
        match self {
            Token::Source(token) => token.ty.name(),
            Token::Error { .. } => "error",
            Token::Directive { .. } => "directive",
            Token::Document(_) => "document",
            Token::DocEnd { .. } => "doc-end",
            Token::FlowScalar { kind, .. } => kind.ty().name(),
            Token::BlockScalar { .. } => "block-scalar",
            Token::BlockMap { .. } => "block-map",
            Token::BlockSeq { .. } => "block-seq",
            Token::FlowCollection { .. } => "flow-collection",
        }
    }

    pub fn offset(&self) -> usize {
        match self {
            Token::Source(token) => token.offset,
            Token::Error { offset, .. }
            | Token::Directive { offset, .. }
            | Token::DocEnd { offset, .. }
            | Token::FlowScalar { offset, .. }
            | Token::BlockScalar { offset, .. }
            | Token::BlockMap { offset, .. }
            | Token::BlockSeq { offset, .. }
            | Token::FlowCollection { offset, .. } => *offset,
            Token::Document(document) => document.offset,
        }
    }

    /// `'indent' in token ? token.indent : undefined`.
    pub fn indent(&self) -> Option<i64> {
        match self {
            Token::Source(token) => Some(token.indent),
            Token::FlowScalar { indent, .. }
            | Token::BlockScalar { indent, .. }
            | Token::BlockMap { indent, .. }
            | Token::BlockSeq { indent, .. }
            | Token::FlowCollection { indent, .. } => Some(*indent),
            _ => None,
        }
    }

    /// `token.source` where the token has one (a string).
    pub fn source(&self) -> Option<&[u16]> {
        match self {
            Token::Source(token) => Some(&token.source),
            Token::Error { source, .. }
            | Token::Directive { source, .. }
            | Token::DocEnd { source, .. }
            | Token::FlowScalar { source, .. }
            | Token::BlockScalar { source, .. } => Some(source),
            _ => None,
        }
    }

    /// `token.end` where the property exists and is an array.
    pub fn end_mut(&mut self) -> Option<&mut Vec<SourceToken>> {
        match self {
            Token::FlowScalar { end, .. } | Token::DocEnd { end, .. } => end.as_mut(),
            Token::FlowCollection { end, .. } => Some(end),
            Token::Document(document) => document.end.as_mut(),
            _ => None,
        }
    }

    /// `isFlowToken(token)`.
    pub fn is_flow_token(&self) -> bool {
        matches!(self, Token::FlowScalar { .. } | Token::FlowCollection { .. })
    }
}

/// Moves a token's nested tokens onto `stack`.
fn detach(token: &mut Token, stack: &mut Vec<Token>) {
    let mut items = Vec::new();
    match token {
        Token::Document(document) => {
            if let Some(value) = document.value.take() {
                stack.push(*value);
            }
        }
        Token::BlockScalar { props, .. } => stack.append(props),
        Token::BlockMap { items: list, .. } | Token::BlockSeq { items: list, .. } | Token::FlowCollection { items: list, .. } => items = std::mem::take(list),
        _ => {}
    }
    for mut item in items {
        if let Some(key) = item.key.take() {
            stack.push(*key);
        }
        if let Some(value) = item.value.take() {
            stack.push(*value);
        }
    }
}

/// Drops nested tokens one at a time, so no nesting depth exhausts the stack.
impl Drop for Token {
    fn drop(&mut self) {
        let mut stack = Vec::new();
        detach(self, &mut stack);
        while let Some(mut token) = stack.pop() {
            detach(&mut token, &mut stack);
        }
    }
}

/// The deepest nesting of collection tokens in these tokens (the same
/// measure the generators take with yaml's own CST).
pub fn max_depth(tokens: &[Token]) -> usize {
    let mut deepest = 0;
    let mut pending: Vec<(&Token, usize)> = tokens.iter().map(|token| (token, 0)).collect();
    while let Some((token, depth)) = pending.pop() {
        match token {
            Token::Document(document) => {
                if let Some(value) = &document.value {
                    pending.push((value, depth));
                }
            }
            Token::BlockMap { items, .. } | Token::BlockSeq { items, .. } | Token::FlowCollection { items, .. } => {
                deepest = deepest.max(depth + 1);
                for item in items {
                    if let Some(key) = &item.key {
                        pending.push((key, depth + 1));
                    }
                    if let Some(value) = &item.value {
                        pending.push((value, depth + 1));
                    }
                }
            }
            _ => {}
        }
    }
    deepest
}

//! `Composer` of yaml 2.9.0 (`dist/compose/*.js`) for the options
//! `yaml.parse` uses (version 1.2, core schema, strict, unique keys): CST
//! documents to nodes, with every error and warning in the package's order.
//! Comments are not kept (nothing the server reads holds them), except where
//! they move a node's range.

use super::cst::{FlowKind, Item, SourceToken, Token, Ty};
use super::directives::Directives;
use super::scalars::{self, At, CoreTag, OnError, Problem, ScalarValue, TAG_PREFIX, source_at, token_at};
use crate::js;

/// The deepest collection nesting composed; deeper documents are declined
/// (Node's own limit is its stack, which differs between machines).
pub const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug)]
pub enum Kind {
    Scalar(ScalarValue),
    Map(Vec<(usize, Option<usize>)>),
    Seq(Vec<usize>),
    Alias(Vec<u16>),
}

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: Kind,
    pub anchor: Option<Vec<u16>>,
    pub range: [usize; 3],
}

/// Why a document is left to the JavaScript (see the crate documentation).
pub type Decline = &'static str;

pub struct Doc {
    pub nodes: Vec<Node>,
    pub contents: Option<usize>,
    pub range: [usize; 3],
    pub errors: Vec<Problem>,
    pub warnings: Vec<Problem>,
    pub decline: Option<Decline>,
    pub doc_start: bool,
}

struct Ctx<'d> {
    at_key: bool,
    at_root: bool,
    directives: &'d Directives,
    nodes: Vec<Node>,
    decline: Option<Decline>,
    depth: usize,
}

impl Ctx<'_> {
    fn add(&mut self, kind: Kind, range: [usize; 3]) -> usize {
        self.nodes.push(Node { kind, anchor: None, range });
        self.nodes.len() - 1
    }
}

/// The next token `resolveProps` looks at.
#[derive(Clone, Copy)]
enum Next<'a> {
    None,
    Token(&'a Token),
    Source(&'a SourceToken),
}

impl Next<'_> {
    fn type_name(&self) -> Option<&'static str> {
        match self {
            Next::None => None,
            Next::Token(token) => Some(token.type_name()),
            Next::Source(token) => Some(token.ty.name()),
        }
    }

    fn offset(&self) -> usize {
        match self {
            Next::None => 0,
            Next::Token(token) => token.offset(),
            Next::Source(token) => token.offset,
        }
    }

    fn is_empty_plain_scalar(&self) -> bool {
        match self {
            Next::Token(Token::FlowScalar {
                kind: FlowKind::Plain, source, ..
            }) => source.is_empty(),
            Next::Source(token) => token.ty == Ty::Scalar && token.source.is_empty(),
            _ => false,
        }
    }
}

fn next_of<'a>(key: Option<&'a Token>, sep: Option<&'a [SourceToken]>) -> Next<'a> {
    match (key, sep.and_then(<[SourceToken]>::first)) {
        (Some(token), _) => Next::Token(token),
        (None, Some(token)) => Next::Source(token),
        _ => Next::None,
    }
}

#[derive(Clone, Default)]
struct Props {
    comma: Option<SourceToken>,
    found: Option<SourceToken>,
    comment: bool,
    has_newline: bool,
    anchor: Option<SourceToken>,
    tag: Option<SourceToken>,
    newline_after_prop: Option<SourceToken>,
    end: usize,
    start: usize,
}

struct PropsOptions<'a> {
    flow: Option<&'static str>,
    indicator: Ty,
    next: Next<'a>,
    offset: usize,
    parent_indent: i64,
    start_on_newline: bool,
}

/// `resolveProps(tokens, options)`.
fn resolve_props(tokens: &[SourceToken], options: PropsOptions, on_error: &mut OnError) -> Props {
    let PropsOptions {
        flow,
        indicator,
        next,
        offset,
        parent_indent,
        start_on_newline,
    } = options;
    let mut at_newline = start_on_newline;
    let mut has_space = start_on_newline;
    let mut props = Props::default();
    let mut req_space = false;
    let mut tab: Option<&SourceToken> = None;
    let mut start: Option<usize> = None;
    for token in tokens {
        if req_space {
            if !matches!(token.ty, Ty::Space | Ty::Newline | Ty::Comma) {
                on_error(
                    At::Offset(token.offset),
                    "MISSING_CHAR",
                    "Tags and anchors must be separated from the next token by white space".to_owned(),
                    false,
                );
            }
            req_space = false;
        }
        if let Some(tab_token) = tab {
            if at_newline && token.ty != Ty::Comment && token.ty != Ty::Newline {
                on_error(source_at(tab_token), "TAB_AS_INDENT", "Tabs are not allowed as indentation".to_owned(), false);
            }
            tab = None;
        }
        match token.ty {
            Ty::Space => {
                if flow.is_none() && (indicator != Ty::DocStart || next.type_name() != Some("flow-collection")) && token.source.contains(&0x09) {
                    tab = Some(token);
                }
                has_space = true;
            }
            Ty::Comment => {
                if !has_space {
                    on_error(
                        source_at(token),
                        "MISSING_CHAR",
                        "Comments must be separated from other tokens by white space characters".to_owned(),
                        false,
                    );
                }
                props.comment = true;
                at_newline = false;
            }
            Ty::Newline => {
                at_newline = true;
                props.has_newline = true;
                if props.anchor.is_some() || props.tag.is_some() {
                    props.newline_after_prop = Some(token.clone());
                }
                has_space = true;
            }
            Ty::Anchor => {
                if props.anchor.is_some() {
                    on_error(source_at(token), "MULTIPLE_ANCHORS", "A node can have at most one anchor".to_owned(), false);
                }
                if token.source.last() == Some(&0x3a) {
                    on_error(
                        At::Offset(token.offset + token.source.len() - 1),
                        "BAD_ALIAS",
                        "Anchor ending in : is ambiguous".to_owned(),
                        true,
                    );
                }
                props.anchor = Some(token.clone());
                start.get_or_insert(token.offset);
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            Ty::Tag => {
                if props.tag.is_some() {
                    on_error(source_at(token), "MULTIPLE_TAGS", "A node can have at most one tag".to_owned(), false);
                }
                props.tag = Some(token.clone());
                start.get_or_insert(token.offset);
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            ty if ty == indicator => {
                if props.anchor.is_some() || props.tag.is_some() {
                    on_error(
                        source_at(token),
                        "BAD_PROP_ORDER",
                        format!("Anchors and tags must be after the {} indicator", js::lossy(&token.source)),
                        false,
                    );
                }
                if props.found.is_some() {
                    on_error(
                        source_at(token),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected {} in {}", js::lossy(&token.source), flow.unwrap_or("collection")),
                        false,
                    );
                }
                props.found = Some(token.clone());
                at_newline = indicator == Ty::SeqItemInd || indicator == Ty::ExplicitKeyInd;
                has_space = false;
            }
            Ty::Comma if flow.is_some() => {
                if props.comma.is_some() {
                    on_error(
                        source_at(token),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected , in {}", flow.unwrap_or_default()),
                        false,
                    );
                }
                props.comma = Some(token.clone());
                at_newline = false;
                has_space = false;
            }
            other => {
                on_error(source_at(token), "UNEXPECTED_TOKEN", format!("Unexpected {} token", other.name()), false);
                at_newline = false;
                has_space = false;
            }
        }
    }
    let end = match tokens.last() {
        Some(last) => last.offset + last.source.len(),
        None => offset,
    };
    if req_space && !matches!(next.type_name(), None | Some("space" | "newline" | "comma")) && !next.is_empty_plain_scalar() {
        on_error(
            At::Offset(next.offset()),
            "MISSING_CHAR",
            "Tags and anchors must be separated from the next token by white space".to_owned(),
            false,
        );
    }
    if let Some(tab_token) = tab
        && ((at_newline && tab_token.indent <= parent_indent) || matches!(next.type_name(), Some("block-map" | "block-seq")))
    {
        on_error(source_at(tab_token), "TAB_AS_INDENT", "Tabs are not allowed as indentation".to_owned(), false);
    }
    props.end = end;
    props.start = start.unwrap_or(end);
    props
}

/// `emptyScalarPosition(offset, before, pos)` with `pos` null.
fn empty_scalar_position(mut offset: usize, before: Option<&[SourceToken]>) -> usize {
    let Some(before) = before else { return offset };
    let mut i = before.len() as i64 - 1;
    while i >= 0 {
        let st = &before[i as usize];
        if matches!(st.ty, Ty::Space | Ty::Comment | Ty::Newline) {
            offset = offset.wrapping_sub(st.source.len());
            i -= 1;
            continue;
        }
        let mut j = i as usize + 1;
        while let Some(st) = before.get(j).filter(|st| st.ty == Ty::Space) {
            offset = offset.wrapping_add(st.source.len());
            j += 1;
        }
        break;
    }
    offset
}

/// `containsNewline(key)`.
fn contains_newline(key: Option<&Token>) -> bool {
    let Some(key) = key else { return false };
    match key {
        Token::FlowScalar { source, end, .. } => source.contains(&0x0a) || end.as_ref().is_some_and(|end| end.iter().any(|st| st.ty == Ty::Newline)),
        Token::FlowCollection { items, .. } => items.iter().any(|it| {
            it.start.iter().any(|st| st.ty == Ty::Newline)
                || it.sep.as_ref().is_some_and(|sep| sep.iter().any(|st| st.ty == Ty::Newline))
                || contains_newline(it.key.as_deref())
                || contains_newline(it.value.as_deref())
        }),
        _ => true,
    }
}

const PROTOTYPE_NAMES: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// The known tags of the core schema (`coreKnownTags`), with their collection type.
fn known_tag(tag_name: &[u16]) -> Option<(&'static str, Option<&'static str>)> {
    let name = js::lossy(tag_name);
    let suffix = name.strip_prefix(TAG_PREFIX)?;
    Some(match suffix {
        "binary" => ("binary", None),
        "merge" => ("merge", None),
        "omap" => ("omap", Some("seq")),
        "pairs" => ("pairs", Some("seq")),
        "set" => ("set", Some("map")),
        "timestamp" => ("timestamp", None),
        _ => return None,
    })
}

fn is_prototype_name(tag_name: &[u16]) -> bool {
    PROTOTYPE_NAMES.iter().any(|name| js::units(name) == tag_name)
}

/// The tag's resolved name; an empty one (`!<>`, or `!<x` cut short) is falsy
/// in the package, so it counts as no tag.
fn tag_name(ctx: &Ctx, tag: &SourceToken, on_error: &mut OnError) -> Option<Vec<u16>> {
    let at = source_at(tag);
    ctx.directives
        .tag_name(&tag.source, &mut |message| on_error(at, "TAG_RESOLVE_FAILED", message, false))
        .filter(|name| !name.is_empty())
}

/// `composeScalar(ctx, token, tagToken, onError)`: the node id.
fn compose_scalar(ctx: &mut Ctx, token: &Token, tag: Option<&SourceToken>, on_error: &mut OnError) -> usize {
    let resolved = match token {
        Token::BlockScalar { .. } => scalars::resolve_block_scalar(token, ctx.at_root, on_error),
        _ => scalars::resolve_flow_scalar(token, on_error),
    };
    let name = tag.and_then(|tag| tag_name(ctx, tag, on_error));
    let value = &resolved.value;
    let chosen: CoreTag = if let (Some(name), Some(tag)) = (&name, tag) {
        // findScalarTagByName
        if name == &[0x21] {
            CoreTag::Str
        } else {
            let mut found = None;
            if name == &js::units(&CoreTag::Str.tag()) {
                found = Some(CoreTag::Str);
            } else {
                for candidate in CoreTag::TESTED {
                    if js::units(&candidate.tag()) == *name && candidate.test(value) {
                        found = Some(candidate);
                        break;
                    }
                }
            }
            match found {
                Some(found) => found,
                None => {
                    if known_tag(name).is_some_and(|(_, collection)| collection.is_none()) || is_prototype_name(name) {
                        ctx.decline
                            .get_or_insert("a scalar with a tag outside the core schema (binary, merge, timestamp)");
                    }
                    let warning = name != &js::units(&CoreTag::Str.tag());
                    on_error(source_at(tag), "TAG_RESOLVE_FAILED", format!("Unresolved tag: {}", js::lossy(name)), warning);
                    CoreTag::Str
                }
            }
        }
    } else if matches!(token, Token::FlowScalar { kind: FlowKind::Plain, .. }) {
        CoreTag::TESTED.into_iter().find(|candidate| candidate.test(value)).unwrap_or(CoreTag::Str)
    } else {
        CoreTag::Str
    };
    let scalar = chosen.resolve(value);
    ctx.add(Kind::Scalar(scalar), resolved.range)
}

fn compose_empty(ctx: &mut Ctx, offset: usize, before: Option<&[SourceToken]>, props: &Props, on_error: &mut OnError) -> usize {
    let token = Token::FlowScalar {
        kind: FlowKind::Plain,
        offset: empty_scalar_position(offset, before),
        indent: -1,
        source: Vec::new(),
        end: None,
    };
    let id = compose_scalar(ctx, &token, props.tag.as_ref(), on_error);
    if let Some(anchor) = &props.anchor {
        let name = anchor.source[1..].to_vec();
        if name.is_empty() {
            on_error(source_at(anchor), "BAD_ALIAS", "Anchor cannot be an empty string".to_owned(), false);
        }
        ctx.nodes[id].anchor = Some(name);
    }
    if props.comment {
        ctx.nodes[id].range[2] = props.end;
    }
    id
}

fn compose_alias(ctx: &mut Ctx, token: &Token, on_error: &mut OnError) -> usize {
    let Token::FlowScalar { offset, source, end, .. } = token else { return 0 };
    let name = source.get(1..).unwrap_or_default().to_vec();
    if name.is_empty() {
        on_error(At::Offset(*offset), "BAD_ALIAS", "Alias cannot be an empty string".to_owned(), false);
    }
    if name.last() == Some(&0x3a) {
        on_error(
            At::Offset(offset + source.len() - 1),
            "BAD_ALIAS",
            "Alias ending in : is ambiguous".to_owned(),
            true,
        );
    }
    let value_end = offset + source.len();
    let re = scalars::resolve_end(end.as_deref(), value_end, true, on_error);
    ctx.add(Kind::Alias(name), [*offset, value_end, re])
}

/// `composeNode(ctx, token, props, onError)`.
fn compose_node(ctx: &mut Ctx, token: &Token, props: &Props, on_error: &mut OnError) -> usize {
    let anchor = props.anchor.as_ref();
    let mut node = None;
    match token {
        Token::FlowScalar { kind: FlowKind::Alias, .. } => {
            node = Some(compose_alias(ctx, token, on_error));
            if anchor.is_some() || props.tag.is_some() {
                on_error(
                    token_at(token),
                    "ALIAS_PROPS",
                    "An alias node must not specify any properties".to_owned(),
                    false,
                );
            }
        }
        Token::FlowScalar { .. } | Token::BlockScalar { .. } => {
            let id = compose_scalar(ctx, token, props.tag.as_ref(), on_error);
            if let Some(anchor) = anchor {
                ctx.nodes[id].anchor = Some(anchor.source[1..].to_vec());
            }
            node = Some(id);
        }
        Token::BlockMap { .. } | Token::BlockSeq { .. } | Token::FlowCollection { .. } => {
            if ctx.depth >= MAX_DEPTH {
                ctx.decline.get_or_insert("collections nested deeper than the composer's bound");
            } else {
                ctx.depth += 1;
                let id = compose_collection(ctx, token, props, on_error);
                ctx.depth -= 1;
                if let Some(anchor) = anchor {
                    ctx.nodes[id].anchor = Some(anchor.source[1..].to_vec());
                }
                node = Some(id);
            }
        }
        Token::Error { message, .. } => on_error(token_at(token), "UNEXPECTED_TOKEN", js::lossy(message), false),
        other => on_error(
            token_at(other),
            "UNEXPECTED_TOKEN",
            format!("Unsupported token (type: {})", other.type_name()),
            false,
        ),
    }
    let id = match node {
        Some(id) => id,
        None => compose_empty(ctx, token.offset(), None, props, on_error),
    };
    if let Some(anchor) = anchor
        && ctx.nodes[id].anchor.as_ref().is_some_and(Vec::is_empty)
    {
        on_error(source_at(anchor), "BAD_ALIAS", "Anchor cannot be an empty string".to_owned(), false);
    }
    id
}

fn compose_collection(ctx: &mut Ctx, token: &Token, props: &Props, on_error: &mut OnError) -> usize {
    let tag_token = props.tag.as_ref();
    let name = tag_token.and_then(|tag| tag_name(ctx, tag, on_error));
    if matches!(token, Token::BlockSeq { .. }) {
        let last_prop = match (&props.anchor, tag_token) {
            (Some(anchor), Some(tag)) => Some(if anchor.offset > tag.offset { anchor } else { tag }),
            (Some(anchor), None) => Some(anchor),
            (None, tag) => tag,
        };
        if let Some(last_prop) = last_prop
            && props.newline_after_prop.as_ref().is_none_or(|nl| nl.offset < last_prop.offset)
        {
            on_error(
                source_at(last_prop),
                "MISSING_CHAR",
                "Missing newline after block sequence props".to_owned(),
                false,
            );
        }
    }
    let exp_type = match token {
        Token::BlockMap { .. } => "map",
        Token::BlockSeq { .. } => "seq",
        Token::FlowCollection { start, .. } if start.source == [0x7b] => "map",
        _ => "seq",
    };
    if let (Some(tag_token), Some(name)) = (tag_token, &name) {
        let core = |kind: &str| js::units(&format!("{TAG_PREFIX}{kind}"));
        let matches_core = name == &[0x21] || (*name == core("map") && exp_type == "map") || (*name == core("seq") && exp_type == "seq");
        if !matches_core {
            match known_tag(name) {
                Some((_, Some(collection))) if collection == exp_type => {
                    ctx.decline.get_or_insert("a collection tagged !!set, !!omap or !!pairs");
                }
                Some((tag, collection)) => on_error(
                    source_at(tag_token),
                    "BAD_COLLECTION_TYPE",
                    format!(
                        "{TAG_PREFIX}{tag} used for {exp_type} collection, but expects {}",
                        collection.unwrap_or("scalar")
                    ),
                    true,
                ),
                None if is_prototype_name(name) => on_error(
                    source_at(tag_token),
                    "BAD_COLLECTION_TYPE",
                    format!("undefined used for {exp_type} collection, but expects scalar"),
                    true,
                ),
                None => on_error(source_at(tag_token), "TAG_RESOLVE_FAILED", format!("Unresolved tag: {}", js::lossy(name)), true),
            }
        }
    }
    match token {
        Token::BlockMap { .. } => resolve_block_map(ctx, token, on_error),
        Token::BlockSeq { .. } => resolve_block_seq(ctx, token, on_error),
        _ => resolve_flow_collection(ctx, token, on_error),
    }
}

fn scalar_value<'a>(ctx: &'a Ctx<'_>, id: usize) -> Option<&'a ScalarValue> {
    match &ctx.nodes[id].kind {
        Kind::Scalar(value) => Some(value),
        _ => None,
    }
}

/// `mapIncludes(ctx, items, search)` with unique keys.
fn map_includes(ctx: &Ctx, items: &[(usize, Option<usize>)], search: usize) -> bool {
    let Some(searched) = scalar_value(ctx, search) else {
        return items.iter().any(|(key, _)| *key == search);
    };
    items.iter().any(|(key, _)| {
        *key == search
            || scalar_value(ctx, *key).is_some_and(|value| match (value, searched) {
                (ScalarValue::Null, ScalarValue::Null) => true,
                (ScalarValue::Bool(a), ScalarValue::Bool(b)) => a == b,
                (ScalarValue::Number(a), ScalarValue::Number(b)) => a == b,
                (ScalarValue::String(a), ScalarValue::String(b)) => a == b,
                _ => false,
            })
    })
}

fn resolve_block_map(ctx: &mut Ctx, token: &Token, on_error: &mut OnError) -> usize {
    let Token::BlockMap {
        offset: bm_offset,
        indent: bm_indent,
        items,
    } = token
    else {
        return 0;
    };
    let start_col = "All mapping items must start at the same column";
    ctx.at_root = false;
    let mut offset = *bm_offset;
    let mut comment_end: Option<usize> = None;
    let mut pairs: Vec<(usize, Option<usize>)> = Vec::new();
    for Item { start, key, sep, value, .. } in items {
        let key = key.as_deref();
        let value = value.as_deref();
        let key_props = resolve_props(
            start,
            PropsOptions {
                flow: None,
                indicator: Ty::ExplicitKeyInd,
                next: next_of(key, sep.as_deref()),
                offset,
                parent_indent: *bm_indent,
                start_on_newline: true,
            },
            on_error,
        );
        let implicit_key = key_props.found.is_none();
        if implicit_key {
            if let Some(key) = key {
                if matches!(key, Token::BlockSeq { .. }) {
                    on_error(
                        At::Offset(offset),
                        "BLOCK_AS_IMPLICIT_KEY",
                        "A block sequence may not be used as an implicit map key".to_owned(),
                        false,
                    );
                } else if key.indent().is_some_and(|indent| indent != *bm_indent) {
                    on_error(At::Offset(offset), "BAD_INDENT", start_col.to_owned(), false);
                }
            }
            if key_props.anchor.is_none() && key_props.tag.is_none() && sep.is_none() {
                comment_end = Some(key_props.end);
                continue;
            }
            if key_props.newline_after_prop.is_some() || contains_newline(key) {
                let at = match key {
                    Some(key) => token_at(key),
                    None => start.last().map_or(At::Offset(0), source_at),
                };
                on_error(at, "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line".to_owned(), false);
            }
        } else if key_props.found.as_ref().map(|found| found.indent) != Some(*bm_indent) {
            on_error(At::Offset(offset), "BAD_INDENT", start_col.to_owned(), false);
        }
        ctx.at_key = true;
        let key_start = key_props.end;
        let key_node = match key {
            Some(key) => compose_node(ctx, key, &key_props, on_error),
            None => compose_empty(ctx, key_start, Some(start), &key_props, on_error),
        };
        ctx.at_key = false;
        if map_includes(ctx, &pairs, key_node) {
            on_error(At::Offset(key_start), "DUPLICATE_KEY", "Map keys must be unique".to_owned(), false);
        }
        let key_range = ctx.nodes[key_node].range;
        let value_props = resolve_props(
            sep.as_deref().unwrap_or_default(),
            PropsOptions {
                flow: None,
                indicator: Ty::MapValueInd,
                next: value.map_or(Next::None, Next::Token),
                offset: key_range[2],
                parent_indent: *bm_indent,
                start_on_newline: key.is_none_or(|key| matches!(key, Token::BlockScalar { .. })),
            },
            on_error,
        );
        offset = value_props.end;
        if let Some(found) = &value_props.found {
            if implicit_key {
                if matches!(value, Some(Token::BlockMap { .. })) && !value_props.has_newline {
                    on_error(
                        At::Offset(offset),
                        "BLOCK_AS_IMPLICIT_KEY",
                        "Nested mappings are not allowed in compact mappings".to_owned(),
                        false,
                    );
                }
                if (key_props.start as i64) < found.offset as i64 - 1024 {
                    on_error(
                        At::Range(key_range[0], key_range[1]),
                        "KEY_OVER_1024_CHARS",
                        "The : indicator must be at most 1024 chars after the start of an implicit block mapping key".to_owned(),
                        false,
                    );
                }
            }
            let value_node = match value {
                Some(value) => compose_node(ctx, value, &value_props, on_error),
                None => compose_empty(ctx, offset, sep.as_deref(), &value_props, on_error),
            };
            offset = ctx.nodes[value_node].range[2];
            pairs.push((key_node, Some(value_node)));
        } else {
            if implicit_key {
                on_error(
                    At::Range(key_range[0], key_range[1]),
                    "MISSING_CHAR",
                    "Implicit map keys need to be followed by map values".to_owned(),
                    false,
                );
            }
            pairs.push((key_node, None));
        }
    }
    if let Some(comment_end) = comment_end
        && comment_end != 0
        && comment_end < offset
    {
        on_error(At::Offset(comment_end), "IMPOSSIBLE", "Map comment with trailing content".to_owned(), false);
    }
    ctx.add(Kind::Map(pairs), [*bm_offset, offset, comment_end.unwrap_or(offset)])
}

fn resolve_block_seq(ctx: &mut Ctx, token: &Token, on_error: &mut OnError) -> usize {
    let Token::BlockSeq {
        offset: bs_offset,
        indent: bs_indent,
        items,
    } = token
    else {
        return 0;
    };
    ctx.at_root = false;
    ctx.at_key = false;
    let mut offset = *bs_offset;
    let mut comment_end: Option<usize> = None;
    let mut out = Vec::new();
    for Item { start, value, .. } in items {
        let value = value.as_deref();
        let props = resolve_props(
            start,
            PropsOptions {
                flow: None,
                indicator: Ty::SeqItemInd,
                next: value.map_or(Next::None, Next::Token),
                offset,
                parent_indent: *bs_indent,
                start_on_newline: true,
            },
            on_error,
        );
        if props.found.is_none() {
            if props.anchor.is_some() || props.tag.is_some() || value.is_some() {
                if matches!(value, Some(Token::BlockSeq { .. })) {
                    on_error(
                        At::Offset(props.end),
                        "BAD_INDENT",
                        "All sequence items must start at the same column".to_owned(),
                        false,
                    );
                } else {
                    on_error(At::Offset(offset), "MISSING_CHAR", "Sequence item without - indicator".to_owned(), false);
                }
            } else {
                comment_end = Some(props.end);
                continue;
            }
        }
        let node = match value {
            Some(value) => compose_node(ctx, value, &props, on_error),
            None => compose_empty(ctx, props.end, Some(start), &props, on_error),
        };
        offset = ctx.nodes[node].range[2];
        out.push(node);
    }
    ctx.add(Kind::Seq(out), [*bs_offset, offset, comment_end.unwrap_or(offset)])
}

fn is_block(token: Option<&Token>) -> bool {
    matches!(token, Some(Token::BlockMap { .. } | Token::BlockSeq { .. }))
}

fn resolve_flow_collection(ctx: &mut Ctx, token: &Token, on_error: &mut OnError) -> usize {
    let Token::FlowCollection {
        offset: fc_offset,
        indent: fc_indent,
        start: fc_start,
        items,
        end: fc_end,
    } = token
    else {
        return 0;
    };
    let is_map = fc_start.source == [0x7b];
    let fc_name = if is_map { "flow map" } else { "flow sequence" };
    let block_msg = "Block collections are not allowed within flow collections";
    let at_root = ctx.at_root;
    ctx.at_root = false;
    ctx.at_key = false;
    let mut offset = fc_offset + fc_start.source.len();
    let mut map_pairs: Vec<(usize, Option<usize>)> = Vec::new();
    let mut seq_items: Vec<usize> = Vec::new();
    for (i, Item { start, key, sep, value, .. }) in items.iter().enumerate() {
        let key = key.as_deref();
        let value = value.as_deref();
        let props = resolve_props(
            start,
            PropsOptions {
                flow: Some(fc_name),
                indicator: Ty::ExplicitKeyInd,
                next: next_of(key, sep.as_deref()),
                offset,
                parent_indent: *fc_indent,
                start_on_newline: false,
            },
            on_error,
        );
        if props.found.is_none() {
            if props.anchor.is_none() && props.tag.is_none() && sep.is_none() && value.is_none() {
                if i == 0
                    && let Some(comma) = &props.comma
                {
                    on_error(source_at(comma), "UNEXPECTED_TOKEN", format!("Unexpected , in {fc_name}"), false);
                } else if i + 1 < items.len() {
                    on_error(
                        At::Offset(props.start),
                        "UNEXPECTED_TOKEN",
                        format!("Unexpected empty item in {fc_name}"),
                        false,
                    );
                }
                offset = props.end;
                continue;
            }
            if !is_map && contains_newline(key) {
                let at = key.map_or(At::Offset(offset), token_at);
                on_error(
                    at,
                    "MULTILINE_IMPLICIT_KEY",
                    "Implicit keys of flow sequence pairs need to be on a single line".to_owned(),
                    false,
                );
            }
        }
        if i == 0 {
            if let Some(comma) = &props.comma {
                on_error(source_at(comma), "UNEXPECTED_TOKEN", format!("Unexpected , in {fc_name}"), false);
            }
        } else if props.comma.is_none() {
            on_error(At::Offset(props.start), "MISSING_CHAR", format!("Missing , between {fc_name} items"), false);
        }
        if !is_map && sep.is_none() && props.found.is_none() {
            let value_node = match value {
                Some(value) => compose_node(ctx, value, &props, on_error),
                None => compose_empty(ctx, props.end, sep.as_deref(), &props, on_error),
            };
            seq_items.push(value_node);
            let range = ctx.nodes[value_node].range;
            offset = range[2];
            if is_block(value) {
                on_error(At::Range(range[0], range[1]), "BLOCK_IN_FLOW", block_msg.to_owned(), false);
            }
            continue;
        }
        ctx.at_key = true;
        let key_start = props.end;
        let key_node = match key {
            Some(key) => compose_node(ctx, key, &props, on_error),
            None => compose_empty(ctx, key_start, Some(start), &props, on_error),
        };
        let key_range = ctx.nodes[key_node].range;
        if is_block(key) {
            on_error(At::Range(key_range[0], key_range[1]), "BLOCK_IN_FLOW", block_msg.to_owned(), false);
        }
        ctx.at_key = false;
        let value_props = resolve_props(
            sep.as_deref().unwrap_or_default(),
            PropsOptions {
                flow: Some(fc_name),
                indicator: Ty::MapValueInd,
                next: value.map_or(Next::None, Next::Token),
                offset: key_range[2],
                parent_indent: *fc_indent,
                start_on_newline: false,
            },
            on_error,
        );
        if let Some(found) = &value_props.found {
            if !is_map && props.found.is_none() {
                if let Some(sep) = sep {
                    for st in sep {
                        if st.offset == found.offset && st.ty == found.ty {
                            break;
                        }
                        if st.ty == Ty::Newline {
                            on_error(
                                source_at(st),
                                "MULTILINE_IMPLICIT_KEY",
                                "Implicit keys of flow sequence pairs need to be on a single line".to_owned(),
                                false,
                            );
                            break;
                        }
                    }
                }
                if (props.start as i64) < found.offset as i64 - 1024 {
                    on_error(
                        source_at(found),
                        "KEY_OVER_1024_CHARS",
                        "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key".to_owned(),
                        false,
                    );
                }
            }
        } else if let Some(value) = value {
            let starts_with_colon = value.source().is_some_and(|source| source.first() == Some(&0x3a));
            if starts_with_colon {
                on_error(token_at(value), "MISSING_CHAR", format!("Missing space after : in {fc_name}"), false);
            } else {
                on_error(
                    At::Offset(value_props.start),
                    "MISSING_CHAR",
                    format!("Missing , or : between {fc_name} items"),
                    false,
                );
            }
        }
        let value_node = match value {
            Some(value) => Some(compose_node(ctx, value, &value_props, on_error)),
            None if value_props.found.is_some() => Some(compose_empty(ctx, value_props.end, sep.as_deref(), &value_props, on_error)),
            None => None,
        };
        if let Some(value_node) = value_node
            && is_block(value)
        {
            let range = ctx.nodes[value_node].range;
            on_error(At::Range(range[0], range[1]), "BLOCK_IN_FLOW", block_msg.to_owned(), false);
        }
        if is_map {
            if map_includes(ctx, &map_pairs, key_node) {
                on_error(At::Offset(key_start), "DUPLICATE_KEY", "Map keys must be unique".to_owned(), false);
            }
            map_pairs.push((key_node, value_node));
        } else {
            let end_range = ctx.nodes[value_node.unwrap_or(key_node)].range;
            let map = ctx.add(Kind::Map(vec![(key_node, value_node)]), [key_range[0], end_range[1], end_range[2]]);
            seq_items.push(map);
        }
        offset = match value_node {
            Some(value_node) => ctx.nodes[value_node].range[2],
            None => value_props.end,
        };
    }
    let expected_end: u16 = if is_map { 0x7d } else { 0x5d };
    let mut ce_pos = offset;
    let mut ends: Vec<SourceToken> = fc_end.iter().skip(1).cloned().collect();
    match fc_end.first() {
        Some(ce) if ce.source == [expected_end] => ce_pos = ce.offset + ce.source.len(),
        ce => {
            let name = if is_map { "Flow map" } else { "Flow sequence" };
            let end_char = if is_map { "}" } else { "]" };
            let message = if at_root {
                format!("{name} must end with a {end_char}")
            } else {
                format!("{name} in block collection must be sufficiently indented and end with a {end_char}")
            };
            on_error(At::Offset(offset), if at_root { "MISSING_CHAR" } else { "BAD_INDENT" }, message, false);
            if let Some(ce) = ce
                && ce.source.len() != 1
            {
                ends.insert(0, ce.clone());
            }
        }
    }
    let range = if ends.is_empty() {
        [*fc_offset, ce_pos, ce_pos]
    } else {
        let end = scalars::resolve_end(Some(&ends), ce_pos, true, on_error);
        [*fc_offset, ce_pos, end]
    };
    if is_map {
        ctx.add(Kind::Map(map_pairs), range)
    } else {
        ctx.add(Kind::Seq(seq_items), range)
    }
}

/// `composeDoc(options, directives, token, onError)`.
fn compose_doc(directives: &mut Directives, document: &super::cst::Document, on_error: &mut OnError) -> Doc {
    let mut doc_directives = directives.at_document();
    let version_11 = doc_directives.explicit && doc_directives.version == js::units("1.1");
    let value = document.value.as_deref();
    let next = match value {
        Some(value) => Next::Token(value),
        None => document.end.as_ref().and_then(|end| end.first()).map_or(Next::None, Next::Source),
    };
    let props = resolve_props(
        &document.start,
        PropsOptions {
            flow: None,
            indicator: Ty::DocStart,
            next,
            offset: document.offset,
            parent_indent: 0,
            start_on_newline: true,
        },
        on_error,
    );
    if props.found.is_some() {
        doc_directives.doc_start = true;
        if matches!(value, Some(Token::BlockMap { .. } | Token::BlockSeq { .. })) && !props.has_newline {
            on_error(
                At::Offset(props.end),
                "MISSING_CHAR",
                "Block collection cannot start on same line with directives-end marker".to_owned(),
                false,
            );
        }
    }
    let doc_start = doc_directives.doc_start;
    let mut ctx = Ctx {
        at_key: false,
        at_root: true,
        directives: &doc_directives,
        nodes: Vec::new(),
        decline: None,
        depth: 0,
    };
    let contents = match value {
        Some(value) => compose_node(&mut ctx, value, &props, on_error),
        None => compose_empty(&mut ctx, props.end, Some(&document.start), &props, on_error),
    };
    let content_end = ctx.nodes[contents].range[2];
    let end = scalars::resolve_end(document.end.as_deref(), content_end, false, on_error);
    let mut decline = ctx.decline;
    if version_11 {
        decline = Some("a %YAML 1.1 document (the yaml-1.1 schema)");
    }
    Doc {
        nodes: ctx.nodes,
        contents: Some(contents),
        range: [document.offset, content_end, end],
        errors: Vec::new(),
        warnings: Vec::new(),
        decline,
        doc_start,
    }
}

fn problem(at: At, code: &'static str, message: String) -> Problem {
    let (start, end) = match at {
        At::Offset(offset) => (offset, offset + 1),
        At::Range(start, end) => (start, end),
    };
    Problem {
        start,
        end,
        code,
        message: js::units(&message),
    }
}

/// What the composer gives `parseDocument`: every document, in order, each
/// with the errors and warnings the composer attached to it.
pub fn compose(tokens: &[Token], source_length: usize) -> Vec<Doc> {
    let mut directives = Directives::new();
    let mut errors: Vec<Problem> = Vec::new();
    let mut warnings: Vec<Problem> = Vec::new();
    let mut current: Option<Doc> = None;
    let mut docs: Vec<Doc> = Vec::new();
    let mut at_directives = false;
    for token in tokens {
        match token {
            Token::Directive { offset, source } => {
                let base = *offset;
                let length = source.len();
                directives.add(source, &mut |rel, message, warning| {
                    let found = problem(At::Range(base + rel, base + length), "BAD_DIRECTIVE", message);
                    if warning { warnings.push(found) } else { errors.push(found) }
                });
                at_directives = true;
            }
            Token::Document(document) => {
                let mut on_error = |at: At, code: &'static str, message: String, warning: bool| {
                    let found = problem(at, code, message);
                    if warning { warnings.push(found) } else { errors.push(found) }
                };
                let mut doc = compose_doc(&mut directives, document, &mut on_error);
                if at_directives && !doc.doc_start {
                    errors.push(problem(
                        token_at(token),
                        "MISSING_CHAR",
                        "Missing directives-end/doc-start indicator line".to_owned(),
                    ));
                }
                doc.errors = std::mem::take(&mut errors);
                doc.warnings = std::mem::take(&mut warnings);
                if let Some(previous) = current.take() {
                    docs.push(previous);
                }
                current = Some(doc);
                at_directives = false;
            }
            Token::Source(source) if matches!(source.ty, Ty::ByteOrderMark | Ty::Space | Ty::Comment | Ty::Newline) => {}
            Token::Error { message, source, .. } => {
                let text = if source.is_empty() {
                    js::lossy(message)
                } else {
                    format!("{}: {}", js::lossy(message), js::lossy_json(source))
                };
                let found = problem(token_at(token), "UNEXPECTED_TOKEN", text);
                match current.as_mut() {
                    Some(doc) if !at_directives => doc.errors.push(found),
                    _ => errors.push(found),
                }
            }
            Token::DocEnd { offset, source, end } => {
                let Some(doc) = current.as_mut() else {
                    errors.push(problem(
                        token_at(token),
                        "UNEXPECTED_TOKEN",
                        "Unexpected doc-end without preceding document".to_owned(),
                    ));
                    continue;
                };
                let mut on_error = |at: At, code: &'static str, message: String, warning: bool| {
                    let found = problem(at, code, message);
                    if warning { warnings.push(found) } else { errors.push(found) }
                };
                let end_offset = scalars::resolve_end(end.as_deref(), offset + source.len(), true, &mut on_error);
                doc.errors.append(&mut errors);
                doc.warnings.append(&mut warnings);
                doc.range[2] = end_offset;
            }
            other => errors.push(problem(token_at(other), "UNEXPECTED_TOKEN", format!("Unsupported token {}", other.type_name()))),
        }
    }
    if let Some(mut doc) = current.take() {
        doc.errors.append(&mut errors);
        doc.warnings.append(&mut warnings);
        docs.push(doc);
    } else {
        // forceDoc: an empty document carrying the stream's errors.
        if at_directives {
            errors.push(problem(
                At::Offset(source_length),
                "MISSING_CHAR",
                "Missing directives-end indicator line".to_owned(),
            ));
        }
        docs.push(Doc {
            nodes: Vec::new(),
            contents: None,
            range: [0, source_length, source_length],
            errors,
            warnings,
            decline: None,
            doc_start: false,
        });
    }
    docs
}

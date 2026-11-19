//! `yaml.stringify(value)` of yaml 2.9.0 (`doc/createNode.js`,
//! `stringify/*.js`) for JavaScript values: primitives, arrays and plain
//! objects, with repeated objects (and cycles) written as anchors and aliases.
//! Nodes made from JavaScript values carry no comments, tags or styles and
//! are never flow collections, so only those paths of the package exist here.

use std::collections::{HashMap, HashSet};

use super::scalars::CoreTag;
use crate::value::{Graph, Node, Val};
use crate::{Refused, js};

const LINE_WIDTH: i64 = 80;
const MIN_CONTENT_WIDTH: i64 = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;

enum SKind {
    Scalar(Val),
    Map(Vec<(usize, usize)>),
    Seq(Vec<usize>),
    Alias(Vec<u16>),
}

struct SNode {
    kind: SKind,
    anchor: Option<Vec<u16>>,
}

struct Builder<'g> {
    graph: &'g Graph,
    nodes: Vec<SNode>,
    /// `sourceObjects`: graph object -> (anchor, node).
    sources: HashMap<usize, (Option<Vec<u16>>, Option<usize>)>,
    aliased: Vec<usize>,
    next_anchor: usize,
}

impl Builder<'_> {
    fn add(&mut self, kind: SKind) -> usize {
        self.nodes.push(SNode { kind, anchor: None });
        self.nodes.len() - 1
    }

    /// `createNode(value, undefined, ctx)`.
    fn create(&mut self, value: &Val, level: usize) -> Result<usize, Refused> {
        let Val::Ref(id) = value else {
            return Ok(self.add(SKind::Scalar(value.clone())));
        };
        if let Some((anchor, _)) = self.sources.get_mut(id) {
            let name = match anchor {
                Some(name) => name.clone(),
                None => {
                    self.next_anchor += 1;
                    let name = js::units(&format!("a{}", self.next_anchor));
                    *anchor = Some(name.clone());
                    self.aliased.push(*id);
                    name
                }
            };
            return Ok(self.add(SKind::Alias(name)));
        }
        if level > super::MAX_DEPTH {
            return Err(super::TOO_DEEP);
        }
        self.sources.insert(*id, (None, None));
        let node = match self.graph.node(*id) {
            Node::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.create(item, level + 1)?);
                }
                self.add(SKind::Seq(out))
            }
            Node::Object(object) => {
                let mut pairs = Vec::with_capacity(object.len());
                for (key, item) in object.entries() {
                    if matches!(item, Val::Undefined) {
                        continue;
                    }
                    let key = self.add(SKind::Scalar(Val::String(key)));
                    let value = self.create(item, level + 1)?;
                    pairs.push((key, value));
                }
                self.add(SKind::Map(pairs))
            }
        };
        if let Some(entry) = self.sources.get_mut(id) {
            entry.1 = Some(node);
        }
        Ok(node)
    }
}

/// The stringify context; cloned where the package uses `Object.assign`.
#[derive(Clone)]
struct Ctx {
    indent: Vec<u16>,
    implicit_key: bool,
    indent_at_start: Option<i64>,
    force_block_indent: bool,
    actual_string: bool,
}

const INDENT_STEP: [u16; 2] = [0x20, 0x20];

/// `/^(%|---|\.\.\.)/m.test(text)`.
fn contains_document_marker(text: &[u16]) -> bool {
    let at = |start: usize| {
        let rest = &text[start..];
        rest.first() == Some(&0x25) || rest.starts_with(&[0x2d, 0x2d, 0x2d]) || rest.starts_with(&[0x2e, 0x2e, 0x2e])
    };
    if at(0) {
        return true;
    }
    (0..text.len()).any(|i| js::is_line_terminator(text[i]) && at(i + 1))
}

/// `text.replace(/\n+/g, prefix + '$&' + suffix)` with the run in the middle.
fn replace_newline_runs(text: &[u16], before: &[u16], after: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == 0x0a {
            let start = i;
            while i < text.len() && text[i] == 0x0a {
                i += 1;
            }
            out.extend_from_slice(before);
            out.extend_from_slice(&text[start..i]);
            out.extend_from_slice(after);
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}

fn is_ws(unit: u16) -> bool {
    unit == 0x20 || unit == 0x09
}

fn line_length_over_limit(text: &[u16], line_width: i64, indent_length: i64) -> bool {
    if line_width <= 0 {
        return false;
    }
    let limit = line_width - indent_length;
    let length = text.len() as i64;
    if length <= limit {
        return false;
    }
    let mut start: i64 = 0;
    for (i, unit) in text.iter().enumerate() {
        if *unit == 0x0a {
            if i as i64 - start > limit {
                return true;
            }
            start = i as i64 + 1;
            if length - start <= limit {
                return false;
            }
        }
    }
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fold {
    Flow,
    Block,
    Quoted,
}

fn consume_more_indented_lines(text: &[u16], i: i64, indent: i64) -> i64 {
    let at = |index: i64| if index < 0 { None } else { text.get(index as usize).copied() };
    let mut i = i;
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(start);
    while ch == Some(0x20) || ch == Some(0x09) {
        if i < start + indent {
            i += 1;
            ch = at(i);
        } else {
            loop {
                i += 1;
                ch = at(i);
                if !(ch.is_some() && ch != Some(0x0a)) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(start);
        }
    }
    end
}

/// `text.slice(start, end)` with JavaScript's negative indexes.
fn slice(text: &[u16], start: i64, end: i64) -> &[u16] {
    let len = text.len() as i64;
    let norm = |value: i64| if value < 0 { (len + value).max(0) } else { value.min(len) };
    let (a, b) = (norm(start), norm(end));
    if a >= b { &[] } else { &text[a as usize..b as usize] }
}

/// `foldFlowLines(text, indent, mode, { indentAtStart, lineWidth: 80, minContentWidth: 20, onOverflow })`.
/// Returns the text and whether it overflowed.
fn fold_flow_lines(text: &[u16], indent: &[u16], mode: Fold, indent_at_start: Option<i64>) -> (Vec<u16>, bool) {
    let line_width = LINE_WIDTH;
    let min_content_width = MIN_CONTENT_WIDTH;
    let indent_len = indent.len() as i64;
    let end_step = (1 + min_content_width).max(1 + line_width - indent_len);
    if text.len() as i64 <= end_step {
        return (text.to_vec(), false);
    }
    let at = |index: i64| if index < 0 { None } else { text.get(index as usize).copied() };
    let mut folds: Vec<i64> = Vec::new();
    let mut escaped: HashSet<i64> = HashSet::new();
    let mut end = line_width - indent_len;
    if let Some(indent_at_start) = indent_at_start {
        if indent_at_start > line_width - 2i64.max(min_content_width) {
            folds.push(0);
        } else {
            end = line_width - indent_at_start;
        }
    }
    let mut split: Option<i64> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: i64 = -1;
    let mut esc_start: i64 = -1;
    let mut esc_end: i64 = -1;
    if mode == Fold::Block {
        i = consume_more_indented_lines(text, i, indent_len);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(mut ch) = at(i) else { break };
        if mode == Fold::Quoted && ch == 0x5c {
            esc_start = i;
            match at(i + 1) {
                Some(0x78) => i += 3,
                Some(0x75) => i += 5,
                Some(0x55) => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if ch == 0x0a {
            if mode == Fold::Block {
                i = consume_more_indented_lines(text, i, indent_len);
            }
            end = i + indent_len + end_step;
            split = None;
        } else {
            if ch == 0x20 && prev.is_some_and(|p| p != 0x20 && p != 0x0a && p != 0x09) {
                let next = at(i + 1);
                if next.is_some_and(|n| n != 0x20 && n != 0x0a && n != 0x09) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(at_split) = split.filter(|s| *s != 0) {
                    folds.push(at_split);
                    end = at_split + end_step;
                    split = None;
                } else if mode == Fold::Quoted {
                    while prev == Some(0x20) || prev == Some(0x09) {
                        prev = Some(ch);
                        i += 1;
                        ch = at(i).unwrap_or(0);
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped.contains(&j) {
                        return (text.to_vec(), overflow);
                    }
                    folds.push(j);
                    escaped.insert(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    if folds.is_empty() {
        return (text.to_vec(), overflow);
    }
    let len = text.len() as i64;
    let mut res: Vec<u16> = slice(text, 0, folds[0]).to_vec();
    for (index, fold) in folds.iter().enumerate() {
        let next = folds.get(index + 1).copied().filter(|next| *next != 0).unwrap_or(len);
        if *fold == 0 {
            res = js::concat(&[&[0x0a], indent, slice(text, 0, next)]);
        } else {
            if mode == Fold::Quoted && escaped.contains(fold) {
                if let Some(unit) = at(*fold) {
                    res.push(unit);
                }
                res.push(0x5c);
            }
            res.push(0x0a);
            res.extend_from_slice(indent);
            res.extend_from_slice(slice(text, fold + 1, next));
        }
    }
    (res, overflow)
}

fn fold_options_flow(ctx: &Ctx) -> Option<i64> {
    ctx.indent_at_start
}

fn double_quoted_string(value: &[u16], ctx: &Ctx) -> Vec<u16> {
    let json = js::json_string(value);
    let implicit_key = ctx.implicit_key;
    let indent: Vec<u16> = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        INDENT_STEP.to_vec()
    } else {
        Vec::new()
    };
    let at = |index: usize| json.get(index).copied();
    let mut out: Vec<u16> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while let Some(mut ch) = at(i) {
        if ch == 0x20 && at(i + 1) == Some(0x5c) && at(i + 2) == Some(0x6e) {
            out.extend_from_slice(&json[start..i]);
            out.extend([0x5c, 0x20]);
            i += 1;
            start = i;
            ch = 0x5c;
        }
        if ch == 0x5c {
            match at(i + 1) {
                Some(0x75) => {
                    out.extend_from_slice(&json[start..i]);
                    let code = js::lossy(js::substr(&json, i + 2, 4));
                    let replacement: Option<&str> = match code.as_str() {
                        "0000" => Some("\\0"),
                        "0007" => Some("\\a"),
                        "000b" => Some("\\v"),
                        "001b" => Some("\\e"),
                        "0085" => Some("\\N"),
                        "00a0" => Some("\\_"),
                        "2028" => Some("\\L"),
                        "2029" => Some("\\P"),
                        _ => None,
                    };
                    match replacement {
                        Some(text) => out.extend(js::units(text)),
                        None if code.starts_with("00") => {
                            out.extend(js::units("\\x"));
                            out.extend(js::units(&code[2..]));
                        }
                        None => out.extend_from_slice(js::substr(&json, i, 6)),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some(0x6e) => {
                    if implicit_key || at(i + 2) == Some(0x22) || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH {
                        i += 1;
                    } else {
                        out.extend_from_slice(&json[start..i]);
                        out.extend([0x0a, 0x0a]);
                        while at(i + 2) == Some(0x5c) && at(i + 3) == Some(0x6e) && at(i + 4) != Some(0x22) {
                            out.push(0x0a);
                            i += 2;
                        }
                        out.extend_from_slice(&indent);
                        if at(i + 2) == Some(0x20) {
                            out.push(0x5c);
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 {
        out.extend_from_slice(json.get(start..).unwrap_or_default());
        out
    } else {
        json.clone()
    };
    if implicit_key {
        text
    } else {
        fold_flow_lines(&text, &indent, Fold::Quoted, fold_options_flow(ctx)).0
    }
}

fn single_quoted_string(value: &[u16], ctx: &Ctx) -> Vec<u16> {
    let around_newline = value
        .windows(2)
        .any(|pair| (is_ws(pair[0]) && pair[1] == 0x0a) || (pair[0] == 0x0a && is_ws(pair[1])));
    if (ctx.implicit_key && value.contains(&0x0a)) || around_newline {
        return double_quoted_string(value, ctx);
    }
    let indent: Vec<u16> = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        INDENT_STEP.to_vec()
    } else {
        Vec::new()
    };
    let mut doubled = Vec::with_capacity(value.len());
    for unit in value {
        doubled.push(*unit);
        if *unit == 0x27 {
            doubled.push(0x27);
        }
    }
    let mut after = vec![0x0a];
    after.extend_from_slice(&indent);
    let mut res = vec![0x27];
    res.extend(replace_newline_runs(&doubled, &[], &after));
    res.push(0x27);
    if ctx.implicit_key {
        res
    } else {
        fold_flow_lines(&res, &indent, Fold::Flow, fold_options_flow(ctx)).0
    }
}

fn quoted_string(value: &[u16], ctx: &Ctx) -> Vec<u16> {
    let has_double = value.contains(&0x22);
    let has_single = value.contains(&0x27);
    if has_double && !has_single {
        single_quoted_string(value, ctx)
    } else {
        double_quoted_string(value, ctx)
    }
}

/// `/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g` replaced by `$1$2`.
fn unfold_more_indented(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut p = 0;
    // A match: its end, group 1's start and end, and group 2.
    type Match = (usize, usize, usize, Option<(usize, usize)>);
    let try_at = |p: usize| -> Option<Match> {
        let mut starts: Vec<usize> = Vec::new();
        if p == 0 {
            starts.push(0);
        }
        if text.get(p) == Some(&0x0a) {
            starts.push(p + 1);
        }
        for s in starts {
            if !text.get(s).is_some_and(|unit| is_ws(*unit)) {
                continue;
            }
            let mut q = s + 1;
            while q < text.len() && !js::is_line_terminator(text[q]) {
                q += 1;
            }
            let mut r = q;
            while r < text.len() && (text[r] == 0x0a || is_ws(text[r])) {
                r += 1;
            }
            if r > q && text[r - 1] == 0x0a {
                return Some((r, s, q, Some((q, r - 1))));
            }
            return Some((q, s, q, None));
        }
        None
    };
    while p <= text.len() {
        match try_at(p) {
            Some((end, g1s, g1e, g2)) => {
                out.extend_from_slice(&text[g1s..g1e]);
                if let Some((a, b)) = g2 {
                    out.extend_from_slice(&text[a..b]);
                }
                p = end;
            }
            None => {
                if p < text.len() {
                    out.push(text[p]);
                }
                p += 1;
            }
        }
    }
    out
}

fn block_string(value: &[u16], ctx: &Ctx) -> Vec<u16> {
    // /\n[\t ]+$/
    let trailing_ws = value.iter().rposition(|unit| !is_ws(*unit));
    if let Some(at) = trailing_ws
        && at + 1 < value.len()
        && value[at] == 0x0a
    {
        return quoted_string(value, ctx);
    }
    let indent: Vec<u16> = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        INDENT_STEP.to_vec()
    } else {
        Vec::new()
    };
    let literal = !line_length_over_limit(value, LINE_WIDTH, indent.len() as i64);
    if value.is_empty() {
        return js::units(if literal { "|\n" } else { ">\n" });
    }
    let mut end_start = value.len();
    while end_start > 0 {
        let ch = value[end_start - 1];
        if ch != 0x0a && ch != 0x09 && ch != 0x20 {
            break;
        }
        end_start -= 1;
    }
    let mut end: Vec<u16> = value[end_start..].to_vec();
    let end_nl = end.iter().position(|unit| *unit == 0x0a);
    let chomp: &[u16] = match end_nl {
        None => &[0x2d],
        Some(at) if end_start == 0 || at != end.len() - 1 => &[0x2b],
        Some(_) => &[],
    };
    let mut value: Vec<u16> = value.to_vec();
    if !end.is_empty() {
        value.truncate(value.len() - end.len());
        if end.last() == Some(&0x0a) {
            end.pop();
        }
        // blockEndNewlines: runs not at the end of `end`, each followed by the indent.
        let mut replaced = Vec::with_capacity(end.len());
        let mut i = 0;
        while i < end.len() {
            if end[i] == 0x0a {
                let start = i;
                while i < end.len() && end[i] == 0x0a {
                    i += 1;
                }
                replaced.extend_from_slice(&end[start..i]);
                if i < end.len() {
                    replaced.extend_from_slice(&indent);
                }
            } else {
                replaced.push(end[i]);
                i += 1;
            }
        }
        end = replaced;
    }
    let mut start_with_space = false;
    let mut start_end = 0;
    let mut start_nl: i64 = -1;
    while start_end < value.len() {
        let ch = value[start_end];
        if ch == 0x20 {
            start_with_space = true;
        } else if ch == 0x0a {
            start_nl = start_end as i64;
        } else {
            break;
        }
        start_end += 1;
    }
    let start_len = if start_nl < start_end as i64 { (start_nl + 1) as usize } else { start_end };
    let mut start: Vec<u16> = value[..start_len].to_vec();
    if !start.is_empty() {
        value = value[start.len()..].to_vec();
        start = replace_newline_runs(&start, &[], &indent);
    }
    let mut header: Vec<u16> = Vec::new();
    if start_with_space {
        header.push(if indent.is_empty() { 0x31 } else { 0x32 });
    }
    header.extend_from_slice(chomp);
    if !literal {
        let folded = replace_newline_runs(&value, &[0x0a], &[]);
        let folded = unfold_more_indented(&folded);
        let folded = replace_newline_runs(&folded, &[], &indent);
        let body_text = js::concat(&[&start, &folded, &end]);
        let (body, overflow) = fold_flow_lines(&body_text, &indent, Fold::Block, Some(ctx.indent.len() as i64));
        if !overflow {
            return js::concat(&[&[0x3e], &header, &[0x0a], &indent, &body]);
        }
    }
    let value = replace_newline_runs(&value, &[], &indent);
    js::concat(&[&[0x7c], &header, &[0x0a], &indent, &start, &value, &end])
}

/// The big test of `plainString`.
fn needs_quotes(value: &[u16]) -> bool {
    let first = value.first().copied();
    if first.is_some_and(|unit| {
        matches!(
            unit,
            0x0a | 0x09 | 0x20 | 0x2c | 0x5b | 0x5d | 0x7b | 0x7d | 0x23 | 0x26 | 0x2a | 0x21 | 0x7c | 0x3e | 0x27 | 0x22 | 0x25 | 0x40 | 0x60
        )
    }) {
        return true;
    }
    if value.len() == 1 && matches!(first, Some(0x3f | 0x2d)) {
        return true;
    }
    if matches!(first, Some(0x3f | 0x2d)) && value.get(1).is_some_and(|unit| is_ws(*unit)) {
        return true;
    }
    for pair in value.windows(2) {
        if matches!(pair[0], 0x0a | 0x3a) && is_ws(pair[1]) {
            return true;
        }
        if is_ws(pair[0]) && pair[1] == 0x0a {
            return true;
        }
        if matches!(pair[0], 0x0a | 0x09 | 0x20) && pair[1] == 0x23 {
            return true;
        }
    }
    value.last().is_some_and(|unit| matches!(unit, 0x0a | 0x09 | 0x20 | 0x3a))
}

fn plain_string(value: &[u16], ctx: &mut Ctx) -> Vec<u16> {
    let implicit_key = ctx.implicit_key;
    if implicit_key && value.contains(&0x0a) {
        return quoted_string(value, ctx);
    }
    if needs_quotes(value) {
        return if implicit_key || !value.contains(&0x0a) {
            quoted_string(value, ctx)
        } else {
            block_string(value, ctx)
        };
    }
    if !implicit_key && value.contains(&0x0a) {
        return block_string(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            ctx.force_block_indent = true;
            return block_string(value, ctx);
        } else if implicit_key && ctx.indent == INDENT_STEP {
            return quoted_string(value, ctx);
        }
    }
    let mut after = vec![0x0a];
    after.extend_from_slice(&ctx.indent);
    let text = replace_newline_runs(value, &[], &after);
    if ctx.actual_string && CoreTag::TESTED.iter().any(|tag| tag.test(&text)) {
        return quoted_string(value, ctx);
    }
    if implicit_key {
        text
    } else {
        fold_flow_lines(&text, &ctx.indent.clone(), Fold::Flow, fold_options_flow(ctx)).0
    }
}

/// `stringifyString(item, ctx)` for a string value with no style.
fn stringify_string(value: &[u16], ctx: &Ctx) -> Vec<u16> {
    let mut ctx = ctx.clone();
    ctx.actual_string = true;
    let mut index = 0;
    let mut needs_double = false;
    while index < value.len() {
        let unit = value[index];
        if matches!(unit, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f) {
            needs_double = true;
            break;
        }
        if (0xd800..=0xdbff).contains(&unit) && value.get(index + 1).is_some_and(|low| (0xdc00..=0xdfff).contains(low)) {
            index += 2;
            continue;
        }
        if (0xd800..=0xdfff).contains(&unit) {
            needs_double = true;
            break;
        }
        index += 1;
    }
    if needs_double {
        double_quoted_string(value, &ctx)
    } else {
        plain_string(value, &mut ctx)
    }
}

fn stringify_number(x: f64) -> Vec<u16> {
    if x.is_nan() {
        return js::units(".nan");
    }
    if x.is_infinite() {
        return js::units(if x < 0.0 { "-.inf" } else { ".inf" });
    }
    if x == 0.0 && x.is_sign_negative() {
        return js::units("-0");
    }
    js::units(&js::number_to_string(x))
}

struct Writer<'b> {
    nodes: &'b [SNode],
    anchors: HashSet<Vec<u16>>,
}

impl Writer<'_> {
    fn is_collection(&self, id: usize) -> bool {
        matches!(self.nodes[id].kind, SKind::Map(_) | SKind::Seq(_))
    }

    /// `stringify(item, ctx)` for a node.
    fn stringify(&mut self, id: usize, ctx: &mut Ctx) -> Vec<u16> {
        let node = &self.nodes[id];
        if let SKind::Alias(name) = &node.kind {
            let mut out = vec![0x2a];
            out.extend_from_slice(name);
            if ctx.implicit_key {
                out.push(0x20);
            }
            return out;
        }
        let mut props: Vec<u16> = Vec::new();
        if let Some(anchor) = &node.anchor {
            self.anchors.insert(anchor.clone());
            props.push(0x26);
            props.extend_from_slice(anchor);
        }
        if !props.is_empty() {
            ctx.indent_at_start = Some(ctx.indent_at_start.unwrap_or(0) + props.len() as i64 + 1);
        }
        let text = match &node.kind {
            SKind::Scalar(value) => match value {
                Val::String(text) => stringify_string(text, ctx),
                Val::Number(x) => stringify_number(*x),
                Val::Bool(flag) => js::units(if *flag { "true" } else { "false" }),
                _ => js::units("null"),
            },
            SKind::Map(pairs) => {
                let pairs = pairs.clone();
                self.block_collection(
                    ctx,
                    &pairs.iter().map(|(k, v)| Entry::Pair(*k, *v)).collect::<Vec<_>>(),
                    &[],
                    &[0x7b, 0x7d],
                    ctx.indent.clone(),
                )
            }
            SKind::Seq(items) => {
                let items: Vec<Entry> = items.iter().map(|item| Entry::Item(*item)).collect();
                let mut item_indent = ctx.indent.clone();
                item_indent.extend_from_slice(&INDENT_STEP);
                self.block_collection(ctx, &items, &[0x2d, 0x20], &[0x5b, 0x5d], item_indent)
            }
            SKind::Alias(_) => Vec::new(),
        };
        if props.is_empty() {
            return text;
        }
        let is_scalar = matches!(self.nodes[id].kind, SKind::Scalar(_));
        if is_scalar || text.first() == Some(&0x7b) || text.first() == Some(&0x5b) {
            js::concat(&[&props, &[0x20], &text])
        } else {
            js::concat(&[&props, &[0x0a], &ctx.indent, &text])
        }
    }

    fn block_collection(&mut self, ctx: &Ctx, items: &[Entry], prefix: &[u16], flow_chars: &[u16; 2], item_indent: Vec<u16>) -> Vec<u16> {
        let mut item_ctx = ctx.clone();
        item_ctx.indent = item_indent;
        let mut lines: Vec<Vec<u16>> = Vec::new();
        for item in items {
            let text = match item {
                Entry::Pair(key, value) => self.pair(*key, *value, &item_ctx),
                Entry::Item(id) => self.stringify(*id, &mut item_ctx),
            };
            lines.push(js::concat(&[prefix, &text]));
        }
        if lines.is_empty() {
            return flow_chars.to_vec();
        }
        let mut out = lines[0].clone();
        for line in &lines[1..] {
            if line.is_empty() {
                out.push(0x0a);
            } else {
                out.push(0x0a);
                out.extend_from_slice(&ctx.indent);
                out.extend_from_slice(line);
            }
        }
        out
    }

    /// `stringifyPair(pair, ctx)` for a string key and a node value, outside flow.
    fn pair(&mut self, key: usize, value: usize, outer: &Ctx) -> Vec<u16> {
        let mut ctx = outer.clone();
        ctx.implicit_key = true;
        ctx.indent = js::concat(&[&outer.indent, &INDENT_STEP]);
        let mut text = self.stringify(key, &mut ctx);
        let explicit_key = text.len() > 1024;
        if explicit_key {
            text = js::concat(&[&[0x3f, 0x20], &text, &[0x0a], &outer.indent, &[0x3a]]);
        } else {
            text.push(0x3a);
        }
        ctx.implicit_key = false;
        let value_is_scalar = matches!(self.nodes[value].kind, SKind::Scalar(_));
        if !explicit_key && value_is_scalar {
            ctx.indent_at_start = Some(text.len() as i64 + 1);
        }
        let value_text = self.stringify(value, &mut ctx);
        let mut ws: Vec<u16> = vec![0x20];
        if !explicit_key && self.is_collection(value) {
            let empty = match &self.nodes[value].kind {
                SKind::Map(pairs) => pairs.is_empty(),
                SKind::Seq(items) => items.is_empty(),
                _ => false,
            };
            let first = value_text.first().copied();
            let nl0 = value_text.iter().position(|unit| *unit == 0x0a);
            let has_newline = nl0.is_some();
            let flow = empty;
            if has_newline || !flow {
                let mut has_props_line = false;
                if let Some(nl0) = nl0
                    && (first == Some(0x26) || first == Some(0x21))
                {
                    let mut sp0 = value_text.iter().position(|unit| *unit == 0x20);
                    if first == Some(0x26)
                        && let Some(sp) = sp0
                        && sp < nl0
                        && value_text.get(sp + 1) == Some(&0x21)
                    {
                        sp0 = value_text[sp + 1..].iter().position(|unit| *unit == 0x20).map(|at| at + sp + 1);
                    }
                    if sp0.is_none_or(|sp| nl0 < sp) {
                        has_props_line = true;
                    }
                }
                if !has_props_line {
                    ws = js::concat(&[&[0x0a], &ctx.indent]);
                }
            }
        } else if value_text.is_empty() || value_text.first() == Some(&0x0a) {
            ws = Vec::new();
        }
        text.extend(ws);
        text.extend(value_text);
        text
    }
}

enum Entry {
    Pair(usize, usize),
    Item(usize),
}

/// `yaml.stringify(value)`: `None` where it returns `undefined` (an
/// undefined value). A value nested deeper than `MAX_DEPTH` is refused; the
/// package itself throws nothing for these values.
pub fn stringify(graph: &Graph, value: &Val) -> Result<Option<Vec<u16>>, Refused> {
    if matches!(value, Val::Undefined) {
        return Ok(None);
    }
    let mut builder = Builder {
        graph,
        nodes: Vec::new(),
        sources: HashMap::new(),
        aliased: Vec::new(),
        next_anchor: 0,
    };
    let root = builder.create(value, 1)?;
    // setAnchors
    for source in builder.aliased.clone() {
        if let Some((Some(anchor), Some(node))) = builder.sources.get(&source).cloned() {
            builder.nodes[node].anchor = Some(anchor);
        }
    }
    let mut writer = Writer {
        nodes: &builder.nodes,
        anchors: HashSet::new(),
    };
    let mut ctx = Ctx {
        indent: Vec::new(),
        implicit_key: false,
        indent_at_start: None,
        force_block_indent: false,
        actual_string: false,
    };
    let mut body = writer.stringify(root, &mut ctx);
    body.push(0x0a);
    Ok(Some(body))
}

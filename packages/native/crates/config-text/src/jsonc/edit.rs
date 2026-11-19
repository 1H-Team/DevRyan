//! `parseTree`, `findNodeAtLocation`, `setProperty` (`modify`) and
//! `applyEdits` of jsonc-parser 3.3.1 (`lib/umd/impl/edit.js`, `parser.js`,
//! `main.js`), for property paths of strings, as the server passes them.

use super::format::{self, FormatEdit};
use super::parser::{self, Literal, Visitor};
use crate::{Refused, js};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    Object,
    Array,
    Property,
    String,
    Number,
    Boolean,
    Null,
}

impl TreeKind {
    pub fn name(self) -> &'static str {
        match self {
            TreeKind::Object => "object",
            TreeKind::Array => "array",
            TreeKind::Property => "property",
            TreeKind::String => "string",
            TreeKind::Number => "number",
            TreeKind::Boolean => "boolean",
            TreeKind::Null => "null",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TreeNode {
    pub kind: TreeKind,
    pub offset: i64,
    pub length: i64,
    pub children: Vec<usize>,
    pub parent: Option<usize>,
    /// A string node's value (a property name or a string literal).
    pub value: Option<Vec<u16>>,
}

/// The tree `parseTree` builds; node 0 is the artificial root array.
pub struct Tree {
    pub nodes: Vec<TreeNode>,
}

impl Tree {
    pub fn root(&self) -> Option<usize> {
        self.nodes[0].children.first().copied()
    }

    fn add(&mut self, node: TreeNode) -> usize {
        let parent = node.parent;
        self.nodes.push(node);
        let id = self.nodes.len() - 1;
        if let Some(parent) = parent {
            self.nodes[parent].children.push(id);
        }
        id
    }

    /// `findNodeAtLocation(root, path)` for string segments.
    pub fn find(&self, root: Option<usize>, path: &[Vec<u16>]) -> Option<usize> {
        let mut node = root?;
        for segment in path {
            if self.nodes[node].kind != TreeKind::Object {
                return None;
            }
            let mut found = None;
            for property in &self.nodes[node].children {
                let children = &self.nodes[*property].children;
                if let Some(first) = children.first()
                    && self.nodes[*first].value.as_deref() == Some(segment.as_slice())
                    && children.len() == 2
                {
                    found = Some(children[1]);
                    break;
                }
            }
            node = found?;
        }
        Some(node)
    }
}

struct TreeVisitor {
    tree: Tree,
    current: usize,
}

impl TreeVisitor {
    fn ensure_property_complete(&mut self, end: i64) {
        let current = &mut self.tree.nodes[self.current];
        if current.kind == TreeKind::Property {
            current.length = end - current.offset;
            self.current = current.parent.unwrap_or(0);
        }
    }

    fn node(&self, kind: TreeKind, offset: usize, length: i64, value: Option<Vec<u16>>) -> TreeNode {
        TreeNode {
            kind,
            offset: offset as i64,
            length,
            children: Vec::new(),
            parent: Some(self.current),
            value,
        }
    }
}

impl Visitor for TreeVisitor {
    fn object_begin(&mut self, offset: usize, _length: usize) {
        let node = self.node(TreeKind::Object, offset, -1, None);
        self.current = self.tree.add(node);
    }
    fn object_property(&mut self, name: &[u16], offset: usize, length: usize) {
        let node = self.node(TreeKind::Property, offset, -1, None);
        self.current = self.tree.add(node);
        let name = self.node(TreeKind::String, offset, length as i64, Some(name.to_vec()));
        self.tree.add(name);
    }
    fn object_end(&mut self, offset: usize, length: usize) {
        let end = (offset + length) as i64;
        self.ensure_property_complete(end);
        let current = &mut self.tree.nodes[self.current];
        current.length = end - current.offset;
        self.current = current.parent.unwrap_or(0);
        self.ensure_property_complete(end);
    }
    fn array_begin(&mut self, offset: usize, _length: usize) {
        let node = self.node(TreeKind::Array, offset, -1, None);
        self.current = self.tree.add(node);
    }
    fn array_end(&mut self, offset: usize, length: usize) {
        let end = (offset + length) as i64;
        let current = &mut self.tree.nodes[self.current];
        current.length = end - current.offset;
        self.current = current.parent.unwrap_or(0);
        self.ensure_property_complete(end);
    }
    fn literal(&mut self, value: Literal, offset: usize, length: usize) {
        let (kind, text) = match value {
            Literal::String(text) => (TreeKind::String, Some(text)),
            Literal::Number(_) => (TreeKind::Number, None),
            Literal::Null => (TreeKind::Null, None),
            Literal::Bool(_) => (TreeKind::Boolean, None),
        };
        let node = self.node(kind, offset, length as i64, text);
        self.tree.add(node);
        self.ensure_property_complete((offset + length) as i64);
    }
    fn separator(&mut self, separator: u8, offset: usize, _length: usize) {
        if self.tree.nodes[self.current].kind == TreeKind::Property && separator == b',' {
            self.ensure_property_complete(offset as i64);
        }
    }
    fn error(&mut self, _code: u32, _offset: usize, _length: usize) {}
}

/// `parseTree(text)` with the default options (no trailing commas).
pub fn parse_tree(text: &[u16]) -> Tree {
    let root = TreeNode {
        kind: TreeKind::Array,
        offset: -1,
        length: -1,
        children: Vec::new(),
        parent: None,
        value: None,
    };
    let mut visitor = TreeVisitor {
        tree: Tree { nodes: vec![root] },
        current: 0,
    };
    parser::visit(text, &mut visitor, false);
    visitor.tree
}

/// An edit `modify` returns: `{ offset, length, content }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub offset: usize,
    pub length: usize,
    pub content: Vec<u16>,
}

/// Why `modify`, `applyEdits` or a sequence of them gives no text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModifyError {
    /// What the package throws, as `String(error)` prints it.
    Thrown(String),
    /// The crate hands the input back to JavaScript (`crate::Refused`).
    Refused(Refused),
}

fn thrown(message: impl Into<String>) -> ModifyError {
    ModifyError::Thrown(message.into())
}

fn apply_one(text: &[u16], offset: usize, length: usize, content: &[u16]) -> Vec<u16> {
    js::concat(&[
        js::substring(text, 0, offset as i64),
        content,
        js::substring(text, (offset + length) as i64, i64::MAX),
    ])
}

fn with_formatting(text: &[u16], edit: Edit, eol: &[u16]) -> Result<Vec<Edit>, ModifyError> {
    let mut new_text = apply_one(text, edit.offset, edit.length, &edit.content);
    let mut begin = edit.offset;
    let mut end = edit.offset + edit.content.len();
    if edit.length == 0 || edit.content.is_empty() {
        while begin > 0 && !format::is_eol(&new_text, begin - 1) {
            begin -= 1;
        }
        while end < new_text.len() && !format::is_eol(&new_text, end) {
            end += 1;
        }
    }
    let edits: Vec<FormatEdit> = format::format(&new_text, begin, end - begin, eol);
    for format_edit in edits.iter().rev() {
        let Some(content) = &format_edit.content else {
            // `edit.content.length` on undefined.
            return Err(thrown("TypeError: Cannot read properties of undefined (reading 'length')"));
        };
        new_text = apply_one(&new_text, format_edit.offset, format_edit.length, content);
        begin = begin.min(format_edit.offset);
        end = end.max(format_edit.offset + format_edit.length);
        end = (end as i64 + content.len() as i64 - format_edit.length as i64) as usize;
    }
    let edit_length = text.len() as i64 - (new_text.len() as i64 - end as i64) - begin as i64;
    Ok(vec![Edit {
        offset: begin,
        length: edit_length.max(0) as usize,
        content: js::substring(&new_text, begin as i64, end as i64).to_vec(),
    }])
}

/// `modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })`
/// for a path of strings. `value` is the JSON text `JSON.stringify(value)`
/// gives, or `None` for `undefined` (a removal).
pub fn modify(text: &[u16], path: &[Vec<u16>], value: Option<Vec<u16>>, eol: &[u16]) -> Result<Vec<Edit>, ModifyError> {
    if parser::nesting_depth(text) > parser::MAX_DEPTH {
        return Err(ModifyError::Refused(parser::TOO_DEEP));
    }
    let tree = parse_tree(text);
    let root = tree.root();
    let mut path = path.to_vec();
    let mut value = value;
    let mut parent = None;
    let mut last_segment: Option<Vec<u16>> = None;
    while let Some(segment) = path.pop() {
        parent = tree.find(root, &path);
        let wrap = parent.is_none() && value.is_some();
        last_segment = Some(segment);
        if wrap {
            let inner = value.take().unwrap_or_default();
            let mut wrapped = vec![u16::from(b'{')];
            js::push_json_string(&mut wrapped, last_segment.as_deref().unwrap_or_default());
            wrapped.push(u16::from(b':'));
            wrapped.extend(inner);
            wrapped.push(u16::from(b'}'));
            value = Some(wrapped);
        } else {
            break;
        }
    }
    let Some(parent) = parent else {
        let Some(value) = value else {
            return Err(thrown("Error: Can not delete in empty document"));
        };
        let (offset, length) = match root {
            Some(root) => (tree.nodes[root].offset, tree.nodes[root].length),
            None => (0, 0),
        };
        return with_formatting(
            text,
            Edit {
                offset: offset as usize,
                length: length as usize,
                content: value,
            },
            eol,
        );
    };
    let parent_node = &tree.nodes[parent];
    let Some(last_segment) = last_segment.filter(|_| parent_node.kind == TreeKind::Object) else {
        return Err(thrown(format!("Error: Can not add index to parent of type {}", parent_node.kind.name())));
    };
    let existing = tree.find(Some(parent), std::slice::from_ref(&last_segment));
    if let Some(existing) = existing {
        let Some(value) = value else {
            let Some(property) = tree.nodes[existing].parent else {
                return Err(thrown("Error: Malformed AST"));
            };
            let property_index = parent_node
                .children
                .iter()
                .position(|child| *child == property)
                .map_or(-1, |index| index as i64);
            let property_node = &tree.nodes[property];
            let mut remove_end = property_node.offset + property_node.length;
            let remove_begin;
            if property_index > 0 {
                let previous = &tree.nodes[parent_node.children[property_index as usize - 1]];
                remove_begin = previous.offset + previous.length;
            } else {
                remove_begin = parent_node.offset + 1;
                if parent_node.children.len() > 1 {
                    remove_end = tree.nodes[parent_node.children[1]].offset;
                }
            }
            let edit = Edit {
                offset: remove_begin as usize,
                length: (remove_end - remove_begin).max(0) as usize,
                content: Vec::new(),
            };
            return with_formatting(text, edit, eol);
        };
        let node = &tree.nodes[existing];
        return with_formatting(
            text,
            Edit {
                offset: node.offset as usize,
                length: node.length as usize,
                content: value,
            },
            eol,
        );
    }
    let Some(value) = value else { return Ok(Vec::new()) };
    let mut property = js::json_string(&last_segment);
    property.extend(js::units(": "));
    property.extend(value);
    let index = parent_node.children.len();
    let edit = if index > 0 {
        let previous = &tree.nodes[parent_node.children[index - 1]];
        let mut content = vec![u16::from(b',')];
        content.extend(property);
        Edit {
            offset: (previous.offset + previous.length) as usize,
            length: 0,
            content,
        }
    } else {
        Edit {
            offset: (parent_node.offset + 1) as usize,
            length: 0,
            content: property,
        }
    };
    with_formatting(text, edit, eol)
}

/// `applyEdits(text, edits)`.
pub fn apply_edits(text: &[u16], edits: &[Edit]) -> Result<Vec<u16>, ModifyError> {
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    // Array.prototype.sort is stable, as is sort_by.
    sorted.sort_by(|a, b| a.offset.cmp(&b.offset).then(a.length.cmp(&b.length)));
    let mut text = text.to_vec();
    let mut last_modified = text.len();
    for edit in sorted.iter().rev() {
        if edit.offset + edit.length <= last_modified {
            text = apply_one(&text, edit.offset, edit.length, &edit.content);
        } else {
            return Err(thrown("Error: Overlapping edit"));
        }
        last_modified = edit.offset;
    }
    Ok(text)
}

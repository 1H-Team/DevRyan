//! `doc.toJS({ mapAsMap: false, maxAliasCount: 100 })` of yaml 2.9.0
//! (`nodes/toJS.js`, `Alias.js`, `addPairToJSMap.js`, `YAMLMap.js`, `YAMLSeq.js`).

use std::collections::HashMap;

use super::compose::{Doc, Kind};
use super::scalars::ScalarValue;
use crate::js;
use crate::value::{Graph, Val};

const MAX_ALIAS_COUNT: f64 = 100.0;

/// What ends the conversion early.
pub enum Stop {
    /// A `ReferenceError` with this message.
    Thrown(String),
    /// A case the crate leaves to JavaScript.
    Declined(&'static str),
}

struct AnchorData {
    alias_count: f64,
    count: f64,
    res: Option<Val>,
}

struct ToJs<'a> {
    doc: &'a Doc,
    graph: Graph,
    anchors: HashMap<usize, AnchorData>,
    on_create: Option<usize>,
    order: Vec<usize>,
}

fn pre_order(doc: &Doc) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(root) = doc.contents else { return out };
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let node = &doc.nodes[id];
        let anchored = !matches!(node.kind, Kind::Alias(_)) && node.anchor.as_ref().is_some_and(|anchor| !anchor.is_empty());
        if anchored || matches!(node.kind, Kind::Alias(_)) {
            out.push(id);
        }
        match &node.kind {
            Kind::Map(pairs) => {
                for (key, value) in pairs.iter().rev() {
                    if let Some(value) = value {
                        stack.push(*value);
                    }
                    stack.push(*key);
                }
            }
            Kind::Seq(items) => stack.extend(items.iter().rev()),
            _ => {}
        }
    }
    out
}

impl ToJs<'_> {
    fn has_anchor(&self, id: usize) -> bool {
        let node = &self.doc.nodes[id];
        !matches!(node.kind, Kind::Alias(_)) && node.anchor.as_ref().is_some_and(|anchor| !anchor.is_empty())
    }

    /// `Alias.resolve(doc)`: the last anchored node before the alias with its name.
    fn resolve(&self, alias: usize) -> Option<usize> {
        let Kind::Alias(name) = &self.doc.nodes[alias].kind else { return None };
        let mut found = None;
        for id in &self.order {
            if *id == alias {
                break;
            }
            if self.doc.nodes[*id].anchor.as_ref() == Some(name) && !matches!(self.doc.nodes[*id].kind, Kind::Alias(_)) {
                found = Some(*id);
            }
        }
        found
    }

    fn created(&mut self, value: &Val) {
        if let Some(pending) = self.on_create.take()
            && let Some(data) = self.anchors.get_mut(&pending)
        {
            data.res = Some(value.clone());
        }
    }

    fn convert(&mut self, id: usize) -> Result<Val, Stop> {
        if !self.has_anchor(id) {
            return self.convert_node(id);
        }
        self.anchors.insert(
            id,
            AnchorData {
                alias_count: 0.0,
                count: 1.0,
                res: None,
            },
        );
        self.on_create = Some(id);
        let res = self.convert_node(id)?;
        if self.on_create == Some(id) {
            self.created(&res);
        }
        Ok(res)
    }

    fn convert_node(&mut self, id: usize) -> Result<Val, Stop> {
        match &self.doc.nodes[id].kind {
            Kind::Scalar(value) => Ok(match value {
                ScalarValue::Null => Val::Null,
                ScalarValue::Bool(flag) => Val::Bool(*flag),
                ScalarValue::Number(x) => Val::Number(*x),
                ScalarValue::String(text) => Val::String(text.clone()),
            }),
            Kind::Map(pairs) => {
                let object = self.graph.object();
                self.created(&Val::Ref(object));
                for (key, value) in pairs.clone() {
                    let js_key = self.convert(key)?;
                    let string_key = match &js_key {
                        Val::Null => Vec::new(),
                        Val::Undefined => js::units("undefined"),
                        Val::Bool(flag) => js::units(if *flag { "true" } else { "false" }),
                        Val::Number(x) => js::units(&js::number_to_string(*x)),
                        Val::String(text) => text.clone(),
                        Val::Ref(_) => return Err(Stop::Declined("a mapping key that is a collection (stringified with a warning)")),
                    };
                    let js_value = match value {
                        Some(value) => self.convert(value)?,
                        None => Val::Null,
                    };
                    self.graph.define(object, string_key, js_value);
                }
                Ok(Val::Ref(object))
            }
            Kind::Seq(items) => {
                let array = self.graph.array();
                self.created(&Val::Ref(array));
                for item in items.clone() {
                    let value = self.convert(item)?;
                    self.graph.push(array, value);
                }
                Ok(Val::Ref(array))
            }
            Kind::Alias(name) => {
                let name = js::lossy(name);
                let Some(source) = self.resolve(id) else {
                    return Err(Stop::Thrown(format!("Unresolved alias (the anchor must be set before the alias): {name}")));
                };
                if !self.anchors.contains_key(&source) {
                    self.convert(source)?;
                }
                let resolved = self.anchors.get(&source).and_then(|data| data.res.clone());
                let Some(res) = resolved else {
                    return Err(Stop::Thrown("This should not happen: Alias anchor was not resolved?".to_owned()));
                };
                if let Some(data) = self.anchors.get_mut(&source) {
                    data.count += 1.0;
                }
                if self.anchors.get(&source).is_some_and(|data| data.alias_count == 0.0) {
                    let alias_count = self.alias_count(Some(source));
                    if let Some(data) = self.anchors.get_mut(&source) {
                        data.alias_count = alias_count;
                    }
                }
                if self.anchors.get(&source).is_some_and(|data| data.count * data.alias_count > MAX_ALIAS_COUNT) {
                    return Err(Stop::Thrown("Excessive alias count indicates a resource exhaustion attack".to_owned()));
                }
                Ok(res)
            }
        }
    }

    /// `getAliasCount(doc, node, anchors)`.
    fn alias_count(&self, node: Option<usize>) -> f64 {
        let Some(id) = node else { return 1.0 };
        match &self.doc.nodes[id].kind {
            Kind::Alias(_) => {
                let source = self.resolve(id);
                match source.and_then(|source| self.anchors.get(&source)) {
                    Some(anchor) => anchor.count * anchor.alias_count,
                    None => 0.0,
                }
            }
            Kind::Map(pairs) => {
                let mut count: f64 = 0.0;
                for (key, value) in pairs {
                    let c = self.alias_count(Some(*key)).max(self.alias_count(*value));
                    if c > count {
                        count = c;
                    }
                }
                count
            }
            Kind::Seq(items) => {
                let mut count: f64 = 0.0;
                for item in items {
                    let c = self.alias_count(Some(*item));
                    if c > count {
                        count = c;
                    }
                }
                count
            }
            Kind::Scalar(_) => 1.0,
        }
    }
}

/// The document's JavaScript value.
pub fn to_js(doc: &Doc) -> Result<(Graph, Val), Stop> {
    let mut state = ToJs {
        doc,
        graph: Graph::new(),
        anchors: HashMap::new(),
        on_create: None,
        order: pre_order(doc),
    };
    let value = match doc.contents {
        Some(root) => state.convert(root)?,
        None => Val::Null,
    };
    Ok((state.graph, value))
}

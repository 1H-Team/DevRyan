//! A JavaScript object's own enumerable string-keyed properties in V8's
//! order: canonical array-index keys (`0` to `2^32 - 2`) ascending, then the
//! other keys in the order they were first defined. Defining a key that
//! exists keeps its place; deleting one and defining it again puts it last.

use std::collections::{BTreeMap, HashMap};

use devryan_config_text::value::array_index;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Props<V> {
    indexed: BTreeMap<u32, V>,
    named: Vec<(Vec<u16>, V)>,
    positions: HashMap<Vec<u16>, usize>,
}

impl<V> Props<V> {
    pub fn new() -> Self {
        Props {
            indexed: BTreeMap::new(),
            named: Vec::new(),
            positions: HashMap::new(),
        }
    }

    /// `CreateDataProperty(object, key, value)`.
    pub fn define(&mut self, key: Vec<u16>, value: V) {
        if let Some(index) = array_index(&key) {
            self.indexed.insert(index, value);
        } else if let Some(&position) = self.positions.get(&key) {
            self.named[position].1 = value;
        } else {
            self.positions.insert(key.clone(), self.named.len());
            self.named.push((key, value));
        }
    }

    pub fn get(&self, key: &[u16]) -> Option<&V> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index),
            None => self.positions.get(key).map(|position| &self.named[*position].1),
        }
    }

    pub fn get_mut(&mut self, key: &[u16]) -> Option<&mut V> {
        match array_index(key) {
            Some(index) => self.indexed.get_mut(&index),
            None => match self.positions.get(key) {
                Some(position) => Some(&mut self.named[*position].1),
                None => None,
            },
        }
    }

    /// `Object.hasOwn(object, key)`.
    pub fn has(&self, key: &[u16]) -> bool {
        self.get(key).is_some()
    }

    /// `delete object[key]`; the value, if there was one.
    pub fn remove(&mut self, key: &[u16]) -> Option<V> {
        if let Some(index) = array_index(key) {
            return self.indexed.remove(&index);
        }
        let position = self.positions.remove(key)?;
        let (_, value) = self.named.remove(position);
        for (moved, (name, _)) in self.named.iter().enumerate().skip(position) {
            self.positions.insert(name.clone(), moved);
        }
        Some(value)
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `Object.entries(object)`, in order.
    pub fn entries(&self) -> Vec<(Vec<u16>, &V)> {
        let mut out: Vec<(Vec<u16>, &V)> = self
            .indexed
            .iter()
            .map(|(index, value)| (index.to_string().encode_utf16().collect(), value))
            .collect();
        out.extend(self.named.iter().map(|(key, value)| (key.clone(), value)));
        out
    }

    /// The entries, consumed, in order.
    pub fn into_entries(self) -> Vec<(Vec<u16>, V)> {
        let mut out: Vec<(Vec<u16>, V)> = self
            .indexed
            .into_iter()
            .map(|(index, value)| (index.to_string().encode_utf16().collect(), value))
            .collect();
        out.extend(self.named);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devryan_config_text::js::units;

    fn keys(props: &Props<u8>) -> Vec<String> {
        props.entries().into_iter().map(|(key, _)| String::from_utf16_lossy(&key)).collect()
    }

    #[test]
    fn v8_order() {
        let mut props = Props::new();
        for key in ["b", "10", "a", "2", "01", "4294967295", "4294967294"] {
            props.define(units(key), 0);
        }
        props.define(units("b"), 1);
        assert_eq!(keys(&props), ["2", "10", "4294967294", "b", "a", "01", "4294967295"]);
        assert_eq!(props.remove(&units("b")), Some(1));
        props.define(units("b"), 2);
        assert_eq!(keys(&props), ["2", "10", "4294967294", "a", "01", "4294967295", "b"]);
        assert_eq!(props.get(&units("a")), Some(&0));
        assert!(!props.has(&units("c")));
    }
}

//! `Directives` of yaml 2.9.0 (`dist/doc/directives.js`): `%YAML` and `%TAG`
//! lines, and tag resolution.

use crate::js;

#[derive(Clone, Debug)]
pub struct Directives {
    pub explicit: bool,
    pub version: Vec<u16>,
    /// `%TAG` handles to prefixes, in insertion order (lookups only).
    pub tags: Vec<(Vec<u16>, Vec<u16>)>,
    pub doc_start: bool,
    at_next_document: bool,
}

fn default_tags() -> Vec<(Vec<u16>, Vec<u16>)> {
    vec![(js::units("!!"), js::units("tag:yaml.org,2002:"))]
}

impl Directives {
    pub fn new() -> Self {
        Directives {
            explicit: false,
            version: js::units("1.2"),
            tags: default_tags(),
            doc_start: false,
            at_next_document: false,
        }
    }

    fn tag(&self, handle: &[u16]) -> Option<&Vec<u16>> {
        self.tags.iter().find(|(name, _)| name == handle).map(|(_, prefix)| prefix)
    }

    fn set_tag(&mut self, handle: Vec<u16>, prefix: Vec<u16>) {
        // `this.tags[handle] = prefix`: assigning `__proto__` a string is ignored.
        if handle == js::units("__proto__") {
            return;
        }
        if let Some(entry) = self.tags.iter_mut().find(|(name, _)| *name == handle) {
            entry.1 = prefix;
        } else {
            self.tags.push((handle, prefix));
        }
    }

    /// `atDocument()`: the directives of the document that starts now.
    pub fn at_document(&mut self) -> Directives {
        let result = Directives {
            explicit: self.explicit,
            version: self.version.clone(),
            tags: self.tags.clone(),
            doc_start: false,
            at_next_document: false,
        };
        if self.version == js::units("1.1") {
            self.at_next_document = true;
        } else if self.version == js::units("1.2") {
            self.at_next_document = false;
            self.explicit = false;
            self.version = js::units("1.2");
            self.tags = default_tags();
        }
        result
    }

    /// `add(line, onError)`: `on_error(offset, message, warning)`.
    pub fn add(&mut self, line: &[u16], on_error: &mut dyn FnMut(usize, String, bool)) {
        if self.at_next_document {
            self.explicit = false;
            self.version = js::units("1.1");
            self.tags = default_tags();
            self.at_next_document = false;
        }
        let trimmed = js::trim(line);
        let mut parts: Vec<&[u16]> = Vec::new();
        let mut at = 0;
        // `split(/[ \t]+/)`.
        let mut start = 0;
        while at < trimmed.len() {
            if trimmed[at] == 0x20 || trimmed[at] == 0x09 {
                parts.push(&trimmed[start..at]);
                while at < trimmed.len() && (trimmed[at] == 0x20 || trimmed[at] == 0x09) {
                    at += 1;
                }
                start = at;
            } else {
                at += 1;
            }
        }
        parts.push(&trimmed[start..]);
        let name = parts.remove(0);
        match js::lossy(name).as_str() {
            "%TAG" => {
                if parts.len() != 2 {
                    on_error(0, "%TAG directive should contain exactly two parts".to_owned(), false);
                    if parts.len() < 2 {
                        return;
                    }
                }
                self.set_tag(parts[0].to_vec(), parts[1].to_vec());
            }
            "%YAML" => {
                self.explicit = true;
                if parts.len() != 1 {
                    on_error(0, "%YAML directive should contain exactly one part".to_owned(), false);
                    return;
                }
                let version = parts[0];
                if version == js::units("1.1").as_slice() || version == js::units("1.2").as_slice() {
                    self.version = version.to_vec();
                } else {
                    let text = js::lossy(version);
                    let valid = {
                        let (major, minor) = text.split_once('.').unwrap_or(("", ""));
                        !major.is_empty() && !minor.is_empty() && major.bytes().all(|b| b.is_ascii_digit()) && minor.bytes().all(|b| b.is_ascii_digit())
                    };
                    on_error(6, format!("Unsupported YAML version {text}"), valid);
                }
            }
            other => on_error(0, format!("Unknown directive {other}"), true),
        }
    }

    /// `tagName(source, onError)`: the resolved tag, or `None` (`null`).
    pub fn tag_name(&self, source: &[u16], on_error: &mut dyn FnMut(String)) -> Option<Vec<u16>> {
        let text = || js::lossy(source);
        if source == [0x21] {
            return Some(source.to_vec());
        }
        if source.first() != Some(&0x21) {
            on_error(format!("Not a valid tag: {}", text()));
            return None;
        }
        if source.get(1) == Some(&0x3c) {
            let verbatim: &[u16] = if source.len() >= 3 { &source[2..source.len() - 1] } else { &[] };
            if verbatim == [0x21] || verbatim == [0x21, 0x21] {
                on_error(format!("Verbatim tags aren't resolved, so {} is invalid.", text()));
                return None;
            }
            if source.last() != Some(&0x3e) {
                on_error("Verbatim tags must end with a >".to_owned());
            }
            return Some(verbatim.to_vec());
        }
        let split = source.iter().rposition(|unit| *unit == 0x21).map_or(0, |at| at + 1);
        let (handle, suffix) = source.split_at(split);
        if suffix.is_empty() {
            on_error(format!("The {} tag has no suffix", text()));
        }
        if let Some(prefix) = self.tag(handle).filter(|prefix| !prefix.is_empty()) {
            return match js::decode_uri_component(suffix) {
                Ok(decoded) => Some(js::concat(&[prefix, &decoded])),
                Err(message) => {
                    on_error(message.to_owned());
                    None
                }
            };
        }
        if handle == [0x21] {
            return Some(source.to_vec());
        }
        on_error(format!("Could not resolve tag: {}", text()));
        None
    }
}

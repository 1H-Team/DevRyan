//! The Rust port of `toolHelpers.ts`. Its lookup tables are plain objects, so a name of an
//! `Object.prototype` member (`constructor`, `toString`, `__proto__`, ...) finds that member: the
//! port returns what V8 does (the function, or `Object.prototype` itself) instead of the
//! fallback. `JSON.stringify(value, null, 2)` and the context-mode regexes are written out.

#![forbid(unsafe_code)]

use std::sync::OnceLock;

use serde_json::{Map, Value, json};

use crate::js;

/// `TOOL_METADATA`, as the module defines it.
const TOOL_METADATA: &str = r#"{"read":{"displayName":"Read File","category":"file","outputLanguage":"auto","inputFields":[{"key":"filePath","label":"File Path","type":"file"},{"key":"offset","label":"Start Line","type":"text"},{"key":"limit","label":"Lines to Read","type":"text"}]},"write":{"displayName":"Write File","category":"file","outputLanguage":"auto","inputFields":[{"key":"filePath","label":"File Path","type":"file"},{"key":"content","label":"Content","type":"code"}]},"edit":{"displayName":"Edit File","category":"file","outputLanguage":"diff","inputFields":[{"key":"filePath","label":"File Path","type":"file"},{"key":"oldString","label":"Find","type":"code"},{"key":"newString","label":"Replace","type":"code"},{"key":"replaceAll","label":"Replace All","type":"text"}]},"multiedit":{"displayName":"Multi-Edit","category":"file","outputLanguage":"diff","inputFields":[{"key":"filePath","label":"File Path","type":"file"},{"key":"edits","label":"Edits","type":"code","language":"json"}]},"apply_patch":{"displayName":"Apply Patch","category":"file","outputLanguage":"diff","inputFields":[{"key":"patchText","label":"Patch","type":"code","language":"diff"}]},"bash":{"displayName":"Shell Command","category":"system","outputLanguage":"text","inputFields":[{"key":"command","label":"Command","type":"command","language":"bash"},{"key":"description","label":"Description","type":"text"},{"key":"timeout","label":"Timeout (ms)","type":"text"}]},"grep":{"displayName":"Search Files","category":"search","outputLanguage":"text","inputFields":[{"key":"pattern","label":"Pattern","type":"pattern"},{"key":"path","label":"Directory","type":"file"},{"key":"include","label":"Include Pattern","type":"pattern"}]},"glob":{"displayName":"Find Files","category":"search","outputLanguage":"text","inputFields":[{"key":"pattern","label":"Pattern","type":"pattern"},{"key":"path","label":"Directory","type":"file"}]},"list":{"displayName":"List Directory","category":"file","outputLanguage":"text","inputFields":[{"key":"path","label":"Directory","type":"file"},{"key":"ignore","label":"Ignore Patterns","type":"pattern"}]},"task":{"displayName":"Subagent Task:","category":"ai","outputLanguage":"markdown","inputFields":[{"key":"description","label":"Task","type":"text"},{"key":"prompt","label":"Instructions","type":"text"},{"key":"subagent_type","label":"Agent Type","type":"text"}]},"webfetch":{"displayName":"Fetch URL","category":"web","outputLanguage":"auto","inputFields":[{"key":"url","label":"URL","type":"text"},{"key":"format","label":"Format","type":"text"},{"key":"timeout","label":"Timeout","type":"text"}]},"websearch":{"displayName":"Web Search","category":"web","outputLanguage":"markdown","inputFields":[{"key":"query","label":"Search Query","type":"text"},{"key":"numResults","label":"Results Count","type":"text"},{"key":"type","label":"Search Type","type":"text"}]},"codesearch":{"displayName":"Code Search","category":"web","outputLanguage":"markdown","inputFields":[{"key":"query","label":"Search Query","type":"text"},{"key":"tokensNum","label":"Tokens","type":"text"}]},"todowrite":{"displayName":"Update Todo List:","category":"system","outputLanguage":"json","inputFields":[{"key":"todos","label":"Todo Items","type":"code","language":"json"}]},"todoread":{"displayName":"Read Todo List","category":"system","outputLanguage":"json","inputFields":[]},"skill":{"displayName":"Loading Skill:","category":"ai","outputLanguage":"markdown","inputFields":[{"key":"name","label":"Skill Name","type":"text"}]},"devryan_browser":{"displayName":"Using DevRyan Browser","category":"web","outputLanguage":"text","inputFields":[]},"gpt_imagegen":{"displayName":"GPT Image Generation","category":"ai","outputLanguage":"text","inputFields":[]},"question":{"displayName":"Question","category":"ai","outputLanguage":"text","inputFields":[{"key":"questions","label":"Questions","type":"code","language":"json"}]},"plan_enter":{"displayName":"Plan Mode","category":"ai","outputLanguage":"text","inputFields":[]},"plan_exit":{"displayName":"Build Mode","category":"ai","outputLanguage":"text","inputFields":[]},"StructuredOutput":{"displayName":"Structured Output","category":"ai","outputLanguage":"json","inputFields":[]},"structuredoutput":{"displayName":"Structured Output","category":"ai","outputLanguage":"json","inputFields":[]}}"#;

const FILENAME_MAP: [(&str, &str); 46] = [
    ("dockerfile", "dockerfile"),
    ("makefile", "makefile"),
    ("gnumakefile", "makefile"),
    ("cmakelists.txt", "cmake"),
    ("gemfile", "ruby"),
    ("rakefile", "ruby"),
    ("podfile", "ruby"),
    ("vagrantfile", "ruby"),
    ("guardfile", "ruby"),
    ("brewfile", "ruby"),
    ("fastfile", "ruby"),
    ("appfile", "ruby"),
    ("matchfile", "ruby"),
    ("pluginfile", "ruby"),
    ("scanfile", "ruby"),
    ("snapfile", "ruby"),
    (".gitignore", "text"),
    (".gitattributes", "text"),
    (".gitmodules", "ini"),
    (".editorconfig", "ini"),
    (".npmrc", "ini"),
    (".yarnrc", "yaml"),
    (".prettierrc", "json"),
    (".eslintrc", "json"),
    (".babelrc", "json"),
    (".browserslistrc", "text"),
    ("tsconfig.json", "jsonc"),
    ("jsconfig.json", "jsonc"),
    (".env", "bash"),
    (".env.local", "bash"),
    (".env.development", "bash"),
    (".env.production", "bash"),
    (".env.test", "bash"),
    ("procfile", "yaml"),
    ("codeowners", "text"),
    ("package-lock.json", "json"),
    ("composer.lock", "json"),
    ("yarn.lock", "yaml"),
    ("pnpm-lock.yaml", "yaml"),
    ("cargo.lock", "toml"),
    ("poetry.lock", "toml"),
    ("gemfile.lock", "ruby"),
    ("pubspec.lock", "yaml"),
    ("packages.lock.json", "json"),
    ("bun.lockb", "text"),
    ("bun.lock", "json"),
];

const LANGUAGE_MAP: [(&str, &str); 242] = [
    ("js", "javascript"),
    ("jsx", "jsx"),
    ("ts", "typescript"),
    ("tsx", "tsx"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("html", "html"),
    ("htm", "html"),
    ("xhtml", "html"),
    ("vue", "html"),
    ("svelte", "html"),
    ("astro", "html"),
    ("ejs", "html"),
    ("hbs", "handlebars"),
    ("handlebars", "handlebars"),
    ("mustache", "handlebars"),
    ("njk", "twig"),
    ("nunjucks", "twig"),
    ("twig", "twig"),
    ("liquid", "liquid"),
    ("css", "css"),
    ("scss", "scss"),
    ("sass", "sass"),
    ("less", "less"),
    ("styl", "stylus"),
    ("stylus", "stylus"),
    ("pcss", "css"),
    ("postcss", "css"),
    ("json", "json"),
    ("jsonc", "json"),
    ("json5", "json"),
    ("jsonl", "json"),
    ("ndjson", "json"),
    ("geojson", "json"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("toml", "toml"),
    ("xml", "xml"),
    ("xsl", "xml"),
    ("xslt", "xml"),
    ("xsd", "xml"),
    ("dtd", "xml"),
    ("plist", "xml"),
    ("svg", "xml"),
    ("rss", "xml"),
    ("atom", "xml"),
    ("xaml", "xml"),
    ("csproj", "xml"),
    ("vbproj", "xml"),
    ("fsproj", "xml"),
    ("props", "xml"),
    ("targets", "xml"),
    ("nuspec", "xml"),
    ("resx", "xml"),
    ("ini", "ini"),
    ("cfg", "ini"),
    ("conf", "ini"),
    ("config", "ini"),
    ("properties", "properties"),
    ("env", "bash"),
    ("csv", "text"),
    ("tsv", "text"),
    ("py", "python"),
    ("pyw", "python"),
    ("pyx", "python"),
    ("pxd", "python"),
    ("pxi", "python"),
    ("pyi", "python"),
    ("gyp", "python"),
    ("gypi", "python"),
    ("bzl", "python"),
    ("rb", "ruby"),
    ("erb", "erb"),
    ("rake", "ruby"),
    ("gemspec", "ruby"),
    ("ru", "ruby"),
    ("podspec", "ruby"),
    ("thor", "ruby"),
    ("jbuilder", "ruby"),
    ("rabl", "ruby"),
    ("builder", "ruby"),
    ("php", "php"),
    ("phtml", "php"),
    ("php3", "php"),
    ("php4", "php"),
    ("php5", "php"),
    ("php7", "php"),
    ("phps", "php"),
    ("inc", "php"),
    ("blade.php", "php"),
    ("java", "java"),
    ("kt", "kotlin"),
    ("kts", "kotlin"),
    ("scala", "scala"),
    ("sc", "scala"),
    ("groovy", "groovy"),
    ("gradle", "groovy"),
    ("gvy", "groovy"),
    ("gy", "groovy"),
    ("gsh", "groovy"),
    ("c", "c"),
    ("h", "c"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("c++", "cpp"),
    ("hpp", "cpp"),
    ("hxx", "cpp"),
    ("hh", "cpp"),
    ("h++", "cpp"),
    ("ino", "cpp"),
    ("m", "objectivec"),
    ("mm", "objectivec"),
    ("cs", "csharp"),
    ("csx", "csharp"),
    ("cake", "csharp"),
    ("fs", "fsharp"),
    ("fsx", "fsharp"),
    ("fsi", "fsharp"),
    ("vb", "vbnet"),
    ("go", "go"),
    ("mod", "go"),
    ("sum", "text"),
    ("rs", "rust"),
    ("swift", "swift"),
    ("dart", "dart"),
    ("lua", "lua"),
    ("pl", "perl"),
    ("pm", "perl"),
    ("pod", "perl"),
    ("t", "perl"),
    ("r", "r"),
    ("R", "r"),
    ("rmd", "markdown"),
    ("rnw", "r"),
    ("jl", "julia"),
    ("hs", "haskell"),
    ("lhs", "haskell"),
    ("ex", "elixir"),
    ("exs", "elixir"),
    ("eex", "html"),
    ("heex", "html"),
    ("leex", "html"),
    ("erl", "erlang"),
    ("hrl", "erlang"),
    ("clj", "clojure"),
    ("cljs", "clojure"),
    ("cljc", "clojure"),
    ("edn", "clojure"),
    ("lisp", "lisp"),
    ("cl", "lisp"),
    ("el", "lisp"),
    ("scm", "scheme"),
    ("ss", "scheme"),
    ("rkt", "scheme"),
    ("ml", "ocaml"),
    ("mli", "ocaml"),
    ("re", "reason"),
    ("rei", "reason"),
    ("nim", "nim"),
    ("nims", "nim"),
    ("nimble", "nim"),
    ("zig", "zig"),
    ("v", "v"),
    ("vsh", "v"),
    ("cr", "crystal"),
    ("d", "d"),
    ("di", "d"),
    ("sh", "bash"),
    ("bash", "bash"),
    ("zsh", "bash"),
    ("fish", "bash"),
    ("ksh", "bash"),
    ("csh", "bash"),
    ("tcsh", "bash"),
    ("ps1", "powershell"),
    ("psm1", "powershell"),
    ("psd1", "powershell"),
    ("bat", "batch"),
    ("cmd", "batch"),
    ("sql", "sql"),
    ("psql", "sql"),
    ("plsql", "sql"),
    ("mysql", "sql"),
    ("pgsql", "sql"),
    ("sqlite", "sql"),
    ("graphql", "graphql"),
    ("gql", "graphql"),
    ("sol", "solidity"),
    ("asm", "nasm"),
    ("s", "nasm"),
    ("S", "nasm"),
    ("nix", "nix"),
    ("tf", "hcl"),
    ("tfvars", "hcl"),
    ("hcl", "hcl"),
    ("dockerignore", "text"),
    ("pp", "puppet"),
    ("tex", "latex"),
    ("latex", "latex"),
    ("sty", "latex"),
    ("cls", "latex"),
    ("bib", "bibtex"),
    ("bst", "bibtex"),
    ("md", "markdown"),
    ("mdx", "markdown"),
    ("markdown", "markdown"),
    ("mdown", "markdown"),
    ("mkd", "markdown"),
    ("rst", "text"),
    ("adoc", "asciidoc"),
    ("asciidoc", "asciidoc"),
    ("org", "text"),
    ("txt", "text"),
    ("text", "text"),
    ("rtf", "text"),
    ("vim", "vim"),
    ("vimrc", "vim"),
    ("mk", "makefile"),
    ("cmake", "cmake"),
    ("diff", "diff"),
    ("patch", "diff"),
    ("prisma", "prisma"),
    ("proto", "protobuf"),
    ("thrift", "thrift"),
    ("wat", "wasm"),
    ("wast", "wasm"),
    ("glsl", "glsl"),
    ("vert", "glsl"),
    ("frag", "glsl"),
    ("geom", "glsl"),
    ("comp", "glsl"),
    ("hlsl", "hlsl"),
    ("fx", "hlsl"),
    ("cg", "cg"),
    ("shader", "glsl"),
    ("htaccess", "apacheconf"),
    ("nginx", "nginx"),
    ("kubeconfig", "yaml"),
    ("ansible", "yaml"),
];

const MIME_MAP: [(&str, &str); 9] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("webp", "image/webp"),
    ("ico", "image/x-icon"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
];

const IMAGE_EXTENSIONS: [&str; 9] = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"];

/// The function-valued members of `Object.prototype` and the function each one is.
const OBJECT_PROTOTYPE: [(&str, &str); 11] = [
    ("constructor", "Object"),                        // recorded-literal: the Object constructor's name
    ("__defineGetter__", "__defineGetter__"),         // recorded-literal: an Object.prototype member name
    ("__defineSetter__", "__defineSetter__"),         // recorded-literal: an Object.prototype member name
    ("hasOwnProperty", "hasOwnProperty"),             // recorded-literal: an Object.prototype member name
    ("__lookupGetter__", "__lookupGetter__"),         // recorded-literal: an Object.prototype member name
    ("__lookupSetter__", "__lookupSetter__"),         // recorded-literal: an Object.prototype member name
    ("isPrototypeOf", "isPrototypeOf"),               // recorded-literal: an Object.prototype member name
    ("propertyIsEnumerable", "propertyIsEnumerable"), // recorded-literal: an Object.prototype member name
    ("toString", "toString"),                         // recorded-literal: an Object.prototype member name
    ("valueOf", "valueOf"),                           // recorded-literal: an Object.prototype member name
    ("toLocaleString", "toLocaleString"),             // recorded-literal: an Object.prototype member name
];

fn metadata_table() -> &'static Map<String, Value> {
    static TABLE: OnceLock<Map<String, Value>> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_str(TOOL_METADATA).unwrap_or_default())
}

/// What `plainObject[key]` finds on `Object.prototype` (absent: `None`).
fn prototype_member(key: &str) -> Option<Value> {
    if key == "__proto__" {
        return Some(json!({}));
    }
    OBJECT_PROTOTYPE.iter().find(|(k, _)| *k == key).map(|(_, f)| json!({ "$function": f }))
}

/// `table[key]` for a `Record<string, string>` literal: own entry, else a prototype member.
fn lookup(table: &[(&str, &str)], key: &str) -> Option<Value> {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| Value::String((*v).into()))
        .or_else(|| prototype_member(key))
}

/// JS `\s`.
fn sp(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
            | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn nullish(value: &Value) -> bool {
    value.is_null() || js::is_undefined(value)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        _ if js::is_undefined(value) => false,
        _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| {
        !(o.len() == 1
            && ["$undefined", "$num", "$utf16", "$map", "$set", "$bytes", "$date", "$function"]
                .iter()
                .any(|k| o.contains_key(*k)))
    })
}

/// `value[key]` of a non-nullish value (own properties only; the keys read here are not
/// `Object.prototype` names).
fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

/// `charAt(0).toUpperCase()`-style: the first BMP character uppercased, a supplementary one kept.
fn upper_first(word: &str) -> String {
    let mut chars = word.chars();
    let Some(first) = chars.next() else { return String::new() };
    let mut out: String = if (first as u32) < 0x10000 {
        first.to_uppercase().collect()
    } else {
        first.to_string()
    };
    out.push_str(chars.as_str());
    out
}

/// `formatFallbackToolDisplayName`.
fn fallback_name(tool: &str) -> String {
    let trimmed = tool.trim_matches(sp);
    let rest = trimmed.strip_prefix("mcp__").unwrap_or(trimmed);
    let mut spaced = String::with_capacity(rest.len());
    let mut run = false;
    for c in rest.chars() {
        if c == '-' || c == '_' || sp(c) {
            if !run {
                spaced.push(' ');
            }
            run = true;
        } else {
            spaced.push(c);
            run = false;
        }
    }
    spaced
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            let first = chars.next().map(|c| upper_first(&c.to_string())).unwrap_or_default();
            format!("{first}{}", chars.as_str().to_lowercase())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn ci_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

/// `formatContextModeToolDisplayName`.
fn context_mode_name(tool: &str) -> Option<String> {
    let trimmed = tool.trim_matches(sp);
    let mcp = ["mcp__context-mode__", "mcp__context_mode__"]
        .iter()
        .find_map(|p| ci_prefix(trimmed, p))
        .filter(|rest| !rest.is_empty() && !rest.contains(line_terminator));
    let action = match mcp {
        Some(name) => name.strip_prefix("ctx_").unwrap_or(name).to_string(),
        None => ci_prefix(trimmed, "ctx_")
            .filter(|r| !r.is_empty() && !r.contains(line_terminator))?
            .to_string(),
    };
    if action.is_empty() {
        return None;
    }
    let display = fallback_name(&action);
    (!display.is_empty()).then(|| format!("Context Mode: {display}"))
}

fn metadata(tool: &Value) -> Result<Value, String> {
    let key = text_of(tool);
    if let Some(found) = metadata_table().get(&key) {
        return Ok(found.clone());
    }
    if let Some(member) = prototype_member(&key) {
        return Ok(member);
    }
    let Some(text) = tool.as_str() else {
        return Err("toolName.trim is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let name = context_mode_name(text).unwrap_or_else(|| fallback_name(text));
    Ok(json!({ "displayName": name, "category": "system", "outputLanguage": "text", "inputFields": [] }))
}

/// `filePath.split(sep).pop().toLowerCase()`.
fn last_lower(path: &str, sep: char) -> String {
    path.rsplit(sep).next().unwrap_or("").to_lowercase()
}

fn language(path: &Value) -> Result<Value, String> {
    let Some(path) = path.as_str() else {
        return Err("filePath.split is not a function".into()); // recorded-literal: V8 TypeError text
    };
    let ext = last_lower(path, '.');
    let filename = last_lower(path, '/');
    if let Some(found) = lookup(&FILENAME_MAP, &filename) {
        return Ok(found);
    }
    Ok(lookup(&LANGUAGE_MAP, &ext).unwrap_or(Value::Null))
}

/// `JSON.parse(text)` succeeds (JSON grammar; JSON's own white space only).
fn json_parses(text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut p = Parser { s: &units, at: 0 };
    p.value() && {
        p.space();
        p.at == units.len()
    }
}

struct Parser<'a> {
    s: &'a [u16],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.s.get(self.at).copied()
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.at += 1;
        }
    }
    fn eat(&mut self, b: u8) -> bool {
        let hit = self.peek() == Some(u16::from(b));
        if hit {
            self.at += 1;
        }
        hit
    }
    fn word(&mut self, w: &str) -> bool {
        w.bytes().all(|b| self.eat(b))
    }
    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(0x30..=0x39)) {
            self.at += 1;
        }
        self.at - start
    }
    fn number(&mut self) -> bool {
        self.eat(b'-');
        if !self.eat(b'0') && self.digits() == 0 {
            return false;
        }
        if self.eat(b'.') && self.digits() == 0 {
            return false;
        }
        if self.eat(b'e') || self.eat(b'E') {
            let _ = self.eat(b'+') || self.eat(b'-');
            if self.digits() == 0 {
                return false;
            }
        }
        true
    }
    fn string(&mut self) -> bool {
        if !self.eat(b'"') {
            return false;
        }
        loop {
            let Some(u) = self.peek() else { return false };
            self.at += 1;
            match u {
                0x22 => return true,
                0x00..=0x1f => return false,
                0x5c => {
                    let Some(e) = self.peek() else { return false };
                    self.at += 1;
                    match e {
                        0x22 | 0x5c | 0x2f | 0x62 | 0x66 | 0x6e | 0x72 | 0x74 => {}
                        0x75 => {
                            for _ in 0..4 {
                                if !self.peek().is_some_and(|h| h < 128 && u8::try_from(h).is_ok_and(|b| b.is_ascii_hexdigit())) {
                                    return false;
                                }
                                self.at += 1;
                            }
                        }
                        _ => return false,
                    }
                }
                _ => {}
            }
        }
    }
    fn value(&mut self) -> bool {
        self.space();
        let ok = match self.peek() {
            Some(0x7b) => {
                self.at += 1;
                self.space();
                if self.eat(b'}') {
                    true
                } else {
                    loop {
                        self.space();
                        if !self.string() {
                            break false;
                        }
                        self.space();
                        if !self.eat(b':') || !self.value() {
                            break false;
                        }
                        self.space();
                        if self.eat(b',') {
                            continue;
                        }
                        break self.eat(b'}');
                    }
                }
            }
            Some(0x5b) => {
                self.at += 1;
                self.space();
                if self.eat(b']') {
                    true
                } else {
                    loop {
                        if !self.value() {
                            break false;
                        }
                        self.space();
                        if self.eat(b',') {
                            continue;
                        }
                        break self.eat(b']');
                    }
                }
            }
            Some(0x22) => self.string(),
            Some(0x74) => self.word("true"),
            Some(0x66) => self.word("false"),
            Some(0x6e) => self.word("null"),
            Some(_) => self.number(),
            None => false,
        };
        self.space();
        ok
    }
}

/// `JSON.stringify` of a string, as code units.
fn quote(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for item in char::decode_utf16(units.iter().copied()) {
        match item {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(value, null, 2)` at `depth`; `None` where it gives `undefined`.
fn pretty(value: &Value, depth: usize) -> Option<String> {
    if js::is_undefined(value) || value.get("$function").is_some() {
        return None;
    }
    if let Some(units) = js::string_units(value) {
        return Some(quote(&units));
    }
    if let Some(n) = js::as_number(value) {
        return Some(if n.is_finite() { js::number_to_string(n) } else { "null".into() });
    }
    let pad = "  ".repeat(depth + 1);
    let close = "  ".repeat(depth);
    match value {
        Value::Null => Some("null".into()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(items) => {
            if items.is_empty() {
                return Some("[]".into());
            }
            let parts: Vec<String> = items
                .iter()
                .map(|v| format!("{pad}{}", pretty(v, depth + 1).unwrap_or_else(|| "null".into())))
                .collect();
            Some(format!("[\n{}\n{close}]", parts.join(",\n")))
        }
        Value::Object(o) => {
            if let Some(date) = o.get("$date").filter(|_| o.len() == 1) {
                return Some(if date.as_str() == Some("Invalid") {
                    "null".into()
                } else {
                    quote(&date.as_str().unwrap_or("").encode_utf16().collect::<Vec<_>>())
                });
            }
            let entries: Vec<(String, Value)> = match o.get("$bytes").filter(|_| o.len() == 1).and_then(Value::as_array) {
                Some(bytes) => bytes.iter().enumerate().map(|(i, b)| (i.to_string(), b.clone())).collect(),
                None if plain(value).is_none() => Vec::new(),
                None => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            };
            let parts: Vec<String> = entries
                .iter()
                .filter_map(|(k, v)| pretty(v, depth + 1).map(|text| format!("{pad}{}: {text}", quote(&k.encode_utf16().collect::<Vec<_>>()))))
                .collect();
            if parts.is_empty() {
                return Some("{}".into());
            }
            Some(format!("{{\n{}\n{close}}}", parts.join(",\n")))
        }
        _ => None,
    }
}

/// `key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().replace(/^./, upper)`.
fn format_key(key: &str) -> String {
    let mut spaced = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            spaced.push(' ');
        }
        spaced.push(if c == '_' { ' ' } else { c });
    }
    let lower = spaced.to_lowercase();
    match lower.chars().next() {
        Some(first) if !line_terminator(first) => upper_first(&lower),
        _ => lower,
    }
}

/// `String(value)` for the template.
fn text_of(value: &Value) -> String {
    if let Some(units) = js::string_units(value) {
        return String::from_utf16_lossy(&units);
    }
    match value {
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|v| if nullish(v) { String::new() } else { text_of(v) })
            .collect::<Vec<_>>()
            .join(","),
        _ if js::is_undefined(value) => "undefined".into(),
        _ => js::as_number(value).map_or_else(|| "[object Object]".into(), js::number_to_string),
    }
}

/// Port of `getToolMetadata` (`toolHelpers.ts:248`).
pub fn get_tool_metadata(tool_name: Value) -> Result<Value, String> {
    metadata(&tool_name)
}

/// Port of `detectToolOutputLanguage` (`toolHelpers.ts:262`).
pub fn detect_tool_output_language(tool_name: Value, output: Value, input: Value) -> Result<Value, String> {
    let meta = metadata(&tool_name)?;
    let output_language = field(&meta, "outputLanguage");
    if output_language.as_str() == Some("auto") {
        let read = |k: &str| if nullish(&input) { js::undefined() } else { field(&input, k) };
        if let Some(path) = ["filePath", "file_path", "sourcePath"].iter().map(|k| read(k)).find(truthy) {
            let found = language(&path)?;
            if truthy(&found) {
                return Ok(found);
            }
        }
        if tool_name.as_str() == Some("webfetch") {
            let Some(text) = output.as_str() else {
                return Err("output.trim is not a function".into()); // recorded-literal: V8 TypeError text
            };
            let trimmed = text.trim_matches(sp);
            if (trimmed.starts_with('{') || trimmed.starts_with('[')) && json_parses(text) {
                return Ok(Value::String("json".into()));
            }
            if trimmed.starts_with('<') {
                return Ok(Value::String("html".into()));
            }
            if text.contains("```") {
                return Ok(Value::String("markdown".into()));
            }
        }
        return Ok(Value::String("text".into()));
    }
    Ok(if truthy(&output_language) {
        output_language
    } else {
        Value::String("text".into())
    })
}

/// Port of `getLanguageFromExtension` (`toolHelpers.ts:298`).
pub fn get_language_from_extension(file_path: Value) -> Result<Value, String> {
    language(&file_path)
}

/// Port of `isImageFile` (`toolHelpers.ts:710`).
pub fn is_image_file(file_path: String) -> Result<bool, String> {
    Ok(IMAGE_EXTENSIONS.contains(&last_lower(&file_path, '.').as_str()))
}

/// Port of `getImageMimeType` (`toolHelpers.ts:715`).
pub fn get_image_mime_type(file_path: String) -> Result<Value, String> {
    Ok(lookup(&MIME_MAP, &last_lower(&file_path, '.')).unwrap_or_else(|| Value::String("image/png".into())))
}

fn units_of(value: &Value) -> Vec<u16> {
    js::string_units(value).unwrap_or_else(|| text_of(value).encode_utf16().collect())
}

/// Port of `formatToolInput` (`toolHelpers.ts:731`).
pub fn format_tool_input(input: Value, tool_name: Value) -> Result<Value, String> {
    if !truthy(&input) {
        return Ok(Value::String(String::new()));
    }
    let get_string = |key: &str| {
        let value = field(&input, key);
        (js::string_units(&value).is_some() || js::as_number(&value).is_some()).then(|| units_of(&value))
    };
    let first = |keys: &[&str]| keys.iter().filter_map(|k| get_string(k)).find(|s| !s.is_empty());
    let is_object = plain(&input).is_some() || input.is_array() || input.get("$map").is_some() || input.get("$set").is_some();
    let picked = match tool_name.as_str() {
        Some("bash") => first(&["command"]),
        Some("task") => first(&["prompt"]).or_else(|| first(&["description"])),
        Some("apply_patch") if is_object => first(&["patchText", "patch_text", "patch"]),
        Some("edit" | "multiedit") if is_object => first(&["filePath", "file_path", "path"]).map(|p| {
            let mut out: Vec<u16> = "File path: ".encode_utf16().collect();
            out.extend(p);
            out
        }),
        Some("write") if is_object => first(&["content"]),
        _ => None,
    };
    if let Some(units) = picked {
        return Ok(js::utf16_string(&units));
    }
    if !is_object {
        return Ok(js::utf16_string(&units_of(&input)));
    }
    let entries: Vec<(String, Value)> = match &input {
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::Object(o) if plain(&input).is_some() => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<u16> = Vec::new();
    for (i, (k, v)) in entries.into_iter().filter(|(_, v)| !nullish(v) && v.as_str() != Some("")).enumerate() {
        if i > 0 {
            out.push(u16::from(b'\n'));
        }
        out.extend(format_key(&k).encode_utf16());
        out.extend(": ".encode_utf16());
        if let Value::Bool(b) = v {
            out.extend(if b { "Yes" } else { "No" }.encode_utf16());
        } else if js::string_units(&v).is_none() && js::as_number(&v).is_none() && (v.is_object() || v.is_array()) {
            out.extend(pretty(&v, 0).unwrap_or_else(|| "undefined".into()).encode_utf16());
        } else {
            out.extend(units_of(&v));
        }
    }
    Ok(js::utf16_string(&out))
}

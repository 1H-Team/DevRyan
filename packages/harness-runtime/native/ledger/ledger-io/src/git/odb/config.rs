//! A repository's `config` file, parsed as `config.c` parses it, for the few
//! settings the reader must honour (`core.repositoryformatversion`,
//! `extensions.*`, `remote.*.promisor`). Anything the parser does not accept
//! (a syntax Git would reject, or one it is unsure of) is an error, which
//! the reader turns into "ask Git". Includes are not followed: Git does not
//! follow them when it reads the repository format either.
#![forbid(unsafe_code)]

/// One `section[.subsection].key [= value]` assignment, in file order.
/// Section and key names are lowercase; the subsection keeps its case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub section: String,
    pub subsection: Option<Vec<u8>>,
    pub key: String,
    /// `None` for a key written without `=` (boolean true).
    pub value: Option<Vec<u8>>,
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    /// `get_next_char`: `\r\n` reads as `\n`; `None` at the end.
    fn next(&mut self) -> Option<u8> {
        let byte = *self.data.get(self.at)?;
        self.at += 1;
        if byte == b'\r' && self.data.get(self.at) == Some(&b'\n') {
            self.at += 1;
            return Some(b'\n');
        }
        Some(byte)
    }

    fn peek(&self) -> Option<u8> {
        let byte = *self.data.get(self.at)?;
        if byte == b'\r' && self.data.get(self.at + 1) == Some(&b'\n') {
            return Some(b'\n');
        }
        Some(byte)
    }

    fn skip_comment(&mut self) {
        while let Some(byte) = self.next() {
            if byte == b'\n' {
                return;
            }
        }
    }
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// Parses the whole file; `Err` with what was not accepted.
pub(crate) fn parse(data: &[u8]) -> Result<Vec<Entry>, &'static str> {
    let data = data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data);
    let mut reader = Reader { data, at: 0 };
    let mut entries = Vec::new();
    let mut section: Option<(String, Option<Vec<u8>>)> = None;
    loop {
        let Some(byte) = reader.next() else {
            return Ok(entries);
        };
        if byte == b'\n' || is_space(byte) {
            continue;
        }
        if byte == b'#' || byte == b';' {
            reader.skip_comment();
            continue;
        }
        if byte == b'[' {
            section = Some(parse_section(&mut reader)?);
            continue;
        }
        if !byte.is_ascii_alphabetic() {
            return Err("a key that does not start with a letter");
        }
        let Some((name, subsection)) = section.clone() else {
            return Err("a key before any section");
        };
        let mut key = String::from(char::from(byte.to_ascii_lowercase()));
        while let Some(byte) = reader
            .peek()
            .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            reader.next();
            key.push(char::from(byte.to_ascii_lowercase()));
        }
        while reader
            .peek()
            .is_some_and(|byte| byte == b' ' || byte == b'\t')
        {
            reader.next();
        }
        let value = match reader.peek() {
            None | Some(b'\n') => {
                reader.next();
                None
            }
            Some(b'#' | b';') => {
                reader.skip_comment();
                None
            }
            Some(b'=') => {
                reader.next();
                Some(parse_value(&mut reader)?)
            }
            Some(_) => return Err("a key followed by something other than '='"),
        };
        entries.push(Entry {
            section: name,
            subsection,
            key,
            value,
        });
    }
}

/// `get_base_var` and `get_extended_base_var`: `[name]`, `[name "sub"]` or
/// the deprecated `[name.sub]` (whose subsection Git lowercases).
fn parse_section(reader: &mut Reader<'_>) -> Result<(String, Option<Vec<u8>>), &'static str> {
    let mut name = String::new();
    loop {
        let byte = reader.next().ok_or("an unterminated section header")?;
        match byte {
            b']' => break,
            b' ' | b'\t' => {
                // `[name "subsection"]`.
                while reader
                    .peek()
                    .is_some_and(|byte| byte == b' ' || byte == b'\t')
                {
                    reader.next();
                }
                if reader.next() != Some(b'"') {
                    return Err("a section header with a space but no quoted subsection");
                }
                let mut subsection = Vec::new();
                loop {
                    match reader.next().ok_or("an unterminated subsection")? {
                        b'\n' => return Err("a newline in a subsection"),
                        b'"' => break,
                        b'\\' => match reader.next().ok_or("an unterminated subsection")? {
                            b'\n' => return Err("a newline in a subsection"),
                            other => subsection.push(other),
                        },
                        other => subsection.push(other),
                    }
                }
                if reader.next() != Some(b']') {
                    return Err("a subsection not followed by ']'");
                }
                return check_section(name).map(|name| (name, Some(subsection)));
            }
            byte if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.' => {
                name.push(char::from(byte.to_ascii_lowercase()))
            }
            _ => return Err("a section name with an invalid character"),
        }
    }
    match name.split_once('.') {
        Some((base, sub)) => {
            check_section(base.to_owned()).map(|base| (base, Some(sub.as_bytes().to_vec())))
        }
        None => check_section(name).map(|name| (name, None)),
    }
}

fn check_section(name: String) -> Result<String, &'static str> {
    if name.is_empty() || name.contains('.') {
        return Err("an empty or dotted section name");
    }
    Ok(name)
}

/// `parse_value`: leading blanks skipped; quotes toggle; `\\`, `\"`, `\n`,
/// `\t`, `\b` and a backslash-newline continuation; a comment outside quotes
/// ends the value; blanks outside quotes become single spaces between words
/// and are dropped at the end.
fn parse_value(reader: &mut Reader<'_>) -> Result<Vec<u8>, &'static str> {
    let mut value = Vec::new();
    let mut quoted = false;
    let mut comment = false;
    let mut spaces = 0usize;
    loop {
        let Some(byte) = reader.next() else {
            if quoted {
                return Err("an unterminated quote");
            }
            return Ok(value);
        };
        if byte == b'\n' {
            if quoted {
                return Err("an unterminated quote");
            }
            return Ok(value);
        }
        if comment {
            continue;
        }
        if is_space(byte) && !quoted {
            if !value.is_empty() {
                spaces += 1;
            }
            continue;
        }
        if !quoted && (byte == b';' || byte == b'#') {
            comment = true;
            continue;
        }
        value.extend(std::iter::repeat_n(b' ', spaces));
        spaces = 0;
        match byte {
            b'\\' => match reader.next() {
                Some(b'\n') => continue,
                Some(b't') => value.push(b'\t'),
                Some(b'b') => value.push(8),
                Some(b'n') => value.push(b'\n'),
                Some(b'\\') => value.push(b'\\'),
                Some(b'"') => value.push(b'"'),
                _ => return Err("an invalid escape"),
            },
            b'"' => quoted = !quoted,
            other => value.push(other),
        }
    }
}

/// `git_config_bool` for the spellings the reader accepts: a bare key, an
/// empty value, `true`/`yes`/`on`/`1`, `false`/`no`/`off`/`0` (any case).
pub(crate) fn boolean(value: Option<&[u8]>) -> Option<bool> {
    let Some(value) = value else {
        return Some(true);
    };
    match value.to_ascii_lowercase().as_slice() {
        b"true" | b"yes" | b"on" | b"1" => Some(true),
        b"false" | b"no" | b"off" | b"0" | b"" => Some(false),
        _ => None,
    }
}

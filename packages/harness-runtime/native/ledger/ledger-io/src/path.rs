//! Node's `path.posix` `dirname`, `basename`, `normalize` and `join`, as the
//! lock and atomic-write code use them to build every name it touches.
//!
//! The JavaScript works on UTF-16 code units and only ever inspects `/` and
//! `.`. Both are single bytes in UTF-8 that never occur inside a multi-byte
//! sequence, so working on the UTF-8 bytes gives the same splits; lengths are
//! measured in bytes on both sides of every comparison, which keeps the
//! algorithm's arithmetic consistent.
#![forbid(unsafe_code)]

const SLASH: u8 = b'/';
const DOT: u8 = b'.';

fn text(bytes: &[u8]) -> String {
    // Every slice taken here starts and ends at an ASCII byte or at an end of
    // the input, so it is valid UTF-8 whenever the input is.
    String::from_utf8_lossy(bytes).into_owned()
}

/// `normalizeString(path, allowAboveRoot, '/', isPosixPathSeparator)`.
fn normalize_string(path: &[u8], allow_above_root: bool) -> Vec<u8> {
    let mut res: Vec<u8> = Vec::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let len = path.len() as isize;
    let mut i: isize = 0;
    while i <= len {
        if i < len {
            code = path[i as usize];
        } else if code == SLASH {
            break;
        } else {
            code = SLASH;
        }
        if code == SLASH {
            if last_slash == i - 1 || dots == 1 {
                // No-op.
            } else if dots == 2 {
                let ends_with_dots =
                    res.len() >= 2 && res[res.len() - 1] == DOT && res[res.len() - 2] == DOT;
                if res.len() < 2 || last_segment_length != 2 || !ends_with_dots {
                    if res.len() > 2 {
                        let last_slash_index = res.len() as isize - last_segment_length - 1;
                        if last_slash_index == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(last_slash_index as usize);
                            let last = res
                                .iter()
                                .rposition(|&b| b == SLASH)
                                .map_or(-1, |p| p as isize);
                            last_segment_length = res.len() as isize - 1 - last;
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.extend_from_slice(b"..");
                    } else {
                        res.extend_from_slice(b"/..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i as usize];
                if !res.is_empty() {
                    res.push(SLASH);
                }
                res.extend_from_slice(segment);
                last_segment_length = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// `path.posix.normalize`.
pub fn normalize(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".to_owned();
    }
    let is_absolute = bytes[0] == SLASH;
    let trailing = bytes[bytes.len() - 1] == SLASH;
    let mut out = normalize_string(bytes, !is_absolute);
    if out.is_empty() {
        if is_absolute {
            return "/".to_owned();
        }
        return if trailing {
            "./".to_owned()
        } else {
            ".".to_owned()
        };
    }
    if trailing {
        out.push(SLASH);
    }
    if is_absolute {
        out.insert(0, SLASH);
    }
    text(&out)
}

/// `path.posix.join(...parts)`.
pub fn join(parts: &[&str]) -> String {
    let kept: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    if kept.is_empty() {
        return ".".to_owned();
    }
    normalize(&kept.join("/"))
}

/// `path.posix.dirname`.
pub fn dirname(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".".to_owned();
    }
    let has_root = bytes[0] == SLASH;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = bytes.len() as isize - 1;
    while i >= 1 {
        if bytes[i as usize] == SLASH {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root {
            "/".to_owned()
        } else {
            ".".to_owned()
        };
    }
    if has_root && end == 1 {
        return "//".to_owned();
    }
    text(&bytes[..end as usize])
}

/// `path.posix.basename(path)` (no suffix).
pub fn basename(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = bytes.len() as isize - 1;
    while i >= 0 {
        if bytes[i as usize] == SLASH {
            if !matched_slash {
                start = i as usize + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }
    if end == -1 {
        return String::new();
    }
    text(&bytes[start..end as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values are Node's `path.posix` (checked against Node; the
    // differential tests exercise the same functions through the lock code).
    #[test]
    fn dirname_matches_node() {
        for (input, expected) in [
            ("", "."),
            ("/", "/"),
            ("//", "/"),
            ("//a", "//"),
            ("/a", "/"),
            ("/a/b/", "/a"),
            ("a", "."),
            ("a/b", "a"),
            ("a//b", "a/"),
            ("/a/b.lock", "/a"),
            ("./x", "."),
        ] {
            assert_eq!(dirname(input), expected, "dirname({input:?})");
        }
    }

    #[test]
    fn basename_matches_node() {
        for (input, expected) in [
            ("", ""),
            ("/", ""),
            ("/a/b", "b"),
            ("/a/b/", "b"),
            ("a", "a"),
            ("é/ü.json", "ü.json"),
        ] {
            assert_eq!(basename(input), expected, "basename({input:?})");
        }
    }

    #[test]
    fn join_and_normalize_match_node() {
        for (parts, expected) in [
            (&["/a", "b"][..], "/a/b"),
            (&["/a/", "/b/"][..], "/a/b/"),
            (&["a", "..", ".."][..], ".."),
            (&["/a", "..", ".."][..], "/"),
            (&["a/./b", "../c"][..], "a/c"),
            (&["", ""][..], "."),
            (&["./", ""][..], "./"),
            (&["a/..", ""][..], "."),
            (&["../../x/..", "y"][..], "../../y"),
            (&["/x", "file.tmp-1"][..], "/x/file.tmp-1"),
        ] {
            assert_eq!(join(parts), expected, "join({parts:?})");
        }
    }
}

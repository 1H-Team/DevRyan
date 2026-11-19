//! `safeChangePath` of `packages/harness-runtime/lib/session-changes-snapshot.js`,
//! which is pure: the project-relative paths the ledger accepts.
//!
//! The JavaScript uses `path.isAbsolute`, which is POSIX's on macOS and Linux
//! (a leading `/`); Windows paths are out of scope, as the native ledger is
//! never selected there.
#![forbid(unsafe_code)]

/// `safeChangePath(value)` for a string value: not empty, not absolute, and
/// no part between `/` or `\` is `..` or `.git` (compared exactly, so `.GIT`
/// and `...` pass). A value that is not a string is never safe.
pub fn safe_change_path(value: &[u16]) -> bool {
    if value.is_empty() || value[0] == u16::from(b'/') {
        return false;
    }
    let dot_dot: Vec<u16> = "..".encode_utf16().collect();
    let git: Vec<u16> = ".git".encode_utf16().collect();
    !value
        .split(|unit| *unit == u16::from(b'/') || *unit == u16::from(b'\\'))
        .any(|part| part == dot_dot.as_slice() || part == git.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn safe(text: &str) -> bool {
        safe_change_path(&text.encode_utf16().collect::<Vec<u16>>())
    }

    #[test]
    fn parts_named_dot_dot_or_dot_git_are_refused_at_either_separator() {
        assert!(
            safe("a/b.txt") && safe("./a") && safe(".GIT/x") && safe("a\\...\\b") && safe("\\a")
        );
        assert!(
            !safe("")
                && !safe("/a")
                && !safe("a/../b")
                && !safe("a\\.git\\c")
                && !safe(".git")
                && !safe("..")
        );
    }
}

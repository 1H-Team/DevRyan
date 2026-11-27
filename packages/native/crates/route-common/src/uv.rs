//! Node's text for a failed file-system call, which the group answers in its
//! 500 bodies: `<code>: <message>, <syscall> '<path>'` (Node's `uvException`),
//! with libuv's own name and message for the error number (`uv-errors.tsv`,
//! as `util.getSystemErrorMap()` gives them), and `UNKNOWN: unknown error` for
//! a number libuv does not map.

const TABLE: &str = include_str!("uv-errors.tsv");

/// libuv's name of an error number of this platform (libuv's codes are the negated numbers).
pub fn name_of(errno: i32) -> Option<&'static str> {
    let common: &[(i32, &str)] = &[
        (libc::E2BIG, "E2BIG"),
        (libc::EACCES, "EACCES"),
        (libc::EADDRINUSE, "EADDRINUSE"),
        (libc::EADDRNOTAVAIL, "EADDRNOTAVAIL"),
        (libc::EAFNOSUPPORT, "EAFNOSUPPORT"),
        (libc::EAGAIN, "EAGAIN"),
        (libc::EALREADY, "EALREADY"),
        (libc::EBADF, "EBADF"),
        (libc::EBUSY, "EBUSY"),
        (libc::ECANCELED, "ECANCELED"),
        (libc::ECONNABORTED, "ECONNABORTED"),
        (libc::ECONNREFUSED, "ECONNREFUSED"),
        (libc::ECONNRESET, "ECONNRESET"),
        (libc::EDESTADDRREQ, "EDESTADDRREQ"),
        (libc::EEXIST, "EEXIST"),
        (libc::EFAULT, "EFAULT"),
        (libc::EFBIG, "EFBIG"),
        (libc::EHOSTDOWN, "EHOSTDOWN"),
        (libc::EHOSTUNREACH, "EHOSTUNREACH"),
        (libc::EILSEQ, "EILSEQ"),
        (libc::EINTR, "EINTR"),
        (libc::EINVAL, "EINVAL"),
        (libc::EIO, "EIO"),
        (libc::EISCONN, "EISCONN"),
        (libc::EISDIR, "EISDIR"),
        (libc::ELOOP, "ELOOP"),
        (libc::EMFILE, "EMFILE"),
        (libc::EMLINK, "EMLINK"),
        (libc::EMSGSIZE, "EMSGSIZE"),
        (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        (libc::ENETDOWN, "ENETDOWN"),
        (libc::ENETUNREACH, "ENETUNREACH"),
        (libc::ENFILE, "ENFILE"),
        (libc::ENOBUFS, "ENOBUFS"),
        (libc::ENODATA, "ENODATA"),
        (libc::ENODEV, "ENODEV"),
        (libc::ENOENT, "ENOENT"),
        (libc::ENOEXEC, "ENOEXEC"),
        (libc::ENOMEM, "ENOMEM"),
        (libc::ENOPROTOOPT, "ENOPROTOOPT"),
        (libc::ENOSPC, "ENOSPC"),
        (libc::ENOSYS, "ENOSYS"),
        (libc::ENOTCONN, "ENOTCONN"),
        (libc::ENOTDIR, "ENOTDIR"),
        (libc::ENOTEMPTY, "ENOTEMPTY"),
        (libc::ENOTSOCK, "ENOTSOCK"),
        (libc::ENOTSUP, "ENOTSUP"),
        (libc::ENOTTY, "ENOTTY"),
        (libc::ENXIO, "ENXIO"),
        (libc::EOVERFLOW, "EOVERFLOW"),
        (libc::EPERM, "EPERM"),
        (libc::EPIPE, "EPIPE"),
        (libc::EPROTO, "EPROTO"),
        (libc::EPROTONOSUPPORT, "EPROTONOSUPPORT"),
        (libc::EPROTOTYPE, "EPROTOTYPE"),
        (libc::ERANGE, "ERANGE"),
        (libc::EROFS, "EROFS"),
        (libc::ESHUTDOWN, "ESHUTDOWN"),
        (libc::ESOCKTNOSUPPORT, "ESOCKTNOSUPPORT"),
        (libc::ESPIPE, "ESPIPE"),
        (libc::ESRCH, "ESRCH"),
        (libc::ETIMEDOUT, "ETIMEDOUT"),
        (libc::ETXTBSY, "ETXTBSY"),
        (libc::EXDEV, "EXDEV"),
    ];
    #[cfg(target_os = "macos")]
    let platform: &[(i32, &str)] = &[(libc::EFTYPE, "EFTYPE")];
    #[cfg(target_os = "linux")]
    let platform: &[(i32, &str)] = &[(libc::ENONET, "ENONET"), (libc::EREMOTEIO, "EREMOTEIO"), (libc::EUNATCH, "EUNATCH")];
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let platform: &[(i32, &str)] = &[];
    common.iter().chain(platform).find(|(number, _)| *number == errno).map(|(_, name)| *name)
}

/// The error number of a name (the reverse of [`name_of`]).
pub fn errno_of(name: &str) -> Option<i32> {
    (1..512).find(|errno| name_of(*errno) == Some(name))
}

/// libuv's message for a name of the table.
pub fn message_of(name: &str) -> Option<&'static str> {
    TABLE
        .lines()
        .filter(|line| !line.starts_with('#'))
        .find_map(|line| line.split_once('\t').filter(|(key, _)| *key == name).map(|(_, message)| message))
}

/// `uvException`'s message for a failed `syscall` on `path` (a JavaScript string's text).
pub fn fs_message(error: &std::io::Error, syscall: &str, path: Option<&str>) -> String {
    let (name, message) = error
        .raw_os_error()
        .and_then(name_of)
        .and_then(|name| message_of(name).map(|message| (name, message)))
        .unwrap_or(("UNKNOWN", "unknown error"));
    match path {
        Some(path) => format!("{name}: {message}, {syscall} '{path}'"),
        None => format!("{name}: {message}, {syscall}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_has_a_message() {
        for errno in 1..200 {
            if let Some(name) = name_of(errno) {
                assert!(message_of(name).is_some(), "{name} has no message in uv-errors.tsv");
            }
        }
    }

    #[test]
    fn node_texts() {
        let error = std::io::Error::from_raw_os_error(libc::EISDIR);
        assert_eq!(
            fs_message(&error, "open", Some("/r/magic-prompts.json")),
            "EISDIR: illegal operation on a directory, open '/r/magic-prompts.json'"
        );
        let error = std::io::Error::from_raw_os_error(libc::ELOOP);
        assert_eq!(
            fs_message(&error, "open", Some("/r/x")),
            "ELOOP: too many symbolic links encountered, open '/r/x'"
        );
        let error = std::io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(fs_message(&error, "open", Some("/r/x")), "EACCES: permission denied, open '/r/x'");
        let error = std::io::Error::other("not an OS error");
        assert_eq!(fs_message(&error, "write", None), "UNKNOWN: unknown error, write");
    }
}

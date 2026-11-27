//! Node's file-system calls as the JavaScript groups make them, with Node's
//! error texts (`uv`): `fsPromises.readFile(path, 'utf8')` (the bytes; the
//! caller decodes), `writeFile` (open with `O_WRONLY | O_CREAT | O_TRUNC`,
//! mode 0666 before the umask), `rename`, `rm(path, { force: true })`,
//! `mkdir(dir, { recursive: true })`, `path.join`, `crypto.randomUUID()`, and
//! harness-runtime's `cleanupStaleAtomicFiles` (the stale-temporary rule).

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::uv;

/// Node's `path.join(dir, name)` for an absolute POSIX directory: the normalised path.
pub fn join(dir: &str, name: &str) -> String {
    let joined = format!("{dir}/{name}");
    let absolute = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    if absolute { format!("/{body}") } else { body }
}

/// Node's `path.dirname` of an absolute normalised path.
pub fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

/// A failed call's text as Node's `uvException` gives it.
fn failed(error: &std::io::Error, syscall: &str, path: &str) -> String {
    uv::fs_message(error, syscall, Some(path))
}

/// `fsPromises.readFile(path)`: the bytes, `Ok(None)` for ENOENT, or Node's error text (an open that fails names
/// `open`, a read that fails, such as a directory's, names `read`; both with the path).
pub fn read_file(path: &str) -> Result<Option<Vec<u8>>, (Option<&'static str>, String)> {
    let opened = if crate::plant::named("rv-read-nofollow") {
        OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)
    } else {
        fs::File::open(path)
    };
    let mut file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err((error.raw_os_error().and_then(uv::name_of), failed(&error, "open", path))),
    };
    let mut bytes = Vec::with_capacity(file.metadata().map(|meta| meta.len() as usize).unwrap_or(0));
    match file.read_to_end(&mut bytes) {
        Ok(_) => Ok(Some(bytes)),
        Err(error) => Err((error.raw_os_error().and_then(uv::name_of), failed(&error, "read", path))),
    }
}

/// `fsPromises.writeFile(path, bytes)`: created with mode 0666 before the umask, truncated, written whole.
pub fn write_file(path: &str, bytes: &[u8], mode: u32) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .map_err(|error| failed(&error, "open", path))?;
    if crate::plant::named("rv-mode-fixed-644") {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o644));
    }
    file.write_all(bytes).map_err(|error| uv::fs_message(&error, "write", None))
}

/// `fsPromises.rename(from, to)`: Node's text names both paths.
pub fn rename(from: &str, to: &str) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| {
        if crate::plant::named("rv-rename-text-from-only") {
            failed(&error, "rename", from)
        } else {
            format!("{} -> '{to}'", failed(&error, "rename", from))
        }
    })
}

/// `fsPromises.rm(path, { force: true })` of a file: a missing one is no error.
pub fn rm_force(path: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failed(&error, "rm", path)),
    }
}

/// `fsPromises.mkdir(dir, { recursive: true })`.
pub fn mkdir_recursive(dir: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| failed(&error, "mkdir", dir))
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// A stat's `mtimeMs` (milliseconds with the nanoseconds as a fraction, as Node computes it).
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1_000_000.0
}

/// harness-runtime's `cleanupStaleAtomicFiles(filePath)` with its defaults: in `filePath`'s folder, every regular
/// file (by its directory entry: a link is not one) whose name starts with `<file name>.tmp-` and whose mtime is
/// `stale_after_ms` or more before `now()` is removed. The names come in libuv's scandir order (sorted by
/// bytes). A missing folder removes nothing; an entry gone between the listing and its stat is skipped; any other
/// failure stops the cleanup there and is returned (the group ignores it, as its `.catch(() => undefined)` does).
pub fn cleanup_stale_atomic_files(file_path: &str, stale_after_ms: f64, now: impl Fn() -> f64) -> Result<usize, String> {
    cleanup_stale_atomic_files_with(file_path, stale_after_ms, now, false)
}

/// [`cleanup_stale_atomic_files`]; `links_too` (a planted change only) also takes links whose target is a file.
pub fn cleanup_stale_atomic_files_with(file_path: &str, stale_after_ms: f64, now: impl Fn() -> f64, links_too: bool) -> Result<usize, String> {
    let directory = dirname(file_path);
    let base = file_path.get(directory.len()..).unwrap_or("").trim_start_matches('/');
    let prefix = if crate::plant::named("rv-cleanup-prefix-no-dash") {
        format!("{base}.tmp")
    } else {
        format!("{base}.tmp-")
    };
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(failed(&error, "scandir", directory)),
    };
    let mut names: Vec<(Vec<u8>, bool)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| failed(&error, "scandir", directory))?;
        use std::os::unix::ffi::OsStrExt;
        let is_file = entry
            .file_type()
            .map(|kind| kind.is_file() || (links_too && kind.is_symlink()) || (crate::plant::named("rv-cleanup-removes-dirs") && kind.is_dir()))
            .unwrap_or(false);
        names.push((entry.file_name().as_bytes().to_vec(), is_file));
    }
    names.sort();
    let mut removed = 0;
    for (name, is_file) in names {
        let named = if crate::plant::named("rv-cleanup-any-file-prefix") {
            name.windows(5).any(|window| window == b".tmp-")
        } else {
            name.starts_with(prefix.as_bytes())
        };
        if !is_file || !named {
            continue;
        }
        let candidate = join(directory, &String::from_utf8_lossy(&name));
        let stat = match fs::metadata(&candidate) {
            Ok(stat) => stat,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(failed(&error, "stat", &candidate)),
        };
        let changed = if crate::plant::named("rv-cleanup-uses-ctime") {
            use std::os::unix::fs::MetadataExt;
            stat.ctime() as f64 * 1000.0 + stat.ctime_nsec() as f64 / 1_000_000.0
        } else {
            mtime_ms(&stat)
        };
        let age = now() - changed;
        if age < stale_after_ms || (crate::plant::named("rv-cleanup-boundary-strict") && age <= stale_after_ms) {
            continue;
        }
        if links_too {
            let _ = fs::remove_file(&candidate);
        } else if crate::plant::named("rv-cleanup-removes-dirs") && stat.is_dir() {
            let _ = fs::remove_dir_all(&candidate);
        } else if crate::plant::named("rv-cleanup-continues") {
            if rm_force(&candidate).is_err() {
                continue;
            }
        } else {
            rm_force(&candidate)?;
        }
        removed += 1;
    }
    Ok(removed)
}

/// harness-runtime's default age of a stale temporary file: a day.
pub const STALE_TMP_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// `crypto.randomUUID()`: a version 4 UUID in lower case, from the system's random source.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    // SAFETY: getentropy writes at most 256 bytes into the buffer it is given; 16 fit.
    let status = unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) };
    if status != 0 {
        // No system randomness: the time and the pid still make the name unique to this save.
        let seed = (now_ms() as u128) ^ (u128::from(std::process::id()) << 64) ^ u128::from(COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        bytes = seed.to_le_bytes();
    }
    if crate::plant::named("rv-uuid-constant") {
        bytes = [0u8; 16];
    }
    bytes[6] = (bytes[6] & 0x0f) | if crate::plant::named("rv-uuid-v7") { 0x70 } else { 0x40 };
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4() {
        let uuid = random_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(uuid, random_uuid());
    }

    #[test]
    fn paths_as_node_joins_them() {
        assert_eq!(join("/a/b/", "c.json"), "/a/b/c.json");
        assert_eq!(dirname("/a/b/c.json"), "/a/b");
    }

    #[test]
    fn the_stale_rule() {
        let root = std::env::temp_dir().join(format!("devryan-fsjs-{}", random_uuid()));
        fs::create_dir(&root).unwrap();
        let dir = root.to_str().unwrap().to_owned();
        let file = join(&dir, "doc.json");
        for name in ["doc.json.tmp-1-a", "doc.json.tmp-", "doc.json.tmp", "other.json.tmp-1"] {
            fs::write(join(&dir, name), "x").unwrap();
        }
        fs::create_dir(join(&dir, "doc.json.tmp-dir")).unwrap();
        // Everything is "a day old" against a clock two days ahead.
        let removed = cleanup_stale_atomic_files(&file, STALE_TMP_AGE_MS, || now_ms() + 2.0 * STALE_TMP_AGE_MS).unwrap();
        assert_eq!(removed, 2);
        let mut left: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["doc.json.tmp", "doc.json.tmp-dir", "other.json.tmp-1"]);
        assert_eq!(cleanup_stale_atomic_files(&file, STALE_TMP_AGE_MS, now_ms).unwrap(), 0);
        fs::remove_dir_all(&root).unwrap();
    }
}

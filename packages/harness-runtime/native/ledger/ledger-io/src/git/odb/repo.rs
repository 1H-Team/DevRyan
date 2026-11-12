//! Opening a repository: what `setup.c` (`check_repository_format_gently`,
//! `verify_repository_format`) decides from its configuration, and what the
//! reader must know before it may say an object is absent.
#![forbid(unsafe_code)]

use std::sync::Mutex;

use super::config;
use super::{Answer, AskGit, ObjectFormat, Reason, ask, io_ask};

/// An opened repository: its directory and object format, every setting
/// that would change an answer checked.
pub struct Repository {
    git_dir: String,
    format: ObjectFormat,
    /// A promisor remote is configured.
    promisor: bool,
    /// `packed-refs` (its stamp) and whether it held `refs/replace/`.
    replace_cache: Mutex<Option<(FileStamp, bool)>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileStamp {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}

impl FileStamp {
    pub(crate) fn of(metadata: &std::fs::Metadata) -> FileStamp {
        use std::os::unix::fs::MetadataExt;
        FileStamp {
            dev: metadata.dev(),
            ino: metadata.ino(),
            size: metadata.size(),
            mtime: metadata.mtime(),
            mtime_ns: metadata.mtime_nsec(),
            ctime: metadata.ctime(),
            ctime_ns: metadata.ctime_nsec(),
        }
    }
}

pub(crate) fn not_found(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

fn exists(path: &str) -> Answer<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if not_found(&error) => Ok(false),
        Err(error) => Err(io_ask(&error, path.rsplit('/').next().unwrap_or(path))),
    }
}

impl Repository {
    /// Opens `git_dir`. Asks Git (`repository_format`) unless it is a
    /// directory with `objects/`, no `commondir` (a linked worktree), a
    /// configuration the parser accepts and `core.repositoryformatversion` 0
    /// or 1; asks Git (`extension`) for any `extensions.*` key but
    /// `objectFormat` = sha1 or sha256 in version 1.
    pub fn open(git_dir: &str) -> Answer<Repository> {
        let git_dir = git_dir.trim_end_matches('/');
        let git_dir = if git_dir.is_empty() { "/" } else { git_dir };
        match std::fs::metadata(git_dir) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return ask(Reason::RepositoryFormat, "not a directory (a gitfile?)"),
            Err(error) if not_found(&error) => {
                return ask(Reason::RepositoryFormat, "no such directory");
            }
            Err(error) => return Err(io_ask(&error, "repository")),
        }
        match std::fs::metadata(format!("{git_dir}/objects")) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return ask(Reason::RepositoryFormat, "objects is not a directory"),
            Err(error) if not_found(&error) => {
                return ask(Reason::RepositoryFormat, "no objects directory");
            }
            Err(error) => return Err(io_ask(&error, "objects")),
        }
        if exists(&format!("{git_dir}/commondir"))? {
            return ask(Reason::RepositoryFormat, "a linked worktree (commondir)");
        }
        let entries = match std::fs::read(format!("{git_dir}/config")) {
            Ok(data) => config::parse(&data)
                .map_err(|what| AskGit::new(Reason::RepositoryFormat, format!("config: {what}")))?,
            Err(error) if not_found(&error) => Vec::new(),
            Err(error) => return Err(io_ask(&error, "config")),
        };
        let mut version = 0u64;
        let mut extensions: Vec<(String, Option<Vec<u8>>)> = Vec::new();
        let mut promisor = false;
        for entry in &entries {
            match (
                entry.section.as_str(),
                entry.subsection.is_some(),
                entry.key.as_str(),
            ) {
                ("core", false, "repositoryformatversion") => {
                    let value = entry.value.as_deref().unwrap_or_default();
                    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) || value.len() > 9
                    {
                        return ask(
                            Reason::RepositoryFormat,
                            "core.repositoryformatversion is not a plain number",
                        );
                    }
                    version = std::str::from_utf8(value)
                        .ok()
                        .and_then(|text| text.parse().ok())
                        .unwrap_or(u64::MAX);
                }
                ("extensions", false, key) => {
                    extensions.push((key.to_owned(), entry.value.clone()))
                }
                ("extensions", true, _) => {
                    return ask(Reason::Extension, "an extensions subsection");
                }
                ("remote", true, "promisor") => match config::boolean(entry.value.as_deref()) {
                    Some(value) => promisor |= value,
                    None => {
                        return ask(
                            Reason::RepositoryFormat,
                            "remote.*.promisor is not a boolean",
                        );
                    }
                },
                _ => {}
            }
        }
        if version > 1 {
            return ask(
                Reason::RepositoryFormat,
                format!("repository format version {version}"),
            );
        }
        let mut format = ObjectFormat::Sha1;
        for (key, value) in &extensions {
            if version == 0 {
                return ask(
                    Reason::Extension,
                    format!("extensions.{key} in a version 0 repository"),
                );
            }
            match (key.as_str(), value.as_deref()) {
                ("objectformat", Some(b"sha1")) => format = ObjectFormat::Sha1,
                ("objectformat", Some(b"sha256")) => format = ObjectFormat::Sha256,
                ("refstorage", _) => {
                    return ask(Reason::Extension, "extensions.refStorage (reftable)");
                }
                _ => return ask(Reason::Extension, format!("extensions.{key}")),
            }
        }
        Ok(Repository {
            git_dir: git_dir.to_owned(),
            format,
            promisor,
            replace_cache: Mutex::new(None),
        })
    }

    pub fn git_dir(&self) -> &str {
        &self.git_dir
    }

    pub fn format(&self) -> ObjectFormat {
        self.format
    }

    /// Why an object found nowhere may still exist: alternates (checked on
    /// every miss, as they may appear later) or a promisor remote.
    pub(crate) fn miss_reason(&self) -> Option<AskGit> {
        match std::fs::symlink_metadata(format!("{}/objects/info/alternates", self.git_dir)) {
            Ok(_) => return Some(AskGit::new(Reason::Alternates, "objects/info/alternates")),
            Err(error) if not_found(&error) => {}
            Err(error) => return Some(io_ask(&error, "alternates")),
        }
        if self.promisor {
            return Some(AskGit::new(Reason::Promisor, "a promisor remote"));
        }
        None
    }

    /// Asks Git while replace refs exist (Git would answer with the
    /// replacement): a non-empty `refs/replace/`, or `packed-refs` naming
    /// one. Checked on every read: an `lstat` and a `stat`, `packed-refs`
    /// read again only when it changed.
    pub(crate) fn check_replace_refs(&self) -> Answer<()> {
        match std::fs::read_dir(format!("{}/refs/replace", self.git_dir)) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return ask(Reason::ReplaceRefs, "refs/replace");
                }
            }
            Err(error) if not_found(&error) => {}
            Err(error) => return Err(io_ask(&error, "refs/replace")),
        }
        let path = format!("{}/packed-refs", self.git_dir);
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if not_found(&error) => return Ok(()),
            Err(error) => return Err(io_ask(&error, "packed-refs")),
        };
        let stamp = FileStamp::of(&metadata);
        let mut cache = self
            .replace_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replaced = match *cache {
            Some((cached, replaced)) if cached == stamp => replaced,
            _ => {
                let data = match std::fs::read(&path) {
                    Ok(data) => data,
                    Err(error) if not_found(&error) => return Ok(()),
                    Err(error) => return Err(io_ask(&error, "packed-refs")),
                };
                let replaced = data
                    .windows(b" refs/replace/".len())
                    .any(|window| window == b" refs/replace/");
                *cache = Some((stamp, replaced));
                replaced
            }
        };
        if replaced {
            return ask(Reason::ReplaceRefs, "packed-refs names refs/replace/");
        }
        Ok(())
    }
}

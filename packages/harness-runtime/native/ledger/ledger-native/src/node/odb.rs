//! The ledger repository's object database on the loop (plan package L3b):
//! what the Git runner's persistent object reader and the store read and
//! write in-process through `ledger_io::git::odb` (L3a), with the `node`
//! module's rule 1. Every read and every loose write is one piece of pool
//! work (`node::submit`) that settles in a unit of its own, never in the
//! checkpoint that started it, as the JavaScript's reader answers in a later
//! loop turn (its `cat-file` process's output) and `writeLooseObject`'s
//! `fs.promises` calls do.
//!
//! - [`ObjectReader`]: what one persistent reader of `crate::git` reads
//!   with: the repository's database, opened on the reader's own thread
//!   and kept for the reader's life (the JavaScript's `cat-file` process:
//!   one per reader, names answered in order, its packs kept open as Git
//!   keeps them), each name as [`Lookup`]: the object, "missing", Git's
//!   `<id> submodule`, or "ask Git" with the reason. A read that blocks in a
//!   system call blocks that reader's thread only, never the I/O pool, as a
//!   stuck `cat-file` blocks only its process; the reader's deadline then
//!   fails it (`crate::git`).
//! - [`write_loose_object`]: `writeLooseObject` of `session-changes-trees.js`
//!   (L3a's `write_loose_object`, call for call), its failure as Node's error.
//! - [`object_id`], [`sha256_hex`], [`random_uuid`]: the synchronous
//!   `crypto` calls the store makes (`objectID`, `changeKey`,
//!   `crypto.randomUUID()`), inline as in JavaScript.
#![forbid(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use ledger_io::git::odb::{
    Kind, NameLookup, ObjectFormat, Odb, OdbOptions, RealLooseFs, SystemLooseEnv,
};

use super::{error_value, submit};
use crate::js::Promise;
use crate::value::W;

/// What one name resolves to, as the reader's `cat-file` would print it.
#[derive(Clone, Debug)]
pub enum Lookup {
    /// `<id> <type> <size>` (and the content, unless only checked).
    Found {
        oid: String,
        kind: &'static str,
        size: f64,
        data: Option<Rc<Vec<u8>>>,
    },
    /// `<name> missing`.
    Missing,
    /// `<id> submodule`: a gitlink entry whose commit is absent (not given:
    /// the reader asks Git for every gitlink, `OdbOptions::ask_gitlinks`).
    Submodule(String),
    /// The database cannot answer exactly: ask Git (the reason's code).
    Ask(&'static str),
}

/// [`Lookup`] as the reader's thread makes it (no `Rc`: it crosses threads).
pub enum Looked {
    Found {
        oid: String,
        kind: &'static str,
        size: u64,
        data: Option<Vec<u8>>,
    },
    Missing,
    Submodule(String),
    Ask(&'static str),
}

/// One name for the reader's thread to look up, and where to post it.
struct Job {
    name: Vec<u8>,
    check: bool,
    poster: super::SourcePoster<Looked>,
}

/// The work a reader's thread does: the lookup of each job in turn (a test
/// substitutes one that blocks).
pub type LookupWork = Box<dyn FnMut(&[u8], bool) -> Looked + Send>;

struct ReaderInner {
    jobs: RefCell<Option<std::sync::mpsc::Sender<Job>>>,
    /// Each lookup in flight: its source, closed when the reader is.
    flight: RefCell<HashMap<u64, super::Source<Looked>>>,
    next: Cell<u64>,
}

/// One persistent reader's database and thread. Clones are the same reader.
#[derive(Clone)]
pub struct ObjectReader(Rc<ReaderInner>);

impl ObjectReader {
    /// The reader of the repository at `git_dir` (absolute, as `path.resolve`
    /// gives it). `ask_all`: every name asks Git (an environment whose Git
    /// would look objects up otherwise, `GIT_REPLACE_REF_BASE`).
    pub fn new(git_dir: &str, ask_all: bool) -> ObjectReader {
        let git_dir = git_dir.to_owned();
        let mut odb: Option<Result<Odb, &'static str>> = None;
        ObjectReader::with_work(Box::new(move |name: &[u8], check: bool| {
            if ask_all {
                return Looked::Ask("replace_ref_base");
            }
            let odb = odb.get_or_insert_with(|| {
                Odb::open(
                    &git_dir,
                    OdbOptions {
                        ask_gitlinks: true,
                        ..OdbOptions::default()
                    },
                )
                .map_err(|ask| ask.reason.code())
            });
            let odb = match odb {
                Ok(odb) => odb,
                Err(code) => return Looked::Ask(code),
            };
            match odb.read_name(name, check) {
                Ok(NameLookup::Found(named)) => Looked::Found {
                    oid: named.oid.hex(),
                    kind: named.kind.name(),
                    size: named.size,
                    data: named.data,
                },
                Ok(NameLookup::Missing) => Looked::Missing,
                Ok(NameLookup::Submodule(oid)) => Looked::Submodule(oid.hex()),
                Err(ask) => Looked::Ask(ask.reason.code()),
            }
        }))
    }

    /// A reader whose thread runs `work` for each name (its database's
    /// lookups; a test's own).
    pub fn with_work(work: LookupWork) -> ObjectReader {
        let (jobs, receive) = std::sync::mpsc::channel::<Job>();
        let mut work = work;
        super::net::helper_thread(
            "object-reader",
            move || {
                while let Ok(job) = receive.recv() {
                    let looked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        work(&job.name, job.check)
                    }))
                    .unwrap_or(Looked::Ask("internal"));
                    job.poster.post(looked);
                }
            },
            |_| {},
        );
        ObjectReader(Rc::new(ReaderInner {
            jobs: RefCell::new(Some(jobs)),
            flight: RefCell::new(HashMap::new()),
            next: Cell::new(0),
        }))
    }

    /// One `cat-file --batch` (`check`: `--batch-check`) name, answered on
    /// the reader's thread in a unit of its own. Never rejects; after
    /// [`ObjectReader::close`] it never settles (its request is failed by
    /// then).
    pub fn read_name(&self, name: &[u8], check: bool) -> Promise<Lookup, W> {
        let (promise, resolvers) = Promise::with_resolvers();
        let id = self.0.next.get() + 1;
        self.0.next.set(id);
        let inner = Rc::downgrade(&self.0);
        let source = super::source(move |looked: Looked| {
            if let Some(inner) = inner.upgrade()
                && let Some(source) = inner.flight.borrow_mut().remove(&id)
            {
                source.close();
            }
            resolvers.fulfill(looked.into());
        });
        let poster = source.poster();
        let sent = self.0.jobs.borrow().as_ref().is_some_and(|jobs| {
            jobs.send(Job {
                name: name.to_vec(),
                check,
                poster,
            })
            .is_ok()
        });
        if sent {
            self.0.flight.borrow_mut().insert(id, source);
        } else {
            source.close();
        }
        promise
    }

    /// The reader's end: its thread stops after the lookup it is in (one
    /// blocked in a system call stays blocked, as a stuck process would,
    /// but holds nothing of the loop's), and nothing it still answers is
    /// delivered. Its database, packs and descriptors go with the thread.
    pub fn close(&self) {
        self.0.jobs.borrow_mut().take();
        let flight: Vec<super::Source<Looked>> = self
            .0
            .flight
            .borrow_mut()
            .drain()
            .map(|(_, source)| source)
            .collect();
        for source in flight {
            source.close();
        }
    }
}

impl From<Looked> for Lookup {
    fn from(looked: Looked) -> Lookup {
        match looked {
            Looked::Found {
                oid,
                kind,
                size,
                data,
            } => Lookup::Found {
                oid,
                kind,
                size: size as f64,
                data: data.map(Rc::new),
            },
            Looked::Missing => Lookup::Missing,
            Looked::Submodule(oid) => Lookup::Submodule(oid),
            Looked::Ask(code) => Lookup::Ask(code),
        }
    }
}

fn format_of(oid_length: usize) -> ObjectFormat {
    if oid_length == 64 {
        ObjectFormat::Sha256
    } else {
        ObjectFormat::Sha1
    }
}

/// `writeLooseObject(gitDir, type, content, oidLength)`: one loose object
/// unless it exists (freshened then), its id; a failure is Node's error of
/// the system call that failed. Resolves the id as a string.
pub fn write_loose_object(
    git_dir: &str,
    kind: &str,
    content: Rc<Vec<u8>>,
    oid_length: usize,
) -> Promise<W, W> {
    let (promise, resolvers) = Promise::with_resolvers();
    let kind = if kind == "tree" {
        Kind::Tree
    } else {
        Kind::Blob
    };
    let (git_dir, content) = (git_dir.to_owned(), content.as_ref().clone());
    submit(
        move || {
            ledger_io::git::odb::write_loose_object(
                &RealLooseFs,
                &mut SystemLooseEnv,
                &git_dir,
                kind,
                &content,
                format_of(oid_length),
            )
            .map(|oid| oid.hex())
        },
        move |written| match written {
            Ok(oid) => resolvers.fulfill(W::string(&oid)),
            Err(error) => resolvers.reject(error_value(&error)),
        },
    );
    promise
}

/// `objectID(type, content, oidLength)`.
pub fn object_id(kind: &str, content: &[u8], oid_length: usize) -> String {
    let kind = if kind == "tree" {
        Kind::Tree
    } else {
        Kind::Blob
    };
    format_of(oid_length).object_id(kind, content).hex()
}

/// `crypto.createHash('sha256').update(bytes).digest('hex')`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    ObjectFormat::Sha256.hash(&[bytes]).hex()
}

/// `crypto.randomUUID()`: synchronous, as in JavaScript.
pub fn random_uuid() -> String {
    ledger_io::atomic::random_uuid().expect("the system's random source")
}

/// `path.join(...parts)` (posix).
pub fn join(parts: &[&str]) -> String {
    ledger_io::path::join(parts)
}

/// `path.dirname(path)` (posix).
pub fn dirname(path: &str) -> String {
    ledger_io::path::dirname(path)
}

/// `path.resolve(base, path)` (posix): `path` if absolute, else joined to
/// `base` (itself resolved against the process's directory), normalized,
/// with no trailing slash.
pub fn resolve(base: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        path.to_owned()
    } else if base.starts_with('/') {
        format!("{base}/{path}")
    } else {
        let cwd = std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|_| String::from("/"));
        format!("{cwd}/{base}/{path}")
    };
    let normalized = ledger_io::path::normalize(&joined);
    if normalized.len() > 1 && normalized.ends_with('/') {
        normalized[..normalized.len() - 1].to_owned()
    } else {
        normalized
    }
}

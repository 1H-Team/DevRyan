//! Unit tests of the object database: the formats on handcrafted packs,
//! indexes and loose objects (cases Git cannot be made to write: delta
//! cycles, huge declared sizes, REF bases outside their pack), the parsers fuzzed with
//! seeded random input, and the writer's call sequence on a recording file
//! system. Git itself is the oracle in `scripts/ledger-native/odb-differential.mjs`.
#![forbid(unsafe_code)]

use std::cell::RefCell;

use super::inflate::Source;
use super::pack::{Pack, PackIndex};
use super::*;
use crate::fs::{Error, Result as FsResult, Stat};

/// A directory under the OS temp dir, removed when dropped (a failing test included).
struct Scratch(String);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "ledger-io-odb-{}-{name}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("scratch");
        Scratch(path.to_str().expect("utf-8 temp dir").to_owned())
    }

    /// A bare repository's skeleton (what the reader needs; no Git involved).
    fn repo(name: &str, format: ObjectFormat) -> Scratch {
        let scratch = Scratch::new(name);
        for directory in ["objects/pack", "objects/info", "refs/heads"] {
            std::fs::create_dir_all(format!("{}/{directory}", scratch.0)).expect("skeleton");
        }
        std::fs::write(format!("{}/HEAD", scratch.0), "ref: refs/heads/main\n").expect("HEAD");
        let config = match format {
            ObjectFormat::Sha1 => "[core]\n\trepositoryformatversion = 0\n\tbare = true\n".to_owned(),
            ObjectFormat::Sha256 => "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n".to_owned(),
        };
        std::fs::write(format!("{}/config", scratch.0), config).expect("config");
        scratch
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// mulberry32.
struct Random(u32);

impl Random {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            self.next() as usize % bound
        }
    }
    fn bytes(&mut self, count: usize) -> Vec<u8> {
        (0..count).map(|_| self.next() as u8).collect()
    }
}

fn zlib(data: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(data, 6)
}

/// `encode_in_pack_object_header`.
fn entry_header(kind: u8, mut size: u64) -> Vec<u8> {
    let mut out = Vec::new();
    let mut byte = (kind << 4) | (size & 15) as u8;
    size >>= 4;
    while size != 0 {
        out.push(byte | 0x80);
        byte = (size & 0x7f) as u8;
        size >>= 7;
    }
    out.push(byte);
    out
}

/// The OFS distance as `write_reuse_object` encodes it.
fn ofs_bytes(mut distance: u64) -> Vec<u8> {
    let mut out = vec![(distance & 127) as u8];
    distance >>= 7;
    while distance != 0 {
        distance -= 1;
        out.insert(0, 0x80 | (distance & 127) as u8);
        distance >>= 7;
    }
    out
}

fn varint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// A delta that copies `base[..keep]` and inserts `tail`.
fn delta(base: &[u8], keep: usize, tail: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint(base.len() as u64, &mut out);
    varint((keep + tail.len()) as u64, &mut out);
    if keep > 0 {
        out.extend_from_slice(&[
            0x80 | 0x10 | 0x20 | 0x40,
            (keep & 0xff) as u8,
            (keep >> 8 & 0xff) as u8,
            (keep >> 16 & 0xff) as u8,
        ]);
    }
    for chunk in tail.chunks(127) {
        out.push(chunk.len() as u8);
        out.extend_from_slice(chunk);
    }
    out
}

/// Builds a pack and its index of version 2.
struct PackBuilder {
    format: ObjectFormat,
    data: Vec<u8>,
    entries: Vec<(Oid, u64)>,
    /// Offsets above this go to the 64-bit table (Git: 2^31 - 1).
    large_above: u64,
}

impl PackBuilder {
    fn new(format: ObjectFormat) -> PackBuilder {
        PackBuilder {
            format,
            data: Vec::new(),
            entries: Vec::new(),
            large_above: 0x7fff_ffff,
        }
    }

    fn offset(&self) -> u64 {
        12 + self.data.len() as u64
    }

    fn raw_entry(&mut self, oid: Oid, header: Vec<u8>, payload: &[u8]) -> u64 {
        let offset = self.offset();
        self.data.extend_from_slice(&header);
        self.data.extend_from_slice(&zlib(payload));
        self.entries.push((oid, offset));
        offset
    }

    fn object(&mut self, kind: Kind, content: &[u8]) -> (Oid, u64) {
        let oid = self.format.object_id(kind, content);
        let number = match kind {
            Kind::Commit => 1,
            Kind::Tree => 2,
            Kind::Blob => 3,
            Kind::Tag => 4,
        };
        (
            oid,
            self.raw_entry(oid, entry_header(number, content.len() as u64), content),
        )
    }

    fn ofs_delta(&mut self, oid: Oid, base_offset: u64, delta: &[u8]) -> u64 {
        let offset = self.offset();
        let mut header = entry_header(6, delta.len() as u64);
        header.extend(ofs_bytes(offset - base_offset));
        self.raw_entry(oid, header, delta)
    }

    fn ref_delta(&mut self, oid: Oid, base: &Oid, delta: &[u8]) -> u64 {
        let mut header = entry_header(7, delta.len() as u64);
        header.extend_from_slice(base.raw());
        self.raw_entry(oid, header, delta)
    }

    /// The pack's and the index's bytes.
    fn finish(&self) -> (Vec<u8>, Vec<u8>) {
        let mut pack = b"PACK".to_vec();
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&(self.entries.len() as u32).to_be_bytes());
        pack.extend_from_slice(&self.data);
        let checksum = self.format.hash(&[&pack]);
        pack.extend_from_slice(checksum.raw());
        let mut sorted = self.entries.clone();
        sorted.sort();
        let mut index = vec![0xff, b't', b'O', b'c', 0, 0, 0, 2];
        for first in 0..256usize {
            let count = sorted
                .iter()
                .filter(|(oid, _)| usize::from(oid.raw()[0]) <= first)
                .count() as u32;
            index.extend_from_slice(&count.to_be_bytes());
        }
        for (oid, _) in &sorted {
            index.extend_from_slice(oid.raw());
        }
        for _ in &sorted {
            index.extend_from_slice(&0u32.to_be_bytes());
        }
        let mut large = Vec::new();
        for (_, offset) in &sorted {
            if *offset > self.large_above {
                index.extend_from_slice(&(0x8000_0000u32 | large.len() as u32).to_be_bytes());
                large.push(*offset);
            } else {
                index.extend_from_slice(&(*offset as u32).to_be_bytes());
            }
        }
        for offset in large {
            index.extend_from_slice(&offset.to_be_bytes());
        }
        index.extend_from_slice(checksum.raw());
        let own = self.format.hash(&[&index]);
        index.extend_from_slice(own.raw());
        (pack, index)
    }

    /// Writes the pack into a repository as `pack-<name>.{pack,idx}`.
    fn install(&self, repo: &Scratch, name: &str) {
        let (pack, index) = self.finish();
        std::fs::write(format!("{}/objects/pack/pack-{name}.pack", repo.0), pack).expect("pack");
        std::fs::write(format!("{}/objects/pack/pack-{name}.idx", repo.0), index).expect("idx");
    }
}

fn write_loose(repo: &Scratch, oid: &Oid, raw: &[u8]) {
    let hex = oid.hex();
    std::fs::create_dir_all(format!("{}/objects/{}", repo.0, &hex[..2])).expect("fan-out");
    std::fs::write(
        format!("{}/objects/{}/{}", repo.0, &hex[..2], &hex[2..]),
        zlib(raw),
    )
    .expect("loose");
}

fn loose_object(repo: &Scratch, format: ObjectFormat, kind: Kind, content: &[u8]) -> Oid {
    let oid = format.object_id(kind, content);
    let mut raw = format!("{} {}\0", kind.name(), content.len()).into_bytes();
    raw.extend_from_slice(content);
    write_loose(repo, &oid, &raw);
    oid
}

fn open(repo: &Scratch) -> Odb {
    Odb::open(&repo.0, OdbOptions::default()).expect("open")
}

fn reason<T: std::fmt::Debug>(answer: Answer<T>) -> Reason {
    answer.expect_err("ask Git").reason
}

#[test]
fn object_ids_are_gits() {
    assert_eq!(
        ObjectFormat::Sha1.object_id(Kind::Blob, b"").hex(),
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
    assert_eq!(
        ObjectFormat::Sha1.object_id(Kind::Tree, b"").hex(),
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    );
    assert_eq!(
        ObjectFormat::Sha256.object_id(Kind::Blob, b"").hex(),
        "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"
    );
    assert_eq!(
        ObjectFormat::Sha256.object_id(Kind::Tree, b"").hex(),
        "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    );
    let oid = Oid::from_hex("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391").expect("id");
    assert_eq!(oid.hex(), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    assert!(
        Oid::from_hex("E69DE29BB2D1D6434B8B29AE775AD8C2E48C5391").is_none(),
        "uppercase is not the ledger's spelling"
    );
    assert!(Oid::from_hex("e69de29").is_none());
    assert!(Oid::from_hex(&"g".repeat(40)).is_none());
}

#[test]
fn deltas_apply_as_patch_delta_does() {
    let base = b"0123456789abcdefghij".to_vec();
    assert_eq!(
        delta::apply(&base, &delta(&base, 10, b"XYZ")).as_deref(),
        Some(&b"0123456789XYZ"[..])
    );
    assert_eq!(delta::sizes(&delta(&base, 10, b"XYZ")), Some((20, 13)));
    // A copy of size 0 means 0x10000.
    let big = vec![7u8; 0x10000];
    let mut copy = Vec::new();
    varint(0x10000, &mut copy);
    varint(0x10000, &mut copy);
    copy.push(0x80);
    assert_eq!(
        delta::apply(&big, &copy).map(|out| out.len()),
        Some(0x10000)
    );
    // Refusals: a base of another size, opcode 0, a copy outside the base, too much or too little output, too short.
    assert_eq!(delta::apply(&base[..19], &delta(&base, 10, b"XYZ")), None);
    let mut opcode_zero = delta(&base, 0, b"");
    opcode_zero.push(0);
    assert_eq!(delta::apply(&base, &opcode_zero), None);
    let mut outside = Vec::new();
    varint(20, &mut outside);
    varint(5, &mut outside);
    outside.extend_from_slice(&[0x80 | 0x01 | 0x10, 18, 5]);
    assert_eq!(delta::apply(&base, &outside), None);
    let mut short = Vec::new();
    varint(20, &mut short);
    varint(9, &mut short);
    short.extend_from_slice(&[3, b'a', b'b', b'c']);
    assert_eq!(delta::apply(&base, &short), None, "declared 9, produced 3");
    assert_eq!(
        delta::apply(&base, &[20, 0]),
        None,
        "shorter than DELTA_SIZE_MIN"
    );
    // An overflowing size.
    assert_eq!(delta::sizes(&[0xff; 12]), None);
}

#[test]
fn random_deltas_never_panic_and_never_exceed_their_declared_size() {
    let mut random = Random(0xde17a);
    for round in 0..20_000 {
        let length = random.below(300);
        let base = random.bytes(length);
        let mut patch = Vec::new();
        varint(
            if round % 3 == 0 {
                random.below(400) as u64
            } else {
                base.len() as u64
            },
            &mut patch,
        );
        varint(random.below(600) as u64, &mut patch);
        let extra = random.below(64);
        patch.extend(random.bytes(extra));
        if let Some(out) = delta::apply(&base, &patch) {
            assert_eq!(
                Some(out.len() as u64),
                delta::sizes(&patch).map(|sizes| sizes.1)
            );
        }
    }
}

#[test]
fn loose_headers_parse_as_gits() {
    assert_eq!(loose::parse_header(b"blob 0\0"), Some((Kind::Blob, 0, 7)));
    assert_eq!(
        loose::parse_header(b"commit 1234\0xyz"),
        Some((Kind::Commit, 1234, 12))
    );
    assert_eq!(
        loose::parse_header(b"tag 18446744073709551615\0"),
        Some((Kind::Tag, u64::MAX, 25))
    );
    for bad in [
        &b"blob 05\0"[..],
        b"blob 18446744073709551616\0",
        b"frob 5\0",
        b"blob 5",
        b"blob\0",
        b"blob x\0",
        b"blob -1\0",
        b"blob  5\0",
        b"Blob 5\0",
    ] {
        assert_eq!(
            loose::parse_header(bad),
            None,
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
}

#[test]
fn configurations_parse_as_gits() {
    let entries = config::parse(b"\xef\xbb\xbf# comment\n[core]\n\trepositoryFormatVersion = 1 ; trailing\n\tbare\n[Remote \"Origin\"]\n\tpromisor = \"tr\\\nue\"\n[extensions] objectFormat=sha256\n[a.B]\n\tk = x  y  \n").expect("parses");
    let found: Vec<(String, Option<String>, String, Option<String>)> = entries
        .iter()
        .map(|entry| {
            (
                entry.section.clone(),
                entry
                    .subsection
                    .as_ref()
                    .map(|sub| String::from_utf8_lossy(sub).into_owned()),
                entry.key.clone(),
                entry
                    .value
                    .as_ref()
                    .map(|value| String::from_utf8_lossy(value).into_owned()),
            )
        })
        .collect();
    let expect = |section: &str, sub: Option<&str>, key: &str, value: Option<&str>| {
        (
            section.to_owned(),
            sub.map(str::to_owned),
            key.to_owned(),
            value.map(str::to_owned),
        )
    };
    assert_eq!(
        found,
        vec![
            expect("core", None, "repositoryformatversion", Some("1")),
            expect("core", None, "bare", None),
            expect("remote", Some("Origin"), "promisor", Some("true")),
            expect("extensions", None, "objectformat", Some("sha256")),
            expect("a", Some("b"), "k", Some("x  y")),
        ]
    );
    for bad in [
        &b"[core\n"[..],
        b"key = 1\n",
        b"[core]\n1key = 2\n",
        b"[core]\nk = \"open\n",
        b"[core]\nk = a\\q\n",
        b"[a \"b\n\"]\n",
        b"[core]\nk ! v\n",
        b"[]\n",
    ] {
        assert!(
            config::parse(bad).is_err(),
            "{}",
            String::from_utf8_lossy(bad)
        );
    }
    assert_eq!(config::boolean(None), Some(true));
    assert_eq!(config::boolean(Some(b"Off")), Some(false));
    assert_eq!(config::boolean(Some(b"maybe")), None);
}

#[test]
fn random_configurations_never_panic() {
    let mut random = Random(0xc0f19);
    let alphabet = b"[]\" \t\n\\#;=abcXY.-1\r";
    for _ in 0..20_000 {
        let text: Vec<u8> = (0..random.below(60))
            .map(|_| alphabet[random.below(alphabet.len())])
            .collect();
        let _ = config::parse(&text);
    }
}

#[test]
fn ref_names_in_the_simple_form() {
    for name in [
        "refs/devryan/state",
        "refs/devryan/leases/0b4a4f20-1c4a-4f0e-8b0a-2f8f1d0c9e11",
        "refs/heads/a.b_c-d",
        "refs/x",
    ] {
        assert!(valid_ref_name(name), "{name}");
    }
    for name in [
        "refs/",
        "refs",
        "heads/main",
        "refs/a b",
        "refs/.x",
        "refs/x.",
        "refs/x.lock",
        "refs/a..b",
        "refs//a",
        "refs/a/",
        "refs/a@{1}",
        "refs/ü",
        "refs/a*",
    ] {
        assert!(!valid_ref_name(name), "{name}");
    }
}

#[test]
fn tree_entries_parse_as_the_javascript_does() {
    let mut random = Random(0x7ee5);
    for _ in 0..5_000 {
        let mut data = Vec::new();
        for _ in 0..random.below(4) {
            let mode = [&b"100644"[..], b"40000", b"100755", b"1"][random.below(4)];
            data.extend_from_slice(mode);
            data.push(b' ');
            let length = random.below(6);
            data.extend(random.bytes(length).into_iter().map(|byte| byte | 1));
            data.push(0);
            data.extend(random.bytes(20));
        }
        if random.below(3) == 0 {
            let cut = random.below(data.len() + 1);
            data.truncate(cut);
        }
        let mine = parse_tree_entries(&data, 20);
        let theirs = ledger_core::tree::parse_tree(&data, 40);
        match (mine, theirs) {
            (Some(mine), Ok(theirs)) => {
                assert_eq!(mine.len(), theirs.len());
                for (left, right) in mine.iter().zip(theirs.iter()) {
                    assert_eq!(ledger_core::tree::latin1_string(&left.name), right.name);
                    assert_eq!(ledger_core::tree::latin1_string(&left.mode), right.mode);
                    assert_eq!(left.oid.hex(), right.oid.to_string_lossy());
                }
            }
            (None, Err(_)) => {}
            (mine, theirs) => panic!("parsers disagree: {mine:?} {theirs:?}"),
        }
    }
}

#[test]
fn git_order_compares_subtrees_as_if_they_ended_in_a_slash() {
    let oid = ObjectFormat::Sha1.object_id(Kind::Blob, b"");
    let entry = |mode: &str, name: &str| walk::TreeEntryBytes {
        mode: mode.as_bytes().to_vec(),
        name: name.as_bytes().to_vec(),
        oid,
    };
    assert!(in_git_order(&[
        entry("100644", "a-b"),
        entry("40000", "a"),
        entry("100644", "a0")
    ]));
    assert!(
        !in_git_order(&[entry("40000", "a"), entry("100644", "a-b")]),
        "'a/' sorts after 'a-b'"
    );
    assert!(in_git_order(&[
        entry("100644", "a"),
        entry("100644", "a-b")
    ]));
    assert!(
        !in_git_order(&[entry("100644", "a"), entry("100644", "a")]),
        "a repeated name"
    );
    assert!(
        !in_git_order(&[entry("100644", "a"), entry("40000", "a")]),
        "a name repeated as file and directory"
    );
    assert!(!in_git_order(&[entry("100644", "b"), entry("100644", "a")]));
}

#[test]
fn packs_read_whole_objects_and_ofs_and_ref_delta_chains() {
    for format in [ObjectFormat::Sha1, ObjectFormat::Sha256] {
        let repo = Scratch::repo("chains", format);
        let mut builder = PackBuilder::new(format);
        let mut text = b"the base text of a long chain\n".repeat(20);
        let (base_oid, base_offset) = builder.object(Kind::Blob, &text);
        let mut previous = (base_oid, base_offset, text.clone());
        let mut expected = vec![(base_oid, text.clone())];
        for step in 0..40 {
            let mut next = text.clone();
            next.extend_from_slice(format!("line {step}\n").as_bytes());
            let patch = delta(
                &previous.2,
                previous.2.len(),
                format!("line {step}\n").as_bytes(),
            );
            let oid = format.object_id(Kind::Blob, &next);
            let offset = if step % 2 == 0 {
                builder.ofs_delta(oid, previous.1, &patch)
            } else {
                builder.ref_delta(oid, &previous.0, &patch)
            };
            previous = (oid, offset, next.clone());
            expected.push((oid, next.clone()));
            text = next;
        }
        let (tree, _) = builder.object(Kind::Tree, b"");
        builder.install(&repo, "a");
        let odb = open(&repo);
        for (oid, content) in &expected {
            let object = odb.read_verified(oid).expect("answered").expect("found");
            assert_eq!((object.kind, &object.data), (Kind::Blob, content));
            assert_eq!(
                odb.info(oid).expect("answered"),
                Some(ObjectInfo {
                    kind: Kind::Blob,
                    size: content.len() as u64
                })
            );
        }
        assert_eq!(
            odb.info(&tree).expect("answered"),
            Some(ObjectInfo {
                kind: Kind::Tree,
                size: 0
            })
        );
        assert_eq!(
            odb.all_object_ids().expect("listed").len(),
            expected.len() + 1
        );
        let depth = Odb::open(
            &repo.0,
            OdbOptions {
                max_delta_depth: 10,
                ..OdbOptions::default()
            },
        )
        .expect("open");
        assert_eq!(
            reason(depth.read(&expected.last().expect("chain").0)),
            Reason::DeltaDepth
        );
        assert_eq!(
            reason(depth.info(&expected.last().expect("chain").0)),
            Reason::DeltaDepth
        );
        let budget = Odb::open(
            &repo.0,
            OdbOptions {
                delta_budget_bytes: 2_000,
                ..OdbOptions::default()
            },
        )
        .expect("open");
        assert_eq!(
            reason(budget.read(&expected.last().expect("chain").0)),
            Reason::DeltaBudget
        );
    }
}

#[test]
fn a_ref_delta_base_outside_its_pack_asks_git() {
    // Git resolves a REF base only in the delta's own pack and otherwise
    // reports the object missing; the reader asks Git, whether the base is
    // loose, in another pack or nowhere, for the delta and for a delta on it.
    let format = ObjectFormat::Sha1;
    let base = b"an external base\n".repeat(10);
    let mut target = base.clone();
    target.extend_from_slice(b"more");
    let target_oid = format.object_id(Kind::Blob, &target);
    let mut second = target.clone();
    second.extend_from_slice(b" again");
    let second_oid = format.object_id(Kind::Blob, &second);
    for place in ["loose", "another pack", "nowhere"] {
        let repo = Scratch::repo("external", format);
        let base_oid = format.object_id(Kind::Blob, &base);
        match place {
            "loose" => assert_eq!(loose_object(&repo, format, Kind::Blob, &base), base_oid),
            "another pack" => {
                let mut other = PackBuilder::new(format);
                assert_eq!(other.object(Kind::Blob, &base).0, base_oid);
                other.install(&repo, "aaaa");
            }
            _ => {}
        }
        let mut builder = PackBuilder::new(format);
        builder.ref_delta(target_oid, &base_oid, &delta(&base, base.len(), b"more"));
        builder.ref_delta(
            second_oid,
            &target_oid,
            &delta(&target, target.len(), b" again"),
        );
        builder.install(&repo, "bbbb");
        let odb = open(&repo);
        if place != "nowhere" {
            assert!(
                odb.read(&base_oid).expect("answered").is_some(),
                "{place}: the base itself is read"
            );
        }
        for oid in [&target_oid, &second_oid] {
            assert_eq!(reason(odb.read(oid)), Reason::CorruptPack, "{place}: read");
            assert_eq!(reason(odb.info(oid)), Reason::CorruptPack, "{place}: info");
        }
    }
}

#[test]
fn a_ref_delta_cycle_asks_git() {
    let format = ObjectFormat::Sha1;
    let repo = Scratch::repo("cycle", format);
    let (a, b) = (
        format.object_id(Kind::Blob, b"a"),
        format.object_id(Kind::Blob, b"b"),
    );
    let mut builder = PackBuilder::new(format);
    builder.ref_delta(a, &b, &delta(b"b", 0, b"a"));
    builder.ref_delta(b, &a, &delta(b"a", 0, b"b"));
    builder.install(&repo, "cycle");
    let odb = open(&repo);
    assert_eq!(reason(odb.read(&a)), Reason::DeltaCycle);
    assert_eq!(reason(odb.info(&b)), Reason::DeltaCycle);
}

#[test]
fn declared_sizes_past_the_bound_ask_git_without_allocating_them() {
    let format = ObjectFormat::Sha1;
    let repo = Scratch::repo("sizes", format);
    let mut builder = PackBuilder::new(format);
    // An entry that claims 2^40 bytes.
    let huge = format.object_id(Kind::Blob, b"huge");
    builder.raw_entry(huge, entry_header(3, 1 << 40), b"tiny");
    // A delta whose result claims 2^40 bytes (a zip bomb's shape).
    let (base, base_offset) = builder.object(Kind::Blob, b"base");
    let mut bomb = Vec::new();
    varint(4, &mut bomb);
    varint(1 << 40, &mut bomb);
    bomb.extend(std::iter::repeat_n([0x80u8 | 0x10, 4], 64).flatten());
    let bomb_oid = format.object_id(Kind::Blob, b"bomb");
    builder.ofs_delta(bomb_oid, base_offset, &bomb);
    // A delta whose copies amplify a small base past a small bound.
    let mut amplify = Vec::new();
    varint(4, &mut amplify);
    varint(4 * 3000, &mut amplify);
    amplify.extend(std::iter::repeat_n([0x80u8 | 0x10, 4], 3000).flatten());
    let amplified = format.object_id(Kind::Blob, &b"base".repeat(3000));
    builder.ofs_delta(amplified, base_offset, &amplify);
    builder.install(&repo, "sizes");
    let odb = Odb::open(
        &repo.0,
        OdbOptions {
            max_object_bytes: 1 << 20,
            ..OdbOptions::default()
        },
    )
    .expect("open");
    assert_eq!(reason(odb.read(&huge)), Reason::TooLarge);
    assert_eq!(
        odb.info(&huge).expect("the header alone"),
        Some(ObjectInfo {
            kind: Kind::Blob,
            size: 1 << 40
        })
    );
    assert_eq!(reason(odb.read(&bomb_oid)), Reason::TooLarge);
    assert_eq!(
        odb.read_verified(&amplified)
            .expect("answered")
            .expect("found")
            .data
            .len(),
        12_000
    );
    let small = Odb::open(
        &repo.0,
        OdbOptions {
            max_object_bytes: 4096,
            ..OdbOptions::default()
        },
    )
    .expect("open");
    assert_eq!(reason(small.read(&amplified)), Reason::TooLarge);
    assert_eq!(
        small.read(&base).expect("answered").expect("found").data,
        b"base"
    );
    // A loose object that declares more than the bound.
    let loose_huge = format.object_id(Kind::Blob, b"loose huge");
    write_loose(&repo, &loose_huge, b"blob 99999999999\0short");
    assert_eq!(reason(odb.read(&loose_huge)), Reason::TooLarge);
    assert_eq!(
        odb.info(&loose_huge)
            .expect("the header alone")
            .map(|info| info.size),
        Some(99_999_999_999)
    );
}

#[test]
fn large_offsets_are_read_and_checked() {
    let format = ObjectFormat::Sha256;
    let repo = Scratch::repo("large", format);
    let mut builder = PackBuilder::new(format);
    builder.large_above = 12;
    let objects: Vec<(Oid, Vec<u8>)> = (0..20)
        .map(|index| format!("object {index}").into_bytes())
        .map(|content| (builder.object(Kind::Blob, &content).0, content))
        .collect();
    builder.install(&repo, "large");
    let odb = open(&repo);
    for (oid, content) in &objects {
        assert_eq!(
            &odb.read_verified(oid)
                .expect("answered")
                .expect("found")
                .data,
            content
        );
    }
    // A large-offset position beyond the table.
    let (_, mut index) = builder.finish();
    let hash = format.raw_len();
    let offsets = 8 + 1024 + 20 * (hash + 4);
    let position = (0..20)
        .find(|position| index[offsets + 4 * position] & 0x80 != 0)
        .expect("a large offset");
    index[offsets + 4 * position..offsets + 4 * position + 4]
        .copy_from_slice(&(0x8000_0000u32 | 40).to_be_bytes());
    let length = index.len();
    let own = format.hash(&[&index[..length - hash]]);
    index[length - hash..].copy_from_slice(own.raw());
    let parsed = PackIndex::parse(index, format).expect("well formed but for that entry");
    assert_eq!(
        parsed.offset_at(position).expect_err("ask Git").reason,
        Reason::CorruptIndex
    );
}

/// An index's bytes with its trailing checksum recomputed after an edit.
fn reseal(mut index: Vec<u8>, format: ObjectFormat) -> Vec<u8> {
    let hash = format.raw_len();
    let length = index.len();
    let own = format.hash(&[&index[..length - hash]]);
    index[length - hash..].copy_from_slice(own.raw());
    index
}

#[test]
fn indexes_are_refused_as_git_refuses_them_and_more() {
    let format = ObjectFormat::Sha1;
    let mut builder = PackBuilder::new(format);
    for index in 0..30 {
        builder.object(Kind::Blob, format!("blob {index}").as_bytes());
    }
    let (pack, index) = builder.finish();
    assert!(PackIndex::parse(index.clone(), format).is_ok());
    let edit = |change: &dyn Fn(&mut Vec<u8>), seal: bool| {
        let mut copy = index.clone();
        change(&mut copy);
        let copy = if seal { reseal(copy, format) } else { copy };
        PackIndex::parse(copy, format)
            .map(|_| ())
            .expect_err("refused")
            .reason
    };
    assert_eq!(
        edit(&|bytes| bytes[..4].copy_from_slice(&[0, 0, 0, 1]), false),
        Reason::IndexVersion,
        "version 1 has no magic"
    );
    assert_eq!(edit(&|bytes| bytes[7] = 3, true), Reason::IndexVersion);
    assert_eq!(
        edit(
            &|bytes| bytes[8..12].copy_from_slice(&40u32.to_be_bytes()),
            true
        ),
        Reason::CorruptIndex,
        "non-monotonic fan-out"
    );
    assert_eq!(
        edit(&|bytes| bytes.truncate(bytes.len() - 3), false),
        Reason::CorruptIndex,
        "wrong size"
    );
    assert_eq!(
        edit(&|bytes| bytes[8 + 1024 + 5] ^= 1, false),
        Reason::CorruptIndex,
        "checksum"
    );
    assert_eq!(
        edit(
            &|bytes| {
                let (a, b) = (8 + 1024, 8 + 1024 + 20);
                let first: Vec<u8> = bytes[a..b].to_vec();
                let second: Vec<u8> = bytes[b..b + 20].to_vec();
                bytes[a..b].copy_from_slice(&second);
                bytes[b..b + 20].copy_from_slice(&first);
            },
            true
        ),
        Reason::CorruptIndex,
        "ids out of order"
    );
    assert_eq!(
        edit(&|bytes| bytes[8 + 1024] ^= 0x80, true),
        Reason::CorruptIndex,
        "an id outside its fan-out bucket"
    );
    // The pack: magic, version, count, trailer.
    let open_pack = |bytes: Vec<u8>| {
        Pack::new(
            1,
            "test",
            PackIndex::parse(index.clone(), format).expect("index"),
            Box::new(bytes),
        )
        .map(|_| ())
        .expect_err("refused")
        .reason
    };
    let mut bad = pack.clone();
    bad[0] = b'X';
    assert_eq!(open_pack(bad), Reason::CorruptPack);
    let mut bad = pack.clone();
    bad[7] = 3;
    assert_eq!(open_pack(bad), Reason::PackVersion);
    let mut bad = pack.clone();
    bad[11] = 31;
    assert_eq!(open_pack(bad), Reason::CorruptPack);
    let mut bad = pack.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    assert_eq!(open_pack(bad), Reason::CorruptPack);
}

#[test]
fn random_indexes_and_packs_never_panic() {
    let format = ObjectFormat::Sha1;
    let mut builder = PackBuilder::new(format);
    builder.large_above = 200;
    let (_, base_offset) = builder.object(Kind::Blob, &b"base text ".repeat(30));
    for step in 0..12 {
        let content = format!("object {step} with some text");
        builder.object(Kind::Blob, content.as_bytes());
        let target = format.object_id(Kind::Blob, format!("delta {step}").as_bytes());
        builder.ofs_delta(
            target,
            base_offset,
            &delta(
                &b"base text ".repeat(30),
                3,
                format!("delta {step}").as_bytes(),
            ),
        );
    }
    let (pack, index) = builder.finish();
    let ids: Vec<(Oid, u64)> = builder.entries.clone();
    let mut random = Random(0xf022);
    let mut refused = 0;
    for round in 0..4_000 {
        let mut index_copy = index.clone();
        let mut pack_copy = pack.clone();
        let target = if round % 2 == 0 {
            &mut index_copy
        } else {
            &mut pack_copy
        };
        for _ in 0..1 + random.below(4) {
            let at = random.below(target.len());
            match random.below(4) {
                0 => target[at] ^= 1 << random.below(8),
                1 => target.truncate(at),
                2 => target[at] = 0xff,
                _ => target.insert(at, random.next() as u8),
            }
        }
        if round % 4 == 1 {
            index_copy = reseal(index_copy, format);
        }
        let parsed = match PackIndex::parse(index_copy, format) {
            Ok(parsed) => parsed,
            Err(_) => {
                refused += 1;
                continue;
            }
        };
        let Ok(pack) = Pack::new(1, "fuzz", parsed, Box::new(pack_copy)) else {
            refused += 1;
            continue;
        };
        for (oid, _) in &ids {
            if let Ok(Some(offset)) = pack.index.find(oid)
                && let Ok(entry) = pack.entry(offset)
            {
                let _ = pack.inflate(entry.data_start, entry.size.min(1 << 16));
                let _ = pack.inflate_prefix(entry.data_start, 20);
            }
        }
    }
    assert!(refused > 1_000, "{refused} refused");
}

#[test]
fn a_miss_lists_the_packs_again_and_a_vanished_pack_stays_readable() {
    let format = ObjectFormat::Sha1;
    let repo = Scratch::repo("rescan", format);
    let odb = open(&repo);
    let content = b"written after the first listing";
    let oid = format.object_id(Kind::Blob, content);
    assert_eq!(odb.read(&oid).expect("answered"), None);
    let mut builder = PackBuilder::new(format);
    builder.object(Kind::Blob, content);
    builder.install(&repo, "late");
    assert_eq!(
        odb.read(&oid)
            .expect("answered")
            .expect("found by the rescan")
            .data,
        content
    );
    // The pack is deleted (repack -a -d): the open pack still answers.
    for extension in ["pack", "idx"] {
        std::fs::remove_file(format!("{}/objects/pack/pack-late.{extension}", repo.0))
            .expect("delete");
    }
    assert_eq!(
        odb.read(&oid)
            .expect("answered")
            .expect("still readable")
            .data,
        content
    );
}

#[test]
fn loose_objects_are_refused_as_git_refuses_them() {
    let format = ObjectFormat::Sha1;
    let repo = Scratch::repo("loose", format);
    let good = loose_object(&repo, format, Kind::Tag, b"object x\n");
    let odb = open(&repo);
    assert_eq!(
        odb.read(&good).expect("answered").expect("found").kind,
        Kind::Tag
    );
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("trailing", [zlib(b"blob 1\0x"), b"!".to_vec()].concat()),
        ("short", zlib(b"blob 9\0x")),
        ("long", zlib(b"blob 1\0xy")),
        ("type", zlib(b"note 1\0x")),
        ("zeros", zlib(b"blob 01\0x")),
        ("raw", b"blob 1\0x".to_vec()),
        ("cut", zlib(b"blob 100\0").into_iter().take(5).collect()),
        ("empty", Vec::new()),
    ];
    for (label, bytes) in cases {
        let oid = format.object_id(Kind::Blob, label.as_bytes());
        let hex = oid.hex();
        std::fs::create_dir_all(format!("{}/objects/{}", repo.0, &hex[..2])).expect("fan-out");
        std::fs::write(
            format!("{}/objects/{}/{}", repo.0, &hex[..2], &hex[2..]),
            bytes,
        )
        .expect("loose");
        assert_eq!(reason(odb.read(&oid)), Reason::CorruptObject, "{label}");
    }
}

/// A recording file system with scripted failures, for the writer's sequence.
struct Recording {
    calls: RefCell<Vec<String>>,
    failures: RefCell<Vec<(&'static str, &'static str)>>,
    directory_inode: RefCell<i64>,
}

impl Recording {
    fn new(failures: Vec<(&'static str, &'static str)>) -> Recording {
        Recording {
            calls: RefCell::new(Vec::new()),
            failures: RefCell::new(failures),
            directory_inode: RefCell::new(1),
        }
    }
    fn call(&self, op: &'static str, path: &str) -> FsResult<()> {
        self.calls
            .borrow_mut()
            .push(format!("{op} {}", path.rsplit('/').next().unwrap_or(path)));
        let mut failures = self.failures.borrow_mut();
        if let Some(position) = failures.iter().position(|(failing, _)| *failing == op) {
            let (_, code) = failures.remove(position);
            if code == "REPLACE" {
                *self.directory_inode.borrow_mut() += 1;
                return Err(Error::os(libc::EINVAL, op, Some(path)));
            }
            let errno = match code {
                "ENOENT" => libc::ENOENT,
                "EINVAL" => libc::EINVAL,
                "EEXIST" => libc::EEXIST,
                _ => libc::EIO,
            };
            return Err(Error::os(errno, op, Some(path)));
        }
        Ok(())
    }
}

impl LooseFs for Recording {
    fn utimes(&self, path: &str, _: f64, _: f64) -> FsResult<()> {
        self.call("utimes", path)?;
        Err(Error::os(libc::ENOENT, "utime", Some(path)))
    }
    fn mkdir_recursive(&self, path: &str) -> FsResult<()> {
        self.call("mkdir", path)
    }
    fn stat(&self, path: &str) -> FsResult<Stat> {
        self.call("stat", path)?;
        let mut stat = crate::fs::stat(".").expect("a stat to shape");
        stat.ino = *self.directory_inode.borrow();
        Ok(stat)
    }
    fn write_file_exclusive(&self, path: &str, _: &[u8], mode: u32) -> FsResult<()> {
        assert_eq!(mode, 0o444);
        self.call("writeFile", path)
    }
    fn link(&self, from: &str, _: &str) -> FsResult<()> {
        self.call("link", from)
    }
    fn unlink(&self, path: &str) -> FsResult<()> {
        self.call("unlink", path)
    }
}

struct Uuids(u32);

impl LooseEnv for Uuids {
    fn now(&mut self) -> f64 {
        1_700_000_000_000.0
    }
    fn random_uuid(&mut self) -> FsResult<String> {
        self.0 += 1;
        Ok(format!("{:08}-0000-4000-8000-000000000000", self.0))
    }
}

#[test]
fn the_writer_retries_and_fails_as_the_javascript_does() {
    let run = |failures: Vec<(&'static str, &'static str)>| {
        let recording = Recording::new(failures);
        let result = write_loose_object(
            &recording,
            &mut Uuids(0),
            "/repo",
            Kind::Blob,
            b"x",
            ObjectFormat::Sha1,
        )
        .map(|oid| oid.hex())
        .map_err(|error| error.code);
        (result, recording.calls.into_inner())
    };
    let oid = ObjectFormat::Sha1.object_id(Kind::Blob, b"x").hex();
    let rest = &oid[2..];
    let fan_out = &oid[..2];
    let attempt = |number: u32| {
        vec![
            format!("mkdir {fan_out}"),
            format!("stat {fan_out}"),
            format!("writeFile tmp_obj_{number:08}-0000-4000-8000-000000000000"),
        ]
    };
    let (result, calls) = run(vec![]);
    assert_eq!(result.as_deref(), Ok(oid.as_str()));
    let mut expected = vec![format!("utimes {rest}")];
    expected.extend(attempt(1));
    expected.push("link tmp_obj_00000001-0000-4000-8000-000000000000".to_owned());
    expected.push("unlink tmp_obj_00000001-0000-4000-8000-000000000000".to_owned());
    assert_eq!(calls, expected);
    // ENOENT five times: four retries, then thrown.
    let (result, calls) = run(vec![("link", "ENOENT"); 5]);
    assert_eq!(result, Err("ENOENT".to_owned()));
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("writeFile"))
            .count(),
        5
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("unlink"))
            .count(),
        5
    );
    // EINVAL with the same directory: thrown at once (after one more stat and the removal).
    let (result, calls) = run(vec![("link", "EINVAL")]);
    assert_eq!(result, Err("EINVAL".to_owned()));
    assert_eq!(
        calls.iter().filter(|call| call.starts_with("stat")).count(),
        2
    );
    assert_eq!(
        calls.last().map(String::as_str),
        Some("unlink tmp_obj_00000001-0000-4000-8000-000000000000")
    );
    // EINVAL after the directory was replaced: retried.
    let (result, calls) = run(vec![("link", "REPLACE")]);
    assert_eq!(result.as_deref(), Ok(oid.as_str()));
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("writeFile"))
            .count(),
        2
    );
    // EEXIST from link is success; a failed unlink replaces success; ENOENT from unlink does not.
    assert_eq!(run(vec![("link", "EEXIST")]).0.as_deref(), Ok(oid.as_str()));
    assert_eq!(run(vec![("unlink", "EIO")]).0, Err("EIO".to_owned()));
    assert_eq!(
        run(vec![("unlink", "ENOENT")]).0.as_deref(),
        Ok(oid.as_str())
    );
    // mkdir fails: thrown with no temporary and no removal.
    let (result, calls) = run(vec![("mkdir", "EIO")]);
    assert_eq!(result, Err("EIO".to_owned()));
    assert_eq!(
        calls,
        vec![format!("utimes {rest}"), format!("mkdir {fan_out}")]
    );
}

#[test]
fn written_objects_read_back_and_an_existing_one_is_only_freshened() {
    for format in [ObjectFormat::Sha1, ObjectFormat::Sha256] {
        let repo = Scratch::repo("write", format);
        let content = b"{\"key\":\"value\"}";
        let oid = write_loose_object(
            &RealLooseFs,
            &mut SystemLooseEnv,
            &repo.0,
            Kind::Blob,
            content,
            format,
        )
        .expect("written");
        let odb = open(&repo);
        assert_eq!(
            odb.read_verified(&oid)
                .expect("answered")
                .expect("found")
                .data,
            content
        );
        let again = write_loose_object(
            &RealLooseFs,
            &mut SystemLooseEnv,
            &repo.0,
            Kind::Blob,
            content,
            format,
        )
        .expect("freshened");
        assert_eq!(again, oid);
        let fan_out = format!("{}/objects/{}", repo.0, &oid.hex()[..2]);
        assert_eq!(
            std::fs::read_dir(fan_out).expect("fan-out").count(),
            1,
            "no temporary is left"
        );
    }
}

#[test]
fn sources_read_what_they_hold() {
    let bytes: Vec<u8> = (0..=255u8).collect();
    let mut buffer = [0u8; 10];
    assert_eq!(read_fully(&bytes, 250, &mut buffer).expect("read"), 6);
    assert_eq!(&buffer[..6], &[250, 251, 252, 253, 254, 255]);
    assert_eq!(bytes.size(), 256);
}

#[test]
fn the_database_is_shared_between_threads() {
    fn shareable<T: Send + Sync>() {}
    shareable::<Odb>();
    shareable::<Repository>();
}

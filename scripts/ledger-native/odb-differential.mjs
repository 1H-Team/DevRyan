// Differential tests of the native ledger's object database (plan package
// L3a): `ledger_io::git::odb` in packages/harness-runtime/native/ledger,
// driven through its test-only probe (`odb-probe`), with Git as the oracle
// and today's JavaScript (lib/session-changes-trees.js, -git.js, -store.js)
// as the reference for writes and listings. They need Rust, so they are not
// in the script suite: the build script's --verify runs them with the probes
// it built (LEDGER_NATIVE_ODB_PROBE); started alone they build them.
//
//   a. generated repositories: sha1 and sha256, eight pack layouts, three
//      ref styles; every object, name, listing and ref equal to Git's
//   b. every "ask Git" case, each in its own repository
//   c. writes: Rust-written objects pass fsck --strict and are read by Git
//      and by the JavaScript; JavaScript-written objects read by the Rust
//   d. the operation sequence of a write against the JavaScript's, retries
//      and failures included
//   e. reads while repack and prune run on the same repository
//   f. hostile input: corrupted packs, indexes and loose objects (fuzzed;
//      half the rounds by default, all of them in the extended run)
//
// The ledgers the product writes (the aged-profile corpus and the dual-run
// scenarios) are read in the extended run, the build script's --extended.
//
// Git runs in a private environment (odb-repos.mjs); every repository is in
// this run's scratch, removed on success, failure and interruption.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { buildProbe, EXTENDED_VARIABLE, ODB_PROBE_VARIABLE } from '../build-ledger-native.mjs';
import { scratchParent } from '../qa/run-root.mjs';
import { compareRepository, runProbe } from './odb-oracle.mjs';
import { LAYOUTS, REF_STYLES, buildRepository, generateObjects, gitEnvironment, gitVersion, hashOf, objectId, refsOf, runGit, serializeTree, updateRefs, writeObjects, writeRawLoose } from './odb-repos.mjs';
import { referenceRuntime } from './reference-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARM = path.join(here, 'odb-js-arm.mjs');
const reference = referenceRuntime();
console.log(`JavaScript reference runtime: ${reference.description}`);

let probe = process.env[ODB_PROBE_VARIABLE];
let disposeProbe = () => {};
const parent = scratchParent('ledger-native');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(path.join(parent, 'odb-'));
const env = gitEnvironment(path.join(scratch, 'git-home'));
console.log(`Git: ${gitVersion(env)}`);
const children = new Set();
const cleanup = () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  // Object files are read-only and fuzzing may leave a directory unreadable.
  spawnSync('chmod', ['-R', 'u+rwX', scratch]);
  rmSync(scratch, { recursive: true, force: true });
};
const interrupted = (signal) => { cleanup(); disposeProbe(); process.exit(signal === 'SIGINT' ? 130 : 143); };
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

before(() => {
  if (!probe) ({ odbProbe: probe, dispose: disposeProbe } = buildProbe());
  assert.ok(existsSync(probe), `${ODB_PROBE_VARIABLE}=${probe} does not exist; build it with: node scripts/build-ledger-native.mjs --verify`);
});
after(() => { cleanup(); disposeProbe(); });

const directory = (name) => mkdtempSync(path.join(scratch, `${name}-`));
const probeEnv = (extra = {}) => ({ ...env, ...extra });
const ask = (args, options = {}) => {
  const result = runProbe(probe, args, { env: probeEnv(options.env), input: options.input });
  return result.status === 3 ? result.stderr.split(' ')[1] : result.status === 0 ? `ok:${result.stdout.toString().trim()}` : `exit ${result.status}: ${result.stderr}`;
};
/** The JavaScript arm on the reference runtime. */
function runArm(args, { input } = {}) {
  const result = spawnSync(reference.command, [ARM, ...args], { input, env: { ...env, ...reference.env }, maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `odb-js-arm ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
const init = (dir, format = 'sha1', extra = []) => { runGit(env, null, ['init', '-q', '--bare', `--object-format=${format}`, ...extra, dir]); return dir; };

describe('a. generated repositories: Git and the Rust read the same', () => {
  let combination = 0;
  // The objects of each format are written once and copied into every layout.
  const templates = new Map();
  const template = (format) => {
    if (!templates.has(format)) templates.set(format, buildRepository({ env, scratch: directory(`template-${format}`), name: 'template', format, seed: format === 'sha1' ? 0x1a3a : 0x2b4b, layout: null }));
    return templates.get(format);
  };
  for (const format of ['sha1', 'sha256']) {
    for (const layout of LAYOUTS) {
      const refStyle = REF_STYLES[combination % REF_STYLES.length];
      combination += 1;
      test(`${format}, ${layout.name}, refs ${refStyle}`, () => {
        const root = directory(`${format}-${layout.name}`);
        const { gitDir, generated, packs } = buildRepository({ env, scratch: root, name: 'repo', format, layout, refStyle, template: template(format) });
        // The layout is what it says.
        const packCount = packs.filter((file) => file.endsWith('.pack')).length;
        const loose = readdirSync(path.join(gitDir, 'objects')).filter((name) => /^[0-9a-f]{2}$/.test(name)).length;
        if (layout.name === 'loose') assert.equal(packCount, 0);
        else assert.ok(packCount >= (layout.name === 'multi-pack' ? 2 : 1), `${layout.name} has ${packCount} packs`);
        if (layout.name === 'multi-pack') assert.ok(loose > 0, 'multi-pack keeps loose objects too');
        if (layout.name === 'no-rev') assert.ok(!packs.some((file) => file.endsWith('.rev')), 'no .rev file');
        if (layout.name === 'repack-a-d') assert.ok(packs.some((file) => file.endsWith('.rev')), 'a .rev file');
        const census = packCensus(gitDir, format);
        if (layout.name === 'ref-delta') assert.ok(census.ref > 0 && census.ofs === 0, `REF deltas only (${JSON.stringify(census)})`);
        else if (packCount) assert.equal(census.ref, 0, 'OFS deltas only');
        if (layout.name === 'deep-delta') assert.ok(census.depth >= 100, `a delta chain of ${census.depth}`);
        if (layout.name === 'large-offset') assert.ok(census.large > 0, 'offsets in the 64-bit table');
        const { counts, differences } = compareRepository({ env, gitDir, probe, generated, probeEnv: probeEnv(), treeLimit: 24, prefixTrees: 5 });
        assert.deepEqual(differences, []);
        assert.ok(counts.objects > 200 && counts.names > 1000 && counts.listings >= 30, JSON.stringify(counts));
        console.log(`  ${format} ${layout.name}: ${JSON.stringify({ ...counts, packs: packCount, ...census })}`);
      });
    }
  }
});

/** Pack entries by kind (from `git show-index` and the pack bytes), the longest chain, and large offsets. */
function packCensus(gitDir, format) {
  const census = { ofs: 0, ref: 0, depth: 0, large: 0 };
  const directoryPath = path.join(gitDir, 'objects/pack');
  for (const name of readdirSync(directoryPath).filter((file) => file.endsWith('.idx'))) {
    const pack = readFileSync(path.join(directoryPath, name.replace(/\.idx$/, '.pack')));
    const index = readFileSync(path.join(directoryPath, name));
    const count = index.readUInt32BE(8 + 255 * 4);
    const hash = format === 'sha256' ? 32 : 20;
    census.large += (index.length - (8 + 1024 + count * (hash + 8) + 2 * hash)) / 8;
    const rows = runGit(env, gitDir, ['show-index'], { input: index }).toString().trim().split('\n');
    for (const row of rows) {
      const kind = (pack[Number(row.split(' ')[0])] >> 4) & 7;
      if (kind === 6) census.ofs += 1;
      if (kind === 7) census.ref += 1;
    }
    for (const match of runGit(env, gitDir, ['verify-pack', '-v', path.join(directoryPath, name)]).toString().matchAll(/^chain length = (\d+):/gm)) census.depth = Math.max(census.depth, Number(match[1]));
  }
  return census;
}

const varint = (value) => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
/** A Git delta that copies all of `base` (1 to 2^24 - 1 bytes) and appends `tail` (at most 127 bytes). */
function appendDelta(base, tail) {
  const text = Buffer.from(tail);
  const size = base.length;
  return Buffer.from([...varint(size), ...varint(size + text.length), 0x80 | 0x10 | 0x20 | 0x40, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, text.length, ...text]);
}

/**
 * Writes a version 2 sha1 pack and its version 2 index as
 * `objects/pack/pack-<letter × 40>.{pack,idx}`: entries `{ type: 'blob', oid, content }`
 * or `{ type: 'ref', oid, base, delta }`, in order.
 */
function installCraftedPack(gitDir, letter, entries) {
  const header = (type, size) => { const bytes = [(type << 4) | (size & 0x0f)]; let rest = Math.floor(size / 16); while (rest) { bytes[bytes.length - 1] |= 0x80; bytes.push(rest & 0x7f); rest = Math.floor(rest / 128); } return Buffer.from(bytes); };
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2].writeUInt32BE(entries.length);
  let offset = 12;
  const rows = [];
  for (const entry of entries) {
    const bytes = entry.type === 'blob'
      ? Buffer.concat([header(3, entry.content.length), zlib.deflateSync(entry.content)])
      : Buffer.concat([header(7, entry.delta.length), Buffer.from(entry.base, 'hex'), zlib.deflateSync(entry.delta)]);
    rows.push({ oid: entry.oid, offset, crc: zlib.crc32(bytes) });
    parts.push(bytes);
    offset += bytes.length;
  }
  const body = Buffer.concat(parts);
  const checksum = Buffer.from(hashOf('sha1', body), 'hex');
  rows.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const fanout = Array.from({ length: 256 }, (_, first) => u32(rows.filter((row) => parseInt(row.oid.slice(0, 2), 16) <= first).length));
  const index = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), ...fanout, ...rows.map((row) => Buffer.from(row.oid, 'hex')), ...rows.map((row) => u32(row.crc)), ...rows.map((row) => u32(row.offset)), checksum]);
  const name = path.join(gitDir, 'objects/pack', `pack-${letter.repeat(40)}`);
  writeFileSync(`${name}.pack`, Buffer.concat([body, checksum]));
  writeFileSync(`${name}.idx`, Buffer.concat([index, Buffer.from(hashOf('sha1', index), 'hex')]));
}

describe('b. every case the reader does not fully understand asks Git', () => {
  const small = (name, { format = 'sha1', layout = 'repack-a-d' } = {}) => {
    const root = directory(name);
    return buildRepository({ env, scratch: root, name: 'repo', format, seed: 7, layout: LAYOUTS.find((entry) => entry.name === layout), refStyle: 'loose', small: true });
  };
  const missing = (generated) => hashOf(generated.format, Buffer.from('never written'));
  const configured = (name, text) => {
    const { gitDir, generated } = small(name, { layout: 'loose' });
    writeFileSync(path.join(gitDir, 'config'), text);
    return { gitDir, generated };
  };
  const first = (generated) => generated.blobs[3];

  test('repository format version 2, an unparseable config, a gitfile, a linked worktree: repository_format', () => {
    assert.equal(ask(['open', configured('v2', '[core]\n\trepositoryformatversion = 2\n').gitDir]), 'repository_format');
    assert.equal(ask(['open', configured('garbage', '[core\n').gitDir]), 'repository_format');
    assert.equal(ask(['open', configured('version-word', '[core]\n\trepositoryformatversion = one\n').gitDir]), 'repository_format');
    const file = path.join(directory('gitfile'), 'dot-git');
    writeFileSync(file, 'gitdir: /elsewhere\n');
    assert.equal(ask(['open', file]), 'repository_format');
    const { gitDir } = small('commondir', { layout: 'loose' });
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    assert.equal(ask(['open', gitDir]), 'repository_format');
    // Git agrees that version 2 is not a repository it can read.
    const v2 = configured('v2-git', '[core]\n\trepositoryformatversion = 2\n');
    assert.notEqual(spawnSync('git', ['--git-dir', v2.gitDir, 'cat-file', '-t', first(v2.generated)], { env }).status, 0);
  });

  test('extensions: unknown, reftable, partial clone, compat format, any in version 0, an unknown object format', () => {
    for (const [name, text] of [
      ['unknown', '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tfooBar = true\n'],
      ['reftable', '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n'],
      ['partial', '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tpartialClone = origin\n'],
      ['compat', '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha256\n'],
      ['v0-format', '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha256\n'],
      ['sha512', '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha512\n'],
    ]) assert.equal(ask(['open', configured(name, text).gitDir]), 'extension', name);
    // A sha256 repository opens.
    assert.equal(ask(['open', init(path.join(directory('sha256'), 'r.git'), 'sha256')]), 'ok:ok sha256');
  });

  test('alternates, a promisor remote, a .promisor pack: found objects answered, a missing one asks Git', () => {
    const alternates = small('alternates');
    mkdirSync(path.join(alternates.gitDir, 'objects/info'), { recursive: true });
    writeFileSync(path.join(alternates.gitDir, 'objects/info/alternates'), '/nowhere/objects\n');
    const remote = configured('promisor-remote', '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = /nowhere\n\tpromisor = true\n');
    const pack = small('promisor-pack');
    const packName = readdirSync(path.join(pack.gitDir, 'objects/pack')).find((file) => file.endsWith('.pack'));
    writeFileSync(path.join(pack.gitDir, 'objects/pack', packName.replace(/\.pack$/, '.promisor')), '');
    for (const [{ gitDir, generated }, code] of [[alternates, 'alternates'], [remote, 'promisor'], [pack, 'promisor']]) {
      const lines = runProbe(probe, ['batch-check', gitDir], { input: `${first(generated)}\n${missing(generated)}\n`, env: probeEnv() }).stdout.toString().trim().split('\n');
      assert.match(lines[0], /^[0-9a-f]{40} blob \d+$/);
      assert.equal(lines[1], `${missing(generated)} ask-git ${code}`);
    }
  });

  test('replace refs, loose or packed: every read asks Git (Git answers with the replacement)', () => {
    const { gitDir, generated } = small('replace');
    runGit(env, gitDir, ['replace', generated.blobs[3], generated.blobs[4]]);
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${generated.blobs[3]}\n`, env: probeEnv() }).stdout.toString().trim(), `${generated.blobs[3]} ask-git replace_refs`);
    // Git really does answer with the replacement.
    assert.match(runGit(env, gitDir, ['cat-file', '--batch-check'], { input: `${generated.blobs[3]}\n` }).toString(), new RegExp(`^${generated.blobs[3]} blob`));
    runGit(env, gitDir, ['pack-refs', '--all']);
    assert.equal(existsSync(path.join(gitDir, 'refs/replace', generated.blobs[3])), false);
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${generated.blobs[3]}\n`, env: probeEnv() }).stdout.toString().trim(), `${generated.blobs[3]} ask-git replace_refs`);
  });

  test('a multi-pack index: objects of its packs answered from their indexes; a miss, a listing of all, or a pack whose index is gone, asks Git', () => {
    const { gitDir, generated } = small('midx', { layout: 'multi-pack' });
    runGit(env, gitDir, ['multi-pack-index', 'write']);
    assert.ok(existsSync(path.join(gitDir, 'objects/pack/multi-pack-index')));
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${missing(generated)}\n`, env: probeEnv() }).stdout.toString().trim(), `${missing(generated)} ask-git multi_pack_index`);
    // Every object is read from the pack indexes, as Git reads it (listing them all asks Git: the multi-pack index might hold more).
    const ids = runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch-check']).toString();
    const names = ids.trim().split('\n').map((line) => line.split(' ')[0]).join('\n') + '\n';
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: names, env: probeEnv() }).stdout.toString(), ids);
    assert.equal(ask(['batch-all-check', gitDir]), 'multi_pack_index');
    // A pack whose .idx is gone: Git 2.56 reports its objects missing; the Rust, seeing a multi-pack index, asks Git.
    const index = readdirSync(path.join(gitDir, 'objects/pack')).find((file) => file.endsWith('.idx'));
    const inPack = runGit(env, null, ['show-index'], { input: readFileSync(path.join(gitDir, 'objects/pack', index)) }).toString().trim().split('\n')[0].split(' ')[1];
    rmSync(path.join(gitDir, 'objects/pack', index), { force: true });
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${inPack}\n`, env: probeEnv() }).stdout.toString().trim(), `${inPack} ask-git multi_pack_index`);
  });

  test('a .pack without its .idx, and an .idx whose .pack is a dangling link: unindexed_pack, unstable_packs', () => {
    const { gitDir, generated } = small('unindexed');
    writeFileSync(path.join(gitDir, 'objects/pack/pack-0000000000000000000000000000000000000000.pack'), 'PACK');
    assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${missing(generated)}\n`, env: probeEnv() }).stdout.toString().trim(), `${missing(generated)} ask-git unindexed_pack`);
    const dangling = small('dangling');
    const pack = readdirSync(path.join(dangling.gitDir, 'objects/pack')).find((file) => file.endsWith('.pack'));
    const copy = path.join(dangling.gitDir, 'objects/pack', pack.replace(/^pack-/, 'pack-copy-'));
    cpSync(path.join(dangling.gitDir, 'objects/pack', pack.replace(/\.pack$/, '.idx')), copy.replace(/\.pack$/, '.idx'));
    symlinkSync('/nowhere/at/all.pack', copy);
    assert.equal(runProbe(probe, ['batch-check', dangling.gitDir], { input: `${missing(dangling.generated)}\n`, env: probeEnv() }).stdout.toString().trim(), `${missing(dangling.generated)} ask-git unstable_packs`);
  });

  /** A small repository with its one pack; `edit(pack, idx)` returns the bytes to write back. */
  const editedPack = (name, edit, { format = 'sha1' } = {}) => {
    const repo = small(name, { format });
    const dir = path.join(repo.gitDir, 'objects/pack');
    const base = readdirSync(dir).find((file) => file.endsWith('.pack')).replace(/\.pack$/, '');
    for (const extra of ['.rev', '.bitmap']) rmSync(path.join(dir, base + extra), { force: true });
    const files = { pack: path.join(dir, `${base}.pack`), idx: path.join(dir, `${base}.idx`) };
    const edited = edit({ pack: readFileSync(files.pack), idx: readFileSync(files.idx), files, repo });
    for (const [kind, bytes] of Object.entries(edited)) { rmSync(files[kind], { force: true }); writeFileSync(files[kind], bytes); }
    return repo;
  };
  const objectInPack = (repo) => repo.generated.blobs[3];
  /** A whole (not delta) blob entry of at least 32 bytes: its id, offset and length. */
  const blobEntry = (pack, idx) => {
    const rows = runGit(env, null, ['show-index'], { input: idx }).toString().trim().split('\n').map((row) => row.split(' ')).map(([offset, oid]) => ({ offset: Number(offset), oid }))
      .sort((a, b) => a.offset - b.offset);
    rows.forEach((row, index) => { row.length = (rows[index + 1]?.offset ?? pack.length - 20) - row.offset; });
    return rows.find((row) => row.length >= 32 && ((pack[row.offset] >> 4) & 7) === 3);
  };
  const checkOf = (repo, oid) => runProbe(probe, ['batch-check', repo.gitDir], { input: `${oid}\n`, env: probeEnv() }).stdout.toString().trim();

  test('pack index version 1, all offsets in the large table, a pack of version 3: index_version, corrupt_index, pack_version', () => {
    const rebuilt = (files, version) => {
      const out = path.join(directory('rebuilt'), 'rebuilt.idx');
      runGit(env, null, ['index-pack', `--index-version=${version}`, '-o', out, files.pack]);
      return readFileSync(out);
    };
    const v1 = editedPack('idx-v1', ({ files }) => ({ idx: rebuilt(files, '1') }));
    assert.equal(checkOf(v1, objectInPack(v1)), `${objectInPack(v1)} ask-git index_version`);
    // Git reads version 1; the Rust leaves it to Git.
    assert.match(runGit(env, v1.gitDir, ['cat-file', '--batch-check'], { input: `${objectInPack(v1)}\n` }).toString(), / blob /);
    const allLarge = editedPack('idx-all-large', ({ files }) => ({ idx: rebuilt(files, '2,0') }));
    assert.equal(checkOf(allLarge, objectInPack(allLarge)), `${objectInPack(allLarge)} ask-git corrupt_index`);
    // Git refuses that index too ("wrong index v2 file size").
    assert.match(runGit(env, allLarge.gitDir, ['cat-file', '--batch-check'], { input: `${objectInPack(allLarge)}\n` }).toString(), /missing/);
    const v3 = editedPack('pack-v3', ({ pack }) => { const bytes = Buffer.from(pack); bytes.writeUInt32BE(3, 4); return { pack: bytes }; });
    assert.equal(checkOf(v3, objectInPack(v3)), `${objectInPack(v3)} ask-git pack_version`);
  });

  test('a corrupt index, a pack unlike its index, corrupt entries: corrupt_index, corrupt_pack, corrupt_object', () => {
    const flipped = editedPack('idx-flip', ({ idx }) => { const bytes = Buffer.from(idx); bytes[8 + 1024 + 3] ^= 1; return { idx: bytes }; });
    assert.equal(checkOf(flipped, objectInPack(flipped)), `${objectInPack(flipped)} ask-git corrupt_index`);
    const fanout = editedPack('idx-fanout', ({ idx }) => { const bytes = Buffer.from(idx); bytes.writeUInt32BE(0xffffffff, 8); return { idx: bytes }; });
    assert.equal(checkOf(fanout, objectInPack(fanout)), `${objectInPack(fanout)} ask-git corrupt_index`);
    const trailer = editedPack('pack-trailer', ({ pack }) => { const bytes = Buffer.from(pack); bytes[bytes.length - 1] ^= 1; return { pack: bytes }; });
    assert.equal(checkOf(trailer, objectInPack(trailer)), `${objectInPack(trailer)} ask-git corrupt_pack`);
    // The last byte of a blob entry's zlib stream (its adler32 no longer matches).
    let flippedEntry;
    const entry = editedPack('pack-entry', ({ pack, idx }) => {
      flippedEntry = blobEntry(pack, idx);
      const bytes = Buffer.from(pack);
      bytes[flippedEntry.offset + flippedEntry.length - 1] ^= 0x55;
      return { pack: bytes };
    });
    assert.equal(runProbe(probe, ['batch', entry.gitDir], { input: `${flippedEntry.oid}\n`, env: probeEnv() }).stdout.toString().trim(), `${flippedEntry.oid} ask-git corrupt_object`);
    // Git refuses it too.
    assert.notEqual(spawnSync('git', ['--git-dir', entry.gitDir, 'cat-file', 'blob', flippedEntry.oid], { env }).status, 0);
    // An entry of type 5 (reserved).
    let reservedEntry;
    const reserved = editedPack('pack-type-5', ({ pack, idx }) => {
      reservedEntry = blobEntry(pack, idx);
      const bytes = Buffer.from(pack);
      bytes[reservedEntry.offset] = (bytes[reservedEntry.offset] & 0x8f) | (5 << 4);
      return { pack: bytes };
    });
    assert.equal(checkOf(reserved, reservedEntry.oid), `${reservedEntry.oid} ask-git corrupt_pack`);
  });

  test('a REF delta whose base is outside its pack (loose, in another pack): Git reports it missing, the Rust asks Git; in its own pack both read it', () => {
    // Git's writers never make such a pack (index-pack refuses an unresolved
    // delta), so it is crafted: Git resolves a REF base only in the delta's own pack.
    const base = Buffer.from('a base for a REF delta\n'.repeat(30));
    const target = Buffer.concat([base, Buffer.from('more')]);
    const second = Buffer.concat([target, Buffer.from(' again')]);
    const [baseId, targetId, secondId] = [base, target, second].map((content) => objectId('sha1', 'blob', content));
    const deltas = [{ type: 'ref', oid: targetId, base: baseId, delta: appendDelta(base, 'more') }, { type: 'ref', oid: secondId, base: targetId, delta: appendDelta(target, ' again') }];
    const whole = { type: 'blob', oid: baseId, content: base };
    const ids = `${baseId}\n${targetId}\n${secondId}\n`;
    for (const place of ['loose', 'another pack', 'own pack']) {
      const gitDir = init(path.join(directory(`ref-base-${place.replace(' ', '-')}`), 'r.git'));
      if (place === 'loose') assert.equal(runGit(env, gitDir, ['hash-object', '-w', '--stdin'], { input: base }).toString().trim(), baseId);
      if (place === 'another pack') installCraftedPack(gitDir, 'a', [whole]);
      installCraftedPack(gitDir, 'b', place === 'own pack' ? [whole, ...deltas] : deltas);
      const git = { check: runGit(env, gitDir, ['cat-file', '--batch-check'], { input: ids }).toString(), batch: runGit(env, gitDir, ['cat-file', '--batch'], { input: ids }) };
      const rust = { check: runProbe(probe, ['batch-check', gitDir], { input: ids, env: probeEnv() }).stdout.toString(), batch: runProbe(probe, ['batch', gitDir], { input: ids, env: probeEnv() }).stdout };
      if (place === 'own pack') {
        assert.equal(git.check, `${baseId} blob ${base.length}\n${targetId} blob ${target.length}\n${secondId} blob ${second.length}\n`);
        assert.equal(rust.check, git.check);
        assert.equal(Buffer.compare(rust.batch, git.batch), 0, 'own pack: --batch byte-equal');
        continue;
      }
      assert.equal(git.check, `${baseId} blob ${base.length}\n${targetId} missing\n${secondId} missing\n`, `${place}: Git`);
      for (const output of [rust.check, rust.batch.toString()]) {
        const lines = output.split('\n');
        assert.equal(lines.at(-3), `${targetId} ask-git corrupt_pack`, place);
        assert.equal(lines.at(-2), `${secondId} ask-git corrupt_pack`, place);
      }
      assert.equal(rust.check.split('\n')[0], `${baseId} blob ${base.length}`, `${place}: the base itself`);
    }
  });

  test('corrupt loose objects: truncated, garbage after the stream, an unknown type, a size unlike the content, leading zeros: corrupt_object', () => {
    const { gitDir, generated } = small('loose-corrupt', { layout: 'loose' });
    const cases = [];
    const oid = (label) => hashOf('sha1', Buffer.from(label));
    const raw = (label, bytes, options) => { const id = oid(label); writeRawLoose(gitDir, id, bytes, options); cases.push(id); };
    raw('truncated', zlib.deflateSync(Buffer.from('blob 5\0hello')).subarray(0, 8), { deflate: false });
    raw('garbage', Buffer.concat([zlib.deflateSync(Buffer.from('blob 5\0hello')), Buffer.from('xx')]), { deflate: false });
    raw('unknown-type', Buffer.from('frob 5\0hello'));
    raw('size', Buffer.from('blob 9\0hello'));
    raw('leading-zero', Buffer.from('blob 05\0hello'));
    raw('no-nul', Buffer.from(`blob ${'9'.repeat(80)}`));
    raw('not-zlib', Buffer.from('plain text, not a zlib stream'), { deflate: false });
    const lines = runProbe(probe, ['batch', gitDir], { input: `${cases.join('\n')}\n`, env: probeEnv() }).stdout.toString().trim().split('\n');
    assert.deepEqual(lines, cases.map((id) => `${id} ask-git corrupt_object`));
    assert.equal(lines.length, 7);
    void generated;
  });

  test('bounds: a declared size, a delta chain, a chain budget, a tree depth or row count past its limit', () => {
    const deep = small('bounds', { layout: 'deep-delta' });
    // The last version is the deepest delta (fast-import deltas each against the one before).
    const last = deep.generated.family.at(-1);
    const first = (args, extra) => runProbe(probe, args, { input: `${last}\n`, env: probeEnv(extra) }).stdout.toString().split('\n')[0];
    assert.match(first(['batch', deep.gitDir], {}), / blob \d+$/, 'read in full within the default bounds');
    assert.equal(first(['batch', deep.gitDir], { ODB_PROBE_MAX_DELTA_DEPTH: '2' }), `${last} ask-git delta_depth`);
    assert.equal(first(['batch', deep.gitDir], { ODB_PROBE_DELTA_BUDGET: '1000' }), `${last} ask-git delta_budget`);
    assert.equal(first(['batch', deep.gitDir], { ODB_PROBE_MAX_OBJECT_BYTES: '100' }), `${last} ask-git too_large`);
    const loose = small('bounds-loose', { layout: 'loose' });
    assert.equal(first(['batch', loose.gitDir], { ODB_PROBE_MAX_OBJECT_BYTES: '100' }), `${last} ask-git too_large`);
    // The header is read without the content: the size of a too-large object is still answered, loose and packed.
    assert.match(first(['batch-check', loose.gitDir], { ODB_PROBE_MAX_OBJECT_BYTES: '100' }), / blob \d+$/);
    assert.match(first(['batch-check', deep.gitDir], { ODB_PROBE_MAX_OBJECT_BYTES: '100' }), / blob \d+$/);
    assert.equal(ask(['ls-tree', deep.gitDir, deep.generated.ledgerRoot], { env: { ODB_PROBE_MAX_TREE_DEPTH: '1' } }), 'tree_limit');
    assert.equal(ask(['ls-tree', deep.gitDir, deep.generated.ledgerRoot], { env: { ODB_PROBE_MAX_ROWS: '2' } }), 'tree_limit');
  });

  test('an object stored under another id: id_mismatch when ids are checked', () => {
    const { gitDir, generated } = small('mismatch', { layout: 'loose' });
    const wrong = hashOf('sha1', Buffer.from('a name for other content'));
    mkdirSync(path.join(gitDir, 'objects', wrong.slice(0, 2)), { recursive: true });
    cpSync(path.join(gitDir, 'objects', generated.blobs[4].slice(0, 2), generated.blobs[4].slice(2)), path.join(gitDir, 'objects', wrong.slice(0, 2), wrong.slice(2)));
    assert.equal(runProbe(probe, ['batch', gitDir], { input: `${wrong}\n`, env: probeEnv({ ODB_PROBE_VERIFY: '1' }) }).stdout.toString().trim(), `${wrong} ask-git id_mismatch`);
  });

  test('refs: symbolic, a symlink, other content, uppercase, the other id length, malformed or falsely sorted packed-refs, names and patterns outside the simple form', () => {
    const { gitDir, generated } = small('refs', { layout: 'loose' });
    const refs = path.join(gitDir, 'refs');
    const write = (name, text) => { mkdirSync(path.dirname(path.join(gitDir, name)), { recursive: true }); writeFileSync(path.join(gitDir, name), text); };
    runGit(env, gitDir, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/alias']), 'ref_format');
    assert.equal(ask(['for-each-ref', gitDir]), 'ref_format');
    rmSync(path.join(refs, 'heads/alias'));
    symlinkSync(path.join(refs, 'heads/main'), path.join(refs, 'heads/linked'));
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/linked']), 'ref_format');
    rmSync(path.join(refs, 'heads/linked'));
    write('refs/odd/content', `${generated.blobs[1]}\ntrailing\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/odd/content']), 'ref_format');
    write('refs/odd/content', `${generated.blobs[1].toUpperCase()}\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/odd/content']), 'ref_format');
    write('refs/odd/content', `${hashOf('sha256', Buffer.from('x'))}\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/odd/content']), 'ref_format');
    rmSync(path.join(refs, 'odd'), { recursive: true });
    for (const name of ['refs/heads/a b', 'heads/main', 'refs/heads/.hidden', 'refs/heads/x.lock', 'refs/a..b', 'refs/']) assert.equal(ask(['read-ref', gitDir, name]), 'ref_name', name);
    for (const pattern of ['refs/heads/*', 'refs/heads/ma?n', 'refs/[ab]']) assert.equal(ask(['for-each-ref', gitDir, pattern]), 'ref_name', pattern);
    runGit(env, gitDir, ['pack-refs', '--all']);
    const packed = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    assert.match(packed, /^# pack-refs with: .*sorted/);
    const lines = packed.trimEnd().split('\n');
    writeFileSync(path.join(gitDir, 'packed-refs'), [lines[0], ...lines.slice(1).reverse()].join('\n') + '\n');
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/main']), 'ref_format', 'marked sorted but not');
    writeFileSync(path.join(gitDir, 'packed-refs'), `${packed}garbage line\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/main']), 'ref_format', 'a malformed line');
    writeFileSync(path.join(gitDir, 'packed-refs'), packed.trimEnd());
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/main']), 'ref_format', 'no final newline');
    writeFileSync(path.join(gitDir, 'packed-refs'), `${packed}^${generated.blobs[1]}\n^${generated.blobs[1]}\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/main']), 'ref_format', 'a peel line without a ref');
    writeFileSync(path.join(gitDir, 'packed-refs'), `${packed}${generated.blobs[1]} refs/zz/a b\n`);
    assert.equal(ask(['read-ref', gitDir, 'refs/heads/main']), 'ref_name', 'a packed name outside the simple form');
  });

  test('tree walks: unordered, repeated names, odd modes, missing objects, prefixes and names Git might read otherwise', () => {
    // The generated malformed trees are checked in (a); here, the prefixes.
    const { gitDir, generated } = small('walks', { layout: 'loose' });
    for (const prefix of ['runs/../runs', 'runs/', './runs', 'runs//r1', 'r u n s', 'runs.d']) assert.equal(ask(['ls-tree', gitDir, generated.ledgerRoot, prefix]), 'name_syntax', prefix);
    assert.equal(ask(['ls-tree', gitDir, generated.ledgerRoot, 'meta']), 'ok:', 'a missing prefix lists nothing');
    assert.equal(ask(['ls-tree', gitDir, generated.blobs[1]]), 'tree_missing', 'a blob is not a tree');
    assert.equal(ask(['ls-tree', gitDir, hashOf('sha1', Buffer.from('no tree'))]), 'tree_missing');
    assert.equal(ask(['ls-tree', gitDir, generated.commits[0]]), 'tree_missing', 'a commit is not listed (Git would list its tree)');
  });

  test('a system error other than "not found": io', { skip: process.getuid?.() === 0 && 'root reads unreadable files' }, () => {
    const { gitDir, generated } = small('io', { layout: 'loose' });
    const file = path.join(gitDir, 'objects', generated.blobs[4].slice(0, 2), generated.blobs[4].slice(2));
    chmodSync(file, 0o000);
    try {
      assert.equal(runProbe(probe, ['batch-check', gitDir], { input: `${generated.blobs[4]}\n`, env: probeEnv() }).stdout.toString().trim(), `${generated.blobs[4]} ask-git io`);
    } finally { chmodSync(file, 0o444); }
  });
});

/** A ledger-shaped object set: JSON records under prefixes, list pages, a meta record; trees built here. */
function ledgerObjects(format, seed) {
  const rand = (() => { let state = seed >>> 0; return (bound) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % bound; }; })();
  const records = new Map();
  for (let index = 0; index < 40; index += 1) records.set(`leases/${hashOf('sha256', Buffer.from(`lease ${index}`))}.json`, { token: index, state: rand(3), note: 'é'.repeat(rand(4)) });
  for (let page = 0; page < 6; page += 1) records.set(`runs/r${rand(3)}/${String(page).padStart(10, '0')}.json`, Array.from({ length: 1 + rand(5) }, (_, item) => ({ item, at: rand(1000) })));
  records.set('meta.json', { version: 1, format });
  records.set('empty/x.json', {});
  const objects = [];
  const add = (type, content) => { const oid = objectId(format, type, content); objects.push({ type, content, oid }); return oid; };
  const root = new Map();
  for (const [key, value] of records) {
    const parts = key.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) { if (!node.has(part)) node.set(part, new Map()); node = node.get(part); }
    node.set(parts.at(-1), add('blob', Buffer.from(JSON.stringify(value))));
  }
  const write = (node) => add('tree', serializeTree([...node].map(([name, value]) => (value instanceof Map
    ? { mode: '40000', name: Buffer.from(name), oid: write(value) } : { mode: '100644', name: Buffer.from(name), oid: value }))));
  return { objects, root: write(root), records };
}

const recordsInput = (objects) => Buffer.concat(objects.flatMap((object) => [Buffer.from(`${object.type} ${object.content.length}\n`), object.content]));
const looseFile = (gitDir, oid) => path.join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
/** What `writeFile(…, { mode: 0o444 })` leaves under this process's umask. */
const expectedMode = () => { const probeFile = path.join(scratch, `mode-${process.pid}`); writeFileSync(probeFile, '', { mode: 0o444 }); const mode = statSync(probeFile).mode & 0o777; rmSync(probeFile, { force: true }); return mode; };

describe('c. writes: Rust-written objects are Git objects the JavaScript reads, and the reverse', () => {
  for (const format of ['sha1', 'sha256']) {
    test(`${format}: the Rust writes, fsck --strict passes, Git and the JavaScript store and listing read it`, () => {
      const root = directory(`write-${format}`);
      const gitDir = init(path.join(root, 'rust.git'), format);
      const { objects, root: tree, records } = ledgerObjects(format, 11);
      const printed = runProbe(probe, ['write', gitDir], { input: recordsInput(objects), env: probeEnv() });
      assert.equal(printed.status, 0, printed.stderr);
      assert.deepEqual(printed.stdout.toString().trim().split('\n'), objects.map((object) => object.oid));
      const mode = expectedMode();
      for (const object of objects) assert.equal(statSync(looseFile(gitDir, object.oid)).mode & 0o777, mode, `mode of ${object.oid}`);
      assert.equal(readdirSync(path.join(gitDir, 'objects', objects[0].oid.slice(0, 2))).filter((name) => name.startsWith('tmp_obj_')).length, 0, 'no temporary left');
      runGit(env, gitDir, ['update-ref', 'refs/devryan/state', tree]);
      const fsck = runGit(env, gitDir, ['fsck', '--strict', '--full', '--no-dangling']);
      assert.equal(fsck.stderr.trim(), '', 'fsck --strict --full reports nothing');
      const batch = runGit(env, gitDir, ['cat-file', '--batch'], { input: objects.map((object) => object.oid).join('\n') + '\n' });
      assert.equal(Buffer.compare(batch, Buffer.concat(objects.flatMap((object) => [Buffer.from(`${object.oid} ${object.type} ${object.content.length}\n`), object.content, Buffer.from('\n')]))), 0, 'Git reads every object back');
      // Today's JavaScript store reads every record (ls-tree, then its cat-file readers).
      const rows = runArm(['store', gitDir, 'refs/devryan/state']).toString().trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(rows.map((row) => [row.key, row.value]), [...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      // The JavaScript's direct listings and the Rust's: the whole tree, and pages by prefix.
      const rustRows = (prefix) => {
        const rust = runProbe(probe, ['ls-tree', gitDir, tree, ...(prefix ? [prefix] : [])], { env: probeEnv() });
        assert.equal(rust.status, 0, rust.stderr);
        return rust.stdout.toString('latin1').split('\0').filter(Boolean);
      };
      const whole = JSON.parse(runArm(['list', gitDir, tree]).toString());
      assert.deepEqual(whole.map((row) => row.text), rustRows(null).map((row) => Buffer.from(row, 'latin1').toString()));
      for (const prefix of ['leases', 'runs', 'runs/r0', 'nope']) {
        const js = runArm(['entries', gitDir, 'refs/devryan/state', prefix]).toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const rust = rustRows(prefix).map((row) => ({ key: Buffer.from(row.slice(row.indexOf('\t') + 1), 'latin1').toString(), oid: row.split(' ')[2] }));
        assert.deepEqual(js, rust, `page ${prefix}`);
      }
      // A prefix naming a blob: the JavaScript's paging asks Git (which lists nothing); so does the Rust.
      assert.equal(runArm(['entries', gitDir, 'refs/devryan/state', 'meta.json']).toString(), '');
      assert.equal(runProbe(probe, ['ls-tree', gitDir, tree, 'meta'], { env: probeEnv() }).status, 0, 'meta is absent: nothing');
      // Writing again only freshens.
      const before = statSync(looseFile(gitDir, objects[0].oid)).mtimeMs;
      spawnSync('sleep', ['0.02']);
      assert.equal(runProbe(probe, ['write', gitDir], { input: recordsInput(objects.slice(0, 1)), env: probeEnv() }).status, 0);
      assert.ok(statSync(looseFile(gitDir, objects[0].oid)).mtimeMs >= before);
    });

    test(`${format}: the JavaScript writes, the Rust reads what Git reads; both writers store the same objects`, () => {
      const root = directory(`js-write-${format}`);
      const generated = generateObjects({ seed: 23, format, small: true });
      const objects = [...generated.objects.values()];
      const jsDir = init(path.join(root, 'js.git'), format);
      const rustDir = init(path.join(root, 'rust.git'), format);
      assert.deepEqual(runArm(['write', jsDir, format], { input: recordsInput(objects) }).toString().trim().split('\n'), objects.map((object) => object.oid));
      assert.equal(runProbe(probe, ['write', rustDir], { input: recordsInput(objects), env: probeEnv() }).status, 0);
      for (const dir of [jsDir, rustDir]) updateRefs(env, dir, refsOf(generated));
      const { differences } = compareRepository({ env, gitDir: jsDir, probe, generated, probeEnv: probeEnv() });
      assert.deepEqual(differences, []);
      // Same objects, same modes; the zlib bytes may differ (identity is the id).
      let sameBytes = 0;
      for (const object of objects) {
        const js = readFileSync(looseFile(jsDir, object.oid)), rust = readFileSync(looseFile(rustDir, object.oid));
        assert.deepEqual(zlib.inflateSync(rust), zlib.inflateSync(js), object.oid);
        assert.equal(statSync(looseFile(rustDir, object.oid)).mode, statSync(looseFile(jsDir, object.oid)).mode);
        if (Buffer.compare(js, rust) === 0) sameBytes += 1;
      }
      console.log(`  ${format}: ${objects.length} objects written by both; ${sameBytes} with identical zlib bytes`);
    });
  }
});

describe('d. the operation sequence of a write equals the JavaScript\'s', () => {
  const uuids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
  const fault = (op, code, nth = 1, alter) => ({ op, code, nth, ...(alter ? { alter } : {}) });
  const SCENARIOS = [
    { name: 'a new object in a new fan-out directory', faults: [] },
    { name: 'an existing object is only freshened', existing: true, faults: [] },
    { name: 'writeFile ENOENT after the directory was removed: retried', faults: [fault('writeFile', 'ENOENT', 1, 'remove-dir')] },
    { name: 'writeFile ENOENT four times, then written', faults: [1, 2, 3, 4].map((nth) => fault('writeFile', 'ENOENT', nth)), writes: 5, ok: true },
    { name: 'link ENOENT five times: the fifth is thrown', faults: [1, 2, 3, 4, 5].map((nth) => fault('link', 'ENOENT', nth)), writes: 5, ok: false },
    { name: 'link EINVAL after the directory was replaced: retried', faults: [fault('link', 'EINVAL', 1, 'replace-dir')], writes: 2, ok: true },
    { name: 'link EINVAL with the same directory: thrown', faults: [fault('link', 'EINVAL')], writes: 1, ok: false },
    { name: 'link EEXIST: another writer installed it', faults: [fault('link', 'EEXIST')] },
    { name: 'writeFile EACCES: thrown, the temporary removed', faults: [fault('writeFile', 'EACCES')] },
    { name: 'unlink EIO after a successful link: thrown', faults: [fault('unlink', 'EIO')] },
    { name: 'mkdir EACCES: thrown before any temporary', faults: [fault('mkdir', 'EACCES')] },
    { name: 'stat fails, then link EINVAL: counted as removed, retried', faults: [fault('stat', 'ENOENT'), fault('link', 'EINVAL')] },
    { name: 'utimes EIO on an existing object: written again, link EEXIST', existing: true, faults: [fault('utimes', 'EIO')] },
    { name: 'sha256', format: 'sha256', faults: [] },
    { name: 'an empty tree', kind: 'tree', content: '', faults: [] },
  ];
  /** The tree a run leaves: every path under the repository's objects, its mode and, for objects, the inflated bytes. */
  const leftBehind = (dir) => {
    const out = [];
    const walk = (relative) => {
      for (const name of readdirSync(path.join(dir, relative)).sort()) {
        const file = path.join(relative, name);
        const stat = statSync(path.join(dir, file));
        if (stat.isDirectory()) { out.push([file, 'dir']); walk(file); continue; }
        let content = null;
        try { content = zlib.inflateSync(readFileSync(path.join(dir, file))).toString('latin1'); } catch { content = 'not zlib'; }
        out.push([file, (stat.mode & 0o777).toString(8), content]);
      }
    };
    walk('objects');
    return out;
  };
  for (const scenario of SCENARIOS) {
    test(scenario.name, () => {
      const run = (arm) => {
        const root = directory(`trace-${arm}`);
        const gitDir = path.join(root, 'r.git');
        init(gitDir, scenario.format ?? 'sha1');
        const kind = scenario.kind ?? 'blob';
        const content = scenario.content ?? `{"record":"${scenario.name}"}`;
        if (scenario.existing) runGit(env, gitDir, ['hash-object', '-w', '-t', kind, '--stdin'], { input: content });
        const request = JSON.stringify({ root, gitDir: 'r.git', kind, content, format: scenario.format ?? 'sha1', now: 1700000000123, uuids, faults: scenario.faults });
        const output = arm === 'rust' ? runProbe(probe, ['write-trace'], { input: request, env: probeEnv() }).stdout : runArm(['trace'], { input: request });
        return { ...JSON.parse(output.toString()), tree: leftBehind(gitDir) };
      };
      const js = run('js');
      const rust = run('rust');
      assert.deepEqual(rust, js);
      assert.ok(js.trace.length >= 1);
      // The scenario did what its name says.
      if (scenario.writes !== undefined) assert.equal(js.trace.filter((entry) => entry.op === 'writeFile').length, scenario.writes);
      if (scenario.ok !== undefined) assert.equal('oid' in js.result, scenario.ok);
    });
  }
});

describe('e. reads while repack and prune run on the same repository', () => {
  for (const format of ['sha1', 'sha256']) {
    test(`${format}: never a wrong object, never a false "absent"`, async () => {
      const root = directory(`stress-${format}`);
      const { gitDir } = buildRepository({ env, scratch: root, name: 'repo', format, seed: 99, layout: LAYOUTS[0], refStyle: 'loose', small: true });
      const expected = runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch-check']).toString();
      // Only reachable objects: prune must not remove what the reader expects.
      const reachable = new Set(runGit(env, gitDir, ['rev-list', '--objects', '--all']).toString().trim().split('\n').map((line) => line.split(' ')[0]));
      const wanted = expected.trim().split('\n').filter((line) => reachable.has(line.split(' ')[0]));
      const stop = path.join(root, 'stop');
      const child = spawn(probe, ['stress', gitDir, '1000000', stop], { env: probeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.stdin.end(`${wanted.join('\n')}\n`);
      const cycles = 6;
      const gitAsync = (args) => new Promise((resolve, reject) => {
        const run = spawn('git', ['--git-dir', gitDir, ...args], { env, stdio: 'ignore' });
        run.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
      });
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        // New loose objects each cycle, so every repack has work and old packs are replaced.
        const blob = runGit(env, gitDir, ['hash-object', '-w', '--stdin'], { input: `cycle ${cycle}\n` }).toString().trim();
        runGit(env, gitDir, ['update-ref', `refs/gen/cycle-${cycle}`, blob]);
        await gitAsync(['repack', '-d', '-q']);
        await gitAsync(['prune-packed']);
        await gitAsync(['repack', '-a', '-d', '-q']);
        await gitAsync(['prune', '--expire=now']);
        await gitAsync(['repack', '-a', '-d', '-f', '-q', '--depth=20']);
      }
      writeFileSync(stop, '');
      const code = await exited;
      children.delete(child);
      assert.equal(code, 0);
      const counts = JSON.parse(output);
      console.log(`  ${format}: ${JSON.stringify(counts)} over ${cycles} maintenance cycles`);
      assert.equal(counts.wrong, 0);
      assert.equal(counts.absent, 0);
      assert.ok(counts.found > 0 && counts.rounds >= 1);
    });
  }
});

// The gate runs half the rounds; the extended run (EXTENDED_VARIABLE set) all
// of them. LEDGER_NATIVE_ODB_FUZZ_SCALE multiplies either.
const FUZZ_SCALE = Math.max(1, Number(process.env.LEDGER_NATIVE_ODB_FUZZ_SCALE ?? 1) || 1);
const FUZZ_SHARE = process.env[EXTENDED_VARIABLE] === '1' ? 1 : 0.5;
describe('f. hostile input: corrupted packs, indexes and loose objects', () => {
  for (const [format, layout, full] of [['sha1', 'multi-pack', 150], ['sha1', 'ref-delta', 75], ['sha256', 'deep-delta', 75], ['sha1', 'large-offset', 50]]) {
    const rounds = Math.ceil(full * FUZZ_SHARE) * FUZZ_SCALE;
    test(`${format} ${layout}: ${rounds} corruptions, every answer right or "ask Git", no panic, bounded memory`, () => {
      const root = directory(`fuzz-${format}-${layout}`);
      const { gitDir } = buildRepository({ env, scratch: root, name: 'repo', format, seed: 5, layout: LAYOUTS.find((entry) => entry.name === layout), refStyle: 'packed', small: true });
      const expected = runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch-check']).toString();
      const result = spawnSync(probe, ['fuzz', gitDir, String(0x5eed + rounds), String(rounds)], { input: expected, env: probeEnv(), timeout: 600_000, maxBuffer: 1 << 24 });
      assert.equal(result.signal, null, `the fuzz run ended by ${result.signal} (a hang?)`);
      assert.equal(result.status, 0, result.stderr.toString());
      const counts = JSON.parse(result.stdout.toString());
      console.log(`  ${format} ${layout}: ${JSON.stringify(counts)}`);
      assert.equal(counts.panics, 0);
      assert.equal(counts.wrong, 0);
      assert.equal(counts.absent, 0);
      assert.ok(Object.values(counts.askGit).reduce((a, b) => a + b, 0) > 0, 'corruption was met');
      assert.ok(counts.peakResidentBytes < 512 * 1024 * 1024, `peak resident ${counts.peakResidentBytes}`);
      // After the run every file is restored: Git reads the repository as before.
      assert.equal(runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch-check']).toString(), expected);
    });
  }
});

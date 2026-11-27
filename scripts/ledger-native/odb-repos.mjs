// Seeded Git repositories for the native ledger's object-database tests
// (plan package L3a): objects, trees, refs and pack layouts generated from a
// seed, written by Git itself, and Git run in a private environment (its own
// HOME, no system or global configuration, no inherited GIT_* variables).
//
// The generator computes every id itself and checks Git's, so the tests
// know each object's type, size, tree structure and the names and listings
// that Git must answer, and which ones the native reader must leave to Git.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

/** mulberry32: the generators' seeded random numbers, identical on every platform. */
export function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound) => Math.floor(next() * bound);
  return { next, int, pick: (items) => items[int(items.length)], bytes: (count) => Buffer.from(Array.from({ length: count }, () => int(256))) };
}

/** A private Git environment rooted at `home`: no system or global configuration, a fixed identity and clock. */
export function gitEnvironment(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, '.gitconfig'), '');
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^GIT_/.test(name) || /^XDG_/.test(name) || ['HOME', 'LANG', 'LANGUAGE'].includes(name) || /^LC_/.test(name)) continue;
    env[name] = value;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_AUTHOR_NAME: 'Ledger Tests', GIT_AUTHOR_EMAIL: 'tests@devryan.invalid', GIT_COMMITTER_NAME: 'Ledger Tests',
    GIT_COMMITTER_EMAIL: 'tests@devryan.invalid', GIT_AUTHOR_DATE: '2001-02-03T04:05:06Z', GIT_COMMITTER_DATE: '2001-02-03T04:05:06Z' };
}

/** Runs Git; returns its stdout as a Buffer. Throws unless the status is accepted. */
export function runGit(env, gitDir, args, { input, accept = [0] } = {}) {
  const result = spawnSync('git', gitDir ? ['--git-dir', gitDir, ...args] : args, { env, input, maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  if (!accept.includes(result.status)) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr.toString().slice(0, 2000)}`);
  return Object.assign(result.stdout, { status: result.status, stderr: result.stderr.toString() });
}

/** The Git version, for the report. */
export const gitVersion = (env) => runGit(env, null, ['--version']).toString().trim();

export const hashOf = (format, ...parts) => {
  const hash = crypto.createHash(format === 'sha256' ? 'sha256' : 'sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};
export const objectId = (format, type, content) => hashOf(format, Buffer.from(`${type} ${content.length}\0`), content);

const TREE = '40000';
const sortKey = (entry) => (entry.mode === TREE ? Buffer.concat([entry.name, Buffer.from('/')]) : entry.name);
/** A tree's bytes, its entries in Git's order. */
export function serializeTree(entries, { sorted = true } = {}) {
  const ordered = sorted ? [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b))) : entries;
  return Buffer.concat(ordered.flatMap((entry) => [Buffer.from(`${entry.mode} `), entry.name, Buffer.from([0]), Buffer.from(entry.oid, 'hex')]));
}

/** Names with Git's ordering edge cases: prefixes, '-', '.', '_' around '/', spaces, UTF-8 and a byte that is not UTF-8. */
const NAME_POOL = ['a', 'a-b', 'a.b', 'a0', 'a_b', 'ab', 'b', 'B', 'file.json', 'x y', 'dir', 'dir-1', 'dir.d', 'dir_x', 'sub', 'z', 'Zeta', '0000000001.json',
  'tab\there', 'ünï', 'emoji-😀', '#hash', '-dash'].map((name) => Buffer.from(name));
NAME_POOL.push(Buffer.from([0x6e, 0xff, 0x6d]), Buffer.from([0xe9, 0x74, 0xe9]));

/** Blob contents: empty, text, binary, sizes around zlib's and Git's thresholds, a few large ones. */
function blobContent(rand, index, large) {
  if (index === 0) return Buffer.alloc(0);
  if (large) {
    const lines = [];
    for (let line = 0; lines.length < 40_000; line += 1) lines.push(`${line} ${rand.int(1_000_000)} large blob line\n`);
    return Buffer.from(lines.join(''));
  }
  const kind = rand.int(4);
  if (kind === 0) return rand.bytes(rand.int(3000));
  if (kind === 1) return Buffer.from(JSON.stringify({ id: index, value: rand.int(1 << 30), text: 'x'.repeat(rand.int(400)) }));
  return Buffer.from(Array.from({ length: 1 + rand.int(80) }, (_, line) => `line ${line} ${rand.int(1000)}`).join('\n'));
}

/**
 * Generates a repository's objects in memory. Returns the objects (id, type,
 * content), the trees with their entries, roots for refs, the delta family
 * (one text in many versions, for deep chains) and malformed trees (written
 * with --literally, never referenced) the native reader must refuse.
 */
export function generateObjects({ seed, format, scale = 1, small = false }) {
  const rand = random(seed);
  const objects = new Map();
  const add = (type, content) => {
    const oid = objectId(format, type, content);
    if (!objects.has(oid)) objects.set(oid, { oid, type, content });
    return oid;
  };
  const blobs = [];
  for (let index = 0; index < (small ? 20 : 60 * scale); index += 1) blobs.push(add('blob', blobContent(rand, index, false)));
  const large = small ? [] : [add('blob', blobContent(rand, 1, true)), add('blob', blobContent(rand, 2, true))];
  // One text in many versions, each the one before with a line inserted at a
  // random place: a version is closest to the next larger one (one
  // difference) and farther from every other, so Git's chains run as deep as
  // --depth allows.
  const family = [];
  const text = Array.from({ length: 300 }, (_, line) => `version line ${line}: ${'abcdefghij'.repeat(2)}`);
  for (let version = 0; version < (small ? 30 : 120 * scale); version += 1) {
    text.splice(rand.int(text.length + 1), 0, `edit ${version} ${rand.int(100000)}`);
    family.push(add('blob', Buffer.from(text.join('\n'))));
  }
  const trees = new Map();
  const addTree = (entries) => {
    const content = serializeTree(entries);
    const oid = add('tree', content);
    trees.set(oid, { oid, entries: [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b))), good: true });
    return oid;
  };
  const emptyTree = addTree([]);
  const makeTree = (depth) => {
    const count = depth === 0 ? 4 + rand.int(8) : rand.int(7);
    const names = new Set();
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const name = rand.pick(NAME_POOL);
      if (names.has(name.toString('latin1'))) continue;
      names.add(name.toString('latin1'));
      const kind = rand.int(10);
      if (kind < 3 && depth < 4) entries.push({ mode: TREE, name, oid: makeTree(depth + 1) });
      else if (kind === 3) entries.push({ mode: '100755', name, oid: rand.pick(blobs) });
      else if (kind === 4) entries.push({ mode: '120000', name, oid: add('blob', Buffer.from(`target/${rand.int(100)}`)) });
      else if (kind === 5) entries.push({ mode: '160000', name, oid: hashOf(format, Buffer.from(`gitlink ${rand.int(1 << 30)}`)) });
      else if (kind === 6 && depth > 0) entries.push({ mode: TREE, name, oid: emptyTree });
      else entries.push({ mode: '100644', name, oid: rand.pick(blobs) });
    }
    return addTree(entries);
  };
  const roots = Array.from({ length: 4 * scale }, () => makeTree(0));
  // The ledger's own shape: records under prefixes, list pages, JSON names.
  const pages = Array.from({ length: 12 }, (_, page) => ({ mode: '100644', name: Buffer.from(`${String(page).padStart(10, '0')}.json`), oid: rand.pick(blobs) }));
  const ledgerRoot = addTree([
    { mode: TREE, name: Buffer.from('leases'), oid: addTree(blobs.slice(0, 9).map((oid, index) => ({ mode: '100644', name: Buffer.from(`${hashOf('sha256', Buffer.from(String(index)))}.json`), oid }))) },
    { mode: TREE, name: Buffer.from('runs'), oid: addTree([{ mode: TREE, name: Buffer.from('r1'), oid: addTree(pages) }, { mode: TREE, name: Buffer.from('r1-x'), oid: addTree(pages.slice(0, 2)) }]) },
    { mode: '100644', name: Buffer.from('meta.json'), oid: blobs[3] },
  ]);
  // Each version as `v<n>/doc.txt`: one path, as a file's history is, so Git's
  // delta search meets the versions side by side.
  const history = addTree([
    ...family.map((oid, index) => ({ mode: TREE, name: Buffer.from(`v${String(index).padStart(4, '0')}`), oid: addTree([{ mode: '100644', name: Buffer.from('doc.txt'), oid }]) })),
    ...large.map((oid, index) => ({ mode: '100644', name: Buffer.from(`large-${index}`), oid })),
  ]);
  const commit = (tree, parents, message) => add('commit', Buffer.from([`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`),
    'author Ledger Tests <tests@devryan.invalid> 981173106 +0000', 'committer Ledger Tests <tests@devryan.invalid> 981173106 +0000', '', message, ''].join('\n')));
  const first = commit(roots[0], [], 'first');
  const second = commit(roots[1], [first], 'second');
  const tag = add('tag', Buffer.from([`object ${second}`, 'type commit', 'tag v1', 'tagger Ledger Tests <tests@devryan.invalid> 981173106 +0000', '', 'a tag', ''].join('\n')));
  // Malformed trees: Git stores them only with --literally; the reader must ask Git for each.
  const bad = [];
  // `probe`: a path whose lookup reads the malformed tree.
  const badTree = (entries, reason, options, probe = 'a') => {
    const content = serializeTree(entries, options);
    const oid = objectId(format, 'tree', content);
    objects.set(oid, { oid, type: 'tree', content, literally: true });
    trees.set(oid, { oid, entries, good: false, reason, probe });
    bad.push(oid);
  };
  const leaf = (name, oid = blobs[1], mode = '100644') => ({ mode, name: Buffer.from(name), oid });
  badTree([leaf('b'), leaf('a')], 'tree_order', { sorted: false });
  badTree([leaf('a'), leaf('a')], 'tree_order', { sorted: false });
  badTree([leaf('a', blobs[1], '100664'), leaf('b')], 'tree_mode');
  badTree([leaf('a', roots[0], '040000'), leaf('b')], 'tree_mode');
  badTree([leaf('a', hashOf(format, Buffer.from('no such blob'))), leaf('b')], 'tree_missing');
  badTree([{ mode: TREE, name: Buffer.from('d'), oid: bad[0] }, leaf('e')], 'tree_order', {}, 'd/a');
  return { format, objects, trees, roots, ledgerRoot, history, emptyTree, commits: [first, second], tag, blobs, large, family, bad };
}

/** Writes every object with `git hash-object -w` (one process per type), checking each id Git prints. */
export function writeObjects(env, gitDir, generated, scratch, filter = () => true) {
  const byType = new Map();
  for (const object of generated.objects.values()) {
    if (!filter(object)) continue;
    const key = `${object.type}${object.literally ? ' literally' : ''}`;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(object);
  }
  const directory = path.join(scratch, 'object-files');
  mkdirSync(directory, { recursive: true });
  for (const [key, list] of byType) {
    const [type, literally] = key.split(' ');
    const files = list.map((object) => {
      const file = path.join(directory, object.oid);
      writeFileSync(file, object.content);
      return file;
    });
    const printed = runGit(env, gitDir, ['hash-object', '-w', '-t', type, ...(literally ? ['--literally'] : []), '--stdin-paths'], { input: `${files.join('\n')}\n` }).toString().trim().split('\n');
    const expected = list.map((object) => object.oid);
    if (printed.join(' ') !== expected.join(' ')) throw new Error(`git hash-object printed other ids for ${key}`);
  }
  rmSync(directory, { recursive: true, force: true });
}

/** The refs a generated repository gets: every root, a lease per root, the history, the empty tree, two blobs, a commit and a tag. */
export function refsOf(generated) {
  const refs = [['refs/heads/main', generated.commits[1]], ['refs/heads/first', generated.commits[0]], ['refs/tags/v1', generated.tag],
    ['refs/devryan/state', generated.ledgerRoot], ['refs/gen/history', generated.history], ['refs/gen/empty', generated.emptyTree],
    ...(generated.large.length ? [['refs/gen/large', generated.large[0]]] : []), ['refs/gen/blob', generated.blobs[5]]];
  generated.roots.forEach((root, index) => refs.push([`refs/devryan/leases/${hashOf('sha1', Buffer.from(String(index))).slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, '0')}`, root]));
  return refs;
}

export function updateRefs(env, gitDir, refs) {
  runGit(env, gitDir, ['update-ref', '--stdin'], { input: refs.map(([name, oid]) => `update ${name} ${oid}\n`).join('') });
}

/**
 * Pack layouts. Each takes a fresh repository holding the generated objects
 * (all loose, refs not yet written) and leaves it in its layout.
 */
export const LAYOUTS = Object.freeze([
  { name: 'loose', apply: ({ refs, update }) => update(refs) },
  { name: 'repack-d', apply: ({ refs, update, git }) => { update(refs); git(['repack', '-d', '-q']); } },
  { name: 'repack-a-d', apply: ({ refs, update, git }) => { update(refs); git(['-c', 'pack.writeReverseIndex=true', 'repack', '-a', '-d', '-q']); } },
  { name: 'no-rev', apply: ({ refs, update, git }) => { update(refs); git(['-c', 'pack.writeReverseIndex=false', '-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '-f', '-q']); } },
  { name: 'multi-pack', apply: ({ refs, update, git }) => {
    // Two packs from two repacks, the rest loose.
    const third = Math.ceil(refs.length / 3);
    update(refs.slice(0, third)); git(['repack', '-d', '-q']);
    update(refs.slice(third, 2 * third)); git(['repack', '-d', '-q']);
    update(refs.slice(2 * third));
  } },
  { name: 'deep-delta', apply: ({ refs, update, git, generated, gitInput, gitDir }) => {
    // fast-import deltas each blob against the one before it in its stream,
    // so the versions (their loose copies removed first) form one chain;
    // repack -a -d without -f reuses it whole.
    for (const oid of generated.family) rmSync(path.join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
    const stream = Buffer.concat(generated.family.map((oid) => generated.objects.get(oid).content).flatMap((content) => [Buffer.from(`blob\ndata ${content.length}\n`), content, Buffer.from('\n')]));
    gitInput(['-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--depth=4095'], stream);
    update(refs);
    git(['repack', '-a', '-d', '-q', '--depth=4095']);
  } },
  { name: 'ref-delta', apply: ({ refs, update, git }) => { update(refs); git(['-c', 'repack.useDeltaBaseOffset=false', 'repack', '-a', '-d', '-f', '-q']); } },
  { name: 'large-offset', apply: ({ refs, update, git, packFiles }) => {
    update(refs); git(['repack', '-a', '-d', '-q']);
    // Every object past the first behind a 64-bit offset.
    for (const pack of packFiles().filter((file) => file.endsWith('.pack'))) {
      const index = pack.replace(/\.pack$/, '.idx');
      const rebuilt = path.join(path.dirname(path.dirname(path.dirname(pack))), 'rebuilt-large.idx');
      git(['index-pack', '--index-version=2,12', '-o', rebuilt, pack]);
      rmSync(index, { force: true });
      writeFileSync(index, readFileSync(rebuilt));
      rmSync(rebuilt, { force: true });
      rmSync(pack.replace(/\.pack$/, '.rev'), { force: true });
      rmSync(pack.replace(/\.pack$/, '.bitmap'), { force: true });
    }
  } },
]);

/** Ref storage: loose, packed (`pack-refs --all`), or both (packed, then some moved and some added loose). */
export const REF_STYLES = Object.freeze(['loose', 'packed', 'both']);
export function applyRefStyle(env, gitDir, style, generated) {
  if (style === 'loose') return;
  runGit(env, gitDir, ['pack-refs', '--all']);
  if (style === 'both') {
    updateRefs(env, gitDir, [['refs/heads/main', generated.commits[0]], ['refs/devryan/state', generated.roots[0]], ['refs/gen/loose-only', generated.blobs[7]]]);
  }
}

/**
 * Builds one repository: `git init --bare`, the objects, a layout and a ref
 * style. `template` (`{ gitDir, generated }` of an earlier build with
 * `layout: null`) is copied instead of writing the objects again.
 */
export function buildRepository({ env, scratch, name, format, seed, layout, refStyle, scale = 1, small = false, template }) {
  const gitDir = path.join(scratch, `${name}.git`);
  rmSync(gitDir, { recursive: true, force: true });
  let generated;
  if (template) {
    cpSync(template.gitDir, gitDir, { recursive: true });
    generated = template.generated;
  } else {
    runGit(env, null, ['init', '-q', '--bare', `--object-format=${format}`, gitDir]);
    generated = generateObjects({ seed, format, scale, small });
    writeObjects(env, gitDir, generated, scratch);
  }
  if (!layout) return { gitDir, generated, packs: [] };
  const git = (args) => runGit(env, gitDir, args);
  const packFiles = () => readdirSync(path.join(gitDir, 'objects/pack')).map((file) => path.join(gitDir, 'objects/pack', file));
  const gitInput = (args, input) => runGit(env, gitDir, args, { input });
  layout.apply({ refs: refsOf(generated), update: (refs) => updateRefs(env, gitDir, refs), git, gitInput, gitDir, packFiles, generated });
  applyRefStyle(env, gitDir, refStyle, generated);
  return { gitDir, generated, packs: packFiles().map((file) => path.basename(file)) };
}

/** A loose object file of any header, deflated by Node (for corrupt and unknown-type objects Git will not write). */
export function writeRawLoose(gitDir, oid, bytes, { deflate = true } = {}) {
  const directory = path.join(gitDir, 'objects', oid.slice(0, 2));
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, oid.slice(2));
  rmSync(file, { force: true });
  writeFileSync(file, deflate ? zlib.deflateSync(bytes) : bytes);
  return file;
}

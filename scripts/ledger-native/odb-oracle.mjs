// Git as the oracle of the native object database (plan package L3a): one
// repository read by Git and by the probe (`odb-probe`), compared byte for
// byte. `cat-file --batch-all-objects --batch` and `--batch-check`; every
// `<id>` and `<tree>:<path>` name with `cat-file --batch` and `--batch-check`;
// `ls-tree -r -l -z` of trees (up to `treeLimit` whole, the first
// `prefixTrees` also by prefix); `for-each-ref` with and without patterns;
// every ref by name.
//
// Where the probe answers "ask Git" the case must be one the test expected
// (`expectAsk`, with its reason); anywhere else its answer must be Git's.
import { spawnSync } from 'node:child_process';

import { hashOf, runGit } from './odb-repos.mjs';

/** Runs the probe; stdout as a Buffer. */
export function runProbe(probe, args, { input, env = process.env } = {}) {
  const result = spawnSync(probe, args, { input, env, maxBuffer: 1 << 30 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString() };
}

/** The probe's output, which must be a success. */
function probeOk(probe, args, options) {
  const result = runProbe(probe, args, options);
  if (result.status !== 0) throw new Error(`odb-probe ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/** `cat-file --batch` output split into records `{ header, content }`, as Git prints them for `inputs`. */
function batchRecords(buffer, count, withContent = true) {
  const records = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    const end = buffer.indexOf(10, at);
    if (end < 0) throw new Error(`batch output ends after ${index} of ${count} records (last ${records.at(-1)?.header})`);
    const header = buffer.subarray(at, end).toString('latin1');
    at = end + 1;
    const fields = header.split(' ');
    if (!withContent || ['missing', 'ambiguous', 'submodule'].includes(fields.at(-1)) || fields.at(-2) === 'ask-git') {
      records.push({ header });
      continue;
    }
    const size = Number(fields[2]);
    records.push({ header, content: buffer.subarray(at, at + size) });
    at += size + 1;
  }
  if (at !== buffer.length) throw new Error(`batch output has bytes after its records: ${JSON.stringify(buffer.subarray(at, at + 120).toString("latin1"))} after ${records.at(-1)?.header}`);
  return records;
}

const lines = (buffer) => {
  const text = buffer.toString('latin1');
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
};

/** `ok <n>\n<bytes>` or `ask-git <code>\n` records of `ls-tree-many`. */
function listingRecords(buffer, count) {
  const records = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    const end = buffer.indexOf(10, at);
    const header = buffer.subarray(at, end).toString();
    at = end + 1;
    if (header.startsWith('ask-git ')) { records.push({ ask: header.slice(8) }); continue; }
    const size = Number(header.slice(3));
    records.push({ rows: buffer.subarray(at, at + size) });
    at += size;
  }
  return records;
}

/** Paths of every entry under a generated tree, `[path, entry]`, depth first. */
function generatedPaths(generated, oid, prefix = Buffer.alloc(0), out = []) {
  const tree = generated.trees.get(oid);
  if (!tree || !tree.good) return out;
  for (const entry of tree.entries) {
    const path = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), entry.name]) : entry.name;
    out.push([path, entry]);
    if (entry.mode === '40000') generatedPaths(generated, entry.oid, path, out);
  }
  return out;
}

const SIMPLE = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;

/**
 * The names, listings and refs to compare, and the cases where the probe
 * must ask Git. From the generator's knowledge when there is any, otherwise
 * (a real ledger) from Git's own listings.
 */
function requests({ env, gitDir, generated, ids, trees, refs, prefixTrees }) {
  const names = [...ids.map((oid) => Buffer.from(oid))];
  const expectAsk = new Map();
  const asked = (name, code) => { expectAsk.set(Buffer.isBuffer(name) ? name.toString('latin1') : name, code); return name; };
  const format = ids[0]?.length === 64 ? 'sha256' : 'sha1';
  for (let index = 0; index < 4; index += 1) names.push(Buffer.from(hashOf(format, Buffer.from(`absent ${index}`))));
  const listings = [];
  const expectListingAsk = new Map();
  const listingKey = (tree, prefix) => `${tree} ${prefix ?? ''}`;
  // Every tree is listed whole; the first `prefixTrees` also by prefix.
  trees.forEach((tree, treeIndex) => {
    const entries = generated ? generatedPaths(generated, tree) : null;
    // A real ledger keeps unreachable trees whose objects maintenance pruned:
    // Git cannot list them, and the Rust must ask Git.
    const listed = entries ? null : runGit(env, gitDir, ['ls-tree', '-r', '-t', '-z', tree], { accept: [0, 1, 128] });
    if (listed && listed.status !== 0) {
      listings.push([tree, null]);
      expectListingAsk.set(listingKey(tree, null), 'tree_missing');
      return;
    }
    const rows = entries ?? lines(listed).flatMap((line) => line.split('\0')).filter(Boolean).map((row) => {
      const tab = row.indexOf('\t');
      // `ls-tree` prints a tree's mode as 040000; the trees store 40000.
      return [Buffer.from(row.slice(tab + 1), 'latin1'), { mode: row.split(' ')[0].replace(/^0/, '') }];
    });
    for (const [path, entry] of rows) {
      const name = (suffix) => Buffer.concat([Buffer.from(`${tree}:`), path, Buffer.from(suffix)]);
      names.push(name(''));
      names.push(name('x'));
      if (entry.mode !== '40000') names.push(name('/child'));
    }
    listings.push([tree, null]);
    if (treeIndex >= prefixTrees) return;
    const directories = rows.filter(([path, entry]) => entry.mode === '40000' && path.toString('latin1').split('/').length <= 2).map(([path]) => path.toString('latin1'));
    for (const directory of directories.filter((dir) => SIMPLE.test(dir)).slice(0, 6)) listings.push([tree, directory]);
    listings.push([tree, 'nope']);
    const blob = rows.find(([path, entry]) => entry.mode !== '40000' && SIMPLE.test(path.toString('latin1')));
    if (blob) {
      listings.push([tree, blob[0].toString('latin1')]);
      expectListingAsk.set(listingKey(tree, blob[0].toString('latin1')), 'tree_mode');
    }
  });
  if (generated) {
    for (const oid of generated.bad) {
      const { reason, probe } = generated.trees.get(oid);
      listings.push([oid, null]);
      expectListingAsk.set(listingKey(oid, null), reason);
      // A lookup through a malformed tree asks Git; through a tree naming a missing blob, Git's answer is "missing".
      names.push(reason === 'tree_missing' ? Buffer.from(`${oid}:${probe}`) : asked(Buffer.from(`${oid}:${probe}`), reason));
    }
    for (const oid of [...generated.commits, generated.tag]) names.push(asked(Buffer.from(`${oid}:a`), 'peel'));
    names.push(asked(Buffer.from(ids[0].toUpperCase()), 'name_syntax'));
    names.push(asked(Buffer.from(ids[0].slice(0, 12)), 'name_syntax'));
    names.push(asked(Buffer.from(`${generated.ledgerRoot}:runs//r1`), 'name_syntax'));
    names.push(asked(Buffer.from(`${generated.ledgerRoot}:runs/r1/`), 'name_syntax'));
    names.push(asked(Buffer.from(`${generated.ledgerRoot}:/runs`), 'name_syntax'));
    names.push(asked(Buffer.from(`${generated.ledgerRoot}:`), 'name_syntax'));
  }
  const refNames = [...refs.map((ref) => ref.name), 'refs/nope/x', 'refs/devryan', 'refs/heads'];
  const patterns = [null, 'refs/devryan', 'refs/devryan/', 'refs/devryan/leases', 'refs/heads/main', 'refs/nope', 'refs'];
  return { names, expectAsk, listings, expectListingAsk, listingKey, refNames, patterns };
}

/**
 * Compares Git and the probe on one repository. Returns counts of what was
 * compared and the list of differences (empty when equal).
 */
export function compareRepository({ env, gitDir, probe, generated = null, probeEnv = process.env, treeLimit = 40, prefixTrees = 8 }) {
  const differences = [];
  const differ = (what) => { if (differences.length < 50) differences.push(what); };
  const counts = { objects: 0, names: 0, listings: 0, refs: 0, askGit: 0 };
  // Every object, with contents and by header.
  const all = runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch']);
  const allProbe = probeOk(probe, ['batch-all', gitDir], { env: probeEnv });
  if (Buffer.compare(all, allProbe) !== 0) differ(`cat-file --batch-all-objects --batch differs (${all.length} bytes from Git, ${allProbe.length} from the probe)`);
  const check = runGit(env, gitDir, ['cat-file', '--batch-all-objects', '--batch-check']);
  const checkProbe = probeOk(probe, ['batch-all-check', gitDir], { env: probeEnv });
  if (Buffer.compare(check, checkProbe) !== 0) differ('cat-file --batch-all-objects --batch-check differs');
  const objects = lines(check).map((line) => line.split(' '));
  counts.objects = objects.length;
  const ids = objects.map(([oid]) => oid);
  // Trees to list: the generator's good trees, or every tree of a real ledger (bounded).
  // The roots first (refs name them), then the rest.
  let trees = generated ? [...new Set([generated.ledgerRoot, ...generated.roots, ...[...generated.trees.values()].filter((tree) => tree.good).map((tree) => tree.oid)])]
    : objects.filter(([, type]) => type === 'tree').map(([oid]) => oid);
  if (trees.length > treeLimit) trees = trees.filter((_, index) => index % Math.ceil(trees.length / treeLimit) === 0);
  const refValues = new Map(lines(runGit(env, gitDir, ['for-each-ref', '--format=%(refname) %(objectname)'])).map((line) => line.split(' ')));
  const refs = [...refValues.keys()].map((name) => ({ name }));
  const plan = requests({ env, gitDir, generated, ids, trees, refs, prefixTrees });

  // Names, with contents and by header.
  for (const check of [false, true]) {
    const gitNames = plan.names.filter((name) => !plan.expectAsk.has(name.toString('latin1')));
    const input = Buffer.concat(gitNames.flatMap((name) => [name, Buffer.from('\n')]));
    const fromGit = batchRecords(runGit(env, gitDir, ['cat-file', check ? '--batch-check' : '--batch'], { input }), gitNames.length, !check);
    const allInput = Buffer.concat(plan.names.flatMap((name) => [name, Buffer.from('\n')]));
    const fromProbe = batchRecords(probeOk(probe, [check ? 'batch-check' : 'batch', gitDir], { input: allInput, env: probeEnv }), plan.names.length, !check);
    let gitIndex = 0;
    plan.names.forEach((name, index) => {
      const key = name.toString('latin1');
      const mine = fromProbe[index];
      if (plan.expectAsk.has(key)) {
        if (mine.header !== `${key} ask-git ${plan.expectAsk.get(key)}`) differ(`${key}: expected ask-git ${plan.expectAsk.get(key)}, the probe printed ${mine.header}`);
        counts.askGit += 1;
        return;
      }
      const theirs = fromGit[gitIndex++];
      if (mine.header !== theirs.header || (theirs.content && Buffer.compare(theirs.content, mine.content ?? Buffer.alloc(0)) !== 0)) {
        differ(`cat-file ${check ? '--batch-check' : '--batch'} ${key}: Git ${theirs.header}, probe ${mine.header}`);
      }
    });
    counts.names += plan.names.length;
  }

  // Listings, whole and by prefix.
  const listingInput = plan.listings.map(([tree, prefix]) => (prefix === null ? tree : `${tree} ${prefix}`)).join('\n');
  const probeListings = listingRecords(probeOk(probe, ['ls-tree-many', gitDir], { input: `${listingInput}\n`, env: probeEnv }), plan.listings.length);
  plan.listings.forEach(([tree, prefix], index) => {
    const key = plan.listingKey(tree, prefix);
    const mine = probeListings[index];
    if (plan.expectListingAsk.has(key)) {
      if (mine.ask !== plan.expectListingAsk.get(key)) differ(`ls-tree ${key}: expected ask-git ${plan.expectListingAsk.get(key)}, the probe answered ${mine.ask ?? 'rows'}`);
      counts.askGit += 1;
      return;
    }
    const theirs = runGit(env, gitDir, prefix === null ? ['ls-tree', '-r', '-l', '-z', tree] : ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', tree, '--', `${prefix}/`]);
    // `ls-tree -l` prints BAD for a size it cannot read (a pruned blob): the Rust asks Git there.
    if (mine.ask === 'tree_missing' && / BAD\t/.test(theirs.toString('latin1'))) { counts.askGit += 1; return; }
    if (mine.ask) differ(`ls-tree ${key}: the probe asked Git (${mine.ask})`);
    else if (Buffer.compare(theirs, mine.rows) !== 0) differ(`ls-tree ${key} differs`);
  });
  counts.listings = plan.listings.length;

  // Refs: listed, by pattern and one by one.
  for (const pattern of plan.patterns) {
    const args = pattern === null ? [] : [pattern];
    const theirs = runGit(env, gitDir, ['for-each-ref', ...args]);
    const mine = probeOk(probe, ['for-each-ref', gitDir, ...args], { env: probeEnv });
    if (Buffer.compare(theirs, mine) !== 0) differ(`for-each-ref ${pattern ?? ''} differs`);
  }
  const probeRefs = lines(probeOk(probe, ['read-ref-many', gitDir], { input: `${plan.refNames.join('\n')}\n`, env: probeEnv }));
  // Git's value of each ref by its exact name (none for the names it does not list).
  plan.refNames.forEach((name, index) => {
    const theirs = refValues.get(name) ?? 'absent';
    if (probeRefs[index] !== theirs) differ(`ref ${name}: Git ${theirs}, probe ${probeRefs[index]}`);
  });
  counts.refs = plan.refNames.length + plan.patterns.length;
  return { counts, differences };
}

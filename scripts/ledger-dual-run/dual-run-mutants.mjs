// Deliberately broken copies of the ledger, to prove the harness catches what
// it claims to. Each copies packages/harness-runtime/lib and
// packages/shared-runtime into a temporary directory (never the repository),
// applies its planted difference by exact text replacement (refusing to build
// if an anchor text is not found exactly once), and adds a line that records
// when the planted code runs, so an uncaught mutant can be told apart from an
// unexercised one.
//
// Each mutant names the one finding it must produce: the comparison
// (`category`), where it is (`where`, a pattern on the location) and what it
// says (`detail`, a pattern on the message). Any other difference does not
// count as catching it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPOSITORY_ROOT } from './dual-run-runner.mjs';

// An expression; statement uses add their own semicolon.
const reached = (name) => `process.getBuiltinModule('node:fs').appendFileSync(process.env.LEDGER_DUAL_RUN_PLANT_LOG || '/dev/null', ${JSON.stringify(`${name}\n`)})`;

/**
 * name, kind of difference, its edits ({ file, anchor, replacement }), the
 * scenario that exercises it (or `crash`: only after the crash points that
 * leave a materialization intent), and the finding that catches it.
 */
export const MUTANTS = Object.freeze([
  {
    name: 'tree-byte', kind: 'a changed byte in a tree (blob entry mode 100644 written as 100664)',
    edits: [{ file: 'session-changes-trees.js', anchor: "const BLOB_MODE = '100644', TREE_MODE = '40000';",
      replacement: (name) => `const BLOB_MODE = (${reached(name)}, '100664'), TREE_MODE = '40000';` }],
    scenario: 'smoke', expect: { category: 'git', where: /refs\/devryan\/state\/.+\.json$/, detail: /mode 100644.*mode 100664/ },
  },
  {
    name: 'entry-order', kind: 'a different ordering of tree entries (reverse of Git order)',
    edits: [{ file: 'session-changes-trees.js', anchor: 'const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortName(a), \'latin1\'), Buffer.from(sortName(b), \'latin1\')));',
      replacement: (name) => `${reached(name)}; const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortName(b), 'latin1'), Buffer.from(sortName(a), 'latin1')));` }],
    scenario: 'smoke', expect: { category: 'oracle', where: /tree refs\/devryan\/state in run B/, detail: /out of Git order/ },
  },
  {
    name: 'skipped-object', kind: 'a skipped object (the loose blob of each operation record is never written)',
    edits: [{ file: 'session-changes-trees.js', anchor: '  const oid = objectID(type, content, oidLength);\n',
      replacement: (name) => `  const oid = objectID(type, content, oidLength);\n  if (type === 'blob' && content.includes('"origin":"execution"')) { ${reached(name)}; return oid; }\n` }],
    scenario: 'smoke', expect: { category: 'git', where: /refs\/devryan\/state\/operations\/[0-9a-f]{64}\.json$/, detail: /object missing: B / },
  },
  {
    name: 'json-key-order', kind: 'a different JSON key order in a stored record (lease: scope before token)',
    edits: [{ file: 'session-mutations.js', anchor: 'const result = { token, scope, directory: repo.logicalDirectory, projectDirectory: repo.directory,',
      replacement: (name) => `${reached(name)}; const result = { scope, token, directory: repo.logicalDirectory, projectDirectory: repo.directory,` }],
    scenario: 'smoke', expect: { category: 'git', where: /blob refs\/devryan\/state\/leases\/[0-9a-f]{64}\.json$/, detail: /key order token,scope.*key order scope,token/ },
  },
  {
    name: 'result-number', kind: 'a result that differs only in a number (warm reports one file more)',
    edits: [{ file: 'session-mutations.js', anchor: 'return { built: true, files, elapsedMs: Date.now() - started };',
      replacement: (name) => `${reached(name)}; return { built: true, files: files + 1, elapsedMs: Date.now() - started };` }],
    scenario: 'reconcile', expect: { category: 'call', where: /^warm \(warm\)$/, detail: /"where":"result\.value\.files","a":"\d+","b":"\d+"/ },
  },
  {
    name: 'lock-early-release', kind: 'a lock released at the wrong time (owner.lock removed before the locked work runs)',
    edits: [{ file: 'atomic-file.js', anchor: '  try {\n    options.signal?.throwIfAborted();\n    return await callback();\n  } finally {\n    await removeObservedLock(fsApi, lockPath, `${JSON.stringify(owner)}\\n`, ownerToken);\n  }',
      replacement: (name) => `  try {\n    options.signal?.throwIfAborted();\n    if (lockPath.endsWith('/owner.lock')) { ${reached(name)}; await removeObservedLock(fsApi, lockPath, \`\${JSON.stringify(owner)}\\n\`, ownerToken); }\n    return await callback();\n  } finally {\n    await removeObservedLock(fsApi, lockPath, \`\${JSON.stringify(owner)}\\n\`, ownerToken);\n  }` }],
    // The git shim's observation, not anything the ledger reports about itself.
    scenario: 'smoke', expect: { category: 'lock', where: /^run B ledger /, detail: /not under owner\.lock held by the moving process \(before\/after: absent\/absent\)/ },
  },
  {
    name: 'materialization-drops-observation', kind: 'a materialization that no longer records the observation of what it wrote (the publication path)',
    edits: [{ file: 'session-mutations.js', anchor: '      doc.published = { ...doc.published, ...entry }; repo.db.set(key(\'files\', id), doc);',
      replacement: (name) => `      ${reached(name)}; void doc;` }],
    scenario: 'smoke', expect: { category: 'git', where: /blob refs\/devryan\/state\/files\/[0-9a-f]{64}\.json$/, detail: /missing":\["identity","observation","size","whole"\]/ },
  },
  {
    name: 'recovery-drops-observation', kind: 'a recovery that drops one step: at the next lock after a crash, recovery no longer records the observation of what it wrote (the normal path is unchanged)',
    edits: [
      { file: 'session-mutations.js', anchor: "        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_recovery', () => recover(repo)));",
        replacement: () => "        await withoutExecutionDeadline(() => quietExecutionPhase('ledger_recovery', async () => { globalThis.__dualRunRecovering = true; try { await recover(repo); } finally { globalThis.__dualRunRecovering = false; } }));" },
      { file: 'session-mutations.js', anchor: '      doc.published = { ...doc.published, ...entry }; repo.db.set(key(\'files\', id), doc);',
        replacement: (name) => `      if (globalThis.__dualRunRecovering) { ${reached(name)}; continue; }\n      doc.published = { ...doc.published, ...entry }; repo.db.set(key('files', id), doc);` },
    ],
    // A later refresh warm restamps the file, so the state at rest converges: only the state ref's history shows it.
    scenario: 'crash', expect: { category: 'git', where: /blob refs\/devryan\/state@\{\d+\}\/files\/[0-9a-f]{64}\.json$/, detail: /identity|observation/ },
  },
  // The review's three slip-through cases (L0-review B2, S3, S2).
  {
    name: 'stamp-microseconds', kind: 'stored file stamps cut to microseconds (mtimeNs and ctimeNs end in 000)',
    edits: [{ file: 'session-mutation-files.js', anchor: 'const stamp = (stat) => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(\':\') : null;',
      replacement: (name) => `const stamp = (stat) => stat ? (${reached(name)}, [stat.dev, stat.ino, stat.size, stat.mtimeNs / 1000n * 1000n, stat.ctimeNs / 1000n * 1000n, stat.mode].join(':')) : null;` }],
    scenario: 'smoke', expect: { category: 'git', where: /blob refs\/devryan\/state\/files\/[0-9a-f]{64}\.json$/, detail: /<stamp project\/[^@]+@\d+>.*<stamp project\/[^@]+@\d+ differs in mtime,ctime>/ },
  },
  {
    name: 'stamp-other-inode', kind: 'a stored file identity naming another file\'s inode (the next inode number)',
    edits: [{ file: 'session-mutation-files.js', anchor: "...(stat.isFile() ? { permissions: mode & 0o7777 } : {}), identity: `${stat.dev}:${stat.ino}`,",
      replacement: (name) => `...(stat.isFile() ? { permissions: mode & 0o7777 } : {}), identity: (${reached(name)}, \`\${stat.dev}:\${stat.ino + 1n}\`),` }],
    scenario: 'smoke', expect: { category: 'git', where: /blob refs\/devryan\/state\/files\/[0-9a-f]{64}\.json$/, detail: /"where":"\$\.published\.identity"/ },
  },
  {
    name: 'undefined-as-null', kind: 'a result `undefined` sent as `null` (every call that returns nothing)',
    edits: [{ file: 'session-mutation-worker.js', anchor: 'try { value = outcome.failed ? undefined : encodeResult(outcome.result); }',
      replacement: (name) => `try { value = outcome.failed ? undefined : encodeResult(outcome.result === undefined ? (${reached(name)}, null) : outcome.result); }` }],
    scenario: 'reopen', expect: { category: 'call', where: /^cancel-open \(cancelLease\)$/, detail: /"where":"result\.value","a":"undefined","b":"null"/ },
  },
  {
    name: 'background-callback', kind: 'a background host callback (onChange with no cause) made by one side only',
    edits: [{ file: 'session-mutation-worker.js', anchor: "port.postMessage({ type: 'ready', methods: [...methods] });",
      replacement: (name) => `port.postMessage({ type: 'ready', methods: [...methods] });\nif (observers.onChange) { ${reached(name)}; callHost({ observer: 'onChange' }, [{ planted: true }]).catch(() => {}); }` }],
    scenario: 'smoke', expect: { category: 'journal', where: /^generation 0$/, detail: /background observers and callbacks/ },
  },
  // Planted differences aimed at the comparer's remaining tolerances.
  {
    name: 'time-not-refreshed', kind: 'a stored time written at the wrong moment (every lease after the first keeps the first lease\'s reservedAt)',
    edits: [{ file: 'session-mutations.js', anchor: 'executionFingerprint: input.executionFingerprint, reservedAt: Date.now(),',
      replacement: (name) => `executionFingerprint: input.executionFingerprint, reservedAt: globalThis.__dualRunReservedAt ? (${reached(name)}, globalThis.__dualRunReservedAt) : (globalThis.__dualRunReservedAt = Date.now()),` }],
    scenario: 'undo', expect: { category: 'git', where: /blob refs\/devryan\/state\/leases\/[0-9a-f]{64}\.json$/, detail: /reservedAt.*<time in window \d+>/ },
  },
  {
    name: 'receipt-row-order', kind: 'publication receipt rows in reverse order (the comparer used to sort them)',
    edits: [{ file: 'session-mutations.js', anchor: '      for (const file of new Set([...base.keys(), ...files.keys()])) {\n        const before = base.get(file)?.entry ?? null, after = files.get(file) ?? null;',
      replacement: (name) => `      for (const file of [...new Set([...base.keys(), ...files.keys()])].reverse()) {\n        const before = base.get(file)?.entry ?? null, after = files.get(file) ?? null; ${reached(name)};` }],
    // Without the identifier protocol the rows' order follows random IDs and is compared by path.
    seededOnly: 'unseeded, receipt rows follow random document IDs and are compared ordered by path',
    scenario: 'undo', expect: { category: 'git', where: /blob refs\/devryan\/state\/publications\/[^/]+\/files\/\d{10}\.json$/, detail: /\$\[0\]/ },
  },
  {
    name: 'verified-other-object', kind: 'a verified-objects.v1 line whose stamp describes another file (the objects folder)',
    edits: [{ file: 'session-mutation-files.js', anchor: 'const persistVerified = (root, expected, identity) => fs.appendFile(path.join(root, VERIFIED_OBJECTS_FILE),\n  `${expected} ${identity}\\n`',
      replacement: (name) => `const persistVerified = (root, expected, identity) => fs.appendFile(path.join(root, VERIFIED_OBJECTS_FILE),\n  \`\${expected} \${(${reached(name)}, objectIdentity(lstatSync(path.join(root, 'objects'), { bigint: true })))}\\n\`` }],
    scenario: 'smoke', expect: { category: 'file', where: /\/verified-objects\.v1$/, detail: /\/objects@\d+/ },
  },
  {
    name: 'redundant-ref-move', kind: 'an extra move of the state ref after each commit (same tree, a second compare-and-swap)',
    edits: [{ file: 'session-changes-store.js', anchor: "    await run(['update-ref', ref, next, tree ?? '0'.repeat(oidLength)]);\n",
      replacement: (name) => `    await run(['update-ref', ref, next, tree ?? '0'.repeat(oidLength)]);\n    if (ref === 'refs/devryan/state') { ${reached(name)}; await run(['update-ref', ref, next, next]); }\n` }],
    scenario: 'smoke', expect: { category: 'history', where: /refs\/devryan\/state$/, detail: /"a":"\d+ moves","b":"\d+ moves"/ },
  },
  {
    name: 'alternates-left', kind: 'a file left in the ledger\'s Git object store (objects/info/alternates) that the old comparer skipped',
    edits: [{ file: 'session-mutations.js', anchor: "await git(root, ['init', '--bare', '--quiet', gitDir]); }",
      replacement: (name) => `await git(root, ['init', '--bare', '--quiet', gitDir]); ${reached(name)}; await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), \`\${os.tmpdir()}\\n\`); }` }],
    scenario: 'smoke', expect: { category: 'file', where: /\/git\/objects\/info\/alternates$/, detail: /only in run B/ },
  },
  {
    name: 'guard-skipped-after-cas', kind: 'the host guard no longer asked after the ref compare-and-swap (one callback fewer under the lock)',
    edits: [{ file: 'session-changes-store.js', anchor: '    try { await assertCurrent?.(); }\n    catch (cause) {',
      replacement: (name) => `    try { if (assertCurrent) ${reached(name)}; }\n    catch (cause) {` }],
    scenario: 'guards', expect: { category: 'call', where: /^guarded \(cancelUnstartedCall\)$/, detail: /"where":"callbacks/ },
  },
]);

/** Builds the copy for `mutant` under `parent`; returns its lib directory. */
export async function buildMutant(mutant, parent) {
  const root = path.join(parent, `mutant-${mutant.name}`);
  await fs.rm(root, { recursive: true, force: true });
  const copy = async (relative) => fs.cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative), { recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !/\.test\.[cm]?js$/.test(source) });
  await copy('packages/harness-runtime/lib');
  await copy('packages/harness-runtime/package.json');
  await copy('packages/shared-runtime');
  // `@devryan/shared-runtime` imports resolve to the copy.
  await fs.mkdir(path.join(root, 'node_modules', '@devryan'), { recursive: true });
  await fs.symlink(path.join(root, 'packages', 'shared-runtime'), path.join(root, 'node_modules', '@devryan', 'shared-runtime'));
  const libDir = path.join(root, 'packages', 'harness-runtime', 'lib');
  for (const edit of mutant.edits) {
    const file = path.join(libDir, edit.file);
    const source = await fs.readFile(file, 'utf8');
    const count = source.split(edit.anchor).length - 1;
    if (count !== 1) throw new Error(`mutant ${mutant.name}: anchor found ${count} times in ${edit.file}`);
    await fs.writeFile(file, source.replace(edit.anchor, () => edit.replacement(mutant.name)));
  }
  return libDir;
}

/** The difference that shows the planted difference as expected, or null: its category, location and message must all match. */
export const catching = (mutant, differences) => differences.find((difference) => difference.category === mutant.expect.category
  && mutant.expect.where.test(difference.where) && mutant.expect.detail.test(typeof difference.detail === 'string' ? difference.detail : JSON.stringify(difference.detail))) ?? null;
export const caught = (mutant, differences) => catching(mutant, differences) !== null;

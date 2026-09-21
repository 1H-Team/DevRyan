#!/usr/bin/env node
import { mkdir, readdir, lstat, rm, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activityReasons, activityScope, buildPaths, confined, fileHash, gitState, hash, optionalJson, packagePattern,
  packageReferences, processUsage, recognized, retentionName, run, treeIdentity, within } from './storage-policy.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const day = 86400000;
const defaults = { usage: processUsage, remove: directory => rm(directory, { recursive: true }) };
const isMissing = error => error.code === 'ENOENT';

export async function auditStorage(root = repository, { usage = defaults.usage, now = Date.now() } = {}) {
  const state = await gitState(root);
  const references = await packageReferences(root, state.protectedFiles);
  const activity = await usage(root);
  const entries = [];
  const donorPaths = new Set();
  let packages = [];
  try { await confined(root, '.cache/qa'); packages = await readdir(path.join(root, '.cache/qa')); }
  catch (error) { if (!isMissing(error)) throw error; }
  for (const name of packages.sort()) {
    const packageRoot = `.cache/qa/${name}`;
    if (!packagePattern.test(packageRoot)) continue;
    const relative = `${packageRoot}/app/mac-arm64/DevRyan QA.app`;
    const entry = { path: relative, kind: 'qa-app', owner: 'scripts/qa/package-electron.mjs',
      references: references.get(packageRoot) ?? [], reasons: [],
      recovery: 'Rebuild with scripts/qa/package-electron.mjs using the retained web artifact and native donor; historical bytes are not guaranteed reproducible.' };
    entries.push(entry);
    try {
      await confined(root, packageRoot);
      const evidenceFile = await confined(root, `${packageRoot}/package-evidence.json`);
      const evidence = await optionalJson(evidenceFile);
      // Historical provenance still documents a donor needed for reconstruction.
      if (typeof evidence?.nativeSourceApp === 'string') donorPaths.add(evidence.nativeSourceApp);
      await confined(root, `${packageRoot}/${retentionName}`, true);
      const retention = await optionalJson(path.join(root, packageRoot, retentionName));
      if (retention?.payloadState === 'historical' || retention?.payloadState === 'removing') {
        entry.reasons.push('Historical package; executable unavailable'); continue;
      }
      if (!evidence || evidence.schemaVersion !== 1 || evidence.appPath !== path.join(root, relative)
        || evidence.output !== path.join(root, packageRoot)
        || evidence.nativeSmoke?.sqlite !== 'passed' || evidence.nativeSmoke?.pty !== 'passed'
        || !/^[a-f0-9]{64}$/.test(evidence.archiveSha256 ?? '')) throw new Error('Missing or unrecognized completed package provenance');
      entry.identity = await treeIdentity(await confined(root, relative));
      if (await fileHash(path.join(root, relative, 'Contents/Resources/app.asar')) !== evidence.archiveSha256) throw new Error('Package archive differs from provenance');
      entry.evidenceHash = await fileHash(evidenceFile);
      entry.retentionHash = hash(JSON.stringify(retention));
      entry.completedAt = retention?.completedAt ?? new Date((await lstat(evidenceFile)).mtimeMs).toISOString();
      entry.ageEvidence = retention?.completedAt ? 'Explicit package completion' : 'Evidence file timestamp; ordering only, not age eligibility';
      if (!Number.isFinite(Date.parse(entry.completedAt)) || Date.parse(entry.completedAt) > now) throw new Error('Ambiguous completion time');
      if (retention && (retention.schemaVersion !== 1 || retention.payloadState !== 'ready' || retention.pinned !== false)) entry.reasons.push('Retention pin or incomplete metadata');
      if (entry.references.some(ref => ref.required)) entry.reasons.push('Referenced baseline or QA configuration');
      entry.verified = true;
    } catch (error) { entry.reasons.push(isMissing(error) ? 'Missing payload or provenance' : error.message); }
  }
  const newest = entries.filter(entry => entry.verified).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || a.path.localeCompare(b.path)).slice(0, 2);
  for (const entry of newest) entry.reasons.push('One of the two newest verified packages');
  for (const entry of entries) {
    if ([...donorPaths].some(donor => within(path.join(root, entry.path), donor))) entry.reasons.push('Native-module donor');
  }
  for (const relative of buildPaths) {
    const entry = { path: relative, kind: 'cargo-cache', owner: 'Cargo/Tauri build', references: [], reasons: [],
      ageEvidence: 'Newest descendant modification time; minimum 14 days',
      recovery: 'The next locked Cargo build/test regenerates the cache; compilation will be slower.' };
    try {
      await confined(root, 'packages/desktop/src-tauri/Cargo.toml');
      await confined(root, 'packages/desktop/src-tauri/target/.rustc_info.json');
      entry.identity = await treeIdentity(await confined(root, relative));
      if (entry.identity.latestMtimeMs > now - 14 * day) entry.reasons.push('Modified within the last 14 days');
      entries.push(entry);
    } catch (error) { if (!isMissing(error)) { entry.reasons.push(error.message); entries.push(entry); } }
  }
  for (const entry of entries) {
    entry.reasons.push(...activityReasons(root, activityScope(entry), activity));
    if (state.protectedFiles.some(file => within(entry.path, file))) entry.reasons.push('Contains tracked or non-ignored untracked files');
    if (state.worktrees.some(tree => within(tree, path.join(root, entry.path)) || within(path.join(root, entry.path), tree))) entry.reasons.push('Registered worktree is protected');
    try { await run('git', ['check-ignore', '--quiet', '--', entry.path], { cwd: root }); }
    catch { entry.reasons.push('Not a Git-ignored generated path'); }
    entry.eligible = !!entry.identity && entry.reasons.length === 0;
  }
  const protectedAreas = [
    { path: 'node_modules', reason: 'Installed dependencies' },
    { path: 'packages/electron/dist', reason: 'Native donor and release outputs; never bulk-cleaned' },
    { path: 'packages/web/runtime', reason: 'Required Revert runtime' },
    { path: '.tmp', reason: 'Legacy fixtures lack uniform ownership/completion proof; retained' },
    { path: '.cache/plugin-upgrades', reason: 'Dependency snapshots and evidence; age/ownership unresolved' },
    { path: '.cache/revert-runtime-source', reason: 'Companion source and dependencies; outside cleanup allowlist' },
    ...state.worktrees.filter(tree => within(root, tree)).map(tree => ({ path: path.relative(root, tree), reason: 'Registered worktree; preserve source and evidence, never recursively remove' })),
  ];
  const body = { schemaVersion: 1, root, createdAt: new Date(now).toISOString(), policy: 'conservative-v1', entries, protectedAreas,
    eligibleBytes: entries.filter(entry => entry.eligible).reduce((sum, entry) => sum + entry.identity.allocatedBytes, 0) };
  return { ...body, manifestId: hash(JSON.stringify(body)) };
}

export function validateManifest(manifest, root) {
  const { manifestId, ...body } = manifest;
  if (manifest.schemaVersion !== 1 || manifest.root !== root || manifest.policy !== 'conservative-v1'
    || manifestId !== hash(JSON.stringify(body)) || !Array.isArray(manifest.entries)) throw new Error('Invalid or modified storage manifest');
  const targets = manifest.entries.filter(entry => entry.eligible);
  if (targets.some(entry => !recognized(entry.path, entry.kind))) throw new Error('Unrecognized cleanup target');
  for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
    if (within(targets[i].path, targets[j].path) || within(targets[j].path, targets[i].path)) throw new Error('Overlapping cleanup targets');
  }
  return targets;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

export async function applyStorage(manifest, root = repository, adapters = {}) {
  const dependencies = { ...defaults, ...adapters };
  const targets = validateManifest(manifest, root);
  const output = await confined(root, '.cache/storage', true);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = path.join(output, 'apply.lock');
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const report = { schemaVersion: 1, manifestId: manifest.manifestId, startedAt: new Date().toISOString(), results: [] };
  const reportFile = path.join(output, `cleanup-${Date.now()}-${process.pid}.json`);
  try {
    const fresh = await auditStorage(root, { usage: dependencies.usage });
    for (const target of targets) {
      const result = { path: target.path, outcome: 'refused' };
      report.results.push(result);
      try {
        const current = fresh.entries.find(entry => entry.path === target.path);
        if (!current?.eligible || current.identity.fingerprint !== target.identity?.fingerprint
          || current.evidenceHash !== target.evidenceHash || current.retentionHash !== target.retentionHash) throw new Error('Target changed or is now protected; audit again');
        const directory = await confined(root, target.path);
        const state = await gitState(root);
        if (state.protectedFiles.some(file => within(target.path, file))
          || state.worktrees.some(tree => within(tree, directory) || within(directory, tree))) throw new Error('Source or worktree protection changed');
        const scope = target.path.replace(/\/app\/mac-arm64\/DevRyan QA\.app$/, '');
        if (activityReasons(root, activityScope(target), await dependencies.usage(root)).length) throw new Error('Target active or process visibility unavailable');
        if ((await treeIdentity(directory)).fingerprint !== target.identity.fingerprint) throw new Error('Payload changed immediately before deletion');
        let retentionFile, retention;
        if (target.kind === 'qa-app') {
          retentionFile = await confined(root, `${scope}/${retentionName}`, true);
          retention = await optionalJson(retentionFile);
          if (hash(JSON.stringify(retention)) !== target.retentionHash
            || await fileHash(await confined(root, `${scope}/package-evidence.json`)) !== target.evidenceHash) throw new Error('Package evidence or retention changed');
          retention = { ...retention, schemaVersion: 1, pinned: false, payloadState: 'removing', manifestId: manifest.manifestId,
            historicalReason: 'Superseded QA executable removed; original evidence preserved', removedAt: new Date().toISOString() };
          await writeJsonAtomic(retentionFile, retention);
        }
        result.outcome = 'removing';
        await writeJsonAtomic(reportFile, report);
        await dependencies.remove(directory);
        if (retentionFile) await writeJsonAtomic(retentionFile, { ...retention, payloadState: 'historical' });
        result.outcome = 'removed';
        result.allocatedBytes = target.identity.allocatedBytes;
      } catch (error) { result.error = error.message; if (result.outcome === 'removing') result.outcome = 'partial-failure'; }
      await writeJsonAtomic(reportFile, report);
    }
    report.finishedAt = new Date().toISOString();
    report.ok = report.results.every(result => result.outcome === 'removed');
    await writeJsonAtomic(reportFile, report);
    return { ...report, reportFile: path.relative(root, reportFile) };
  } finally { await rm(lock); }
}

export async function storageMain(argv, root = repository) {
  const [command, ...args] = argv;
  if (!['audit', 'clean'].includes(command)) throw new Error('Usage: node scripts/storage.mjs audit|clean [--json|--quiet] [--manifest <new-file>] [--apply <manifest>]');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--json', '--quiet', '--manifest', '--apply'].includes(flag) || options[flag] !== undefined) throw new Error('Invalid or repeated option');
    options[flag] = ['--manifest', '--apply'].includes(flag) ? args[++i] : true;
    if (!options[flag] || String(options[flag]).startsWith('--')) throw new Error('Missing option value');
  }
  if ((options['--apply'] && (command !== 'clean' || options['--manifest'])) || (options['--json'] && options['--quiet'])) throw new Error('Incompatible options');
  let result;
  if (options['--apply']) {
    const file = await confined(root, options['--apply']);
    if (!/^\.cache\/storage\/[A-Za-z0-9._-]+\.json$/.test(options['--apply'])) throw new Error('Manifest input must be a JSON file in .cache/storage');
    result = await applyStorage(await optionalJson(file), root);
  } else {
    result = await auditStorage(root);
    if (options['--manifest']) {
      if (!/^\.cache\/storage\/[A-Za-z0-9._-]+\.json$/.test(options['--manifest'])) throw new Error('Manifest output must be a new JSON file in .cache/storage');
      const file = await confined(root, options['--manifest'], true);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  if (options['--json']) console.log(JSON.stringify(result));
  else if (!options['--quiet']) {
    if (result.entries) {
      console.log(`Preview only: ${(result.eligibleBytes / 2 ** 30).toFixed(2)} GiB eligible`);
      for (const entry of result.entries) console.log(`${entry.eligible ? 'REMOVE' : 'KEEP'} ${entry.path}: ${entry.reasons.join('; ') || 'verified disposable generated payload'}`);
      for (const entry of result.protectedAreas) console.log(`KEEP ${entry.path}: ${entry.reason}`);
    } else console.log(`Cleanup ${result.ok ? 'complete' : 'incomplete'}: ${result.reportFile}`);
  }
  return result.ok === false ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  storageMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    if (process.argv.includes('--json')) console.error(JSON.stringify({ error: error.message }));
    else console.error(error.message);
    process.exitCode = 1;
  });
}

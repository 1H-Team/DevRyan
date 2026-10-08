#!/usr/bin/env node
import { mkdir, readdir, lstat, rm, rename, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activityReasons, activityScope, buildPaths, cacheCitations, classifyUnit, confined, day, defaultMaxBytes, diskStatus,
  familyRegistry, fileHash, gitState, hash, ignoredPaths, keptFailuresPerFamily, keptRebuildables, makeProtection, minimumAgeMs,
  optionalJson, packagePattern, packageReferences, parseSize, processUsage, protectedInputs, readRunMeta, rebuildableGroup,
  recognized, reportOnlyClasses, retentionName, run, scanUnit, treeIdentity, within, worktreeDetails } from './storage-policy.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const defaults = { usage: processUsage, remove: directory => rm(directory, { recursive: true }) };
const isMissing = error => error.code === 'ENOENT';


// Runs that are already small once stripped are cheap evidence: never worth evicting for the budget.
const minEvictionGain = 1024 * 1024;
const recoveryNotes = {
  scratch: 'Disposable test or workflow scratch; the producer recreates it on the next run.',
  'run-evidence': 'Light evidence (JSON, logs, screenshots) is kept; rerun the producer to recreate stripped runtime payloads.',
  session: 'Light session logs are kept; only regenerable payloads are stripped.',
  unowned: 'Not registered to a producer; re-create from the originating task if needed.',
};

// Walk `.cache` once: size every family, classify candidate units under the retention registry and decide
// strip/remove for each. Nothing here deletes; the result is a preview that `applyStorage` re-derives.
async function auditCache(root, { citations, now, usage, state, baseEligibleBytes, maxBytes }) {
  const protection = makeProtection(citations);
  const families = [], records = [], skipped = { young: 0, nothingToStrip: 0, kept: {} };
  let names = [];
  try { await confined(root, '.cache'); names = (await readdir(path.join(root, '.cache'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) { if (!isMissing(error)) throw error; }
  for (const dirent of names) {
    const relative = `.cache/${dirent.name}`;
    const base = familyRegistry(dirent.name);
    const loose = !dirent.isDirectory() && !dirent.isSymbolicLink();
    const family = { name: dirent.name, path: relative, class: loose ? 'unowned' : base.class, owner: loose ? 'unowned: loose file' : base.owner,
      loose, bytes: 0, units: 0, reclaimableBytes: 0 };
    families.push(family);
    if (dirent.isSymbolicLink()) { family.class = 'symlink'; family.owner = 'Symlink; never followed'; continue; }
    const sizeOnly = target => scanUnit(root, target, protection, { detectHeavy: false }).bytes;
    if (reportOnlyClasses.has(base.class)) { family.bytes = sizeOnly(relative); continue; }
    const addUnit = (unit, klass, child) => {
      const scan = scanUnit(root, unit, protection);
      const stat = lstatSync(path.join(root, unit));
      family.bytes += scan.bytes; family.units++;
      records.push({ path: unit, family, name: child ?? dirent.name, klass, scan,
        meta: stat.isDirectory() ? readRunMeta(path.join(root, unit)) : { pinned: false, failed: false, completedMs: null } });
    };
    if (base.class === 'unowned' || !dirent.isDirectory()) { addUnit(relative, { ...base, class: 'unowned' }, undefined); continue; }
    for (const child of (await readdir(path.join(root, relative))).sort()) {
      const unit = `${relative}/${child}`;
      if (packagePattern.test(unit)) { family.bytes += sizeOnly(unit); continue; }
      if (lstatSync(path.join(root, unit)).isSymbolicLink()) continue;
      addUnit(unit, classifyUnit(dirent.name, child), child);
    }
  }
  const basis = record => record.meta.completedMs ?? record.scan.latestMtimeMs;
  const newestFirst = (a, b) => basis(b) - basis(a) || a.path.localeCompare(b.path);
  const failureKeep = new Set(), rebuildableKeep = new Set();
  for (const family of families) {
    const own = records.filter(record => record.family === family);
    own.filter(record => record.meta.failed).sort(newestFirst).slice(0, keptFailuresPerFamily).forEach(record => failureKeep.add(record.path));
    for (const group of new Set(own.map(record => rebuildableGroup(record.name)).filter(Boolean))) {
      own.filter(record => rebuildableGroup(record.name) === group).sort(newestFirst).slice(0, keptRebuildables).forEach(record => rebuildableKeep.add(record.path));
    }
  }
  const potential = [];
  for (const record of records) {
    const minimum = minimumAgeMs[record.klass.class];
    const tooYoung = record.scan.latestMtimeMs > now - day || basis(record) > now - minimum;
    if (tooYoung) { skipped.young++; continue; }
    const reasons = [];
    if (record.meta.pinned) reasons.push('Pinned');
    if (protectedInputs.some(input => within(input, record.path))) reasons.push('Code-read input or cited artifact root');
    if (failureKeep.has(record.path)) reasons.push(`One of the ${keptFailuresPerFamily} most recent failed runs in ${record.family.name}`);
    if (rebuildableKeep.has(record.path)) reasons.push(`One of the ${keptRebuildables} newest packaged outputs of its kind`);
    const wholeAllowed = ['scratch', 'unowned'].includes(record.klass.class) && !protection.blocksRemoval(record.path);
    const absolute = path.join(root, record.path);
    if (state.worktrees.some(tree => within(tree, absolute) || within(absolute, tree))) reasons.push('Registered worktree is protected');
    if (state.protectedFiles.some(file => file.startsWith('.cache/') && within(record.path, file))) reasons.push('Contains tracked or non-ignored untracked files');
    reasons.push(...activityReasons(root, record.path, usage));
    const evictable = !protection.blocksRemoval(record.path) && !reasons.length;
    const kind = wholeAllowed ? 'remove' : 'strip';
    if (!reasons.length && kind === 'strip' && !record.scan.targets.length) { skipped.nothingToStrip++; if (evictable) potential.push({ record, evictable, entry: null }); continue; }
    const targets = kind === 'strip' ? record.scan.targets.map(item => item.path) : undefined;
    const reclaim = kind === 'remove' ? record.scan.bytes : record.scan.targetBytes;
    const entry = { path: record.path, kind, class: record.klass.class, family: record.family.name, owner: record.klass.owner, references: [], reasons,
      ...(targets && { targets }), unitBytes: record.scan.bytes,
      ageEvidence: record.meta.completedMs ? 'Explicit completion time (run.json or storage-retention.json)' : 'Newest descendant modification time',
      recovery: recoveryNotes[record.klass.class],
      identity: { fingerprint: record.scan.fingerprint, allocatedBytes: reclaim, latestMtimeMs: record.scan.latestMtimeMs, files: record.scan.files } };
    potential.push({ record, evictable, entry });
  }
  const checkPaths = potential.map(item => item.record.path);
  const ignored = checkPaths.length ? await ignoredPaths(root, checkPaths) : new Set();
  for (const item of potential) {
    if (ignored.has(item.record.path)) continue;
    item.evictable = false;
    item.entry?.reasons.push('Not a Git-ignored generated path');
  }
  const entries = [];
  for (const item of potential) {
    if (!item.entry) continue;
    item.entry.eligible = item.entry.reasons.length === 0;
    entries.push(item.entry);
    if (!item.entry.eligible) for (const reason of item.entry.reasons) skipped.kept[reason] = (skipped.kept[reason] ?? 0) + 1;
  }
  const totalBytes = families.reduce((sum, family) => sum + family.bytes, 0);
  let projected = totalBytes - baseEligibleBytes - entries.filter(entry => entry.eligible).reduce((sum, entry) => sum + entry.identity.allocatedBytes, 0);
  const evictions = [];
  if (projected > maxBytes) {
    const candidates = potential.filter(item => item.evictable && ['run-evidence', 'session'].includes(item.record.klass.class)
      && (!item.entry || item.entry.eligible) && item.record.scan.bytes - (item.entry?.identity.allocatedBytes ?? 0) >= minEvictionGain)
      .sort((a, b) => basis(a.record) - basis(b.record) || a.record.path.localeCompare(b.record.path));
    for (const item of candidates) {
      if (projected <= maxBytes) break;
      const { record } = item;
      const already = item.entry?.eligible ? item.entry.identity.allocatedBytes : 0;
      const entry = { path: record.path, kind: 'remove', class: record.klass.class, family: record.family.name, owner: record.klass.owner, references: [],
        reasons: [], budget: true, unitBytes: record.scan.bytes,
        ageEvidence: `Oldest eligible run; evicted to meet the ${(maxBytes / 2 ** 30).toFixed(0)} GiB budget`,
        recovery: recoveryNotes[record.klass.class],
        identity: { fingerprint: record.scan.fingerprint, allocatedBytes: record.scan.bytes, latestMtimeMs: record.scan.latestMtimeMs, files: record.scan.files },
        eligible: true };
      projected -= record.scan.bytes - already;
      if (item.entry) entries.splice(entries.indexOf(item.entry), 1, entry); else entries.push(entry);
      evictions.push(record.path);
    }
  }
  const reclaim = new Map();
  for (const entry of entries) if (entry.eligible) reclaim.set(entry.family, (reclaim.get(entry.family) ?? 0) + entry.identity.allocatedBytes);
  for (const family of families) family.reclaimableBytes = reclaim.get(family.name) ?? 0;
  return { entries, families, skipped, totalBytes, evictions, budgetProjectedBytes: Math.max(0, projected + baseEligibleBytes) };
}

export async function auditStorage(root = repository, { usage = defaults.usage, now = Date.now(), maxBytes = defaultMaxBytes } = {}) {
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
      if (entry.identity.latestMtimeMs > now - day) entry.reasons.push('Modified within the last 24 hours');
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
  const baseEligibleBytes = entries.filter(entry => entry.eligible).reduce((sum, entry) => sum + entry.identity.allocatedBytes, 0);
  const cache = await auditCache(root, { citations: await cacheCitations(root), now, usage: activity, state, baseEligibleBytes, maxBytes });
  entries.push(...cache.entries);
  const worktrees = await worktreeDetails(root);
  const protectedAreas = [
    { path: 'node_modules', reason: 'Installed dependencies' },
    { path: 'packages/electron/dist', reason: 'Native donor and release outputs; never bulk-cleaned' },
    { path: 'packages/web/runtime', reason: 'Required Revert runtime' },
    { path: '.tmp', reason: 'Legacy fixtures lack uniform ownership/completion proof; retained' },
    { path: '.cache/plugin-upgrades', reason: 'Dependency snapshots and evidence; age/ownership unresolved' },
    ...state.worktrees.filter(tree => within(root, tree)).map(tree => ({ path: path.relative(root, tree), reason: 'Registered worktree; preserve source and evidence, never recursively remove' })),
  ];
  const body = { schemaVersion: 1, root, createdAt: new Date(now).toISOString(), policy: 'conservative-v1', entries, protectedAreas,
    families: cache.families, worktrees, skipped: cache.skipped, totalBytes: cache.totalBytes, maxBytes, evictions: cache.evictions,
    freeBytes: diskStatus(root).freeBytes,
    eligibleBytes: entries.filter(entry => entry.eligible).reduce((sum, entry) => sum + entry.identity.allocatedBytes, 0) };
  return { ...body, manifestId: hash(JSON.stringify(body)) };
}

export function validateManifest(manifest, root) {
  const { manifestId, ...body } = manifest;
  if (manifest.schemaVersion !== 1 || manifest.root !== root || manifest.policy !== 'conservative-v1'
    || manifestId !== hash(JSON.stringify(body)) || !Array.isArray(manifest.entries)) throw new Error('Invalid or modified storage manifest');
  const targets = manifest.entries.filter(entry => entry.eligible);
  if (targets.some(entry => !recognized(entry.path, entry.kind, entry))) throw new Error('Unrecognized cleanup target');
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
    const fresh = await auditStorage(root, { usage: dependencies.usage, now: dependencies.now, maxBytes: manifest.maxBytes ?? defaultMaxBytes });
    for (const target of targets) {
      const result = { path: target.path, outcome: 'refused' };
      report.results.push(result);
      try {
        const current = fresh.entries.find(entry => entry.path === target.path && entry.kind === target.kind);
        if (!current?.eligible || current.identity.fingerprint !== target.identity?.fingerprint
          || current.evidenceHash !== target.evidenceHash || current.retentionHash !== target.retentionHash
          || JSON.stringify(current.targets) !== JSON.stringify(target.targets)) throw new Error('Target changed or is now protected; audit again');
        const directory = await confined(root, target.path);
        const cacheUnit = target.kind === 'remove' || target.kind === 'strip';
        const state = await gitState(root);
        if (state.protectedFiles.some(file => within(target.path, file))
          || state.worktrees.some(tree => within(tree, directory) || within(directory, tree))) throw new Error('Source or worktree protection changed');
        const scope = target.path.replace(/\/app\/mac-arm64\/DevRyan QA\.app$/, '');
        if (activityReasons(root, activityScope(target), await dependencies.usage(root)).length) throw new Error('Target active or process visibility unavailable');
        const identity = cacheUnit ? scanUnit(root, target.path, makeProtection(await cacheCitations(root))) : await treeIdentity(directory);
        if (identity.fingerprint !== target.identity.fingerprint) throw new Error('Payload changed immediately before deletion');
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
        if (target.kind === 'strip') for (const item of target.targets) await dependencies.remove(await confined(root, item));
        else await dependencies.remove(directory);
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

const GiB = bytes => `${(bytes / 2 ** 30).toFixed(2)} GiB`;
const table = (rows, columns) => {
  const widths = columns.map(([title, get]) => Math.max(title.length, ...rows.map(row => String(get(row)).length)));
  const line = cells => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map(([title]) => title)), ...rows.map(row => line(columns.map(([, get]) => get(row))))].join('\n');
};

export function renderReport(result) {
  const lines = [`.cache usage: ${GiB(result.totalBytes)} of ${GiB(result.maxBytes)} budget${result.totalBytes > result.maxBytes ? ' (OVER BUDGET)' : ''}`
    + `; free disk ${result.freeBytes === null ? 'unknown' : GiB(result.freeBytes)}`];
  const loose = result.families.filter(family => family.loose);
  const rows = result.families.filter(family => !family.loose);
  if (loose.length) rows.push({ name: `(${loose.length} loose root files)`, class: 'unowned', owner: 'unowned: write session logs under .cache/sessions/',
    bytes: loose.reduce((sum, row) => sum + row.bytes, 0), reclaimableBytes: loose.reduce((sum, row) => sum + row.reclaimableBytes, 0), units: loose.length });
  rows.sort((a, b) => b.bytes - a.bytes);
  lines.push(table(rows, [['FAMILY', row => row.name], ['CLASS', row => row.class], ['SIZE', row => GiB(row.bytes)],
    ['RECLAIM', row => GiB(row.reclaimableBytes)], ['UNITS', row => row.units], ['OWNER', row => row.owner.length > 70 ? `${row.owner.slice(0, 67)}...` : row.owner]]));
  lines.push(`Policy preview reclaims ${GiB(result.eligibleBytes)}${result.evictions.length ? ` (${result.evictions.length} run(s) evicted for the budget)` : ''}; `
    + `${result.skipped.young} unit(s) too recent. Preview with \`bun run cache:prune\`.`);
  if (result.worktrees.length) {
    lines.push('Worktrees (report only; this tool never removes them):');
    for (const tree of result.worktrees) lines.push(`  ${tree.path}: ${tree.note}${tree.advice ? `\n    suggest: ${tree.advice}` : ''}`);
  }
  return lines.join('\n');
}

export async function storageMain(argv, root = repository) {
  const [command, ...args] = argv;
  const usage = 'Usage: node scripts/storage.mjs report|audit|clean [--json|--quiet] [--max-size <N>G] [--manifest <new-file>] [--apply [manifest]]';
  if (!['report', 'audit', 'clean'].includes(command)) throw new Error(usage);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--json', '--quiet', '--manifest', '--apply', '--max-size'].includes(flag) || options[flag] !== undefined) throw new Error('Invalid or repeated option');
    if (flag === '--apply' && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) { options[flag] = true; continue; }
    options[flag] = ['--manifest', '--apply', '--max-size'].includes(flag) ? args[++i] : true;
    if (!options[flag] || String(options[flag]).startsWith('--')) throw new Error('Missing option value');
  }
  if ((options['--apply'] && (command !== 'clean' || options['--manifest'])) || (options['--manifest'] && command === 'report')
    || (options['--json'] && options['--quiet'])) throw new Error('Incompatible options');
  const maxBytes = options['--max-size'] ? parseSize(options['--max-size']) : defaultMaxBytes;
  let result;
  if (options['--apply']) {
    if (options['--apply'] === true) result = await applyStorage(await auditStorage(root, { maxBytes }), root);
    else {
      if (options['--max-size']) throw new Error('Incompatible options');
      const file = await confined(root, options['--apply']);
      if (!/^\.cache\/storage\/[A-Za-z0-9._-]+\.json$/.test(options['--apply'])) throw new Error('Manifest input must be a JSON file in .cache/storage');
      result = await applyStorage(await optionalJson(file), root);
    }
  } else {
    result = await auditStorage(root, { maxBytes });
    if (options['--manifest']) {
      if (!/^\.cache\/storage\/[A-Za-z0-9._-]+\.json$/.test(options['--manifest'])) throw new Error('Manifest output must be a new JSON file in .cache/storage');
      const file = await confined(root, options['--manifest'], true);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  if (options['--json']) console.log(JSON.stringify(result));
  else if (!options['--quiet']) {
    if (command === 'report') console.log(renderReport(result));
    else if (result.entries) {
      console.log(`Preview only: ${GiB(result.eligibleBytes)} eligible (.cache ${GiB(result.totalBytes)}, budget ${GiB(result.maxBytes)})`);
      const eligible = result.entries.filter(entry => entry.eligible);
      const kept = new Map();
      for (const entry of result.entries.filter(item => !item.eligible)) for (const reason of entry.reasons) kept.set(reason, (kept.get(reason) ?? 0) + 1);
      const groups = new Map();
      for (const entry of eligible) {
        const key = `${entry.kind === 'strip' ? 'STRIP' : 'REMOVE'} ${entry.family ?? entry.kind} [${entry.class ?? entry.kind}]`;
        const group = groups.get(key) ?? { count: 0, bytes: 0 };
        group.count++; group.bytes += entry.identity.allocatedBytes;
        groups.set(key, group);
      }
      for (const [key, group] of groups) console.log(`${key}: ${group.count} entr${group.count === 1 ? 'y' : 'ies'}, ${GiB(group.bytes)}`);
      console.log('Largest selections (full list: --json or --manifest):');
      for (const entry of [...eligible].sort((a, b) => b.identity.allocatedBytes - a.identity.allocatedBytes).slice(0, 12)) {
        console.log(`  ${entry.kind === 'strip' ? 'STRIP' : 'REMOVE'} ${entry.path}: ${GiB(entry.identity.allocatedBytes)}`
          + `${entry.targets ? `, ${entry.targets.length} heavy target(s)` : ''}${entry.budget ? ', budget eviction' : ''}`);
      }
      for (const [reason, count] of kept) console.log(`KEEP ${count} entr${count === 1 ? 'y' : 'ies'}: ${reason}`);
      console.log(`KEEP ${result.skipped.young} unit(s): too recent for their class (24 h minimum)`);
      for (const entry of result.protectedAreas) console.log(`KEEP ${entry.path}: ${entry.reason}`);
      for (const tree of result.worktrees) console.log(`WORKTREE ${tree.path}: ${tree.note}${tree.advice ? ` (suggest: ${tree.advice})` : ''}`);
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

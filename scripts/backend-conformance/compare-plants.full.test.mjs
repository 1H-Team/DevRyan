// Planted faults in the comparer itself (BH3; full suite and CI only, by its
// name): each is an anchored, exactly-once replacement in a copy of
// compare.mjs, run with a copy of its self-test (compare.test.mjs) in a
// scratch directory of its own; the self-test must exit 1 for every plant and
// 0 for the unchanged copy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { onceFinished } from './child-finish.mjs';
import { createBackendRun } from './run-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPARER = 'compare.mjs';
const SELF_TEST = 'compare.test.mjs';
const CHILD_MS = 300_000;

/** Each plant: what it breaks, and the replacement (found exactly once in the comparer). */
export const COMPARER_PLANTS = Object.freeze([
  { id: 'status-ignored', find: "  if (left.status !== right.status) ctx.differ('status', 'status', 'bytes', left.status, right.status);", replace: '' },
  { id: 'body-always-equal', find: '  if (Buffer.compare(left, right) === 0) return true;', replace: '  if (left) return true;' },
  { id: 'root-substituted-inside-text', find: '    return beforeOk && afterOk;', replace: '    return beforeOk || afterOk || true;' },
  { id: 'alias-spelling-dropped', find: "      for (const form of ['given', 'canonical', 'alias']) {", replace: "      for (const form of ['given', 'canonical']) {" },
  { id: 'pairing-conflict-overwritten', find: '    if (forward.has(a) || backward.has(b)) { conflicts.push(', replace: '    if (false) { conflicts.push(' },
  { id: 'time-rank-dropped', find: 'item.label = `<time ${item.window} #${ranked.indexOf(item.value) + 1} of ${ranked.length}>`;', replace: 'item.label = `<time ${item.window}>`;' },
  { id: 'etag-by-length', find: "      if (!isDeepStrictEqual(left.values, right.values)) ctx.differ(component, 'value', 'etag'", replace: "      if (left.values.join().length !== right.values.join().length) ctx.differ(component, 'value', 'etag'" },
  { id: 'mode-ignored', find: '    if (a.mode !== b.mode) ctx.differ(', replace: '    if (false) ctx.differ(' },
  { id: 'replaced-ignored', find: "    for (const field of ['replaced', 'removed']) {\n      const x = strip(a[field]).sort();", replace: "    for (const field of []) {\n      const x = strip(a[field]).sort();" },
  { id: 'listing-order-ignored', find: '    if (!isDeepStrictEqual(a, b) && a.length === b.length', replace: '    if (false && a.length === b.length' },
  { id: 'null-equals-absent', find: "      if (!Object.hasOwn(b, key)) return { where: `${where}.${key}`, reference: `${tagOf(a, key)} ${shown(a[key])}`, candidate: 'absent' };", replace: "      if (!Object.hasOwn(b, key)) { if (a[key] === null || a[key] === undefined) continue; return { where: `${where}.${key}`, reference: `${tagOf(a, key)} ${shown(a[key])}`, candidate: 'absent' }; }" },
  { id: 'every-concurrent-result-admissible', find: '    if (found.differences.length === 0 && found.inconclusive.length === 0) {', replace: '    if (true) {' },
  { id: 'content-length-unchecked', find: "  const line = headers.get('content-length');\n  if (!line) return;", replace: "  const line = headers.get('content-length');\n  if (line || !line) return;" },
  { id: 'stream-count-ignored', find: "    if (left.length !== right.length) ctx.differ('stream(count)'", replace: "    if (false) ctx.differ('stream(count)'" },
  { id: 'edge-file-from-candidate-allowed', find: "      if (ctx.mode === 'candidate' && b) ctx.differ(component,", replace: "      if (false && b) ctx.differ(component," },
  { id: 'last-writer-ignored', find: '    for (const name of new Set([...a, ...b])) if (a.has(name) !== b.has(name)) ctx.differ(`tree.${name}.lastWriter`', replace: '    for (const name of new Set([...a, ...b])) if (false) ctx.differ(`tree.${name}.lastWriter`' },
  { id: 'extra-header-allowed', find: "    if (!left) { ctx.differ(component, ctx.mode === 'candidate'", replace: "    if (!left) { continue; ctx.differ(component, ctx.mode === 'candidate'" },
  { id: 'request-body-unchecked', find: "  if (Buffer.compare(ctx.substitution.apply(groupBody), body) !== 0) ctx.differ('request.body'", replace: "  if (false) ctx.differ('request.body'" },
  // The fix round's own rules (S1, S5, S6, M1, M2 of the BH3/BH4 review).
  { id: 'effects-unobserved-silent', find: "    ctx.unsure('effects', 'the candidate arm was not run under observation", replace: "    if (false) ctx.unsure('effects', 'the candidate arm was not run under observation" },
  { id: 'outside-view-ignored', find: '      const found = deepDifference(a, outside ? outsideView(kind, right[index]) : view(right[index]));', replace: '      const found = outside ? null : deepDifference(a, view(right[index]));' },
  { id: 'unread-body-trusted', find: "    if (Buffer.compare(ctx.substitution.apply(referenceSent), body) !== 0) ctx.differ('request.body'", replace: "    if (false) ctx.differ('request.body'" },
  { id: 'prefix-unchecked', find: '  if (seen.length > sent.length || Buffer.compare(seen, sent.subarray(0, seen.length)) !== 0) return', replace: '  if (false) return' },
  { id: 'unread-body-stability-raw', find: '  if (tapA.request?.bodyComplete !== false && tapB.request?.bodyComplete !== false) {', replace: '  if (true) {' },
  { id: 'root-mode-ignored', find: '    if (a !== b) ctx.differ(`tree.${prefix}(root).mode`', replace: '    if (false) ctx.differ(`tree.${prefix}(root).mode`' },
  { id: 'date-presence-ignored', find: "  if (wire && wire.transport.has('date') !== right.transport.has('date')) ctx.differ(", replace: '  if (false) ctx.differ(' },
  { id: 'mtime-lag-unbounded', find: '!(entry.mtimeMs >= span.start - granularity &&', replace: '!(entry.mtimeMs >= span.start - granularity - 1e9 &&' },
  // The 34 weakened copies of the BH3/BH4 review (reports/BH34-review-probes/review-comparer-plants.mjs), each as the reviewer wrote it.
  { id: 'key-order-ignored', review: true, pair: ["    if (!isDeepStrictEqual(Object.keys(a), Object.keys(b))) return { where: `${where}(key order)`", "    if (false) return { where: `${where}(key order)`"] },
  { id: 'number-loose-equal', review: true, pair: ['  return Object.is(a, b) ? null :', '  return a == b ? null :'] },
  { id: 'date-always-in-window', review: true, pair: ['  return at >= Math.floor(t0 / 1000) * 1000 && at <= t1;', '  return true;'] },
  { id: 'missing-supplied-value-ignored', review: true, pair: ["    if (!other) { problems.push(`supplied value ${entry.name} is in one arm only`); continue; }", '    if (!other) continue;'] },
  { id: 'shared-root-ignored', review: true, pair: ["      if (a.given === b.given || (a.canonical && a.canonical === b.canonical)) problems.push(", '      if (false) problems.push('] },
  { id: 'request-method-ignored', review: true, pair: ["  if (tap.entry?.method !== sent.method) ctx.differ(", '  if (false) ctx.differ('] },
  { id: 'request-url-ignored', review: true, pair: ["  if (ctx.substitution.applyText(tap.entry?.url ?? '') !== sent.target) ctx.differ(", '  if (false) ctx.differ('] },
  { id: 'request-headers-ignored', review: true, pair: ["  if (found) ctx.differ('request.headers'", "  if (false) ctx.differ('request.headers'"] },
  { id: 'effects-count-ignored', review: true, pair: ["    if (left.length !== right.length) ctx.differ(`${kind}(count)`", '    if (false) ctx.differ(`${kind}(count)`'] },
  { id: 'effects-declared-none-ignored', review: true, pair: ["      if (left.length && !canCause) ctx.differ(kind,", '      if (false) ctx.differ(kind,'] },
  { id: 'incomplete-candidate-ignored', review: true, pair: ["  if (!right.complete) ctx.differ('body',", "  if (false) ctx.differ('body',"] },
  { id: 'list-elements-unordered', review: true, pair: ['    values.forEach((value, index) => { if (value !== right.values[index])', '    values.forEach((value, index) => { if (!right.values.includes(value))'] },
  { id: 'symlink-target-ignored', review: true, pair: ["    if (a.type === 'symlink' && ctx.substitution.applyText(a.target) !== b.target)", "    if (false)"] },
  { id: 'type-change-ignored', review: true, pair: ["    if (a.type !== b.type) { ctx.differ(`${component}.type`, moment, 'inode', a.type, b.type); continue; }", '    if (a.type !== b.type) continue;'] },
  { id: 'unstable-snapshot-trusted', review: true, pair: ["  if (referenceTree.stable === false || otherTree.stable === false) { ctx.unsure(", "  if (false) { ctx.unsure("] },
  { id: 'unkept-bytes-trusted', review: true, pair: ["        if (a.sha256 !== b.sha256 || a.size !== b.size) ctx.unsure(", "        if (false) ctx.unsure("] },
  { id: 'stream-partial-ignored', review: true, pair: ["  if ((referenceStep.partial ?? '') !== (otherStep.partial ?? '')) ctx.differ(", '  if (false) ctx.differ('] },
  { id: 'stream-ended-ignored', review: true, pair: ["  if (Boolean(referenceStep.endedBeforeClose) !== Boolean(otherStep.endedBeforeClose)) ctx.differ(", '  if (false) ctx.differ('] },
  { id: 'no-serialisations-passes', review: true, pair: ["  if (!Array.isArray(serials) || serials.length === 0) { ctx.unsure('concurrency',", "  if (!Array.isArray(serials) || serials.length === 0) { return; ctx.unsure('concurrency',"] },
  { id: 'scenario-values-ignored', review: true, pair: ["  if (valuesDiffer) ctx.differ('values'", "  if (false) ctx.differ('values'"] },
  { id: 'step-ids-ignored', review: true, pair: ["    if (!partner) { ctx.step = step.id; ctx.differ('step', 'presence'", "    if (!partner) { continue; ctx.differ('step', 'presence'"] },
  { id: 'mtime-window-ignored', review: true, pair: ['      if (entry && entry.type === \'file\' && Number.isFinite(span.start)', '      if (false && entry && entry.type === \'file\' && Number.isFinite(span.start)'] },
  { id: 'startup-file-change-ignored', review: true, pair: ["    for (const item of found.startupChanged) {", '    for (const item of []) {'] },
  { id: 'stability-tap-kind-ignored', review: true, pair: ["  if (tapA.kind !== tapB.kind) { ctx.differ('tap.kind'", "  if (false) { ctx.differ('tap.kind'"] },
  { id: 'stability-entry-ignored', review: true, pair: ["    compareValue(ctx, 'entry', 'request',", "    if (false) compareValue(ctx, 'entry', 'request',"] },
  { id: 'stability-owners-ignored', review: true, pair: ["    compareValue(ctx, 'headers(owners)', 'headers',", "    if (false) compareValue(ctx, 'headers(owners)', 'headers',"] },
  { id: 'kill-signal-ignored', review: true, pair: ["      if (a.exit?.signal !== b.exit?.signal) ctx.differ('kill(exit)', 'signal', 'steps', a.exit?.signal, b.exit?.signal);\n      continue;", '      continue;'] },
  { id: 'reference-unsent-silent', review: true, pair: ["      ctx.unsure(`exchange ${key}`, `the reference did not make this exchange: ${a.notSent}`);", ''] },
  { id: 'stream-head-status-ignored', review: true, pair: ["    if (a?.status !== b?.status) ctx.differ('stream.status'", "    if (false) ctx.differ('stream.status'"] },
  { id: 'time-outside-window-labelled', review: true, pair: ['  const windowOf = (value) => windows.find((window) => value >= window.start && value <= window.end) ?? null;', '  const windowOf = (value) => windows[0] ?? null;'] },
  { id: 'stability-complete-ignored', review: true, pair: ["  if (Boolean(left.complete) !== Boolean(right.complete)) ctx.differ('response(complete)'", "  if (false) ctx.differ('response(complete)'"] },
  { id: 'candidate-not-given-silent', review: true, pair: ["      if (b.notSent !== undefined) { ctx.unsure(`exchange ${key}`, `the candidate was not given this exchange: ${b.notSent}`); return; }", '      if (b.notSent !== undefined) return;'] },
  { id: 'pairing-single-use-note-dropped', review: true, pair: ["  for (const [a] of ctx.pairing.pairs()) if ((ctx.pairing.uses.get(a) ?? 0) <= 1) ctx.note(", '  for (const [a] of []) if (true) ctx.note('] },
  { id: 'substitution-inside-name', review: true, pair: ["    const afterOk = end === text.length || after === '/' || text.slice(end, end + 3).toUpperCase() === '%2F' || !NAME_CHAR.test(after);", '    const afterOk = true;'] },
]);

function runSelfTest(dir) {
  // A test run inside a test file skips its files unless the child is told it is not a nested run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', path.join(dir, SELF_TEST)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, CHILD_MS);
    onceFinished(child, (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

test('every planted fault in the comparer fails its self-test (exit 1); the unchanged copy passes (exit 0)', { timeout: 900_000 }, async (t) => {
  assert.ok(COMPARER_PLANTS.length >= 12);
  const run = createBackendRun({ owner: 'backend-conformance-compare-plants', signals: 'exit' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* finished */ } });
  const source = fs.readFileSync(path.join(HERE, COMPARER), 'utf8');
  const copy = (id, text) => {
    const dir = run.makeDirectory(`comparer-plants/${id}`);
    fs.writeFileSync(path.join(dir, COMPARER), text);
    fs.copyFileSync(path.join(HERE, SELF_TEST), path.join(dir, SELF_TEST));
    return dir;
  };
  const jobs = [{ id: 'unchanged', text: source, expect: 0 }, ...COMPARER_PLANTS.map((plant) => {
    const [find, replace] = plant.pair ?? [plant.find, plant.replace];
    const count = source.split(find).length - 1;
    assert.equal(count, 1, `plant ${plant.id}: its anchor is found ${count} times in the comparer`);
    return { id: plant.id, text: source.replace(find, replace), expect: 1 };
  })];
  const results = [];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) results.push({ ...job, ...(await runSelfTest(copy(job.id, job.text))) });
  }));
  t.diagnostic(results.map((result) => `${result.id}: exit ${result.code ?? result.signal} (expected ${result.expect})`).join('\n'));
  for (const result of results) assert.equal(result.code, result.expect, `${result.id}: exit ${result.code ?? result.signal}\n${result.output.slice(-3000)}`);
  // The unchanged copy really ran the self-test (a skipped run also exits 0).
  assert.match(results.find((result) => result.id === 'unchanged').output, /^ℹ pass (\d{2,})$/m);
  for (const result of results.filter((item) => item.expect === 1)) assert.match(result.output, /^ℹ fail [1-9]\d*$/m, result.id);
  status = 'passed';
});

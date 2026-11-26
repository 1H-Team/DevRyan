// The census bites on real recordings (BH5; full suite and CI only, by its
// name): two small scenarios of the pilot recorded on the real group host
// with block coverage, served from a copy of the group's files, once as they
// are and once with a route and a branch planted in the copy. With every row
// claimed passed (the census must not take a row's word for what ran), the
// planted route and branch are gaps by name; without one scenario, the items
// it alone exercised are gaps by name. The planted copy also has the two
// answers V8 counts as run when they are not (fix round 1 of BH5, S3): an
// answer after a call that throws, and the answer of an awaited rejection;
// the census never credits them, though V8 counted their blocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { referenceArm } from './arms.mjs';
import { judgeCensus, probeExecuted, withoutScenario } from './coverage-census.mjs';
import { interruptTeardown, runScenario } from './driver.mjs';
import { REPOSITORY_ROOT } from './edge.mjs';
import { GROUPS } from './groups.mjs';
import { judgeRun } from './outcomes.mjs';
import { createBackendRun } from './run-scratch.mjs';
import { censusInput } from './scenario-rows.mjs';
import { PRINCIPALS, defineScenario, jsonBody, step } from './scenario.mjs';
import { copiedGroup, groupDirectory } from './toy/copy-groups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = path.join(HERE, 'toy', 'copy-groups.mjs');
const NAME = 'magic-prompts';
const BASE = '/api/magic-prompts';
const principals = { 'local-admin': PRINCIPALS['local-admin'] };
const get = () => ({ method: 'GET', target: BASE, principal: 'local-admin' });
const put = (id, text) => ({ method: 'PUT', target: `${BASE}/${id}`, headers: [['Content-Type', 'application/json']], body: jsonBody({ text }), principal: 'local-admin' });
const READS = defineScenario({ id: 'magic-prompts.bite-reads', group: NAME, principals, fixture: () => {}, steps: (v) => [
  step.exchange('get-empty', get()),
  step.exchange('put-valid', put(v.id('id.visible', 'git.pr.generate.visible'), v.text('text.first', 'first'))),
  step.exchange('put-invalid', put(v.id('id.161', 'b'.repeat(161)), v.text('text.first', 'first'))),
  step.exchange('get-after', get()),
] });
const DELETES = defineScenario({ id: 'magic-prompts.bite-deletes', group: NAME, principals, fixture: () => {}, steps: (v) => [
  step.exchange('put-valid', put(v.id('id.visible', 'git.pr.generate.visible'), v.text('text.first', 'first'))),
  step.exchange('delete-one', { method: 'DELETE', target: `${BASE}/${v.id('id.visible', 'git.pr.generate.visible')}`, principal: 'local-admin' }),
  step.exchange('delete-all', { method: 'DELETE', target: BASE, principal: 'local-admin' }),
] });
const THROWS = defineScenario({ id: 'magic-prompts.bite-throws', group: NAME, principals, fixture: () => {}, steps: (v) => [
  step.exchange('post-not-json', { method: 'POST', target: `${BASE}/planted-parse`, headers: [['Content-Type', 'application/json']], body: jsonBody({ text: v.text('text.not-json', '{') }), principal: 'local-admin' }),
  step.exchange('get-missing', { method: 'GET', target: `${BASE}/planted-read`, principal: 'local-admin' }),
] });
/** Routes and a branch, each an exactly-once insertion into the copy of routes.js. */
const PLANTED_ROUTES = `  app.get('/api/magic-prompts/planted', async (_req, res) => {
    res.json({ planted: true });
  });

  app.post('/api/magic-prompts/planted-parse', async (req, res) => {
    try {
      const value = JSON.parse(req.body.text); return res.status(201).json({ value });
    } catch {
      return res.status(500).json({ error: 'planted parse' });
    }
  });

  app.get('/api/magic-prompts/planted-read', async (_req, res) => {
    try {
      return res.json(await fsPromises.readFile(path.join(devryanDataDir, 'planted-missing.json'), 'utf8'));
    } catch {
      return res.status(500).json({ error: 'planted read' });
    }
  });

`;
const PLANTS = [
  { find: "  app.put('/api/magic-prompts/:id', async (req, res) => {", insert: PLANTED_ROUTES, before: true },
  { find: "      return res.status(400).json({ error: 'text is required' });\n    }\n", insert: "    if (text === 'planted') {\n      return res.status(418).json({ error: 'planted' });\n    }\n" },
];

/** Copies the group's files into `dir`, planting when asked; returns the group entry served from the copy. */
function copyGroup(dir, planted) {
  const real = GROUPS[NAME];
  const base = groupDirectory(real.files);
  for (const file of real.files) {
    let text = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
    if (planted && path.basename(file) === 'routes.js') for (const plant of PLANTS) {
      assert.equal(text.split(plant.find).length - 1, 1, `the plant's anchor is found once: ${plant.find}`);
      text = text.replace(plant.find, plant.before ? `${plant.insert}${plant.find}` : `${plant.find}${plant.insert}`);
    }
    fs.writeFileSync(path.join(dir, path.posix.relative(base, file)), text, { mode: 0o600 });
  }
  return copiedGroup({ name: NAME, dir });
}

/** The two scenarios on the reference with coverage, from the copy; every row claimed passed. */
async function recordCopy(run, label, planted) {
  const dir = run.makeDirectory(`${label}/group`);
  const group = copyGroup(dir, planted);
  const env = { ...process.env, DEVRYAN_BACKEND_GROUP_COPY: JSON.stringify({ name: NAME, dir }) };
  const recordings = [];
  for (const scenario of planted ? [READS, DELETES, THROWS] : [READS, DELETES]) {
    const arm = referenceArm({ run, name: NAME, group, table: TABLE, label: `${label}/${scenario.id}`, env, coverage: true });
    const recording = await runScenario({ scenario, arm, run, label: `${label}/${scenario.id}` });
    const problems = [recording.setup, ...recording.steps].flatMap((result) => result.problems.map((entry) => `${result.id}: ${entry.check}: ${entry.text}`));
    assert.deepEqual(problems, [], `${label} ${scenario.id}`);
    recordings.push({ scenario: scenario.id, recording });
  }
  const rows = recordings.flatMap(({ scenario, recording }) => [...recording.steps.map((result) => ({ id: `${scenario}/${result.id}`, outcome: 'passed', checks: [], differences: [], whole: false })), { id: `${scenario}/recording`, outcome: 'passed', checks: [], differences: [], whole: true }]);
  return censusInput({ name: NAME, group, recordings, rows: judgeRun({ rows }).rows, waivers: {} });
}

test('the census names a planted route and branch as gaps, and the items a dropped scenario alone exercised', { timeout: 600_000 }, async (t) => {
  const run = createBackendRun({ owner: 'backend-conformance-census-bites', signals: 'exit' });
  let status = 'failed';
  t.after(async () => { await interruptTeardown(); try { run.finish(status); } catch { /* finished */ } });
  const [unchanged, planted] = await Promise.all([recordCopy(run, 'unchanged', false), recordCopy(run, 'planted', true)]);
  const asIs = judgeCensus(unchanged);
  const withPlants = judgeCensus(planted);
  assert.deepEqual(asIs.problems, []);
  assert.deepEqual(withPlants.problems, []);
  const statusOf = (census, id) => census.items.find((item) => item.id === id)?.status ?? 'absent';
  const plantedBranch = withPlants.items.find((item) => item.id.endsWith(":then if (text === 'planted')"));
  assert.ok(plantedBranch, 'the planted branch is an item');
  t.diagnostic(withPlants.gaps.filter((gap) => /planted/.test(gap)).join('\n'));
  // The planted route and branch: gaps by name, though every row claims it passed; absent from the unchanged copy.
  for (const id of ['route GET /api/magic-prompts/planted', 'routes.js:registerMagicPromptRoutes>GET /api/magic-prompts/planted handler:function GET /api/magic-prompts/planted handler', plantedBranch.id]) {
    assert.equal(statusOf(withPlants, id), 'gap', id);
    assert.ok(withPlants.gaps.some((gap) => gap.includes(id)), id);
    assert.equal(statusOf(asIs, id), 'absent', id);
  }
  // V8 counted the blocks of both planted answers in the exchanges that threw or rejected; the census credits neither.
  const handler = 'routes.js:registerMagicPromptRoutes>';
  const created = `${handler}POST /api/magic-prompts/planted-parse handler:answer res.status(201).json({ value })`;
  const read = `${handler}GET /api/magic-prompts/planted-read handler:answer res.json(await fsPromises.readFile(`;
  const readItem = planted.items.find((item) => item.id.startsWith(read));
  assert.ok(readItem, 'the planted read answer is an item');
  const throwsRecording = planted.recordings.find((entry) => entry.scenario === THROWS.id).recording;
  for (const [id, stepId] of [[created, 'post-not-json'], [readItem.id, 'get-missing']]) {
    const item = planted.items.find((entry) => entry.id === id);
    const record = throwsRecording.steps.find((entry) => entry.id === stepId).exchanges[0];
    assert.equal(record.tap.response.status, 500, stepId);
    const take = throwsRecording.coverage.find((entry) => entry.process === record.process && entry.seq === record.armSeq);
    assert.equal(probeExecuted(take, item), true, `V8 counted the block of ${id}`);
    assert.equal(statusOf(withPlants, id), 'gap', id);
  }
  for (const id of [`${handler}POST /api/magic-prompts/planted-parse handler:answer res.status(500).json({ error: 'planted parse' })`, `${handler}GET /api/magic-prompts/planted-read handler:answer res.status(500).json({ error: 'planted read' })`]) assert.equal(statusOf(withPlants, id), 'exercised', id);
  // What both scenarios ran is exercised in both copies (the plants changed nothing else).
  for (const [id, expected] of [['route PUT /api/magic-prompts/:id', 'exercised'], ["runtime.js:createMagicPromptRuntime>setOverride:throw new Error('Invalid prompt id')", 'exercised'], ['routes.js:registerMagicPromptRoutes>PUT /api/magic-prompts/:id handler:then if (text === null)', 'gap']]) {
    assert.equal(statusOf(asIs, id), expected, id);
    assert.equal(statusOf(withPlants, id), expected, id);
  }
  // Without the deletes scenario, the items it alone exercised are gaps, each by name.
  const sole = asIs.sole[DELETES.id];
  assert.ok(sole.includes('route DELETE /api/magic-prompts'), sole.join('\n'));
  assert.ok(sole.includes('runtime.js:createMagicPromptRuntime>resetAllOverrides:function resetAllOverrides'));
  const without = judgeCensus(withoutScenario(unchanged, DELETES.id));
  for (const id of sole) assert.equal(statusOf(without, id), 'gap', id);
  assert.equal(without.gaps.length, asIs.gaps.length + sole.length);
  status = 'passed';
});

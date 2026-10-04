import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { expandQaMatrix, loadQaMatrixConfig, validateQaMatrixConfig } from './matrix-config.mjs';

const config = () => ({ schemaVersion: 1, evidenceRoot: '.cache/qa/matrix-test', cells: [{
  id:'openai-builder-plan', runtime:'electron', transport:'live', providerId:'openai', modelId:'gpt-configured',
  agent:'builder', planMode:true, variant:null, scenarioIds:['project-work','compaction-natural'], repetitions:2, timeoutMs:60_000,
}] });

test('actual-backend synthetic cells are distinct from wire and saved-provider admission', () => {
  const value = config(); value.cells[0] = { ...value.cells[0], transport: 'runtime-fixture', providerId: 'devryan-smoke',
    modelId: 'smoke-write', planMode: false, variant: 'high', scenarioIds: ['core-journey'] };
  assert.equal(validateQaMatrixConfig(value).cells[0].transport, 'runtime-fixture');
  for (const patch of [{ providerId: 'openai' }, { modelId: 'other' }, { variant: null }, { planMode: true },
    { scenarioIds: ['project-work'] }, { mirrorPersonalSetup: true }, { preserveOrchestration: true }]) {
    const invalid = structuredClone(value); Object.assign(invalid.cells[0], patch); assert.throws(() => validateQaMatrixConfig(invalid));
  }
  const live = structuredClone(value); live.cells[0].transport = 'live'; assert.throws(() => validateQaMatrixConfig(live));
  const wire = structuredClone(value); wire.cells[0].transport = 'fixture'; assert.throws(() => validateQaMatrixConfig(wire));
});

test('explicit desktop themes retain distinct cell identities and mobile keeps its existing sweep',()=>{
  const value=config();value.cells= ['light','dark'].map(theme=>({...value.cells[0],id:`desktop-${theme}`,theme,scenarioIds:['core-journey']}));
  const runs=expandQaMatrix(value);
  assert.deepEqual(runs.map(row=>[row.runId,row.theme]),[['desktop-light-core-journey-1','light'],['desktop-light-core-journey-2','light'],['desktop-dark-core-journey-1','dark'],['desktop-dark-core-journey-2','dark']]);
  assert.equal(new Set(runs.map(row=>row.evidenceDirectory)).size,4);
  for(const theme of ['system','unknown',null,undefined]){
    const invalid=structuredClone(value);invalid.cells[0].theme=theme;
    assert.throws(()=>validateQaMatrixConfig(invalid),/desktop theme/);
  }
  const mobile=structuredClone(value);mobile.cells[0].runtime='web';mobile.cells[0].scenarioIds=['mobile'];
  assert.throws(()=>validateQaMatrixConfig(mobile),/mobile owns its two-theme sweep/);
  delete mobile.cells[0].theme;
  assert.equal(expandQaMatrix(mobile)[0].theme,undefined);
  const duplicate=structuredClone(value);duplicate.cells[1].id=duplicate.cells[0].id;
  assert.throws(()=>validateQaMatrixConfig(duplicate),/IDs must be unique/);
});

test('matrix expands explicit personal setup mirroring only with a preserved live graph', () => {
  const value = config();
  value.cells[0].preserveOrchestration = true;
  value.cells[0].mirrorPersonalSetup = true;
  assert.deepEqual(expandQaMatrix(value)[0].mirrorPersonalSetup, { plugins: true, skills: true, mcp: 'definitions' });
  value.cells[0].mirrorPersonalSetup = { skills: true, mcp: 'live' };
  const runs = expandQaMatrix(value);
  assert.ok(runs.every(run => run.mirrorPersonalSetup.skills && !run.mirrorPersonalSetup.plugins
    && run.mirrorPersonalSetup.mcp === 'live' && Object.isFrozen(run.mirrorPersonalSetup)));
  for (const patch of [{ preserveOrchestration: false }, { mirrorPersonalSetup: { plugins: 'yes' } },
    { mirrorPersonalSetup: { mcp: 'all' } }, { mirrorPersonalSetup: { credentials: true } }]) {
    const invalid = structuredClone(value); Object.assign(invalid.cells[0], patch);
    assert.throws(() => validateQaMatrixConfig(invalid), { code: 'invalid_qa_matrix' });
  }
  const fixture = config(); Object.assign(fixture.cells[0], { runtime: 'web', transport: 'fixture', providerId: 'fixture',
    modelId: 'fixture-model', scenarioIds: ['core-journey'], mirrorPersonalSetup: true });
  assert.throws(() => validateQaMatrixConfig(fixture), /requires live transport/);
});

test('matrix expands explicit pinned selections without losing provider-default null', () => {
  const normalized = validateQaMatrixConfig(config());
  assert.equal(normalized.cells[0].variant, null);
  const runs = expandQaMatrix(normalized);
  assert.deepEqual(runs.map((run) => [run.scenarioId,run.repetition]), [['project-work',1],['project-work',2],['compaction-natural',1],['compaction-natural',2]]);
  assert.equal(new Set(runs.map((run) => run.evidenceDirectory)).size,4);
  assert.ok(runs.every((run) => run.variant === null && run.planMode && run.agent === 'builder'));
});

test('matrix rejects unsupported runtime/provider/phase combinations and missing thinking intent', () => {
  for (const patch of [{runtime:'vscode'}, {transport:'fixture'}, {providerId:'google'}, {agent:'plan'},
    {planMode:'true'}, {variant:undefined}, {variant:''}, {repetitions:0}, {timeoutMs:Infinity}, {modelId:'../model'}]) {
    const value = config(); Object.assign(value.cells[0],patch);
    assert.throws(() => validateQaMatrixConfig(value), {code:'invalid_qa_matrix'});
  }
  const mobile = config(); mobile.cells[0].scenarioIds = ['mobile'];
  assert.throws(() => validateQaMatrixConfig(mobile), /mobile requires web/);
  mobile.cells[0].runtime = 'web'; mobile.cells[0].variant = 'high';
  assert.equal(validateQaMatrixConfig(mobile).cells[0].variant, 'high');
});

test('matrix fails closed on unknown fields, duplicate IDs/scenarios, and non-cache evidence', () => {
  const extra = config(); extra.password = 'not-a-secret';
  assert.throws(() => validateQaMatrixConfig(extra), /Unknown matrix field/);
  const nested = config(); nested.cells[0].unexpected = true;
  assert.throws(() => validateQaMatrixConfig(nested), /Unknown cell field/);
  const duplicate = config(); duplicate.cells.push({...duplicate.cells[0]});
  assert.throws(() => validateQaMatrixConfig(duplicate), /IDs must be unique/);
  const scenarios = config(); scenarios.cells[0].scenarioIds = ['project-work','project-work'];
  assert.throws(() => validateQaMatrixConfig(scenarios), /scenarioIds must be unique/);
  for (const evidenceRoot of ['docs/audits','../escape','.cache']) assert.throws(() => validateQaMatrixConfig({...config(),evidenceRoot}), /evidenceRoot/);
});

test('live matrix preserves explicit cross-provider specialist selections and rejects implicit substitutions', () => {
  const value = config();
  value.cells[0].agentAssignments = { explorer: { providerId: 'opencode', modelId: 'deepseek-v4-flash', variant: 'high' },
    builder: { providerId: 'xai', modelId: 'grok-4.6', variant: 'high' } };
  assert.throws(() => validateQaMatrixConfig(value), { code: 'invalid_qa_matrix' });
  value.cells[0].allowCrossProviderAssignments = true;
  assert.deepEqual(expandQaMatrix(value)[0].agentAssignments, value.cells[0].agentAssignments);
  for (const patch of [{ providerId: 'unknown' }, { modelId: 'opencode/model' }, { variant: undefined }, { extra: true }]) {
    const invalid = structuredClone(value);
    Object.assign(invalid.cells[0].agentAssignments.explorer, patch);
    assert.throws(() => validateQaMatrixConfig(invalid), { code: 'invalid_qa_matrix' });
  }
});

test('native window dimensions are explicit, bounded and Electron-only', () => {
  const value = config(); value.cells[0].windowSize = { width: 600, height: 800 };
  assert.deepEqual(expandQaMatrix(value)[0].windowSize, { width: 600, height: 800 });
  for (const windowSize of [{ width: 599, height: 800 }, { width: 600, height: Infinity }, { width: 600 }, { width: 600, height: 800, extra: true }]) {
    const invalid = structuredClone(value); invalid.cells[0].windowSize = windowSize;
    assert.throws(() => validateQaMatrixConfig(invalid), { code: 'invalid_qa_matrix' });
  }
});

test('manual compaction composes into each selected Electron project run without matrix expansion', () => {
  const value = config();
  value.cells[0].scenarioIds = ['project-work'];
  const original = expandQaMatrix(value);
  value.cells[0].projectCompaction = 'manual';
  const composed = expandQaMatrix(value);
  assert.deepEqual(composed.map(run => [run.runId, run.evidenceDirectory]), original.map(run => [run.runId, run.evidenceDirectory]));
  assert.ok(composed.every(run => run.scenarioId === 'project-work' && run.projectCompaction === 'manual'
    && run.agent === 'builder' && run.planMode && run.variant === null));
  for (const patch of [{ runtime: 'web' }, { transport: 'fixture', providerId: 'fixture' },
    { scenarioIds: ['compaction-manual'] }, { scenarioIds: ['project-work', 'core-journey'] },
    { projectCompaction: 'natural' }, { projectCompaction: null }, { projectCompaction: false }]) {
    const invalid = structuredClone(value); Object.assign(invalid.cells[0], patch);
    assert.throws(() => validateQaMatrixConfig(invalid), /projectCompaction/);
  }
});

test('loading config is read-only and rejects symlink evidence escapes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(),'qa-matrix-'));
  const outside = mkdtempSync(path.join(os.tmpdir(),'qa-matrix-outside-'));
  try {
    mkdirSync(path.join(root,'.cache'));
    writeFileSync(path.join(root,'matrix.json'),JSON.stringify(config()));
    assert.equal(loadQaMatrixConfig('matrix.json',{repoRoot:root}).cells.length,1);
    symlinkSync(outside,path.join(root,'.cache','escape'));
    assert.throws(() => validateQaMatrixConfig({...config(),evidenceRoot:'.cache/escape/evidence'},{repoRoot:root}), /symlink escapes/);
    writeFileSync(path.join(root,'matrix.json'),'{');
    assert.throws(() => loadQaMatrixConfig('matrix.json',{repoRoot:root}), /Cannot read/);
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
});


test('preserved orchestration is live-only and cannot silently combine with role substitutions', () => {
  const value = config(); value.cells[0].preserveOrchestration = true;
  assert.equal(expandQaMatrix(value)[0].preserveOrchestration, true);
  value.cells[0].agentAssignments = { explorer: { providerId: 'openai', modelId: 'other', variant: null } };
  assert.throws(() => validateQaMatrixConfig(value), /without agent assignment overrides/);
  delete value.cells[0].agentAssignments;
  value.cells[0].preserveOrchestration = 'true';
  assert.throws(() => validateQaMatrixConfig(value), /requires live transport/);
});

test('natural compaction admits live web with the same pinned selection and rejects fixture transports', () => {
  const value = config(); value.cells[0].runtime = 'web';
  assert.equal(expandQaMatrix(value).find(row => row.scenarioId === 'compaction-natural').runtime, 'web');
  for (const transport of ['fixture', 'runtime-fixture']) {
    const invalid = structuredClone(value); invalid.cells[0].transport = transport;
    assert.throws(() => validateQaMatrixConfig(invalid));
  }
});

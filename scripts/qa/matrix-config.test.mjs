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

test('matrix expands explicit pinned selections without losing provider-default null', () => {
  const normalized = validateQaMatrixConfig(config());
  assert.equal(normalized.cells[0].variant, null);
  const runs = expandQaMatrix(normalized);
  assert.deepEqual(runs.map((run) => [run.scenarioId,run.repetition]), [['project-work',1],['project-work',2],['compaction-natural',1],['compaction-natural',2]]);
  assert.equal(new Set(runs.map((run) => run.evidenceDirectory)).size,4);
  assert.ok(runs.every((run) => run.variant === null && run.planMode && run.agent === 'builder'));
});

test('matrix rejects unsupported runtime/provider/phase combinations and missing thinking intent', () => {
  for (const patch of [{runtime:'vscode'}, {runtime:'web'}, {transport:'fixture'}, {providerId:'google'}, {agent:'plan'},
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

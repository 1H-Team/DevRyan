import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

// Structural contract of .github/workflows/release.yml (docs/RELEASE_PIPELINE.md).
const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const { jobs } = workflow;
const needs = job => [jobs[job].needs ?? []].flat();

test('only stage and publish can write repository contents', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes('write')).map(([name]) => name).sort();
  assert.deepEqual(writers, ['publish', 'stage']);
  for (const name of writers) assert.deepEqual(jobs[name].permissions, { contents: 'write', actions: 'read' });
});

test('stage and publish hold the production publication lock and are never cancelled', () => {
  for (const name of ['stage', 'publish']) assert.deepEqual(jobs[name].concurrency, { group: 'devryan-production-publication', 'cancel-in-progress': false });
  assert.deepEqual(jobs['deploy-backend'].concurrency, { group: 'devryan-backend-deploy', 'cancel-in-progress': false });
  assert.equal(workflow.concurrency, undefined, 'no workflow-wide cancellation');
});

test('every job has a timeout, macOS jobs included', () => {
  for (const [name, job] of Object.entries(jobs)) assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0, name);
  const macos = Object.entries(jobs).filter(([, job]) => String(job['runs-on']).includes('macos')).map(([name]) => name).sort();
  assert.deepEqual(macos, ['electron-package', 'final-dmg-smoke', 'upgrade-check']);
});

test('publish needs trusted CI, the staged draft and the deployed backend; Supabase runs only in deploy-backend', () => {
  for (const job of ['preflight', 'trusted-ci', 'stage', 'deploy-backend']) assert.ok(needs('publish').includes(job), job);
  for (const job of ['preflight', 'trusted-ci', 'stage']) assert.ok(needs('deploy-backend').includes(job), job);
  assert.match(jobs.publish.if, /needs\.trusted-ci\.result == 'success' && needs\.deploy-backend\.result == 'success'/);
  const supabase = Object.entries(jobs).filter(([, job]) => JSON.stringify(job).includes('SUPABASE_')).map(([name]) => name);
  assert.deepEqual(supabase, ['deploy-backend']);
  assert.equal(jobs['deploy-backend'].environment, 'DevRyan Secrets');
  assert.ok(needs('stage').includes('upgrade-check') && needs('stage').includes('electron-package'));
});

test('a manual run is a dry run that can write only to the staging repository with its own token', () => {
  assert.equal(workflow.env.RELEASE_DRY_RUN, "${{ github.event_name == 'workflow_dispatch' }}");
  assert.equal(workflow.env.RELEASE_TARGET_REPOSITORY, "${{ github.event_name == 'workflow_dispatch' && '1H-Team/DevRyan-release-staging' || github.repository }}");
  assert.equal(workflow.env.RELEASE_MODE, "${{ github.event_name == 'workflow_dispatch' && inputs.mode || 'publish' }}");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ['build', 'stage']);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'build');
  for (const name of ['stage', 'publish']) {
    assert.equal(jobs[name].env.GITHUB_TOKEN, "${{ github.event_name == 'push' && secrets.GITHUB_TOKEN || '' }}", `${name} gets the repository token only on a tag push`);
    assert.equal(jobs[name].env.RELEASE_STAGING_TOKEN, "${{ github.event_name == 'workflow_dispatch' && secrets.DEVRYAN_RELEASE_STAGING_TOKEN || '' }}");
    for (const step of jobs[name].steps) assert.equal(step.env?.GITHUB_TOKEN, undefined, `${name} step ${step.name ?? step.uses} must not override the token`);
  }
  assert.match(jobs.stage.if, /github\.event_name == 'push' \|\| inputs\.mode == 'stage'/);
  assert.match(jobs['deploy-backend'].if, /github\.event_name == 'push'/);
  assert.match(workflow['run-name'], /format\('Release \{0\} dry run', inputs\.mode\)/, 'the pipeline-change gate finds staging runs by this title');
});

test('preflight sees full history, and a retained DMG at the same SHA is adopted instead of rebuilt', () => {
  assert.equal(jobs.preflight.steps[0].with['fetch-depth'], 0);
  assert.match(jobs.preflight.steps.at(-1).run, /release-preflight\.mjs/);
  assert.equal(jobs['electron-package']['runs-on'], "${{ needs.preflight.outputs.reuse_run_id != '' && 'ubuntu-latest' || 'macos-26' }}");
  assert.match(jobs.web.if, /reuse_run_id == ''/);
  const adopt = jobs['electron-package'].steps.find(step => step.name?.startsWith('Adopt'));
  assert.match(adopt.run, /release-candidate\.mjs adopt/);
  const build = jobs['electron-package'].steps.filter(step => step.name?.startsWith('Package the app') || step.run?.includes('build-native-runtime'));
  assert.ok(build.length === 2 && build.every(step => step.if === "${{ env.REUSE_RUN_ID == '' }}"));
  const identity = jobs['electron-package'].steps.find(step => step.with?.name === 'DevRyan-macos-arm64-candidate-identity');
  assert.match(identity.with.path, /release-manifest\.json/);
});

test('the final-DMG smoke is quarantined at the step until its gate variable is set', () => {
  const smoke = jobs['final-dmg-smoke'];
  assert.equal(smoke['continue-on-error'], undefined, 'no red job in every successful release');
  const observe = smoke.steps.find(step => step.name?.startsWith('Observe'));
  assert.equal(observe['continue-on-error'], "${{ vars.DEVRYAN_FINAL_DMG_SMOKE_GATE != 'qualified-3-runs' }}");
  assert.ok(smoke.steps.some(step => step.run?.includes('--summary')));
  assert.match(jobs.stage.if, /needs\.final-dmg-smoke\.result == 'success' \|\| vars\.DEVRYAN_FINAL_DMG_SMOKE_GATE != 'qualified-3-runs'/);
});

test('the trusted-CI job outlives its rerun-tolerant wait', () => {
  assert.ok(jobs['trusted-ci']['timeout-minutes'] > 25);
  assert.equal(jobs['trusted-ci'].if, "${{ github.event_name == 'push' }}");
});

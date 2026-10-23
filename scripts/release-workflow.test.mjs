import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

// Structural contract of .github/workflows/release.yml (docs/RELEASE_PIPELINE.md).
const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const { jobs } = workflow;
const needs = job => [jobs[job].needs ?? []].flat();
const PUBLICATION_LOCK = 'devryan-production-publication';

test('only the release job can write repository contents', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const writers = Object.entries(jobs).filter(([, job]) => Object.values(job.permissions ?? {}).includes('write')).map(([name]) => name).sort();
  assert.deepEqual(writers, ['release']);
  assert.deepEqual(jobs.release.permissions, { contents: 'write', actions: 'read' });
});

test('exactly one job holds the production publication lock, and it is never cancelled', () => {
  const locked = Object.entries(jobs).filter(([, job]) => job.concurrency?.group === PUBLICATION_LOCK).map(([name]) => name);
  assert.deepEqual(locked, ['release'], 'stage and publish share one job, so no pending publish can be replaced between them');
  assert.deepEqual(jobs.release.concurrency, { group: PUBLICATION_LOCK, 'cancel-in-progress': false });
  assert.equal(jobs.release.env.RELEASE_PUBLICATION_LOCK, PUBLICATION_LOCK);
  assert.deepEqual(jobs['deploy-backend'].concurrency, { group: 'devryan-backend-deploy', 'cancel-in-progress': false });
  assert.equal(workflow.concurrency, undefined, 'no workflow-wide cancellation');
  const step = jobs.release.steps.find(row => row.id === 'release');
  assert.equal(step.run, 'node scripts/release.mjs release', 'stage, CI recheck and publish run in one process');
  assert.equal(step.env.RELEASE_STAGED_PATH, '${{ runner.temp }}/staged.json');
  const staged = jobs.release.steps.find(row => row.with?.name === 'release-staged');
  assert.equal(staged.if, '${{ always() }}', 'staged.json is kept for audit and resume');
  for (const name of ['stage', 'publish', 'final-dmg-smoke']) assert.equal(jobs[name], undefined, name);
});

test('every job has a timeout, macOS jobs included', () => {
  for (const [name, job] of Object.entries(jobs)) assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0, name);
  const macos = Object.entries(jobs).filter(([, job]) => String(job['runs-on']).includes('macos')).map(([name]) => name).sort();
  assert.deepEqual(macos, ['electron-package', 'upgrade-check', 'visual-qa']);
});

test('deploy-backend runs before the publication lock; release needs trusted CI, qualification and the deployed backend', () => {
  for (const job of ['preflight', 'trusted-ci', 'electron-package', 'upgrade-check']) assert.ok(needs('deploy-backend').includes(job), job);
  assert.ok(!needs('deploy-backend').includes('release'));
  assert.equal(jobs['deploy-backend'].concurrency.group, 'devryan-backend-deploy');
  for (const job of ['preflight', 'trusted-ci', 'electron-package', 'upgrade-check', 'deploy-backend']) assert.ok(needs('release').includes(job), job);
  assert.match(jobs.release.if, /needs\.trusted-ci\.result == 'success' && needs\.electron-package\.result == 'success' && needs\.upgrade-check\.result == 'success' && needs\.deploy-backend\.result == 'success'/);
  assert.match(jobs['deploy-backend'].if, /needs\.upgrade-check\.result == 'success'/);
  const supabase = Object.entries(jobs).filter(([, job]) => JSON.stringify(job).includes('SUPABASE_')).map(([name]) => name);
  assert.deepEqual(supabase, ['deploy-backend']);
  assert.equal(jobs['deploy-backend'].environment, 'DevRyan Secrets');
});

test('post-publish verification is read-only and follows the release job', () => {
  const verify = jobs['post-publish-verify'];
  assert.deepEqual(verify.permissions, { contents: 'read' }, 'no write permission');
  assert.equal(verify.concurrency, undefined, 'outside the publication lock');
  assert.deepEqual(needs('post-publish-verify').sort(), ['preflight', 'release']);
  assert.match(verify.if, /needs\.release\.result == 'success'/);
  assert.equal(verify.steps.at(-1).run, 'node scripts/release-verify-public.mjs "v${{ needs.preflight.outputs.version }}"');
  assert.ok(verify['timeout-minutes'] >= 20, 'outlives the ten-minute discovery window plus the download');
  assert.ok(!Object.values(jobs).some(job => (job.needs ?? []).includes?.('post-publish-verify')), 'nothing waits for it');
});

test('a manual run is a dry run that never deploys or publishes, and simulates the release instead', () => {
  assert.equal(workflow.env.RELEASE_DRY_RUN, "${{ github.event_name == 'workflow_dispatch' }}");
  assert.equal(workflow.on.workflow_dispatch, null, 'dispatch takes no inputs');
  for (const name of ['deploy-backend', 'release', 'post-publish-verify']) assert.match(jobs[name].if, /github\.event_name == 'push'/, name);
  assert.equal(jobs.release.env.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  const simulate = jobs['simulate-release'];
  assert.match(simulate.if, /github\.event_name == 'workflow_dispatch'/);
  assert.equal(simulate.permissions, undefined, 'the workflow default: contents read');
  assert.equal(simulate.steps.at(-1).run, 'node scripts/release.mjs release --simulate');
  assert.ok(!JSON.stringify(simulate).includes('secrets.'), 'the simulation holds no token');
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

test('visual QA is non-gating and dispatch-only; no GUI job gates publication', () => {
  const qa = jobs['visual-qa'];
  assert.equal(qa['continue-on-error'], true);
  assert.match(qa.if, /github\.event_name == 'workflow_dispatch'/);
  assert.ok(qa.steps.some(step => step.run?.startsWith('node scripts/qa/release-visual-qa.mjs --dmg ')));
  assert.equal(qa.steps.find(step => step.with?.name === 'release-visual-qa').if, '${{ always() }}');
  for (const [name, job] of Object.entries(jobs)) assert.ok(!needs(name).includes('visual-qa') && !JSON.stringify(job.if ?? '').includes('visual-qa'), name);
  assert.ok(!JSON.stringify(workflow).includes('release-final-dmg-smoke.mjs'));
  assert.ok(!JSON.stringify(workflow).includes('DEVRYAN_FINAL_DMG_SMOKE_GATE'));
});

test('the trusted-CI job outlives its rerun-tolerant wait', () => {
  assert.ok(jobs['trusted-ci']['timeout-minutes'] > 25);
  assert.equal(jobs['trusted-ci'].if, "${{ github.event_name == 'push' }}");
});

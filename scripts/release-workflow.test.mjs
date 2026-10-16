import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';

test('release graph shares one web build and gates packaging on complete inputs', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const images = jobs['build-bot-runtime-image'];
  assert.equal(images.strategy['max-parallel'], 3);
  assert.equal(images.strategy['fail-fast'], false);
  assert.equal(new Set(images.strategy.matrix.image).size, 8);
  const build = images.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
  assert.equal(build.with.provenance, 'mode=max');
  assert.equal(build.with.sbom, true);
  assert.match(build.with['cache-to'], /matrix.image.*mode=max/);
  assert.equal(jobs['prepare-desktop-electron-macos'].needs, 'create-release');
  assert.deepEqual(jobs['build-desktop-electron-macos'].needs, ['create-release', 'prepare-desktop-electron-macos', 'build-web-artifact', 'publish-bot-runtime-images']);
  assert.ok(jobs['publish-npm'].needs.includes('build-web-artifact'));
  assert.ok(jobs['build-web-artifact'].steps.some((step) => step.run === 'bun run type-check:ui'));
  const compilers = Object.values(jobs).flatMap((job) => job.steps).filter((step) => /bun run build:web(?:\s|$)/.test(step.run || ''));
  assert.equal(compilers.length, 1);
  const upload = jobs['build-web-artifact'].steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['include-hidden-files'], true);
});

test('desktop-only release skips npm while requiring all desktop and image gates', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const { jobs } = workflow;
  assert.equal(workflow.on.workflow_dispatch.inputs.scope.default, 'desktop-macos-arm64');
  assert.match(jobs['publish-npm'].if, /outputs.scope == 'full'/);
  const finalize = jobs['finalize-release'];
  assert.match(finalize.if, /always\(\)/);
  assert.match(finalize.if, /outputs.scope == 'desktop-macos-arm64' && needs.publish-npm.result == 'skipped'/);
  assert.deepEqual(finalize.needs, ['create-release', 'publish-bot-runtime-images', 'verify-bot-runtime-topology', 'build-desktop-electron-macos', 'publish-npm', 'final-dmg-smoke']);
  for (const prerequisite of ['create-release', 'publish-bot-runtime-images', 'verify-bot-runtime-topology', 'build-desktop-electron-macos']) {
    assert.ok(finalize.if.includes(`needs.${prerequisite}.result == 'success'`));
  }
  assert.equal(jobs['combine-electron-manifests'], undefined);
  assert.doesNotMatch(finalize.if, /combine-electron-manifests/);
  const verification = finalize.steps.find(step => step.name === 'Verify required release assets before publish');
  assert.equal(verification.env.RELEASE_SCOPE, '${{ needs.create-release.outputs.scope }}');
  assert.equal(verification.env.RELEASE_SHA256_MACOS_ARM64, '${{ needs.build-desktop-electron-macos.outputs.sha256 }}');
  assert.equal(verification.env.RELEASE_SHA256_WEB, '${{ needs.publish-npm.outputs.sha256 }}');
  assert.ok(finalize.steps.find(step => step.name === 'Deploy and verify Supabase configuration and migrations'));
});

test('one finalizer owns stable public uploads after the mandatory exact-DMG gate', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const { jobs } = YAML.parse(source);
  assert.ok(!Object.values(jobs).flatMap(job => job.steps).some(step => step.uses?.startsWith('softprops/action-gh-release@')));
  const writers = Object.entries(jobs).flatMap(([job, { steps }]) => steps.filter(step => step.env?.RELEASE_OPERATION === 'release-finalize').map(() => job));
  assert.deepEqual(writers, ['finalize-release']);
  assert.ok(jobs['finalize-release'].needs.includes('final-dmg-smoke'));
  assert.match(jobs['finalize-release'].if, /needs.final-dmg-smoke.result == 'success'/);
  const desktop = jobs['build-desktop-electron-macos'];
  const artifact = desktop.steps.find(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'DevRyan-macos-arm64-release');
  assert.equal(artifact.with['retention-days'], 14);
  assert.equal(artifact.with.path, 'packages/electron/dist/DevRyan-${{ needs.create-release.outputs.version }}-arm64.dmg');
  assert.equal(desktop.steps.find(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'DevRyan-macos-arm64-packaging').with['retention-days'], 90);
  assert.ok(!desktop.steps.some(step => /latest-mac\.yml/.test(step.with?.path || '')));
  const manifest = jobs['publish-bot-runtime-images'].steps.find(step => step.name === 'Upload Bot runtime manifest for Electron release builds');
  assert.match(manifest.uses, /^actions\/upload-artifact@/); assert.equal(manifest.with.name, 'bot-runtime-images');
});

test('exact receipt identity and frozen budgets are verified before deployment, npm and finalization', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const steps = jobs['finalize-release'].steps;
  const gate = steps.findIndex(step => step.env?.RELEASE_OPERATION === 'release-prepublish');
  assert.ok(gate > 0);
  for (const name of ['Deploy and verify Supabase configuration and migrations', 'Publish verified full-scope npm package', 'Publish release'])
    assert.ok(gate < steps.findIndex(step => step.name === name), name);
  assert.equal(steps[gate].env.RELEASE_SMOKE_RECEIPT, 'release-smoke/final-dmg-smoke.json');
  assert.equal(steps[gate].env.RELEASE_SMOKE_IDENTITY, 'release-smoke-contract/smoke-identity.json');
  assert.equal(steps[gate].env.RELEASE_SMOKE_LIMITS, 'release-smoke-contract/smoke-limits.json');
  const publication = steps.find(step => step.env?.RELEASE_OPERATION === 'release-finalize');
  for (const field of ['RELEASE_SMOKE_RECEIPT', 'RELEASE_SMOKE_IDENTITY', 'RELEASE_SMOKE_LIMITS', 'RELEASE_SMOKE_ATTEMPT'])
    assert.equal(publication.env[field], steps[gate].env[field]);
  const retained = jobs['final-dmg-smoke'].steps.find(step => step.with?.name === 'DevRyan-final-smoke-contract-${{ github.run_attempt }}');
  assert.equal(retained.with['retention-days'], 90);
  assert.match(retained.with.path, /smoke-limits.json/); assert.match(retained.with.path, /smoke-identity.json/);
  const admissionSteps = jobs['create-release'].steps;
  assert.equal(admissionSteps.some(step => step.env?.RELEASE_OPERATION === 'candidate-resolve'), false, 'Candidate and budget resolve inside source admission before draft creation');
  const source = fs.readFileSync(new URL('./release-ci.mjs', import.meta.url), 'utf8');
  const admission = source.slice(source.indexOf("case 'source-admit':"), source.indexOf("case 'candidate-resolve':"));
  const currentAttempt = admission.indexOf('await assertCurrentReleaseGateAttempt(');
  assert.ok(currentAttempt > 0);
  assert.ok(currentAttempt < admission.indexOf("client.pages('/actions/workflows/release.yml/runs'"));
  assert.ok(currentAttempt < admission.indexOf('const admission = await admitRelease('));
  assert.ok(admission.indexOf('if (readOnlyAdmission.publishedNoop === true)') < currentAttempt);
  assert.match(admission, /await hasRetainedRunAdmission\(/);
  assert.match(admission, /currentRunID: env.GITHUB_RUN_ID, currentRunAttempt: env.GITHUB_RUN_ATTEMPT/);
  assert.match(admissionSteps.find(step => step.with?.name === 'DevRyan-release-admission').if, /steps.create_release.outputs.admission_retained != 'true'/);
});

test('Bot image jobs reuse verified input-addressed images unless a refresh is requested', async () => {
  const { BOT_RUNTIME_IMAGE_BUILD_RECIPE } = await import('./bot-runtime-image-inputs.mjs');
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const refresh = workflow.on.workflow_dispatch.inputs.rebuild_bot_images;
  assert.equal(refresh.type, 'boolean');
  assert.equal(refresh.default, false);
  const resolution = workflow.jobs['resolve-bot-runtime-images'];
  assert.equal(resolution.permissions.contents, 'read');
  const resolve = resolution.steps.find(step => step.env?.RELEASE_OPERATION === 'image-resolve');
  assert.equal(resolve.id, 'resolve');
  assert.equal(resolve.env.IMAGE_KEY, undefined);
  assert.equal(resolve.env.REBUILD_BOT_IMAGES, "${{ github.event.inputs.rebuild_bot_images == 'true' }}");
  const { steps } = workflow.jobs['build-bot-runtime-image'];
  assert.deepEqual(workflow.jobs['build-bot-runtime-image'].needs, ['create-release', 'resolve-bot-runtime-images']);
  const position = (predicate) => steps.findIndex(predicate);
  const cosign = position((step) => step.uses?.startsWith('sigstore/cosign-installer@'));
  const login = position((step) => step.uses?.startsWith('docker/login-action@'));
  const build = position((step) => step.uses?.startsWith('docker/build-push-action@'));
  const sign = position((step) => step.env?.RELEASE_OPERATION === 'image-sign');
  const upload = position((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(login < build && cosign < build && build < sign && sign < upload);
  for (const index of [build, sign]) {
    assert.equal(steps[index].if, "${{ env.RELEASE_DRY_RUN != 'true' && contains(fromJSON(needs.resolve-bot-runtime-images.outputs.build), matrix.image) }}");
  }
  assert.equal(steps[upload].if, undefined);
  assert.equal(steps[upload].with.path, 'artifacts/${{ matrix.image }}.json');
  // The input digest covers the recipe; the workflow must build exactly that recipe.
  const recipe = steps[build].with;
  assert.equal(recipe.context, BOT_RUNTIME_IMAGE_BUILD_RECIPE.context);
  assert.equal(recipe.platforms, BOT_RUNTIME_IMAGE_BUILD_RECIPE.platforms.join(','));
  assert.equal(recipe.provenance, BOT_RUNTIME_IMAGE_BUILD_RECIPE.provenance);
  assert.equal(recipe.sbom, BOT_RUNTIME_IMAGE_BUILD_RECIPE.sbom);
  assert.equal(recipe['build-args'], undefined);
  assert.equal(recipe.target, undefined);
  assert.ok(workflow.jobs['verify-bot-runtime-topology'].needs.includes('publish-bot-runtime-images'));
  assert.ok(!workflow.jobs['build-desktop-electron-macos'].needs.includes('verify-bot-runtime-topology'));
});

test('dry-run guards every external writer and verifies staged digests without creating a release', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.env.RELEASE_DRY_RUN, "${{ github.event_name == 'workflow_dispatch' && (inputs.dry_run == true || inputs.candidate == true) }}");
  const writers = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step =>
    /^(?:softprops\/action-gh-release|docker\/login-action|docker\/build-push-action)@/.test(step.uses ?? '')
    || ['image-sign', 'release-finalize'].includes(step.env?.RELEASE_OPERATION) || /npm publish|supabase db push|fetch\(process\.env\.DISCORD_WEBHOOK_URL/.test(step.run ?? ''));
  assert.ok(writers.length >= 6);
  for (const writer of writers) assert.match(writer.if ?? '', /env\.RELEASE_DRY_RUN != 'true'/, writer.name ?? writer.uses);
  const verify = workflow.jobs['finalize-release'].steps.find(step => step.name === 'Verify required release assets before publish');
  assert.equal(verify.run, 'node scripts/verify-release-assets.mjs --directory release-assets');
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.uses?.startsWith('oven-sh/setup-bun@')) assert.equal(step.with['bun-version'], '1.3.14');
  }
});

test('docs source automation preserves the exact Windows preview asset inventory', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/docs-source.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.jobs['validate-and-package'].if,
    "${{ !contains(github.event.release.tag_name || inputs.release_tag || '', '-windows-preview.') }}");
});

test('Bot input preparation excludes automatic releases and every application publication owner', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push.tags, ['v*', '!v*-bot-inputs-*', '!v*-windows-preview.*']);
  assert.equal(workflow.on.workflow_dispatch.inputs.prepare_bot_inputs_only.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.prepare_bot_inputs_only.type, 'boolean');
  assert.equal(workflow.env.RELEASE_BOT_INPUTS_ONLY, "${{ github.event_name == 'workflow_dispatch' && inputs.prepare_bot_inputs_only == true }}");
  const { jobs } = workflow;
  assert.match(jobs['create-release'].steps.find(step => step.id === 'get_version').run, /assertBotInputPreparation\(process.env, version\)/);
  for (const name of ['publish-npm', 'build-web-artifact', 'prepare-desktop-electron-macos', 'build-desktop-electron-macos', 'finalize-release']) {
    assert.match(jobs[name].if, /inputs.prepare_bot_inputs_only == true/);
  }
  for (const job of Object.values(jobs)) for (const step of job.steps) {
    if (step.uses?.startsWith('softprops/action-gh-release@') || /npm publish|supabase db push|fetch\(process\.env\.DISCORD_WEBHOOK_URL/.test(step.run ?? '')) {
      assert.match(step.if, /env\.RELEASE_BOT_INPUTS_ONLY != 'true'/);
    }
  }
  for (const name of ['resolve-bot-runtime-images', 'build-bot-runtime-image', 'publish-bot-runtime-images', 'verify-bot-runtime-topology']) {
    assert.match(jobs[name].if, /published_noop != 'true'/);
  }
});


test('three isolated same-byte candidate rehearsals freeze an exact-source final gate and preserve the legacy runner', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source), { jobs } = workflow;
  assert.equal(workflow.permissions.contents, 'read'); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /format\('v\{0\}'/);
  assert.equal(workflow.on.workflow_dispatch.inputs.candidate.default, false);
  assert.equal(workflow.env.RELEASE_CANDIDATE, '${{ github.event_name == \'workflow_dispatch\' && inputs.candidate == true }}');
  assert.deepEqual(jobs['candidate-startup'].strategy.matrix.sample, [1, 2, 3]);
  for (const name of ['candidate-startup', 'final-dmg-smoke']) {
    assert.equal(jobs[name]['runs-on'], 'macos-26');
    assert.ok(jobs[name].steps.some(step => step.with?.name === 'DevRyan-macos-arm64-release'));
    assert.ok(jobs[name].steps.some(step => step.with?.name === 'DevRyan-macos-arm64-packaging'));
    assert.ok(jobs[name].steps.some(step => /release-startup-smoke.mjs/.test(step.run ?? '')));
    assert.equal(jobs[name].steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with['retention-days'], 90);
  }
  assert.ok(jobs['final-dmg-smoke'].steps.some(step => step.env?.RELEASE_OPERATION === 'candidate-resolve'));
  assert.ok(jobs['final-dmg-smoke'].steps.some(step => step.env?.RELEASE_OPERATION === 'smoke-budget'));
  const admit = jobs['create-release'].steps.findIndex(step => step.env?.RELEASE_OPERATION === 'source-admit');
  assert.ok(admit >= 0); assert.equal(jobs['create-release'].outputs.source, '${{ steps.create_release.outputs.source }}');
  assert.equal(jobs['qualify-release-startup'], undefined);
  assert.ok(fs.readFileSync(new URL('./qa/release-startup-contract.mjs', import.meta.url), 'utf8').includes('unsettled-process-upgrade'));
  const docs = YAML.parse(fs.readFileSync(new URL('../.github/workflows/docs-source.yml', import.meta.url), 'utf8'));
  assert.equal(docs.permissions.contents, 'read');
  assert.ok(!docs.jobs['validate-and-package'].steps.some(step => step.uses?.startsWith('softprops/action-gh-release@') || /curl|dispatches/.test(step.run ?? '')));
});

test('manual Electron consumes a frozen internal signed manifest without changing the legacy Tauri lane', () => {
  const source = fs.readFileSync(new URL('../.github/workflows/build-macos-arm64-dmg.yml', import.meta.url), 'utf8');
  const workflow = YAML.parse(source);
  assert.equal(workflow.on.workflow_dispatch.inputs.signed_bot_manifest_run.required, false);
  const electron = Object.values(workflow.jobs).find(job => job.name?.startsWith('Build Electron DMG'));
  assert.match(electron.if, /signed_bot_manifest_run != ''/);
  assert.ok(electron.steps.some(step => step.with?.name === 'bot-runtime-images' && step.with['run-id'] === '${{ inputs.signed_bot_manifest_run }}'));
  assert.doesNotMatch(electron.steps.find(step => step.name === 'Build Electron app (arm64)').run, /DEVRYAN_BOT_RUNTIME_MANIFEST_URL/);
  assert.match(electron.steps.find(step => step.name === 'Prepare DMG artifact').run, /DevRyan-manual-Developer-ID-\$\{VERSION\}/);
  assert.equal(electron.steps.find(step => step.name === 'Upload DMG artifact').with['retention-days'], 14);
  assert.ok(Object.values(workflow.jobs).find(job => job.name?.startsWith('Build DMG')));
});

test('the stable tag never rebuilds or repackages its frozen candidate DMG', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const job = jobs['build-desktop-electron-macos'];
  const packageStep = job.steps.find(step => step.name === 'Package prepared Electron app');
  assert.match(packageStep.if, /env.RELEASE_CANDIDATE == 'true'/);
  const download = job.steps.find(step => step.name === 'Download exact admitted candidate installer');
  assert.equal(download.with['run-id'], '${{ needs.create-release.outputs.candidate_run }}');
  assert.match(download.if, /env.RELEASE_CANDIDATE != 'true'/);
  assert.ok(job.steps.some(step => step.env?.RELEASE_OPERATION === 'candidate-verify'));
  assert.ok(jobs['final-dmg-smoke'].steps.some(step => /--identity artifacts\/smoke-identity.json/.test(step.run ?? '')));
  const proof = jobs['finalize-release'].steps.find(step => step.name === 'Retain original finalization and deployment proof');
  assert.equal(proof.with['retention-days'], 90);
  for (const name of ['build-web-artifact', 'prepare-desktop-electron-macos']) {
    assert.match(jobs[name].if, /outputs.scope == 'full' \|\| \(github.event_name == 'workflow_dispatch' && inputs.candidate == true\)/);
  }
  assert.match(job.if, /always\(\) && !cancelled\(\)/);
  assert.match(job.if, /needs.create-release.result == 'success'/);
  assert.match(job.if, /needs.publish-bot-runtime-images.result == 'success'/);
  assert.match(job.if, /needs.prepare-desktop-electron-macos.result == 'success' && needs.build-web-artifact.result == 'success'/);
  assert.match(job.if, /outputs.scope == 'desktop-macos-arm64'.*needs.prepare-desktop-electron-macos.result == 'skipped' && needs.build-web-artifact.result == 'skipped'/);
});


test('candidate budget qualifies before draft creation and retained publication proof survives discovery failure', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const candidate = jobs['candidate-budget'];
  assert.deepEqual(candidate.needs, ['create-release', 'candidate-startup', 'candidate-upgrade-rollback']);
  assert.equal(candidate.steps.find(step => step.env?.RELEASE_OPERATION === 'candidate-budget').run, 'node scripts/release-ci.mjs');
  assert.equal(candidate.steps.find(step => step.with?.name === 'DevRyan-candidate-smoke-budget').with['retention-days'], 90);
  const ci = fs.readFileSync(new URL('./release-ci.mjs', import.meta.url), 'utf8');
  const admission = ci.slice(ci.indexOf("case 'source-admit':"), ci.indexOf("case 'candidate-budget':"));
  assert.ok(admission.indexOf('await resolveQualifiedReleaseCandidate(') < admission.indexOf('const admission = await admitRelease('));
  const retained = jobs['finalize-release'].steps.find(step => step.name === 'Retain original finalization and deployment proof');
  assert.match(retained.if, /always\(\)/);
  const manual = YAML.parse(fs.readFileSync(new URL('../.github/workflows/build-macos-arm64-dmg.yml', import.meta.url), 'utf8'));
  for (const job of Object.values(manual.jobs)) {
    assert.match(job.steps.find(step => step.name === 'Upload DMG artifact').with.name, /^DevRyan-/);
    assert.ok(!job.steps.some(step => step.uses?.startsWith('softprops/action-gh-release@')));
  }
});

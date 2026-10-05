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
  assert.deepEqual(finalize.needs, ['create-release', 'publish-bot-runtime-images', 'build-desktop-electron-macos', 'publish-npm']);
  for (const prerequisite of ['create-release', 'publish-bot-runtime-images', 'build-desktop-electron-macos']) {
    assert.ok(finalize.if.includes(`needs.${prerequisite}.result == 'success'`));
  }
  assert.equal(jobs['combine-electron-manifests'], undefined);
  assert.doesNotMatch(finalize.if, /combine-electron-manifests/);
  const verification = finalize.steps.find(step => step.run === 'node scripts/verify-release-assets.mjs');
  assert.equal(verification.env.RELEASE_SCOPE, '${{ needs.create-release.outputs.scope }}');
  assert.ok(finalize.steps.find(step => step.name === 'Deploy and verify Supabase configuration and migrations'));
});

test('public release uploads only the arm64 DMG and the full-scope web tarball', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const uploads = Object.entries(jobs).flatMap(([job, { steps }]) => steps
    .filter((step) => step.uses?.startsWith('softprops/action-gh-release@') && step.with?.files)
    .map((step) => [job, step.with.files]));
  assert.deepEqual(uploads, [
    ['publish-npm', 'artifacts/*.tgz'],
    ['build-desktop-electron-macos', 'packages/electron/dist/DevRyan-${{ needs.create-release.outputs.version }}-arm64.dmg'],
  ]);
  const desktop = jobs['build-desktop-electron-macos'];
  assert.equal(desktop.steps.find((step) => step.name === 'Upload DMG to release').with.fail_on_unmatched_files, true);
  assert.ok(!desktop.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@') && /latest-mac\.yml/.test(step.with?.path || '')));
  const manifest = jobs['publish-bot-runtime-images'].steps.find((step) => step.name === 'Upload Bot runtime manifest for Electron release builds');
  assert.match(manifest.uses, /^actions\/upload-artifact@/);
  assert.equal(manifest.with.name, 'bot-runtime-images');
});

test('Bot image jobs reuse verified input-addressed images unless a refresh is requested', async () => {
  const { BOT_RUNTIME_IMAGE_BUILD_RECIPE } = await import('./bot-runtime-image-inputs.mjs');
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const refresh = workflow.on.workflow_dispatch.inputs.rebuild_bot_images;
  assert.equal(refresh.type, 'boolean');
  assert.equal(refresh.default, false);
  const { steps } = workflow.jobs['build-bot-runtime-image'];
  const position = (predicate) => steps.findIndex(predicate);
  const resolve = position((step) => step.env?.RELEASE_OPERATION === 'image-resolve');
  const cosign = position((step) => step.uses?.startsWith('sigstore/cosign-installer@'));
  const login = position((step) => step.uses?.startsWith('docker/login-action@'));
  const build = position((step) => step.uses?.startsWith('docker/build-push-action@'));
  const sign = position((step) => step.env?.RELEASE_OPERATION === 'image-sign');
  const upload = position((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(login < resolve && cosign < resolve && resolve < build && build < sign && sign < upload);
  assert.equal(steps[resolve].id, 'resolve');
  assert.equal(steps[resolve].env.IMAGE_KEY, '${{ matrix.image }}');
  assert.equal(steps[resolve].env.REBUILD_BOT_IMAGES, "${{ github.event.inputs.rebuild_bot_images == 'true' }}");
  for (const index of [build, sign]) {
    assert.equal(steps[index].if, 'contains(fromJSON(steps.resolve.outputs.build), matrix.image)');
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
});

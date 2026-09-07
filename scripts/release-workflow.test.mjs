import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';

test('release graph shares one web build and gates packaging on complete inputs', () => {
  const { jobs } = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const images = jobs['build-bot-runtime-image'];
  assert.equal(images.strategy['max-parallel'], 3);
  assert.equal(images.strategy['fail-fast'], false);
  assert.equal(new Set(images.strategy.matrix.image).size, 6);
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

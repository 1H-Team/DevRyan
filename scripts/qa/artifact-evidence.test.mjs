import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureQaArtifactIdentity, captureQaElectronAppIdentity, preserveQaProject, sanitizeQaResult, validateQaScreenshotFilename } from './artifact-evidence.mjs';
import { createQaProjectFixture } from './project-fixture.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const cache = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));

test('Electron donor identity pins framework aliases and bytes while generic artifacts refuse them', async () => {
  await mkdir(cache, { recursive: true });
  const output = await realpath(await mkdtemp(path.join(cache, 'app-identity-test-')));
  const app = path.join(output, 'DevRyan QA.app'), framework = path.join(app, 'Contents/Frameworks/Electron.framework');
  try {
    await mkdir(path.join(framework, 'Versions/A'), { recursive: true });
    await writeFile(path.join(framework, 'Versions/A/Electron'), 'original native bytes');
    await chmod(path.join(framework, 'Versions/A/Electron'), 0o755);
    await symlink('A', path.join(framework, 'Versions/Current'));
    await symlink('Versions/Current/Electron', path.join(framework, 'Electron'));
    const initial = await captureQaElectronAppIdentity(app);
    assert.equal(initial.entries.length, 3);
    assert.equal(initial.entries.filter(row => row.target).length, 2);
    await assert.rejects(captureQaArtifactIdentity(app), /symbolic link/);
    await writeFile(path.join(framework, 'Versions/A/Electron'), 'changed native bytes');
    assert.notEqual((await captureQaElectronAppIdentity(app)).sha256, initial.sha256);
    await writeFile(path.join(framework, 'Versions/A/Electron'), 'original native bytes');
    await chmod(path.join(framework, 'Versions/A/Electron'), 0o644);
    assert.notEqual((await captureQaElectronAppIdentity(app)).sha256, initial.sha256);
    await chmod(path.join(framework, 'Versions/A/Electron'), 0o755);
    await rm(path.join(framework, 'Electron'));
    await symlink('Versions/A/Electron', path.join(framework, 'Electron'));
    assert.notEqual((await captureQaElectronAppIdentity(app)).sha256, initial.sha256);
    for (const [name, target, expected] of [['absolute', path.join(framework, 'Versions/A/Electron'), /absolute symbolic link/],
      ['outside', '../outside', /escapes the app/], ['broken', 'missing', /ENOENT/], ['cycle', 'cycle', /ELOOP/]]) {
      await writeFile(path.join(output, 'outside'), 'outside bytes');
      const link = path.join(app, name);
      await symlink(target, link);
      await assert.rejects(captureQaElectronAppIdentity(app), expected);
      await rm(link);
    }
    await symlink('DevRyan QA.app', path.join(output, 'alias.app'));
    await assert.rejects(captureQaElectronAppIdentity(path.join(output, 'alias.app')), /canonical app/);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('written long mobile screenshot basenames survive real sanitization without exempting other evidence', () => {
  const filename = 'fixture-rich-light-390x844-agent-menu.png';
  const sanitizer = createDiagnosticSanitizer();
  const evidence = { revision:'1234567',screenshots:['untrusted.png'],detail:filename,
    headers:{authorization:'Bearer synthetic-private-access'} };
  const sanitized = sanitizer.sanitizeExportValue(evidence);
  assert.notEqual(sanitizer.sanitizeText(filename),filename);
  const result = sanitizeQaResult(evidence,sanitizer,[filename]);
  assert.deepEqual(result.screenshots,[filename]);
  assert.equal(result.detail,sanitized.detail);
  assert.deepEqual(result.headers,sanitized.headers);
  assert.equal(JSON.stringify(result).includes('synthetic-private-access'),false);
  for(const unsafe of ['../failure.png','/failure.png','nested/failure.png','nested\\failure.png','https://example.com/failure.png','file:///failure.png','failure.png?token=x','.png','failure.svg']) {
    assert.throws(() => validateQaScreenshotFilename(unsafe),/safe relative PNG basename/);
    assert.throws(() => sanitizeQaResult(evidence,sanitizer,[unsafe]),/safe relative PNG basename/);
  }
});

test('evidence preserves new implementation and test files omitted from git diff', async () => {
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(path.join(cache, 'archive-test-'));
  try {
    const fixture = createQaProjectFixture({ outputRoot: output, runId: 'archive' });
    await writeFile(path.join(fixture.fixtureRoot, 'src/priority.mjs'), 'export const priority = "normal";\n');
    await writeFile(path.join(fixture.fixtureRoot, 'test/priority.test.mjs'), '// New regression test\n');
    const result = await preserveQaProject({ fixture });
    assert.equal(result.complete, true);
    assert.equal(await readFile(path.join(fixture.evidenceDirectory, 'project-files/src/priority.mjs'), 'utf8'), 'export const priority = "normal";\n');
    assert.equal(await readFile(path.join(fixture.evidenceDirectory, 'project-files/test/priority.test.mjs'), 'utf8'), '// New regression test\n');
    const original = await captureQaArtifactIdentity(path.join(fixture.evidenceDirectory, 'project-files'));
    await writeFile(path.join(fixture.evidenceDirectory, 'project-files/src/priority.mjs'), 'export const priority = "high";\n');
    assert.notEqual((await captureQaArtifactIdentity(path.join(fixture.evidenceDirectory, 'project-files'))).sha256, original.sha256);
  } finally { await rm(output, { recursive: true, force: true }); }
});

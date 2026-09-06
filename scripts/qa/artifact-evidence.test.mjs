import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureQaArtifactIdentity, preserveQaProject, sanitizeQaResult, validateQaScreenshotFilename } from './artifact-evidence.mjs';
import { createQaProjectFixture } from './project-fixture.mjs';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const cache = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));

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

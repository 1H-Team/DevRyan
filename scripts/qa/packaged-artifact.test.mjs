import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureQaArtifactIdentity } from './artifact-evidence.mjs';
import { loadQaPackagedArtifact } from './packaged-artifact.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fixture = async action => {
  const root = await mkdtemp(path.join(repository, '.cache/qa/packaged-artifact-test-'));
  try {
    const appPath = path.join(root, 'DevRyan QA.app');
    const resources = path.join(appPath, 'Contents/Resources');
    const binary = path.join(appPath, 'Contents/MacOS/DevRyan QA');
    const artifactDirectory = path.join(resources, 'web-dist');
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, 'test executable placeholder');
    await writeFile(path.join(artifactDirectory, 'index.html'), '<p>QA artifact fixture</p>');
    await writeFile(path.join(resources, 'app.asar'), 'test archive');
    const nativeArtifacts = [];
    for (const relative of ['node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/node-pty/build/Release/pty.node', 'node_modules/node-pty/build/Release/spawn-helper']) {
      const file = path.join(resources, 'app.asar.unpacked', relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `native fixture ${relative}`);
      nativeArtifacts.push({ relative, sha256: createHash('sha256').update(`native fixture ${relative}`).digest('hex') });
    }
    const evidence = { schemaVersion: 1, appPath, binary, nativeSmoke: { sqlite: 'passed', pty: 'passed' },
      nativeArtifacts,
      archiveSha256: createHash('sha256').update('test archive').digest('hex'),
      packagedWebArtifact: await captureQaArtifactIdentity(artifactDirectory) };
    const evidencePath = path.join(root, 'package-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence));
    await action({ root, evidencePath, artifactDirectory, resources, evidence });
  } finally { await rm(root, { recursive: true, force: true }); }
};

test('loads only the recorded package with unchanged shell and served UI', () => fixture(async input => {
  const result = await loadQaPackagedArtifact(input);
  assert.equal(result.binary, input.evidence.binary);
  assert.equal(result.artifactDirectory, input.artifactDirectory);
  await writeFile(path.join(input.artifactDirectory, 'index.html'), '<p>Changed</p>');
  await assert.rejects(loadQaPackagedArtifact(input), /packaged UI changed/);
}));

test('rejects a changed archive and missing package evidence', () => fixture(async input => {
  await writeFile(path.join(input.resources, 'app.asar'), 'changed archive');
  await assert.rejects(loadQaPackagedArtifact(input), /packaged server or shell changed/);
  await assert.rejects(loadQaPackagedArtifact({ root: input.root }), /requires DEVRYAN_QA_PACKAGE_EVIDENCE/);
}));

test('rejects provenance outside the allowed repository before consuming it', () => fixture(async input => {
  await assert.rejects(loadQaPackagedArtifact({ root: input.artifactDirectory, evidencePath: input.evidencePath }), /evidence must remain inside/);
}));

test('rejects native drift even when the archive and UI remain unchanged', () => fixture(async input => {
  const native = input.evidence.nativeArtifacts[1];
  await loadQaPackagedArtifact(input);
  await writeFile(path.join(input.resources, 'app.asar.unpacked', native.relative), 'changed native binary');
  await assert.rejects(loadQaPackagedArtifact(input), /packaged native artifact changed/);
}));

test('rejects missing native provenance and paths escaping the unpacked package', () => fixture(async input => {
  const native = input.evidence.nativeArtifacts.pop();
  await writeFile(input.evidencePath, JSON.stringify(input.evidence));
  await assert.rejects(loadQaPackagedArtifact(input), /native artifact evidence is incomplete/);
  input.evidence.nativeArtifacts.push({ ...native, relative: '../outside' });
  await writeFile(input.evidencePath, JSON.stringify(input.evidence));
  await assert.rejects(loadQaPackagedArtifact(input), /native artifact evidence is invalid/);
  input.evidence.nativeArtifacts[input.evidence.nativeArtifacts.length - 1] = native;
  await writeFile(input.evidencePath, JSON.stringify(input.evidence));
  const file = path.join(input.resources, 'app.asar.unpacked', native.relative);
  await rm(file);
  const outside = path.join(input.root, 'outside-native');
  await writeFile(outside, 'outside');
  await symlink(outside, file);
  await assert.rejects(loadQaPackagedArtifact(input), /native artifact escaped/);
}));

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { repositoryRoot, repositoryPath } from './artifacts.mjs';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { fixtureSha256 } from './migration-fixture.mjs';

/** Checkout provenance belongs to QA; portable production verification has no source dependency. */
export async function verifyPackageBuildInputs({ manifest }) {
  assert.equal(fixtureSha256(await fs.readFile(path.join(repositoryRoot, 'bun.lock'))), manifest.inputs.lockSha256);
  const rows = [...manifest.inputs.buildSources, ...manifest.inputs.sourceFiles];
  for (const row of rows) {
    assert.equal(path.isAbsolute(row.path), false); assert.equal(path.normalize(row.path), row.path);
    assert.equal(row.path.split(path.sep).includes('..'), false);
    const file = await repositoryPath(path.join(repositoryRoot, row.path)), hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.equal(hash.digest('hex'), row.sha256, `Compiled input changed: ${row.path}`);
  }
  return { id: 'compiled-current-build-inputs', status: 'passed', inputCount: rows.length, source: 'actual-current-lock-build-and-linked-source-digests' };
}

/** Alter only disposable manifests; hard-linked immutable binaries are never written. */
export async function runPortableArtifactTampering({ artifacts, root }) {
  const directory = path.join(root, 'portable-artifact-control'); await fs.mkdir(directory);
  for (const file of artifacts.manifest.files) {
    const destination = path.join(directory, file.path); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.link(path.join(artifacts.directory, file.path), destination);
  }
  const manifestPath = path.join(directory, 'native-bundle.json'), launcher = path.join(directory, path.basename(artifacts.launcher));
  const bytes = await fs.readFile(artifacts.manifestPath);
  await fs.writeFile(manifestPath, bytes);
  const originalHash = fixtureSha256(bytes);
  await verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: originalHash, launcher });
  await fs.appendFile(manifestPath, '\n');
  await assert.rejects(verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: originalHash, launcher }),
    error => error.code === 'native_runtime_artifacts_unverified');
  for (const field of ['sha256', 'mode']) {
    const tampered = structuredClone(artifacts.manifest);
    const output = tampered.files.find(file => file.role === 'writer');
    output[field] = field === 'sha256' ? '0'.repeat(64) : output.mode ^ 0o100;
    const changed = JSON.stringify(tampered) + '\n'; await fs.writeFile(manifestPath, changed);
    await assert.rejects(verifyNativeRuntimeArtifacts({ manifestPath, manifestSha256: fixtureSha256(changed), launcher }),
      error => error.code === 'native_runtime_artifacts_unverified', `Recomputed outer manifest accepted wrong ${field}`);
  }
  await fs.rm(directory, { recursive: true });
  return { id: 'portable-artifact-tamper-refusal', status: 'passed', controls: ['portable-valid', 'manifest-digest', 'output-hash', 'output-mode'],
    source: 'actual-portable-artifact-verifier-and-codesign' };
}

/** This is a native FileMutation formatter subprocess inside the real writer's private view. */
export async function runCompiledFormatter({ directory, writerConfig, invoke }) {
  await fs.writeFile(path.join(directory, 'package-formatter.sh'),
    '#!/bin/sh\nset -eu\n/usr/bin/tr "a-z" "A-Z" < "$1" > "$1.formatted"\n/bin/mv "$1.formatted" "$1"\nprintf "ran\\n" >> package-formatter-count.txt\n');
  writerConfig.formatter = { qualification: { command: ['/bin/sh', './package-formatter.sh', '$FILE'], extensions: ['.nativefmt'] } };
  try {
    const call = await invoke({ id: 'compiled-formatter', tool: 'write', input: { path: 'compiled.nativefmt', content: 'real compiled formatter\n' } });
    assert.equal(call.state.status, 'completed');
    assert.equal(await fs.readFile(path.join(directory, 'compiled.nativefmt'), 'utf8'), 'REAL COMPILED FORMATTER\n');
    assert.equal(await fs.readFile(path.join(directory, 'package-formatter-count.txt'), 'utf8'), 'ran\n');
  } finally { writerConfig.formatter = false; }
  return { id: 'compiled-formatter-subprocess', status: 'passed', source: 'native-FileMutation-and-real-private-view-formatter' };
}

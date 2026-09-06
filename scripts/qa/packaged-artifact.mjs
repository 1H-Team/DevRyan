import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureQaArtifactIdentity } from './artifact-evidence.mjs';

const within = (parent, child) => child.startsWith(`${parent.replace(/\/$/, '')}${path.sep}`);
const requiredNativeArtifacts = [
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/build/Release/spawn-helper',
];

export async function loadQaPackagedArtifact({ root, evidencePath }) {
  if (!evidencePath) throw new Error('Electron matrix acceptance requires DEVRYAN_QA_PACKAGE_EVIDENCE from package-electron.mjs');
  const canonicalRoot = await realpath(root);
  const file = await realpath(path.resolve(root, evidencePath));
  if (!within(canonicalRoot, file)) throw new Error('QA package evidence must remain inside this repository');
  const evidence = JSON.parse(await readFile(file, 'utf8'));
  if (evidence.schemaVersion !== 1 || typeof evidence.appPath !== 'string' || typeof evidence.binary !== 'string'
    || !/^[a-f0-9]{64}$/.test(evidence.archiveSha256 ?? '') || evidence.nativeSmoke?.sqlite !== 'passed'
    || evidence.nativeSmoke?.pty !== 'passed') throw new Error('QA package evidence is incomplete');
  const appPath = await realpath(evidence.appPath);
  const binary = await realpath(evidence.binary);
  if (!within(canonicalRoot, appPath) || !within(appPath, binary)) throw new Error('QA packaged application must remain inside this repository');
  const resources = await realpath(path.join(appPath, 'Contents/Resources'));
  if (!within(appPath, resources)) throw new Error('QA packaged resources escaped the application');
  const archive = await readFile(path.join(resources, 'app.asar'));
  if (createHash('sha256').update(archive).digest('hex') !== evidence.archiveSha256) throw new Error('QA packaged server or shell changed after packaging');
  if (!Array.isArray(evidence.nativeArtifacts)) throw new Error('QA packaged native artifact evidence is incomplete');
  const nativeRoot = await realpath(path.join(resources, 'app.asar.unpacked'));
  if (!within(resources, nativeRoot)) throw new Error('QA packaged native artifacts escaped the application');
  const inspected = new Set();
  for (const artifact of evidence.nativeArtifacts) {
    const relative = artifact?.relative;
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')
      || inspected.has(relative) || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
      throw new Error('QA packaged native artifact evidence is invalid');
    }
    const nativeFile = await realpath(path.join(nativeRoot, relative));
    if (!within(nativeRoot, nativeFile)) throw new Error('QA packaged native artifact escaped the application');
    if (createHash('sha256').update(await readFile(nativeFile)).digest('hex') !== artifact.sha256) {
      throw new Error(`QA packaged native artifact changed after packaging: ${relative}`);
    }
    inspected.add(relative);
  }
  if (requiredNativeArtifacts.some(relative => !inspected.has(relative))) throw new Error('QA packaged native artifact evidence is incomplete');
  const artifactDirectory = path.join(resources, 'web-dist');
  const artifact = await captureQaArtifactIdentity(artifactDirectory);
  if (artifact.sha256 !== evidence.packagedWebArtifact?.sha256) throw new Error('QA packaged UI changed after packaging');
  return { binary, artifactDirectory, evidence, evidencePath: file };
}

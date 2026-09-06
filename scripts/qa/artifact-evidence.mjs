import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertQaProjectFixtureOwned } from './project-fixture.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateQaScreenshotFilename(filename) {
  if (typeof filename !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/.test(filename)) {
    throw new Error('QA screenshot must use a safe relative PNG basename');
  }
  return filename;
}

// Only the screenshot callback's successfully written, fixed-step filenames
// bypass content sanitization. Other evidence retains the shared sanitizer.
export function sanitizeQaResult(evidence, sanitizer, capturedScreenshots) {
  return { ...sanitizer.sanitizeExportValue(evidence), revision: evidence.revision,
    screenshots: capturedScreenshots.map(validateQaScreenshotFilename) };
}

export async function captureQaSourceIdentity(root) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
    .toString('utf8').split('\0').filter(file => file.startsWith('packages/') || ['package.json', 'bun.lock'].includes(file));
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    try {
      const stats = await lstat(path.join(root, file));
      if (!stats.isFile()) continue;
      entries.push({ file, sha256: digest(await readFile(path.join(root, file))) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; entries.push({ file, deleted: true }); }
  }
  return { sha256: digest(JSON.stringify(entries)), entries };
}

export async function captureQaArtifactIdentity(directory) {
  const entries = [];
  const visit = async relative => {
    const files = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('QA artifact contains a symbolic link');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) entries.push({ file, sha256: digest(await readFile(path.join(directory, file))) });
    }
  };
  await visit('');
  return { sha256: digest(JSON.stringify(entries)), entries };
}

// Preserve added source files too: a Git diff by itself omits untracked repairs
// and tests. Bound the archive and report any omission before fixture deletion.
export async function preserveQaProject({ fixture, sanitize = String }) {
  assertQaProjectFixtureOwned(fixture);
  const destination = path.join(fixture.evidenceDirectory, 'project-files');
  const entries = [];
  let bytes = 0;
  const visit = async relative => {
    const files = await readdir(path.join(fixture.fixtureRoot, relative), { withFileTypes: true });
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (relative === '' && entry.name === '.git') continue;
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('QA project archive contains a symbolic link');
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) throw new Error('QA project archive contains a non-file entry');
      const stats = await lstat(path.join(fixture.fixtureRoot, file));
      if (entries.length >= 500 || stats.size > 4 * 1024 * 1024 || bytes + stats.size > 16 * 1024 * 1024) {
        throw new Error('QA project archive exceeds its evidence limit; original project retained');
      }
      const content = await readFile(path.join(fixture.fixtureRoot, file));
      const isPng = content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const output = isPng ? content : Buffer.from(sanitize(content.toString('utf8')));
      await mkdir(path.dirname(path.join(destination, file)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(destination, file), output, { mode: 0o600 });
      bytes += stats.size;
      entries.push({ file, bytes: stats.size, originalSha256: digest(content), archivedSha256: digest(output) });
    }
  };
  await visit('');
  await writeFile(path.join(fixture.evidenceDirectory, 'project-integrity.json'), JSON.stringify({ entries, bytes }, null, 2), { mode: 0o600 });
  return { files: entries.length, bytes, complete: true };
}

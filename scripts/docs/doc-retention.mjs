#!/usr/bin/env node
// Documentation guardrail: no codemap files. Errors are `{ path, line, message }`.
//
// Standalone: `node scripts/docs/doc-retention.mjs` (nonzero exit on any error).
// Embedded: `docRetentionErrorMessages(root)` returns printable `path:line: message`
// strings for `scripts/docs/validate-docs.mjs`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REVIEWED_INPUTS = 'packages/web/runtime/reviewed-inputs/';

const toPosix = (value) => value.split(path.sep).join('/');
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);
const isNodeModules = (file) => /(?:^|\/)node_modules\//.test(file);

export function isCodemapFile(file) {
  const name = baseName(file);
  return name === 'codemap.md' || name === 'CODEMAP.md';
}

export function formatDocRetentionError({ path: file, line, message }) {
  return `${file}:${line}: ${message}`;
}

export function listRepositoryFiles(root) {
  // Includes new untracked (non-ignored) files so a change is checked before it is committed.
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0');
  return [...new Set(listed)].filter((file) => file && existsSync(path.join(root, file)));
}

/** Codemaps were removed; module contracts live in the nearest DOCUMENTATION.md. */
export function lintNoCodemaps(files) {
  return files
    .filter((file) => isCodemapFile(file) && !file.startsWith(REVIEWED_INPUTS) && !isNodeModules(file))
    .map((file) => ({
      path: file, line: 1,
      message: 'codemap files were removed from this repository; put module contracts in the nearest DOCUMENTATION.md',
    }));
}

/**
 * Run every rule. `files` is a repo-relative POSIX file list (injectable for
 * tests); contents are read from `root`.
 */
export function validateDocRetention(root, files) {
  const posix = files.map(toPosix).filter((file) => !isNodeModules(file));
  const errors = lintNoCodemaps(posix);
  errors.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.message.localeCompare(b.message));
  return { errors };
}

export function docRetentionErrorMessages(root) {
  return validateDocRetention(root, listRepositoryFiles(root)).errors.map(formatDocRetentionError);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { errors } = validateDocRetention(root, listRepositoryFiles(root));
  for (const error of errors) console.error(formatDocRetentionError(error));
  if (errors.length > 0) {
    console.error(`Doc retention check failed: ${errors.length} error(s).`);
    process.exit(1);
  }
  console.log('Doc retention check passed.');
}

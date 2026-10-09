#!/usr/bin/env node
// Documentation guardrails: no codemap files, and audit-evidence retention under
// docs/audits. Errors are `{ path, line, message }`.
//
// Standalone: `node scripts/docs/doc-retention.mjs` (nonzero exit on any error).
// Embedded: `docRetentionErrorMessages(root)` returns printable `path:line: message`
// strings for `scripts/docs/validate-docs.mjs`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { documentReferences } from './repository-links.mjs';

export const AUDIT_FILE_LIMIT_BYTES = 200 * 1024;
const AUDIT_BANNED_EXTENSIONS = new Set(['.jsonl', '.log', '.webm', '.mp4', '.mjs']);

// Evidence files whose SHA-256 is pinned by
// packages/web/server/lib/opencode/harness-duplicate-qualification.test.js.
// They are the only audit files allowed above AUDIT_FILE_LIMIT_BYTES.
export const AUDIT_PINNED_EVIDENCE = new Set([
  'docs/audits/2026-09-20-context-deduplication/live-acceptance.json',
  'docs/audits/2026-09-24-companion-requalification/live-acceptance.json',
  'docs/audits/2026-09-24-duplicate-routes/xai-46/live-acceptance.json',
  'docs/audits/2026-09-24-duplicate-routes/xai-47/live-acceptance.json',
  'docs/audits/2026-09-24-duplicate-routes/openai-astra/live-acceptance.json',
  'docs/audits/2026-09-24-duplicate-routes/openai-sol/live-acceptance.json',
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const REVIEWED_INPUTS = 'packages/web/runtime/reviewed-inputs/';

const toPosix = (value) => value.split(path.sep).join('/');
const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);
const isNodeModules = (file) => /(?:^|\/)node_modules\//.test(file);

export function isCodemapFile(file) {
  const name = baseName(file);
  return name === 'codemap.md' || name === 'CODEMAP.md';
}

/** Files that may cite audit evidence: the changelog, top-level docs/*.md and any DOCUMENTATION.md. */
export function isCitingSource(file) {
  return file === 'CHANGELOG.md' || /^docs\/[^/]+\.md$/.test(file) || baseName(file) === 'DOCUMENTATION.md';
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

function readCorpus(root, files) {
  return files.filter(isCitingSource).map((file) => ({ file, source: readFileSync(path.join(root, file), 'utf8') }));
}

function isCited(entry, corpus) {
  const substring = new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`);
  for (const { file, source } of corpus) {
    if (substring.test(source)) return true;
    for (const { target, kind } of documentReferences(source)) {
      if (kind !== 'link' || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
      let local;
      try { local = decodeURIComponent(target.split(/[?#]/)[0]); } catch { continue; }
      if (!local) continue;
      const resolved = local.startsWith('/') ? path.posix.normalize(local.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), local));
      if (resolved === entry || resolved.startsWith(`${entry}/`)) return true;
    }
  }
  return false;
}

/**
 * Audit retention under docs/audits. New-layout entries are
 * `docs/audits/<YYYY-MM-DD>/<slug>/` (or a loose file in the date folder);
 * legacy `<date>-<slug>` names are grandfathered.
 */
export function lintAuditRetention(root, files, { pinned = AUDIT_PINNED_EVIDENCE } = {}) {
  const errors = [];
  const audits = files.filter((file) => file.startsWith('docs/audits/'));
  const dirsNeedingReadme = new Set();
  const entries = new Set(); // new-layout citation targets
  for (const file of audits) {
    const parts = file.split('/');
    const extension = path.posix.extname(file).toLowerCase();
    if (AUDIT_BANNED_EXTENSIONS.has(extension)) {
      errors.push({ path: file, line: 1, message: `audit evidence must not keep ${extension} files (raw logs, recordings and scripts are regenerated, not archived)` });
    }
    const size = statSync(path.join(root, file)).size;
    if (size > AUDIT_FILE_LIMIT_BYTES && !pinned.has(file)) {
      errors.push({ path: file, line: 1, message: `audit file is ${size} bytes (max ${AUDIT_FILE_LIMIT_BYTES}); summarize it, or pin it in AUDIT_PINNED_EVIDENCE if a test hash-checks it` });
    }
    if (parts.length >= 4 && DATE_ONLY.test(parts[2])) {
      if (parts.length === 4) entries.add(file); // loose file directly in a date folder
      else { dirsNeedingReadme.add(parts.slice(0, 4).join('/')); entries.add(parts.slice(0, 4).join('/')); }
    }
  }
  for (const directory of [...dirsNeedingReadme].sort()) {
    if (!audits.includes(`${directory}/README.md`)) {
      errors.push({ path: directory, line: 1, message: 'audit entry directory needs a README.md' });
    }
  }
  const corpus = readCorpus(root, files);
  for (const entry of [...entries].sort()) {
    if (!isCited(entry, corpus)) {
      errors.push({ path: entry, line: 1, message: `audit entry is not cited from CHANGELOG.md, docs/*.md or a DOCUMENTATION.md; cite "${entry}" or delete it` });
    }
  }
  return errors;
}

/**
 * Run every rule. `files` is a repo-relative POSIX file list (injectable for
 * tests); contents are read from `root`.
 */
export function validateDocRetention(root, files, { pinned = AUDIT_PINNED_EVIDENCE } = {}) {
  const posix = files.map(toPosix).filter((file) => !isNodeModules(file));
  const errors = [...lintNoCodemaps(posix), ...lintAuditRetention(root, posix, { pinned })];
  errors.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.message.localeCompare(b.message));
  return { errors };
}

export function docRetentionErrorMessages(root, options) {
  return validateDocRetention(root, listRepositoryFiles(root), options).errors.map(formatDocRetentionError);
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 0.1.10 and 0.1.12 publish the same executable. Keep the former eligible
// for an offline/degraded installation without changing its package version.
const ORIGINAL_SHA256 = '37fc82bf739d0a87a8f6274ffe3b180d4d20c4d3381f5d7d89c0f5c483f32246';
const EDITS = [
  ['var SUBSCRIPTION_MODEL = "gpt-5.5";', 'var SUBSCRIPTION_MODEL = "gpt-6-astra";'],
  ['    model: SUBSCRIPTION_MODEL,', '    model: SUBSCRIPTION_MODEL,\n    reasoning: { effort: "medium" },'],
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const incompatible = error => ({ ok: false, changed: false, code: 'DEVRYAN_IMAGEGEN_MODEL_INCOMPATIBLE', error });

export function applyImagegenModelHotfix({ configDirectory, fs: fsApi = fs, expectedOriginalSha256 = ORIGINAL_SHA256 } = {}) {
  const packageRoot = path.join(configDirectory, 'node_modules/opencode-gpt-imagegen');
  const entry = path.join(packageRoot, 'dist/index.js');
  let source;
  let version;
  try {
    version = JSON.parse(fsApi.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
    if (!['0.1.10', '0.1.12'].includes(version)) return incompatible('Image plugin version has not been reviewed');
    source = fsApi.readFileSync(entry, 'utf8');
  } catch { return incompatible('Image plugin files are unavailable'); }
  const original = EDITS.reduce((text, [before, after]) => text.replace(after, before), source);
  if (sha256(original) !== expectedOriginalSha256
    || EDITS.some(([before]) => original.split(before).length !== 2)) {
    return incompatible('Image plugin source differs from the reviewed executable');
  }
  const patched = EDITS.reduce((text, [before, after]) => text.replace(before, after), original);
  if (source !== original && source !== patched) return incompatible('Image plugin contains an incomplete model patch');
  if (source !== patched) {
    const temporary = `${entry}.${crypto.randomUUID()}.tmp`;
    try {
      fsApi.writeFileSync(temporary, patched, 'utf8');
      // Rename also breaks package-manager hard links; do not mutate its cache.
      fsApi.renameSync(temporary, entry);
    } catch { return incompatible('Image plugin model patch could not be installed atomically'); }
    finally { if (fsApi.existsSync(temporary)) fsApi.unlinkSync(temporary); }
  }
  return { ok: true, changed: source !== patched, version, model: 'gpt-6-astra', reasoningEffort: 'medium', sourceSha256: sha256(patched) };
}

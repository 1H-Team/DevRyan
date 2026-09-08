import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MERIDIAN_HANDOFF_EDITS, MERIDIAN_HANDOFF_HELPER, MERIDIAN_HANDOFF_V1_EDITS, patchMeridianHandoff, stripMeridianHandoffPatch } from './meridian-passthrough-hotfix.js';
import { MERIDIAN_168_EDITS, MERIDIAN_168_HANDOFF_EDITS } from './meridian-upgrade-patches.js';

export const MERIDIAN_HTTP_HOTFIX_VERSION = '1.62.6';
export const MERIDIAN_HTTP_HOTFIX_ORIGINAL_SHA256 = '522decb5f1d2775c04f3a5c9b7e75f49a41fa40de1a62ebe4e2806167ca7b0ab';
export const MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE = 'MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE';
export const MERIDIAN_REVIEWED_PATCHES = Object.freeze({
  '1.62.6': Object.freeze({
    entry: 'cli-wxk8xvd3.js', originalSha256: MERIDIAN_HTTP_HOTFIX_ORIGINAL_SHA256,
    edits: MERIDIAN_HANDOFF_EDITS, previousEdits: MERIDIAN_HANDOFF_V1_EDITS,
  }),
  '1.68.0': Object.freeze({
    entry: 'cli-0zhb8ss4.js', originalSha256: '738e3782bb54d66422fff39b68cef3df3550917252878e3db568b06892b345ef',
    edits: MERIDIAN_168_EDITS, previousEdits: MERIDIAN_168_HANDOFF_EDITS,
  }),
});
const HELPER = 'devryan-meridian-http-server.js';
const IMPORT = `import { serveMeridianHttp } from "./${HELPER}";\n`;
export const MERIDIAN_HTTP_SERVER_ORIGINAL = '  const server = serve({\n    fetch: app.fetch,';
const PATCHED = '  const server = serveMeridianHttp({\n    idleTimeoutSeconds: finalConfig.idleTimeoutSeconds,\n    fetch: app.fetch,';
const ORIGINAL_END = '  });\n  const idleMs = finalConfig.idleTimeoutSeconds * 1000;';
const PATCHED_END = '  }, serve);\n  const idleMs = finalConfig.idleTimeoutSeconds * 1000;';
const sha256 = source => crypto.createHash('sha256').update(source).digest('hex');
const helperSource = fs.readFileSync(new URL('./meridian-http-server.js', import.meta.url), 'utf8');
const handoffSource = fs.readFileSync(new URL('./meridian-passthrough-handoff.js', import.meta.url), 'utf8');
const incompatible = error => ({ ok: false, changed: false, code: MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE, error });

export const applyMeridianHttpHotfix = ({ configDirectory, fs: fsApi = fs,
  expectedOriginalSha256 } = {}) => {
  const packageRoot = path.join(configDirectory, 'node_modules/@rynfar/meridian');
  const helper = path.join(packageRoot, 'dist', HELPER);
  let source;
  let version;
  let review;
  let entry;
  try {
    const manifest = JSON.parse(fsApi.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    version = manifest.version;
    review = Object.hasOwn(MERIDIAN_REVIEWED_PATCHES, version) ? MERIDIAN_REVIEWED_PATCHES[version] : null;
    if (!review) return incompatible('Meridian HTTP hotfix requires an exact reviewed package version');
    entry = path.join(packageRoot, 'dist', review.entry);
    source = fsApi.readFileSync(entry, 'utf8');
  } catch { return incompatible('Meridian HTTP hotfix files are unavailable'); }
  const originalSha256 = expectedOriginalSha256 ?? review.originalSha256;
  const original = stripMeridianHandoffPatch(source, review.edits).replace(IMPORT, '').replace(PATCHED, MERIDIAN_HTTP_SERVER_ORIGINAL).replace(PATCHED_END, ORIGINAL_END);
  if (sha256(original) !== originalSha256) return incompatible('Meridian HTTP source hash is incompatible');
  if (original.split(MERIDIAN_HTTP_SERVER_ORIGINAL).length !== 2 || original.split(ORIGINAL_END).length !== 2) {
    return incompatible('Meridian HTTP source anchors are incompatible');
  }
  const httpPatched = IMPORT + original.replace(MERIDIAN_HTTP_SERVER_ORIGINAL, PATCHED).replace(ORIGINAL_END, PATCHED_END);
  let patched;
  let previousPatched;
  try {
    patched = patchMeridianHandoff(httpPatched, { edits: review.edits });
    previousPatched = patchMeridianHandoff(httpPatched, { edits: review.previousEdits });
  }
  catch { return incompatible('Meridian handoff source anchors are incompatible'); }
  if (source !== original && source !== httpPatched && source !== previousPatched && source !== patched) return incompatible('Meridian source contains an incomplete patch');
  let changed = false;
  try {
    for (const [file, content] of [[helper, helperSource], [path.join(packageRoot, 'dist', MERIDIAN_HANDOFF_HELPER), handoffSource], [entry, patched]]) {
      let previous = null;
      try { previous = fsApi.readFileSync(file, 'utf8'); } catch { /* New managed helper. */ }
      if (previous === content) continue;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        fsApi.writeFileSync(temporary, content, 'utf8');
        fsApi.renameSync(temporary, file);
      } finally {
        if (fsApi.existsSync(temporary)) fsApi.unlinkSync(temporary);
      }
      changed = true;
    }
  } catch { return incompatible('Meridian HTTP hotfix could not be installed atomically'); }
  return { ok: true, changed, version, entry: review.entry, originalSha256,
    sourceSha256: sha256(patched), helperSha256: sha256(helperSource), handoffSha256: sha256(handoffSource),
    transport: 'bun-native-request-signal; node-adapter-preserved', handoff: 'interrupt-after-complete-tool-checkpoint; canonical-terminal-or-verified-native-checkpoint',
    prefix: 'native-fork-at-client-tool-checkpoint; git-snapshot-disabled-for-passthrough',
    background: 'normal-sdk-mode; stop-processing-at-forwarded-tool-hook' };
};

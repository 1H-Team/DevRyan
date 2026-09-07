import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MERIDIAN_HANDOFF_HELPER, patchMeridianHandoff, stripMeridianHandoffPatch } from './meridian-passthrough-hotfix.js';

export const MERIDIAN_HTTP_HOTFIX_VERSION = '1.62.6';
export const MERIDIAN_HTTP_HOTFIX_ORIGINAL_SHA256 = '522decb5f1d2775c04f3a5c9b7e75f49a41fa40de1a62ebe4e2806167ca7b0ab';
export const MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE = 'MERIDIAN_HTTP_HOTFIX_INCOMPATIBLE';
const ENTRY = 'cli-wxk8xvd3.js';
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
  expectedOriginalSha256 = MERIDIAN_HTTP_HOTFIX_ORIGINAL_SHA256 } = {}) => {
  const packageRoot = path.join(configDirectory, 'node_modules/@rynfar/meridian');
  const entry = path.join(packageRoot, 'dist', ENTRY);
  const helper = path.join(packageRoot, 'dist', HELPER);
  let source;
  try {
    const manifest = JSON.parse(fsApi.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== MERIDIAN_HTTP_HOTFIX_VERSION) return incompatible('Meridian HTTP hotfix requires the reviewed 1.62.6 package');
    source = fsApi.readFileSync(entry, 'utf8');
  } catch { return incompatible('Meridian HTTP hotfix files are unavailable'); }
  const original = stripMeridianHandoffPatch(source).replace(IMPORT, '').replace(PATCHED, MERIDIAN_HTTP_SERVER_ORIGINAL).replace(PATCHED_END, ORIGINAL_END);
  if (sha256(original) !== expectedOriginalSha256) return incompatible('Meridian HTTP source hash is incompatible');
  if (original.split(MERIDIAN_HTTP_SERVER_ORIGINAL).length !== 2 || original.split(ORIGINAL_END).length !== 2) {
    return incompatible('Meridian HTTP source anchors are incompatible');
  }
  const httpPatched = IMPORT + original.replace(MERIDIAN_HTTP_SERVER_ORIGINAL, PATCHED).replace(ORIGINAL_END, PATCHED_END);
  let patched;
  try { patched = patchMeridianHandoff(httpPatched); }
  catch { return incompatible('Meridian handoff source anchors are incompatible'); }
  if (source !== original && source !== httpPatched && source !== patched) return incompatible('Meridian source contains an incomplete patch');
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
  return { ok: true, changed, version: MERIDIAN_HTTP_HOTFIX_VERSION, originalSha256: expectedOriginalSha256,
    sourceSha256: sha256(patched), helperSha256: sha256(helperSource), handoffSha256: sha256(handoffSource),
    transport: 'bun-native-request-signal; node-adapter-preserved', handoff: 'interrupt-after-complete-tool-checkpoint; canonical-terminal-or-verified-native-checkpoint' };
};

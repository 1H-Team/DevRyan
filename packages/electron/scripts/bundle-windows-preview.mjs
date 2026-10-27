import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleElectronMain } from './bundle-main.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const outdir = path.join(root, 'dist-bundle');
await bundleElectronMain({ outdir });
// Copy the tiny stdlib/Electron bootstrap rather than letting bundling hoist
// main's static imports ahead of configuration. The existing main bundle
// remains separate and loads only after this literal dynamic import.
for (const name of ['windows-preview-entry.mjs', 'windows-preview.mjs']) {
  await fs.copyFile(path.join(root, name), path.join(outdir, name));
}
const entry = await fs.readFile(path.join(outdir, 'windows-preview-entry.mjs'), 'utf8');
if (!entry.includes('import("./main.mjs")') && !entry.includes("import('./main.mjs')")) throw new Error('windows_preview_entry_order_invalid');

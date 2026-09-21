import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Ship the notices beside the bundled terminal, and reject unrecorded binaries. */
export function terminalAssetsPlugin(directory: string): Plugin {
  return {
    name: 'devryan-terminal-assets',
    apply: 'build',
    generateBundle() {
      const provenance = JSON.parse(readFileSync(path.join(directory, 'provenance.json'), 'utf8')) as {
        assets: Record<string, string>;
      };
      for (const [file, expected] of Object.entries(provenance.assets)) {
        const actual = createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
        if (actual !== expected) this.error(`Terminal asset differs from provenance: ${file}`);
      }
      for (const file of ['LICENSE-ADAPTER', 'LICENSE-T3CODE', 'vendor/LICENSE', 'vendor/VERSION', 'fonts/LICENSE', 'provenance.json']) {
        this.emitFile({ type: 'asset', fileName: `licenses/terminal/${file}`, source: readFileSync(path.join(directory, file)) });
      }
    },
  };
}

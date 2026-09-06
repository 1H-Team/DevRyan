# Coding Agents startup bundle correction

The web startup graph imported the entire Markdown vendor chunk through six small utilities shared with eager markup consumers. `packages/web/vite-chunking.ts` now assigns `property-information`, `hast-util-whitespace`, `comma-separated-tokens`, `space-separated-tokens`, `zwitch`, and `ccount` to `vendor-markup-utils`. Markdown remains lazy. No UI implementation, dependency, budget ceiling, Bot module, or compatibility identifier changed in this optimization.

The declared primary metric is **startup JavaScript bytes**, using the existing `web-main` manifest traversal, entrypoint, and immediate dynamic roots. It does not measure fonts, CSS, interaction latency, startup duration, CPU, or memory.

| Metric | Baseline median | Candidate median | Reduction | Samples / range |
|---|---:|---:|---:|---|
| Raw JavaScript | 5,051,404 B | 4,648,555 B | 402,849 B / 7.97% | 3 fresh processes per condition; 0 B range in each |
| Gzip JavaScript | 1,481,965 B | 1,361,591 B | 120,374 B / 8.12% | 3 fresh processes per condition; 0 B range in each |

Both unchanged ceilings pass: 4,962,877 raw bytes and 1,456,388 gzip bytes. The new shared utility chunk is 28,524 raw / 8,632 gzip bytes. The resulting `vendor-markdown` chunk has only one static importer, the lazy `MarkdownRendererImpl`; the startup graph excludes both. The budget checker now also rejects an eager `vendor-markdown` identity.

Measurements used revision `ff7abd116ca37db53a56981d7de76100f2a97690` plus the recorded working-tree changes, Node 26.0.0, Vite 7.3.6 and Rollup 4.59.0. Every sample used the same installed dependency tree, repository-root working directory, Vite API/config, and separate output directory. All six builds preserved their source fingerprint throughout. Reversing only the new resolver branch **in memory** reproduced the baseline source fingerprint exactly.

| Identity | SHA-256 |
|---|---|
| Baseline production source fingerprint | `5263e13461b34f353bb7d54498f4cce711c38edaaf90383e5ad2ff6d0e4c1e0b` |
| Candidate production source fingerprint | `4d119be4e134d0ed8242edff79fa110e802601cdf3b5b1d1070910d9d9f64e8f` |
| Baseline manifest, identical in all 3 samples | `311ea30c2b909bff8e049d00b16c773a780a77064e8ba7f28995e715f1ff792a` |
| Candidate manifest, identical in all 3 samples | `5a7ab7fa3a2fc479c07d2fe9ba8916457e6cee81e06af1a213786afe901c3dd4` |

`bun run build:web` also passed and refreshed `packages/web/dist` at this bundle checkpoint. Its manifest is `0234c6f0fee40430d3a21926b9187026206e85c933c475ab2039d8bb4b358590`, with 4,648,555 raw / 1,361,608 gzip startup bytes. That command runs from `packages/web`; Tailwind's automatic source detection produces a smaller CSS utility set than the repository-root API samples. The changed CSS filename alters JavaScript preload references and accounts for the different artifact hashes. All 542 comparable JavaScript chunks are identical after normalizing asset references. The 17-byte gzip difference is recorded separately from the matched comparison above. Later acceptance fixes require a fresh final build and its own recorded artifact identity.

The actual browser probe reached the composer, created a new session through the UI, sent attachments, and rendered all 20 response chunks. The first-response screenshot was inspected: chat content and attachment are visible, the composer is reachable, and the app is past startup. This verifies the relevant startup and lazy-rendering behavior, not full Coding Agents acceptance. The same probe later timed out waiting for a pending-reasoning status; that scenario remains a separate QA investigation.

An initial `onlyExplicitManualChunks: true` candidate saved bytes but introduced circular React/Base UI chunks and failed actual browser boot with an undefined `useLayoutEffect`. It was rejected. A five-utility trial still imported Markdown through `ccount` and failed the budgets; it was not accepted. One early measurement reused a Vite process until its heap was exhausted on the third build. That failed run and the second build in the reused process are excluded; every reported sample starts a fresh Node process. Concurrent builds and other host work make elapsed build timings unsuitable for a speed claim.

Validation: 44 chunking tests, web type-check, focused ESLint, `git diff --check`, production web build, and the web bundle gate passed. Six tests build a real Vite graph with an eager consumer and a lazy Markdown consumer, one for each utility package. A temporary resolver fault that omitted the utility assignment made all six fixtures import Markdown eagerly. Full repository and packaged-host acceptance are recorded in the main audit.

Ignored evidence is under `.cache/audit/startup-bundle/`: `reviewed-results.json`, `markup-source-equivalence.json`, the per-sample JSON and module graphs, `regression-fault-control.json`, `final-web-verification.json`, and `final-output-comparison.json`. The three baseline samples are `baseline-1`, `baseline-fresh-2-1`, and `baseline-fresh-3-1`; candidate samples are `markup-candidate-fresh-{1,2,3}-1`. Browser evidence is `.cache/qa/adapter-probes/fixture-adapter-cE839z/fixture-first-response.png`; the rejected boot is recorded in `fixture-adapter-LsJR6u/result.json`.

To reproduce the byte comparison after a normal dependency installation, run this from the repository root. It uses the existing Vite config and budget checker, changes only the measured chunk assignment for the baseline, preserves tracked files and the normal web output, and starts a fresh process for every build:

```sh
for sample_mode in baseline candidate; do
  for sample_run in 1 2 3; do
    DEVRYAN_BUNDLE_MODE="$sample_mode" DEVRYAN_BUNDLE_RUN="$sample_run" node --input-type=module <<'NODE'
import { build } from './packages/web/node_modules/vite/dist/node/index.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import budgets from './scripts/bundle-budgets.config.mjs';
import { checkBundleBudgets } from './scripts/check-bundle-budgets.mjs';
const mode = process.env.DEVRYAN_BUNDLE_MODE;
const run = process.env.DEVRYAN_BUNDLE_RUN;
const output = path.resolve('.cache/audit/startup-bundle/reproduce');
const outDir = path.join(output, `${mode}-${run}`);
await mkdir(output, { recursive: true });
await build({
  configFile: path.resolve('packages/web/vite.config.ts'),
  build: { outDir, emptyOutDir: true },
  plugins: [{
    name: 'startup-comparison-control',
    configResolved(config) {
      if (mode !== 'baseline') return;
      const output = config.build.rollupOptions.output;
      if (!output || Array.isArray(output) || typeof output.manualChunks !== 'function') {
        throw new Error('Expected the web manual chunk resolver');
      }
      const resolve = output.manualChunks;
      output.manualChunks = (...args) => {
        const owner = resolve(...args);
        return owner === 'vendor-markup-utils' ? undefined : owner;
      };
    },
  }],
});
const report = await checkBundleBudgets({
  ...budgets,
  builds: budgets.builds.filter((entry) => entry.id === 'web-main')
    .map((entry) => ({ ...entry, distDir: outDir })),
}, { rootDir: process.cwd() });
const manifest = await readFile(path.join(outDir, '.vite/manifest.json'));
await writeFile(path.join(output, `${mode}-${run}.json`), JSON.stringify({
  mode, run, node: process.version,
  manifestSha256: createHash('sha256').update(manifest).digest('hex'), report,
}, null, 2));
NODE
  done
done
```

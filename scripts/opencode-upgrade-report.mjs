#!/usr/bin/env bun
// Read-only review list for an OpenCode host upgrade (docs/OPENCODE_UPGRADES.md).
// Run it after bumping the @opencode/* manifests and `bun install`: it compares the
// installed candidate with the reviewed pin and prints every seam that needs a
// decision. It edits nothing and contacts the npm registry only to pack the
// previous release for comparison.
//
//   bun scripts/opencode-upgrade-report.mjs            report against the current pin
//   bun scripts/opencode-upgrade-report.mjs --json     the same data as JSON
//   bun scripts/opencode-upgrade-report.mjs --from 2.1.4  compare with another baseline
//   bun scripts/opencode-upgrade-report.mjs --write-openapi  also vendor v2/openapi-<installed>.json
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchParent } from './qa/run-root.mjs';
import { findNativeCoreSources, NATIVE_PHOTON_WORKER_SOURCE } from './native-core-sources.mjs';
import { NATIVE_ASSET_SOURCE_SHA, NATIVE_AGENT_DEFAULTS_SOURCE_SHA256, NATIVE_PHOTON_WORKER_SOURCE_SHA256, NATIVE_WINDOWS_PTY_SOURCE_SHA256 } from './native-runtime-assets.mjs';
import { NATIVE_COMPACTION_SOURCE_SHA256 } from './native-compaction-observation-transform.mjs';
import { NATIVE_FINALIZATION_SOURCE_SHA256 } from './native-finalization-observation-transform.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (file) => import(pathFor(file));
const pathFor = (file) => path.join(repository, file);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PACKAGES = ['ai', 'core', 'plugin', 'schema', 'simulation', 'util', 'sdk', 'server'];

const { TARGET_OPENCODE_VERSION } = await load('packages/web/server/lib/opencode/version-policy.js');
const { OPENCODE_V2_OPENAPI_FILENAME, extractOpenCodeV2Operations } = await load('packages/web/server/lib/opencode/v2/openapi-routes.js');
const { OPENCODE_V2_ROUTE_CLASSES } = await load('packages/web/server/lib/opencode/v2/route-policy.js');
const { REVIEWED_NATIVE_CLONE_RELEASES, REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL } = await load('packages/web/server/lib/opencode/runtime-host/native-bundle-compatibility.js');
const { REVIEWED_NATIVE_PLUGIN_IDS } = await load('packages/web/server/lib/opencode/runtime-host/native-plugin-registry.ts');
const { isReviewedControllerGitArgs, nativeVcsGitFlags } = await load('packages/web/server/lib/opencode/execution-helper-policy.js');

const webModules = pathFor('packages/web/node_modules/@opencode');
const installed = async (name) => fs.realpath(path.join(name === 'sdk' || name === 'server' ? webModules : pathFor('node_modules/@opencode'), name));
const coreRoot = await installed('core');
const candidate = JSON.parse(await fs.readFile(path.join(coreRoot, 'package.json'), 'utf8')).version;
const fromIndex = process.argv.indexOf('--from');
const baseline = fromIndex < 0 ? TARGET_OPENCODE_VERSION : process.argv[fromIndex + 1];
if (!/^2\.\d+\.\d+$/.test(baseline ?? '')) throw new Error('--from needs an exact OpenCode 2.x version');
const report = { pin: TARGET_OPENCODE_VERSION, baseline, candidate, sections: [] };
const section = (title, items, note) => { report.sections.push({ title, note, items }); };

// 1. Pinned core sources: found by content, gated by exact bytes.
{
  const items = [];
  let sources;
  try { sources = await findNativeCoreSources(coreRoot); } catch (error) { items.push({ status: 'action', what: `discovery failed: ${error.message}` }); }
  const pins = [
    ['pty binding', sources?.pty, NATIVE_ASSET_SOURCE_SHA.pty, 'scripts/native-runtime-assets.mjs NATIVE_ASSET_SOURCE_SHA.pty'],
    ['compaction observation', sources?.compaction, NATIVE_COMPACTION_SOURCE_SHA256, 'scripts/native-compaction-observation-transform.mjs (sha + anchor)'],
    ['finalization observation', sources?.finalization, NATIVE_FINALIZATION_SOURCE_SHA256, 'scripts/native-finalization-observation-transform.mjs (sha + anchors)'],
    ['photon worker', path.join(coreRoot, NATIVE_PHOTON_WORKER_SOURCE), NATIVE_PHOTON_WORKER_SOURCE_SHA256, 'scripts/native-runtime-assets.mjs NATIVE_PHOTON_WORKER_SOURCE_SHA256'],
    ['windows pty resolver', path.join(coreRoot, 'dist/persistent-pty/binary.bun.js'), NATIVE_WINDOWS_PTY_SOURCE_SHA256, 'scripts/native-runtime-assets.mjs NATIVE_WINDOWS_PTY_SOURCE_SHA256'],
    ['schema agent defaults', path.join(path.dirname(coreRoot), 'schema/dist/agent.js'), NATIVE_AGENT_DEFAULTS_SOURCE_SHA256, 'scripts/native-runtime-assets.mjs NATIVE_AGENT_DEFAULTS_SOURCE_SHA256'],
  ];
  for (const [what, file, expected, owner] of pins) {
    if (!file) continue;
    const actual = await fs.readFile(file).then(hash, () => null);
    items.push(actual === expected ? { status: 'ok', what, file: path.relative(coreRoot, file) }
      : { status: 'action', what, file: path.relative(coreRoot, file), actual, owner, hint: 'diff the chunk body against the previous release, re-check the anchor, then pin the new sha' });
  }
  section('Pinned core sources', items);
}

// 2. Previous release, packed for comparison only.
await fs.mkdir(scratchParent('opencode-upgrade'), { recursive: true });
const scratch = await fs.mkdtemp(path.join(scratchParent('opencode-upgrade'), 'report-'));
try {
  const previous = {};
  if (candidate !== baseline) {
    for (const name of PACKAGES) {
      const directory = path.join(scratch, name);
      await fs.mkdir(directory);
      const tarball = execFileSync('npm', ['pack', `@opencode/${name}@${baseline}`, '--silent'], { cwd: directory, encoding: 'utf8' }).trim().split('\n').at(-1);
      execFileSync('tar', ['xzf', tarball], { cwd: directory });
      previous[name] = path.join(directory, 'package');
    }
  }

  // 3. Export maps and dependencies.
  {
    const items = [];
    for (const name of PACKAGES) {
      if (!previous[name]) continue;
      const before = JSON.parse(await fs.readFile(path.join(previous[name], 'package.json'), 'utf8'));
      const after = JSON.parse(await fs.readFile(path.join(await installed(name), 'package.json'), 'utf8'));
      const keys = (manifest) => new Set(Object.keys(manifest.exports ?? {}));
      const removed = [...keys(before)].filter((key) => !keys(after).has(key));
      const added = [...keys(after)].filter((key) => !keys(before).has(key));
      const deps = (manifest) => ({ ...manifest.dependencies, ...manifest.peerDependencies });
      const changed = Object.entries(deps(after)).filter(([dep, range]) => !dep.startsWith('@opencode/') && deps(before)[dep] !== range).map(([dep, range]) => `${dep} ${deps(before)[dep] ?? '(new)'} -> ${range}`);
      if (removed.length || added.length > 0 || changed.length) items.push({ status: removed.length ? 'action' : 'review', what: `@opencode/${name}`, removedExports: removed, addedExports: added.length, dependencies: changed });
    }
    // Every repository import must still resolve through the new export maps.
    const files = execFileSync('git', ['grep', '-l', '@opencode/', '--', 'packages', 'scripts', ':!packages/desktop', ':!*.md', ':!*.json'], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter((file) => /\.(?:m?[jt]sx?|cjs)$/.test(file));
    const pattern = /(?:from\s*|import\s*\(\s*|import\s+|require\(\s*)['"](@opencode\/(?:ai|core|plugin|schema|util|sdk|server|simulation|protocol|client|codemode)(?:\/[^'"]*)?)['"]/g;
    for (const file of files) {
      const text = await fs.readFile(pathFor(file), 'utf8');
      for (const match of text.matchAll(pattern)) {
        try { Bun.resolveSync(match[1], pathFor(file)); } catch { items.push({ status: 'action', what: `unresolved import ${match[1]}`, file }); }
      }
    }
    section('Package exports and imports', items);
  }

  // 4. Database migrations decide the clone level.
  {
    const ids = async (root) => (await fs.readdir(path.join(root, 'dist/database/migration')).catch(() => [])).filter((name) => name.endsWith('.js')).map((name) => name.slice(0, -3)).sort();
    const items = [];
    if (previous.core) {
      const before = new Set(await ids(previous.core));
      for (const id of (await ids(coreRoot)).filter((id) => !before.has(id))) {
        const text = await fs.readFile(path.join(coreRoot, 'dist/database/migration', `${id}.js`), 'utf8');
        const chunk = /from "(\.\.\/\.\.\/chunks\/[^"]+)"/.exec(text)?.[1];
        const body = chunk ? await fs.readFile(path.join(coreRoot, 'dist/database/migration', chunk), 'utf8') : text;
        items.push({ status: 'action', what: id, statements: [...body.matchAll(/tx\.run\(`([\s\S]*?)`\)/g)].map((m) => m[1].replace(/\\`/g, '`').replace(/\s+/g, ' ').trim()) });
      }
    }
    section('New database migrations', items, items.length
      ? 'Raise REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL, measure the fresh layout (native-clone-layout.graph.test.ts), revert them in runtime-bundle.test.js startupUpgradeFixture, and check host SQL for dropped tables.'
      : 'None: keep the previous clone level.');
    if (!Object.hasOwn(REVIEWED_NATIVE_CLONE_RELEASES, candidate)) section('Clone release table', [{ status: 'action', what: `add ${candidate} core digest (build output inputs.coreDigest) and level (${JSON.stringify(REVIEWED_NATIVE_CLONE_MIGRATION_LEVEL[TARGET_OPENCODE_VERSION])} before)` }]);
  }

  // 5. HTTP routes: every new operation needs a policy class.
  {
    const server = await installed('server');
    const { OpenApi } = await import(Bun.resolveSync('effect/http-api', path.join(server, 'dist/api.js')));
    const { Api } = await import(path.join(server, 'dist/api.js'));
    const document = JSON.stringify(OpenApi.fromApi(Api), null, 2) + '\n';
    const baselineDocument = pathFor(`packages/web/server/lib/opencode/v2/openapi-${baseline}.json`);
    const vendored = JSON.parse(await fs.readFile(await fs.access(baselineDocument).then(() => baselineDocument, () => pathFor(`packages/web/server/lib/opencode/v2/${OPENCODE_V2_OPENAPI_FILENAME}`)), 'utf8'));
    const key = (operation) => `${operation.method} ${operation.template}`;
    const before = new Map(extractOpenCodeV2Operations(vendored).map((operation) => [key(operation), operation]));
    const after = new Map(extractOpenCodeV2Operations(JSON.parse(document)).map((operation) => [key(operation), operation]));
    const items = [];
    for (const [route, operation] of after) {
      if (!before.has(route)) items.push({ status: Object.hasOwn(OPENCODE_V2_ROUTE_CLASSES, route) ? 'review' : 'action', what: `added ${route}`, operationId: operation.operationId });
      else if (JSON.stringify(before.get(route)) !== JSON.stringify(operation)) items.push({ status: 'review', what: `changed ${route}`, before: before.get(route), after: operation });
    }
    for (const route of before.keys()) if (!after.has(route)) items.push({ status: 'action', what: `removed ${route}` });
    const vendor = `packages/web/server/lib/opencode/v2/openapi-${candidate}.json`;
    if (process.argv.includes('--write-openapi')) { await fs.writeFile(pathFor(vendor), document); report.openapiDocument = vendor; }
    section('HTTP routes', items, `${report.openapiDocument ? `Wrote ${vendor}` : `--write-openapi vendors ${vendor}`}; then set OPENCODE_V2_OPENAPI_VERSION and run node scripts/generate-opencode-v2-routes.mjs.`);
  }

  // 6. Native plugin inventory.
  {
    // Core registers the browser plugin from its own @opencode/plugin-browser dependency.
    const browser = path.join(await fs.realpath(path.join(path.dirname(coreRoot), 'plugin-browser')), 'dist');
    const sources = [...(await fs.readdir(path.join(coreRoot, 'dist/chunks'))).map((name) => path.join(coreRoot, 'dist/chunks', name)), path.join(browser, 'index.js')];
    const declared = new Set(), mentioned = new Set();
    for (const file of sources) {
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      for (const match of text.matchAll(/\bid: "(opencode\.[A-Za-z0-9._-]+)"/g)) declared.add(match[1]);
      for (const match of text.matchAll(/"(opencode\.[A-Za-z0-9._-]+)"/g)) mentioned.add(match[1]);
    }
    const reviewed = new Set(REVIEWED_NATIVE_PLUGIN_IDS);
    section('Native plugin IDs', [
      ...[...declared].filter((id) => !reviewed.has(id)).map((id) => ({ status: 'action', what: `unreviewed ${id}` })),
      ...[...reviewed].filter((id) => !mentioned.has(id)).map((id) => ({ status: 'action', what: `missing ${id}` })),
    ], 'IDs only; the registration order is reviewed separately against plugin/internal.js pre/post.');
  }

  // 7. Controller git commands with fixed operands.
  {
    const items = [];
    const chunks = path.join(coreRoot, 'dist/chunks');
    for (const name of await fs.readdir(chunks)) {
      const text = await fs.readFile(path.join(chunks, name), 'utf8');
      if (!/\/\/ src\/(?:git|vcs\/[^ ]*git)[^ ]*\.ts/.test(text)) continue;
      for (const match of text.matchAll(/\["((?:rev-parse|rev-list|remote|symbolic-ref|for-each-ref|config|worktree)"(?:, "[^"$`]*")*)\]/g)) {
        const args = JSON.parse(`["${match[1]}]`);
        if (!isReviewedControllerGitArgs(args) && !isReviewedControllerGitArgs([...nativeVcsGitFlags, ...args])) items.push({ status: 'review', what: JSON.stringify(args), chunk: name });
      }
    }
    section('Git reads outside the controller policy', [...new Map(items.map((item) => [item.what, item])).values()],
      'Only read-only commands that reach the controller helper belong in execution-helper-policy.js; others never route there.');
  }

  // 8. Version literals still naming the previous pin.
  {
    const hits = execFileSync('git', ['grep', '-n', '-F', `'${baseline}'`, '--', 'packages', 'scripts', ':!*.md', ':!packages/web/runtime/reviewed-inputs'], { cwd: repository, encoding: 'utf8' }).trim();
    section(`Literal '${baseline}' occurrences`, hits ? hits.split('\n').map((line) => ({ status: 'review', what: line.slice(0, 160) })) : [],
      'Retained-version lists keep it and add the candidate; current-pin fixtures move to the candidate.');
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`OpenCode upgrade report: pinned ${report.pin}, baseline ${report.baseline}, installed ${report.candidate}`);
  for (const { title, note, items } of report.sections) {
    const open = items.filter((item) => item.status !== 'ok');
    console.log(`\n## ${title} (${open.length ? `${open.length} to review` : 'clean'})`);
    if (note) console.log(note);
    for (const item of open) {
      const details = [...item.statements ?? [], ...item.removedExports?.length ? [`removed exports: ${item.removedExports.join(', ')}`] : [],
        ...item.dependencies ?? [], ...item.before ? [`${JSON.stringify(item.before)} -> ${JSON.stringify(item.after)}`] : []];
      console.log(`- [${item.status}] ${item.what}${item.file ? ` (${item.file})` : ''}${item.owner ? ` -> ${item.owner}` : ''}${details.map((line) => `\n    ${line}`).join('')}`);
    }
  }
}

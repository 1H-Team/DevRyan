#!/usr/bin/env node
// Refreshes the reviewed model catalog the native runtime embeds
// (packages/web/runtime/reviewed-inputs/model-catalog). The runtime never fetches
// a catalog, so a model released upstream reaches users only when this snapshot
// is refreshed and the native artifact rebuilt.
//
//   bun run catalog:refresh   capture the live catalog, rewrite provenance and README, print the review diff
//   bun run catalog:check     read-only: exit 1 when the snapshot lacks live models of the tracked providers
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODEL_CATALOG_DIRECTORY = path.join(repository, 'packages/web/runtime/reviewed-inputs/model-catalog');
export const MODEL_CATALOG_URL = 'https://models.opencode.ai/api.json';
const CATALOG_FILE = 'DevRyan-model-catalog.json';
const SELECTED_MODEL = Object.freeze({ providerID: 'openai', modelID: 'gpt-6.1-sol' });
// Providers whose new models must reach a release: the packaged agent defaults
// (openai, opencode) and the providers DevRyan ships dedicated sign-in for.
export const TRACKED_PROVIDER_IDS = Object.freeze(['openai', 'opencode', 'xai', 'anthropic', 'google', 'github-copilot']);
const CHATGPT_PLUGIN_SIGNATURE = 'id: "opencode.provider.chatgpt"';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const modelIDs = (catalog, providerID) => Object.keys(catalog?.[providerID]?.models ?? {}).sort();

/** Model ids added and removed per provider between two parsed catalogs. */
export function catalogDiff(before, after, providerIDs = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
  const changes = [];
  for (const providerID of providerIDs) {
    const previous = new Set(modelIDs(before, providerID));
    const next = new Set(modelIDs(after, providerID));
    const added = [...next].filter(id => !previous.has(id));
    const removed = [...previous].filter(id => !next.has(id));
    if (added.length || removed.length) changes.push({ providerID, added, removed });
  }
  return changes;
}

export const formatCatalogDiff = changes => changes.map(({ providerID, added, removed }) =>
  `${providerID}: ${[...added.map(id => `+${id}`), ...removed.map(id => `-${id}`)].join(' ')}`);

/** The ChatGPT sign-in model allow-list compiled into an installed @opencode/core. */
export async function chatgptAllowList(coreRoot) {
  const directory = path.join(coreRoot, 'dist/chunks');
  const found = [];
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.js')).sort()) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    if (!text.includes(CHATGPT_PLUGIN_SIGNATURE)) continue;
    const match = /var fallbackModels = new Set\((\[[^\]]*\])\);/.exec(text);
    if (!match) throw new Error(`chatgpt_allow_list_missing: ${name}`);
    found.push(JSON.parse(match[1]));
  }
  if (found.length !== 1) throw new Error(`chatgpt_allow_list_${found.length ? 'ambiguous' : 'missing'}`);
  return found[0];
}

/** Allow-listed ChatGPT ids with no openai catalog row; `-fast` ids need a base row with a fast mode. */
export function allowListGaps(catalog, allowList) {
  const models = catalog?.openai?.models ?? {};
  return allowList.filter(id => {
    if (models[id]) return false;
    const base = id.endsWith('-fast') ? models[id.slice(0, -'-fast'.length)] : undefined;
    return !base?.experimental?.modes?.fast;
  });
}

export async function readReviewedCatalog(directory = MODEL_CATALOG_DIRECTORY) {
  return JSON.parse(await fs.readFile(path.join(directory, CATALOG_FILE), 'utf8'));
}

async function fetchLiveCatalog(fetchImpl) {
  const response = await fetchImpl(MODEL_CATALOG_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${MODEL_CATALOG_URL} responded with status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, status: response.status, catalog: JSON.parse(bytes.toString('utf8')) };
}

/** Live models of the tracked providers that the reviewed snapshot lacks. Throws when stale. */
export async function modelCatalogFreshness({ directory = MODEL_CATALOG_DIRECTORY, fetchImpl = fetch } = {}) {
  const [reviewed, live] = await Promise.all([readReviewedCatalog(directory), fetchLiveCatalog(fetchImpl)]);
  const missing = catalogDiff(reviewed, live.catalog, TRACKED_PROVIDER_IDS).filter(change => change.added.length)
    .map(change => ({ ...change, removed: [] }));
  if (missing.length) throw new Error(`reviewed model catalog lacks live models (${formatCatalogDiff(missing).join('; ')}); run \`bun run catalog:refresh\` and commit it`);
  return `covers every live ${TRACKED_PROVIDER_IDS.join(', ')} model`;
}

export async function refreshModelCatalog({ directory = MODEL_CATALOG_DIRECTORY, fetchImpl = fetch, now = new Date() } = {}) {
  const catalogPath = path.join(directory, CATALOG_FILE);
  const previousBytes = await fs.readFile(catalogPath);
  const previous = JSON.parse(previousBytes.toString('utf8'));
  const live = await fetchLiveCatalog(fetchImpl);
  const selectedRow = catalog => {
    const row = catalog?.[SELECTED_MODEL.providerID]?.models?.[SELECTED_MODEL.modelID];
    return row ? sha256(JSON.stringify(row)) : null;
  };
  const selected = selectedRow(live.catalog);
  if (!selected) throw new Error(`live catalog has no ${SELECTED_MODEL.providerID}/${SELECTED_MODEL.modelID}; the packaged default needs a decision before refreshing`);
  const retrievedUTC = now.toISOString();
  const digest = sha256(live.bytes);
  const provenance = {
    schema: 1,
    sourceURL: MODEL_CATALOG_URL,
    retrievedUTC,
    httpStatus: live.status,
    sha256: digest,
    byteSize: live.bytes.length,
    providerCount: Object.keys(live.catalog).length,
    selectedModel: { ...SELECTED_MODEL, sha256: selected },
    previousEvidence: { path: `${CATALOG_FILE} (previous)`, sha256: sha256(previousBytes), selectedRowSha256: selectedRow(previous) },
    sameResponse: sha256(previousBytes) === digest,
    sameSelectedRow: selectedRow(previous) === selected,
    path: CATALOG_FILE,
    kind: 'public-runtime-model-metadata',
    credentials: false,
  };
  await fs.writeFile(catalogPath, live.bytes);
  await fs.writeFile(path.join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  const readmePath = path.join(directory, 'README.md');
  const readme = (await fs.readFile(readmePath, 'utf8'))
    .replace(/- Retrieved UTC: `[^`]*`/, `- Retrieved UTC: \`${retrievedUTC}\``)
    .replace(/- HTTP status: `[^`]*`/, `- HTTP status: \`${live.status}\``)
    .replace(/- Byte size: `[^`]*`/, `- Byte size: \`${live.bytes.length}\``)
    .replace(/- SHA-256: `[^`]*`/, `- SHA-256: \`${digest}\``);
  await fs.writeFile(readmePath, readme);
  return { provenance, changes: catalogDiff(previous, live.catalog) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) {
    console.error('Usage: model-catalog-refresh.mjs [--check]');
    process.exit(2);
  }
  try {
    if (args.includes('--check')) {
      console.log(`[catalog] ${await modelCatalogFreshness()}`);
    } else {
      const { provenance, changes } = await refreshModelCatalog();
      console.log(`[catalog] captured ${provenance.byteSize} bytes, sha256 ${provenance.sha256}${provenance.sameResponse ? ' (unchanged)' : ''}`);
      const tracked = changes.filter(change => TRACKED_PROVIDER_IDS.includes(change.providerID));
      const others = changes.filter(change => !TRACKED_PROVIDER_IDS.includes(change.providerID));
      for (const line of formatCatalogDiff(tracked)) console.log(`[catalog] review ${line}`);
      if (others.length) console.log(`[catalog] ${others.length} other providers changed models`);
      console.log('[catalog] review the diff, then rebuild the native runtime and commit the model-catalog directory');
    }
  } catch (error) {
    console.error(`[catalog] ${error.message}`);
    process.exitCode = 1;
  }
}

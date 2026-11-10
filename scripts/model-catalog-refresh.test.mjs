import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG_DIRECTORY, MODEL_CATALOG_STALE, allowListGaps, catalogDiff, chatgptAllowList, modelCatalogFreshness, readReviewedCatalog, refreshModelCatalog } from './model-catalog-refresh.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const row = (id, fast = false) => ({ id, ...(fast ? { experimental: { modes: { fast: {} } } } : {}) });
const catalog = (openai, extra = {}) => ({ openai: { id: 'openai', models: Object.fromEntries(openai.map(model => [model.id, model])) }, ...extra });
const fakeFetch = body => async () => new Response(JSON.stringify(body), { status: 200 });

async function catalogDirectory(t, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-model-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'DevRyan-model-catalog.json'), JSON.stringify(body));
  await fs.writeFile(path.join(directory, 'provenance.json'), '{}\n');
  await fs.writeFile(path.join(directory, 'README.md'), '- Retrieved UTC: `old`\n- HTTP status: `200`\n- Byte size: `1`\n- SHA-256: `old`\n');
  return directory;
}

// The ChatGPT plugin keeps only allow-listed catalog rows, so an allow-listed
// model missing from the reviewed snapshot silently disappears from the app.
test('the reviewed catalog has a row for every ChatGPT model the pinned core allows', async () => {
  const allowList = await chatgptAllowList(await fs.realpath(path.join(repository, 'node_modules/@opencode/core')));
  assert.ok(allowList.includes('gpt-6.1-sol'));
  assert.deepEqual(allowListGaps(await readReviewedCatalog(MODEL_CATALOG_DIRECTORY), allowList), [],
    'run `bun run catalog:refresh` and rebuild the native runtime');
});

test('allow-list gaps accept a fast id only through a base row with a fast mode', () => {
  const reviewed = catalog([row('gpt-6.1-sol', true), row('gpt-6-luna')]);
  assert.deepEqual(allowListGaps(reviewed, ['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-6-luna-fast', 'gpt-6.1-terra']), ['gpt-6-luna-fast', 'gpt-6.1-terra']);
});

test('catalog diff reports added and removed model ids per provider', () => {
  const before = catalog([row('gpt-6.1-sol'), row('gpt-5.4')]);
  const after = catalog([row('gpt-6.1-sol'), row('gpt-6.1-terra')], { xai: { models: { 'grok-5': row('grok-5') } } });
  assert.deepEqual(catalogDiff(before, after), [
    { providerID: 'openai', added: ['gpt-6.1-terra'], removed: ['gpt-5.4'] },
    { providerID: 'xai', added: ['grok-5'], removed: [] },
  ]);
  assert.deepEqual(catalogDiff(before, after, ['xai']), [{ providerID: 'xai', added: ['grok-5'], removed: [] }]);
});

test('freshness fails only on live models of tracked providers that the snapshot lacks', async t => {
  const directory = await catalogDirectory(t, catalog([row('gpt-6.1-sol'), row('gpt-5.4')]));
  assert.match(await modelCatalogFreshness({ directory, fetchImpl: fakeFetch(catalog([row('gpt-6.1-sol')], { untracked: { models: { new: row('new') } } })) }), /covers every live/);
  await assert.rejects(modelCatalogFreshness({ directory, fetchImpl: fakeFetch(catalog([row('gpt-6.1-sol'), row('gpt-6.1-terra')])) }),
    /openai: \+gpt-6\.1-terra\); run `bun run catalog:refresh`/);
  await assert.rejects(modelCatalogFreshness({ directory, fetchImpl: async () => new Response('', { status: 503 }) }), /status 503/);
});

test('refresh keeps the response bytes and records their provenance', async t => {
  const directory = await catalogDirectory(t, catalog([row('gpt-6.1-sol')]));
  const live = catalog([row('gpt-6.1-sol'), row('gpt-6.1-terra')]);
  const { provenance, changes } = await refreshModelCatalog({ directory, fetchImpl: fakeFetch(live), now: new Date('2026-11-02T00:00:00.000Z') });
  assert.equal(await fs.readFile(path.join(directory, 'DevRyan-model-catalog.json'), 'utf8'), JSON.stringify(live));
  assert.deepEqual(changes, [{ providerID: 'openai', added: ['gpt-6.1-terra'], removed: [] }]);
  assert.equal(provenance.sameResponse, false);
  assert.equal(provenance.sameSelectedRow, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'provenance.json'), 'utf8')), provenance);
  const readme = await fs.readFile(path.join(directory, 'README.md'), 'utf8');
  assert.match(readme, /Retrieved UTC: `2026-11-02T00:00:00.000Z`/);
  assert.match(readme, new RegExp(`SHA-256: \`${provenance.sha256}\``));
  await assert.rejects(refreshModelCatalog({ directory, fetchImpl: fakeFetch(catalog([row('gpt-6.1-terra')])) }), /no openai\/gpt-6\.1-sol/);
});

test('a stale verdict carries MODEL_CATALOG_STALE; a catalog that cannot be read rejects without it', async t => {
  const directory = await catalogDirectory(t, catalog([row('gpt-6.1-sol')]));
  await assert.rejects(modelCatalogFreshness({ directory, fetchImpl: fakeFetch(catalog([row('gpt-6.1-sol'), row('gpt-6.1-terra')])) }),
    error => error.code === MODEL_CATALOG_STALE);
  await assert.rejects(modelCatalogFreshness({ directory, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), error => error.code !== MODEL_CATALOG_STALE);
  await assert.rejects(modelCatalogFreshness({ directory, fetchImpl: async () => new Response('', { status: 503 }) }), error => error.code !== MODEL_CATALOG_STALE);
});

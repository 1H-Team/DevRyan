// Explicit, read-only configuration-shape capture; the runtime sees synthetic data only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRunRoot } from './run-root.mjs';
import { runQaNativeFactoryDiagnostic } from './native-profile-factory-diagnostic.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const { parse } = createRequire(new URL('../../packages/web/package.json', import.meta.url))('jsonc-parser');
const id = value => { assert.equal(typeof value, 'string'); assert.match(value, /^[a-zA-Z0-9_./-]{1,256}$/); return value; };
const cost = value => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const result = {};
  for (const key of ['input', 'output', 'cache_read', 'cache_write']) {
    if (value[key] === undefined) continue;
    assert.ok(Number.isFinite(value[key])); result[key] = value[key];
  }
  if (value.context_over_200k !== undefined) result.context_over_200k = cost(value.context_over_200k);
  return result;
};
const options = value => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return { ...(value.cursorModel === undefined ? {} : { cursorModel: id(value.cursorModel) }),
    ...(value.cost === undefined ? {} : { cost: cost(value.cost) }) };
};

export function syntheticCursorProvider(configuration) {
  const source = configuration?.provider?.['cursor-acp'];
  assert.ok(source && typeof source.models === 'object' && !Array.isArray(source.models));
  const models = Object.fromEntries(Object.entries(source.models).map(([key, value]) => {
    id(key); assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return [key, { name: key,
      ...(value.cost === undefined ? {} : { cost: cost(value.cost) }),
      ...(value.options === undefined ? {} : { options: options(value.options) }),
      ...(value.cursorModel === undefined ? {} : { cursorModel: id(value.cursorModel) }),
      ...(value.variants === undefined ? {} : { variants: Object.fromEntries(Object.entries(value.variants)
        .map(([key, value]) => [id(key), options(value)])) }),
    }];
  }));
  return { 'cursor-acp': { name: 'Synthetic Cursor', npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'http://127.0.0.1:1/v1' }, models } };
}

export function syntheticAnthropicProvider(configuration) {
  return configuration.provider?.anthropic ? { anthropic: { options: { baseURL: 'http://127.0.0.1:1',
    ...(Object.hasOwn(configuration.provider.anthropic.options ?? {}, 'apiKey') ? { apiKey: 'synthetic-fixture' } : {}) } } } : {};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'config-overlay': { type: 'string' }, 'legacy-oauth-columns': { type: 'boolean' }, 'artifact-root': { type: 'string' }, 'output-root': { type: 'string' } } });
  assert.ok(values.config && values['artifact-root'], 'Explicit --config and --artifact-root required');
  const errors = [];
  const configuration = parse(await fs.readFile(path.resolve(values.config), 'utf8'), errors);
  assert.equal(errors.length, 0, 'Configuration must be valid JSONC');
  const providers = syntheticCursorProvider(configuration);
  if (values['config-overlay']) {
    const overlay = parse(await fs.readFile(path.resolve(values['config-overlay']), 'utf8'), errors);
    assert.equal(errors.length, 0, 'Overlay must be valid JSONC');
    Object.assign(providers, syntheticAnthropicProvider(overlay));
  }
  const outputRoot = values['output-root'] ? path.resolve(values['output-root']) : undefined;
  if (outputRoot) assert.ok(outputRoot.startsWith(path.join(repository, '.cache/sessions') + path.sep));
  const run = createRunRoot({ parent: outputRoot ? path.dirname(outputRoot) : path.join(repository, '.cache/qa'), name: outputRoot ? path.basename(outputRoot) : undefined, prefix: 'startup-catalog-shape-',
    owner: 'scripts/qa/startup-catalog-reproduction.mjs' });
  await fs.writeFile(path.join(run.dir, 'providers.json'), JSON.stringify(providers, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(run.dir, 'opencode.json'), JSON.stringify({ provider: { 'cursor-acp': providers['cursor-acp'] } }) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(run.dir, 'config.json'), JSON.stringify({ provider: providers.anthropic ? { anthropic: providers.anthropic } : {} }) + '\n', { mode: 0o600 });
  const result = await runQaNativeFactoryDiagnostic({ artifactRoot: values['artifact-root'], providers, legacyOAuthColumns: values['legacy-oauth-columns'] });
  const evidence = { qualification: 'synthetic-provider-shape-only', models: Object.keys(providers['cursor-acp'].models).length,
    result: result.root, status: result.report.status, failure: result.report.failure ?? null };
  await fs.writeFile(path.join(run.dir, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  run.finish(result.report.status === 'passed' ? 'passed' : 'failed');
  process.stdout.write(JSON.stringify({ root: run.dir, ...evidence }) + '\n');
  process.exitCode = result.report.status === 'passed' ? 0 : 1;
}

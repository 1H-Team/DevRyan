// Opt-in installed-package checks. No live provider or user profile access.
// Run in a disposable process because third-party plugins capture environment.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRunRoot } from './run-root.mjs';
import { requireCacheDirectory } from './claude-quota-fixture.mjs';
import { applyImagegenModelHotfix } from '../../packages/web/server/lib/opencode/imagegen-model-hotfix.js';

export async function checkInstalledPlugins({ modules, output }) {
  if (!path.isAbsolute(modules)) throw new Error('An absolute installed modules directory is required');
  await requireCacheDirectory(output);
  const run = createRunRoot({ parent: output, prefix: 'plugins-', owner: 'scripts/qa/plugin-upgrades.mjs', heavyNames: ['config'], signals: 'exit' });
  const root = run.dir;
  let passed = false;
  const profile = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(profile);
  await fs.mkdir(workspace);
  const environment = { PATH: process.env.PATH, TMPDIR: root,
    OPENCODE_CONFIG_DIR: profile, DEVRYAN_OPENCODE_USER_CONFIG_DIR: profile,
    XDG_CONFIG_HOME: path.join(root, 'xdg/config'), XDG_DATA_HOME: path.join(root, 'xdg/data'),
    XDG_CACHE_HOME: path.join(root, 'xdg/cache'), XDG_STATE_HOME: path.join(root, 'xdg/state'),
    OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'synthetic-fixture-only' } }),
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const privateModules = path.join(profile, 'node_modules');
  await fs.mkdir(privateModules);
  for (const name of await fs.readdir(modules)) {
    if (name === 'opencode-gpt-imagegen') {
      await fs.cp(path.join(modules, name), path.join(privateModules, name), { recursive: true, dereference: true });
    } else await fs.symlink(path.join(modules, name), path.join(privateModules, name));
  }
  assert.equal(applyImagegenModelHotfix({ configDirectory: profile }).ok, true);
  const versions = {};
  for (const name of ['@rama_nigg/open-cursor', 'opencode-gpt-imagegen']) {
    versions[name] = JSON.parse(await fs.readFile(path.join(modules, name, 'package.json'), 'utf8')).version;
  }
  const originalFetch = globalThis.fetch;
  const requests = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses', 'Unexpected network attempt');
    requests.push(JSON.parse(options.body));
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: png.toString('base64') } })}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const imageModule = await import(pathToFileURL(path.join(privateModules, 'opencode-gpt-imagegen/dist/index.js')).href);
    const image = await imageModule.default.server({});
    await fs.writeFile(path.join(workspace, 'reference.png'), png);
    const args = { prompt: 'Synthetic fixture', out: 'image.png', quality: 'high', size: '1024x1024', images: ['reference.png'] };
    const first = await image.tool.gpt_imagegen.execute(args, { directory: workspace });
    const second = await image.tool.gpt_imagegen.execute(args, { directory: workspace });
    assert.equal(first.metadata.versioned, false);
    assert.equal(second.metadata.versioned, true);
    assert.deepEqual(await fs.readFile(first.metadata.out), png);
    assert.deepEqual(await fs.readFile(second.metadata.out), png);
    assert.equal(requests[0].input[0].content[1].type, 'input_image');
    assert.equal(requests[0].tools[0].quality, 'high');
    assert.equal(requests[0].tools[0].size, '1024x1024');
    assert.ok(requests.every(request => request.model === 'gpt-6-astra' && request.reasoning?.effort === 'medium'));
    process.env.OPENCODE_AUTH_CONTENT = '{}';
    await assert.rejects(image.tool.gpt_imagegen.execute(args, { directory: workspace }), /credentials not configured/);
    assert.equal(requests.length, 2);

    const cursor = await import(pathToFileURL(path.join(modules, '@rama_nigg/open-cursor/dist/plugin-entry.js')).href);
    assert.ok(Object.values(cursor).some(value => typeof value === 'function' || typeof value?.server === 'function'));
    const cursorRuntime = await import(pathToFileURL(path.join(modules, '@rama_nigg/open-cursor/dist/index.js')).href);
    const stream = new cursorRuntime.StreamToAiSdkParts();
    const textEvent = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    assert.deepEqual(stream.handleEvent(textEvent('Hello')), [{ type: 'text-delta', textDelta: 'Hello' }]);
    assert.deepEqual(stream.handleEvent(textEvent('Hello')), []);
    assert.deepEqual(stream.handleEvent(textEvent('Hello world')), [{ type: 'text-delta', textDelta: ' world' }]);
    const toolEvent = { type: 'tool_call', subtype: 'started', call_id: 'fixture-tool',
      tool_call: { readToolCall: { args: { path: 'fixture.txt' } } } };
    const toolParts = stream.handleEvent(toolEvent);
    assert.equal(toolParts[0].type, 'tool-call-streaming-start');
    assert.equal(toolParts[0].toolName, 'read');
    assert.deepEqual(stream.handleEvent(toolEvent), []);
    const result = { passed: true, versions, image: 'GPT-6 Astra medium; synthetic SSE generation, reference, quality, size, non-overwrite, missing-auth',
      cursor: 'installed entrypoint imports; text delta and tool-call duplicate handling', liveProviderRequests: 0 };
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    passed = true;
    return { ...result, output: root };
  } finally {
    globalThis.fetch = originalFetch;
    run.finish(passed ? 'passed' : 'failed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modules, output] = process.argv.slice(2);
  const result = await checkInstalledPlugins({ modules, output });
  console.log(JSON.stringify(result));
}

// Opt-in, one-image acceptance against the existing ChatGPT OAuth account.
// Never refresh credentials, log provider bodies, or modify the installed app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectQaAuth } from './profile-preparation.mjs';
import { requireCacheDirectory } from './claude-quota-fixture.mjs';
import { applyImagegenModelHotfix } from '../../packages/web/server/lib/opencode/imagegen-model-hotfix.js';

const [profileArgument] = process.argv.slice(2);
if (!profileArgument) throw new Error('Pass the disposable patched profile produced by plugin-upgrades.mjs');
const profile = path.resolve(profileArgument);
await requireCacheDirectory(profile);
await requireCacheDirectory(path.join(profile, 'node_modules/opencode-gpt-imagegen'));
const patched = applyImagegenModelHotfix({ configDirectory: profile });
assert.equal(patched.ok, true, 'Disposable image plugin source must match the reviewed patch');
const output = await fs.mkdtemp(path.join(path.dirname(profile), 'imagegen-live-'));
const result = { passed: false, model: 'gpt-6-astra', reasoningEffort: 'medium', requests: 0 };
const originalFetch = globalThis.fetch;
try {
  const sourceAuth = JSON.parse(await fs.readFile(path.join(os.homedir(), '.local/share/opencode/auth.json'), 'utf8'));
  const projected = projectQaAuth({ openai: sourceAuth.openai });
  const auth = projected.records.openai;
  if (auth?.type !== 'oauth' || auth.expires <= Date.now() + 300_000) {
    result.unavailable = 'Existing OpenCode ChatGPT OAuth access is unavailable or near expiry; no refresh attempted';
  } else {
    // This disposable process retains only the access-only projection in memory.
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { HOME: output, XDG_DATA_HOME: output,
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: auth }) });
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(result.requests, 0, 'Only one live request is admitted');
      const request = JSON.parse(options.body);
      assert.equal(request.model, result.model);
      assert.equal(request.reasoning?.effort, result.reasoningEffort);
      assert.equal(request.tool_choice?.type, 'image_generation');
      result.requests += 1;
      const response = await originalFetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(240_000) });
      result.httpStatus = response.status;
      return response;
    };
    const { default: plugin } = await import(pathToFileURL(path.join(profile, 'node_modules/opencode-gpt-imagegen/dist/index.js')).href);
    const loaded = await plugin.server({});
    const generated = await loaded.tool.gpt_imagegen.execute({
      prompt: 'Create a simple blue circle centered on a white square background. No text.',
      out: 'astra-medium.png', quality: 'low', size: '1024x1024',
    }, { directory: output });
    const png = await fs.readFile(generated.metadata.out);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    result.width = png.readUInt32BE(16);
    result.height = png.readUInt32BE(20);
    assert.ok(result.width > 0 && result.height > 0);
    result.bytes = png.length;
    result.passed = true;
  }
} catch {
  // Upstream errors may contain response bodies: retain only safe metadata.
  result.error = 'Live image acceptance failed; see HTTP status or unavailable prerequisite';
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.OPENCODE_AUTH_CONTENT;
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, output }));
}
if (!result.passed) process.exitCode = 1;

// Opt-in live transport comparison. Executes only the two fixture tools below,
// in cache-owned files. Never starts, restarts, or mutates the user's runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { applyMeridianHttpHotfix } from '../../packages/web/server/lib/opencode/meridian-http-hotfix.js';
import { stripMeridianHandoffPatch } from '../../packages/web/server/lib/opencode/meridian-passthrough-hotfix.js';

const repository = path.resolve(import.meta.dirname, '../..');
const outputRoot = path.join(repository, '.cache/qa/designer-continuity');
const installedModules = path.join(os.homedir(), '.config/opencode/node_modules');
const installedPackage = path.join(installedModules, '@rynfar/meridian');
const model = 'claude-opus-4-8';
const effort = 'high';

async function prepare(arm) {
  const root = await fs.mkdtemp(path.join(outputRoot, `${arm}-`));
  const packageRoot = path.join(root, 'node_modules/@rynfar/meridian');
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(installedPackage, packageRoot, { recursive: true, dereference: true });
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const dependency of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), `@libsql/${process.platform}-${process.arch}`])) {
    try { await fs.access(path.join(installedModules, dependency)); } catch { continue; }
    const target = path.join(root, 'node_modules', dependency);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(installedModules, dependency), target, 'dir');
  }
  const patch = applyMeridianHttpHotfix({ configDirectory: root });
  if (!patch.ok) throw new Error(patch.error);
  if (arm === 'control') {
    const entry = path.join(packageRoot, 'dist/cli-wxk8xvd3.js');
    await fs.writeFile(entry, stripMeridianHandoffPatch(await fs.readFile(entry, 'utf8')));
  }
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'ReviewStats.tsx'), 'export function ReviewStats() { return <section className="gap-6"><h3>Reviews</h3><span>4.8</span><span>42 reviews</span></section>; }\n');
  await fs.writeFile(path.join(workspace, 'ReviewStats.css'), '.review-stats { display: flex; padding: 24px; }\n');
  return { root, packageRoot, workspace, patch };
}

async function parseStream(response) {
  if (!response.ok) throw new Error(`Proxy request failed: HTTP ${response.status}`);
  const raw = await response.text();
  const blocks = new Map();
  let stopReason;
  for (const frame of raw.split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    if (!data) continue;
    const event = JSON.parse(data);
    if (event.type === 'error') throw new Error(`Provider error: ${event.error?.type ?? 'unknown'}`);
    if (event.type === 'content_block_start') blocks.set(event.index, { ...event.content_block, json: '' });
    if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block) throw new Error('Delta without block');
      if (event.delta.type === 'input_json_delta') block.json += event.delta.partial_json;
      if (event.delta.type === 'text_delta') block.text = (block.text ?? '') + event.delta.text;
      if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking;
      if (event.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + event.delta.signature;
    }
    if (event.type === 'message_delta') stopReason = event.delta.stop_reason;
  }
  const content = [...blocks.values()].map(({ json, ...block }) => block.type === 'tool_use'
    ? { ...block, input: json ? JSON.parse(json) : block.input }
    : block);
  return { content, stopReason };
}

export async function runDesignerContinuityComparison() {
  await fs.mkdir(outputRoot, { recursive: true });
  // Reuse the installed credential abstraction in memory, without copying,
  // logging, or persisting authentication into the isolated fixture profile.
  const { createPlatformCredentialStore } = await import(pathToFileURL(path.join(installedPackage, 'dist/cli-khhjyk04.js')).href);
  const credentials = await createPlatformCredentialStore().read();
  const oauthToken = credentials?.claudeAiOauth?.accessToken;
  if (!oauthToken) throw new Error('Existing Claude OAuth access is unavailable');
  const environmentKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'MERIDIAN_SESSION_DIR', 'MERIDIAN_WORKDIR', 'MERIDIAN_CLAUDE_PATH'];
  const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    const results = [];
    for (const arm of ['control', 'candidate']) {
      const fixture = await prepare(arm);
      process.env.CLAUDE_CONFIG_DIR = path.join(fixture.root, 'claude');
      process.env.MERIDIAN_SESSION_DIR = path.join(fixture.root, 'sessions');
      process.env.MERIDIAN_WORKDIR = fixture.workspace;
      process.env.MERIDIAN_CLAUDE_PATH = path.join(installedModules, '@anthropic-ai/claude-code/cli.js');
      const { createProxyServer } = await import(pathToFileURL(path.join(fixture.packageRoot, 'dist/server.js')).href);
      const proxy = createProxyServer({ silent: true, maxConcurrent: 1,
        // Token stays in the subprocess environment. Supplying it on the profile
        // would make Meridian override CLAUDE_CONFIG_DIR outside this fixture.
        profiles: [{ id: 'qa', type: 'oauth-token' }], defaultProfile: 'qa',
        pluginDir: path.join(fixture.root, 'plugins'), pluginConfigPath: path.join(fixture.root, 'plugins.json'),
      });
      const session = `designer-continuity-${arm}-${crypto.randomUUID()}`;
      const messages = [{ role: 'user', content: 'You are Designer. Implement this approved brief: in ReviewStats.tsx change gap-6 to gap-3 and the heading Reviews to Review stats; in ReviewStats.css change padding from 24px to 12px. Preserve the rating and count. Read both files in parallel, then edit both. Use only the supplied tools. Once both changes are complete, briefly report completion. No other work, tests, or inspections are needed.' }];
      const tools = [
        { name: 'read', description: 'Read an owned fixture file.', input_schema: { type: 'object', properties: { file: { type: 'string', enum: ['ReviewStats.tsx', 'ReviewStats.css'] } }, required: ['file'] } },
        { name: 'edit', description: 'Replace exact text once in an owned fixture file.', defer_loading: true, input_schema: { type: 'object', properties: { file: { type: 'string', enum: ['ReviewStats.tsx', 'ReviewStats.css'] }, old: { type: 'string' }, replacement: { type: 'string' } }, required: ['file', 'old', 'replacement'] } },
      ];
      const startedAt = Date.now();
      let firstEditMs;
      let requests = 0;
      let completed = false;
      const calls = [];
      const cancellation = new AbortController();
      const deadline = AbortSignal.any([cancellation.signal, AbortSignal.timeout(240_000)]);
      try {
        for (; requests < 12; requests++) {
          const response = await proxy.app.fetch(new Request('http://127.0.0.1/v1/messages', {
            method: 'POST', signal: deadline,
            headers: { 'content-type': 'application/json', 'x-opencode-session': session, 'x-opencode-agent-mode': 'subagent', 'x-opencode-agent-name': 'designer', 'x-opencode-effort': effort },
            body: JSON.stringify({ model, stream: true, max_tokens: 4096, system: `<env>\nWorking directory: ${fixture.workspace}\n</env>`, messages, tools }),
          }));
          const reply = await parseStream(response);
          messages.push({ role: 'assistant', content: reply.content });
          const toolCalls = reply.content.filter(block => block.type === 'tool_use');
          if (toolCalls.length === 0) { completed = reply.stopReason === 'end_turn'; requests++; break; }
          const toolResults = [];
          for (const call of toolCalls) {
            const input = call.input;
            let content;
            let isError = false;
            if (!['ReviewStats.tsx', 'ReviewStats.css'].includes(input?.file) || !['read', 'edit'].includes(call.name)) {
              content = 'Unsupported fixture tool or file'; isError = true;
            } else {
              const file = path.join(fixture.workspace, input.file);
              const previous = await fs.readFile(file, 'utf8');
              if (call.name === 'read') content = previous;
              else if (typeof input.old !== 'string' || !input.old || previous.split(input.old).length !== 2 || typeof input.replacement !== 'string') {
                content = 'Exact replacement text must occur once'; isError = true;
              } else {
                await fs.writeFile(file, previous.replace(input.old, input.replacement));
                firstEditMs ??= Date.now() - startedAt;
                content = 'Edit applied';
              }
            }
            calls.push({ name: call.name, id: call.id, error: isError });
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
          }
          messages.push({ role: 'user', content: toolResults });
        }
        const tsx = await fs.readFile(path.join(fixture.workspace, 'ReviewStats.tsx'), 'utf8');
        const css = await fs.readFile(path.join(fixture.workspace, 'ReviewStats.css'), 'utf8');
        const telemetry = await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/requests?limit=100'))).json();
        const logs = await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/logs?limit=200'))).json();
        const result = { arm, model, effort, requests, completed,
          accepted: completed && tsx.includes('gap-3') && tsx.includes('Review stats') && tsx.includes('4.8') && tsx.includes('42 reviews') && css.includes('padding: 12px'),
          firstEditMs, completionMs: Date.now() - startedAt, calls,
          sdkSessions: new Set(telemetry.map(entry => entry.sdkSessionId).filter(Boolean)).size,
          freshRequests: telemetry.filter(entry => !entry.isResume).length,
          diagnostics: logs.filter(entry => /checkpoint|sdk_termination|evicted|replay/.test(entry.message)),
        };
        results.push(result);
        await fs.writeFile(path.join(outputRoot, `${arm}.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ ...result, calls: calls.length, diagnostics: result.diagnostics.length }));
      } finally {
        cancellation.abort();
        proxy.beginDrain();
      }
    }
    return results;
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await runDesignerContinuityComparison();
  if (results.some(result => !result.accepted)) process.exitCode = 1;
}

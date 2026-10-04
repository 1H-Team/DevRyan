import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { Global } from '@opencode/util/global';
import { Tool } from '@opencode/core/tool';
import { Agent } from '@opencode/core/agent';
import { Skill } from '@opencode/core/skill';
import { createBotConfigCompiler } from '../../web/server/lib/bots/config-compiler.js';
import { createBotNativeServer } from '../../web/server/lib/bots/native-server.mjs';

const token = 'a'.repeat(43), uuid = '11111111-1111-4111-8111-111111111111';
const environment = { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: token,
  DEVRYAN_BOT_RUN_ID: uuid, DEVRYAN_BOT_CHANNEL_ID: uuid, DEVRYAN_BOT_REVISION_ID: uuid,
  DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '0' };
const skillContent = '---\nname: assigned\ndescription: Fixture assigned skill\n---\n\nRetained assigned instructions.\n';
const digest = crypto.createHash('sha256').update(skillContent).digest('hex');
const contract = fileTools => ({ standingRole: 'Complete deterministic fixture requests.',
  models: { primary: { providerId: 'owned', modelId: 'fixture', credentialId: uuid, egressHosts: ['api.openai.com:443'] }, fallbacks: [] },
  reasoning: { effort: 'high', maxOutputTokens: 4096 }, fileTools, runtimeTools: ['task'],
  gatewayPluginVersion: 'devryan-bot-tools@1.4.0', libraryVersionIds: [],
  memoryPolicy: { shared: true, userPrivate: true, retrievalLimit: 12 },
  actionPolicy: { defaultEffect: 'deny', defaultRisk: 'sensitive', rules: [] },
  browserPolicy: { allowedOrigins: [], deniedOrigins: [] }, skillBindings: [{ id: uuid, digest }], mcpBindings: [],
});
const remove = async root => {
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await remove(path.join(root, entry.name));
  await fs.rm(root, { recursive: true, force: true });
};

test.each([{ fileTools: ['write'] }, { fileTools: ['edit'] }])('native Bot honors exact $fileTools tools, retained skills, and scoped subagents', async ({ fileTools }) => {
  const parent = fileURLToPath(new URL('../../../.cache/bot-native-tests/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'tool-policy-'));
  const directory = path.join(root, 'workspace'), configDirectory = path.join(root, 'config'), output = path.join(directory, 'result.txt');
  await fs.mkdir(directory); await fs.mkdir(configDirectory);
  let runtime, tools, agents, skills;
  const inventories = [];
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    inventories.push(body.tools?.map(item => item.function.name) ?? []);
    const userIndex = body.messages.findLastIndex(message => message.role === 'user');
    const text = JSON.stringify(body.messages[userIndex]), hasResult = body.messages.slice(userIndex + 1).some(message => message.role === 'tool');
    let call;
    if (!hasResult && text.includes('Mutate fixture file')) call = { name: fileTools[0], arguments: JSON.stringify(fileTools[0] === 'write'
      ? { path: output, content: 'after\n' } : { path: output, oldString: 'before', newString: 'after' }) };
    if (!hasResult && text.includes('Spawn allowed fixture')) call = { name: 'subagent', arguments: JSON.stringify({
      agent: 'explore', description: 'Fixture child', prompt: 'Complete the independent child fixture.' }) };
    const delta = call ? { tool_calls: [{ index: 0, id: 'call_actual_fixture', type: 'function', function: call }] }
      : { role: 'assistant', content: 'Fixture complete' };
    return new Response([{ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }]
      .map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const capture = (node, Service, assign) => node.replace(node.mapLayer(layer => Layer.effect(Service, Effect.gen(function* () {
    const service = yield* Service; assign(service); return service;
  })).pipe(Layer.provide(layer))));
  const request = (url, body) => runtime.fetch(new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    const compiler = createBotConfigCompiler({ dataDirectory: root, resolveSkillPackages: async () => [{ id: uuid, name: 'assigned', digest,
      files: [{ path: 'SKILL.md', content: skillContent, sha256: digest }] }] });
    const compiled = await compiler.compile({ channelId: uuid, revisionId: uuid, contract: contract(fileTools) });
    const config = JSON.parse(await fs.readFile(path.join(compiled.directory, 'opencode.json'), 'utf8'));
    // Synthetic provider configuration is fixture-only; all agent permissions
    // and assigned skill bindings come from the actual immutable compiler.
    config.providers = { owned: { package: '@opencode/ai/providers/openai-compatible', env: [],
      settings: { baseURL: `${provider.url}v1` }, models: { fixture: { capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 32768, input: 16384, output: 4096 } } } } };
    await fs.writeFile(path.join(configDirectory, 'opencode.json'), JSON.stringify(config));
    await fs.cp(path.join(compiled.directory, 'skills'), path.join(configDirectory, 'skills'), { recursive: true });
    // Extra discoverable skill has no revision grant, unlike the actual
    // compiler-materialized and digest-verified assigned package.
    await fs.chmod(path.join(configDirectory, 'skills'), 0o700);
    await fs.mkdir(path.join(configDirectory, 'skills', 'unassigned'));
    await fs.writeFile(path.join(configDirectory, 'skills', 'unassigned', 'SKILL.md'), skillContent.replaceAll('assigned', 'unassigned'));
    await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ owned: { type: 'api', key: 'bot-native-fixture-key' } }));
    if (fileTools[0] === 'edit') await fs.writeFile(output, 'before\n');
    runtime = await createBotNativeServer({ directory, configDirectory, databasePath: path.join(root, 'native.db'),
      authPath: path.join(root, 'auth.json'), environment, overrides: [
        Global.node.replace(Global.layerWith({ home: root, data: root, config: configDirectory, cache: root, state: root,
          tmp: root, bin: root, log: root, repos: root })),
        capture(Tool.node, Tool.Service, value => { tools = value; }),
        capture(Agent.node, Agent.Service, value => { agents = value; }),
        capture(Skill.node, Skill.Service, value => { skills = value; }),
      ] });
    const created = await request('/api/session', { title: 'Native tool policy fixture' });
    expect(created.status).toBe(200);
    const session = (await created.json()).data;
    const turn = async text => {
      const previous = new Set((await (await request(`/api/session/${session.id}/message`)).json()).data.map(row => row.id));
      const messageID = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
      const reply = await request('/devryan/bot/prompt', { sessionID: session.id, model: { providerID: 'owned', id: 'fixture' },
        prompt: { id: messageID, text, delivery: 'queue', metadata: {} } });
      expect(reply.status).toBe(200);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const messages = (await (await request(`/api/session/${session.id}/message`)).json()).data;
        const user = messages.find(row => row.id === messageID && row.type === 'user');
        const assistant = user && messages.filter(row => row.type === 'assistant' && !previous.has(row.id))
          .sort((left, right) => left.time.created - right.time.created).at(-1);
        const status = (await (await request('/api/session/active')).json()).data;
        if (assistant?.time?.completed && !status?.[session.id]) return assistant;
        await Bun.sleep(10);
      }
      throw new Error('Native fixture did not settle');
    };
    const assistant = await turn('Mutate fixture file');
    expect(await fs.readFile(output, 'utf8')).toBe('after\n');
    const inventory = inventories[0];
    expect(inventory).toContain(fileTools[0]);
    expect(inventory.includes('write')).toBe(fileTools[0] === 'write');
    expect(inventory.includes('edit')).toBe(fileTools[0] === 'edit');
    const definitions = await Effect.runPromise(tools.list());
    const bot = await Effect.runPromise(agents.resolve('bot'));
    const snapshot = await Effect.runPromise(tools.snapshot(bot.permissions));
    // The model adapter may choose edit over patch; the native permission
    // inventory still pins all three underlying mutation tools.
    expect(snapshot.definitions.some(item => item.name === 'patch')).toBe(fileTools[0] === 'edit');
    const context = { sessionID: session.id, agent: 'bot', messageID: assistant.id, id: 'call_direct_guard' };
    const withheld = fileTools[0] === 'write' ? 'edit' : 'write';
    const denied = definitions.find(item => item.name === withheld);
    await expect(Effect.runPromise(denied.execute({ path: output, content: 'forbidden', oldString: 'after', newString: 'forbidden' }, context)))
      .rejects.toThrow(`Permission denied: devryan_bot_${withheld}`);
    if (fileTools[0] === 'write') await expect(Effect.runPromise(definitions.find(item => item.name === 'patch').execute({
      patchText: `*** Begin Patch\n*** Update File: ${output}\n@@\n-after\n+forbidden\n*** End Patch`,
    }, context))).rejects.toThrow('Permission denied: devryan_bot_edit');
    expect(await fs.readFile(output, 'utf8')).toBe('after\n');
    expect((await Effect.runPromise(skills.list())).map(item => item.id)).toEqual(expect.arrayContaining(['assigned', 'unassigned']));
    const skill = definitions.find(item => item.name === 'skill');
    expect((await Effect.runPromise(skill.execute({ id: 'assigned' }, context))).content).toContain('Retained assigned instructions.');
    await expect(Effect.runPromise(skill.execute({ id: 'unassigned' }, context))).rejects.toThrow('Unable to load skill unassigned');
    const subagent = definitions.find(item => item.name === 'subagent');
    await expect(Effect.runPromise(subagent.execute({ agent: 'general', description: 'Forbidden recursion', prompt: 'Do not execute' },
      { ...context, agent: 'explore' }))).rejects.toThrow('Subagent denied: general');
    await expect(Effect.runPromise(subagent.execute({ agent: 'unassigned', description: 'Unknown child', prompt: 'Do not execute' }, context)))
      .rejects.toThrow('Unknown agent: unassigned');
    await expect(Effect.runPromise(definitions.find(item => item.name === 'devryan_bot').execute({}, { ...context, agent: 'general' })))
      .rejects.toThrow('Permission denied: devryan_bot');
    expect((await Effect.runPromise(agents.resolve('explore'))).mode).toBe('subagent');
    await turn('Spawn allowed fixture');
    const sessions = (await (await request('/api/session')).json()).data;
    expect(sessions.filter(item => item.parentID === session.id)).toHaveLength(1);
  } finally { await runtime?.close(); await provider.stop(true); await remove(root); }
}, 30_000);

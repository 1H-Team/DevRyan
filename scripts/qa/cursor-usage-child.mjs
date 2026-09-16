// Launched only by the explicitly opted-in live study, in a marked QA home.
import './isolated-home.mjs';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const sdkModule = await import(pathToFileURL(path.join(config.adapter, 'node_modules/@cursor/sdk/index.js')).href);
const { Agent, Cursor } = sdkModule;
const { createCursorSdkRuntime } = await import(pathToFileURL(path.join(config.adapter, 'index.js')).href);
let runtime;
let native;
let currentRun;
const sessionID = 'ses_cursor_study';
let ordinal = 0;
const makeRuntime = () => createCursorSdkRuntime({
  storageDir: path.join(config.root, 'runtime-state'),
  env: process.env, nodeBinary: config.workerBinary || process.execPath, useNodeWorkerForPrompts: true,
  workerEnv: { NODE_OPTIONS: `--import=${JSON.stringify(path.resolve(import.meta.dirname, 'isolated-home.mjs'))}`,
    ...(config.workerHost === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  resolveAgentPrompt: () => config.context.prompt,
  resolveAgentDefinitions: () => config.context.definitions,
  onUsageObservation: input => appendFileSync(path.join(config.root, 'runtime-usage.ndjson'), `${JSON.stringify(input)}\n`),
  onTitleUsageObservation: input => appendFileSync(path.join(config.root, 'runtime-usage.ndjson'), `${JSON.stringify({ purpose: 'title', ...input })}\n`),
  logger: { warn() {}, error() {} },
});

const send = async text => {
  if (config.arm === 'direct') {
    native ??= await Agent.create({ apiKey: process.env.CURSOR_API_KEY, model: config.model,
      local: { cwd: config.workspace }, platform: { workspaceRef: config.workspace } });
    currentRun = await native.send({ text }, { model: config.model });
    for await (const _event of currentRun.stream()) { /* Native tools run unchanged. */ }
    const result = await currentRun.wait();
    return { status: result.status, model: result.model, usage: result.usage };
  }
  if (!runtime) {
    runtime = makeRuntime();
    await runtime.refreshVirtualProvider({ force: true, timeoutMs: 30_000 });
  }
  let questionsAnswered = 0;
  const messageID = `msg_study_${String(++ordinal).padStart(4, '0')}`;
  const response = await runtime.handlePromptAsync({ sessionID, directory: config.workspace,
    body: { model: { providerID: 'cursor-acp', modelID: config.model.id }, variant: config.variant,
      agent: 'builder', messageID, parts: [{ type: 'text', text }] } });
  if (!response.handled || response.status !== 204) throw new Error('Cursor runtime rejected study prompt');
  for (;;) {
    if (config.workload === 'lifecycle') {
      for (const question of runtime.listPendingQuestions({ directory: config.workspace })) {
        const marker = text.includes('marker-violet') ? 'violet' : 'amber';
        if (await runtime.replyToQuestion(question.id, question.questions.map(() => [marker]))) questionsAnswered++;
      }
    }
    const records = await runtime.getSessionMessages(sessionID);
    const result = records.find(row => row.info.parentID === messageID && row.info.finish);
    if (result && runtime.getSessionStatus()[sessionID]?.type !== 'busy') {
      return { status: result.info.finish === 'stop' ? 'finished' : result.info.finish, info: result.info, questionsAnswered,
        toolCount: result.parts.filter(part => part.type === 'tool').length,
        missingToolResults: result.parts.filter(part => part.state?.error?.includes('without reporting a result')).length };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

process.on('message', async message => {
  try {
    let result;
    if (message.type === 'send') result = await send(message.text);
    else if (message.type === 'cancel') {
      if (runtime) await runtime.abortSession(sessionID);
      if (currentRun) await currentRun.cancel();
      result = { cancelled: true };
    } else if (message.type === 'reload') {
      if (runtime) { await runtime.dispose(); runtime = null; }
      if (native) { const id = native.agentId; await native.close();
        native = await Agent.resume(id, { apiKey: process.env.CURSOR_API_KEY, model: config.model,
          local: { cwd: config.workspace }, platform: { workspaceRef: config.workspace } }); }
      result = { reloaded: true };
    } else if (message.type === 'title') {
      result = { title: await runtime?.generateTitle({ sessionID, text: 'Verify Cursor usage accounting', directory: config.workspace }) };
    } else if (message.type === 'title-retry') {
      runtime ??= makeRuntime();
      const { createCursorSessionTitleRuntime } = await import(pathToFileURL(config.titleAdapter).href);
      let title = 'Untitled Session'; let patchAttempts = 0;
      const titleRuntime = createCursorSessionTitleRuntime({
        cursorSdkRuntime: {
          generateTitle: input => runtime.generateTitle(input),
          getSessionMessages: async () => [{ info: { role: 'user', providerID: 'cursor-acp' },
            parts: [{ type: 'text', text: 'Verify Cursor usage accounting and avoid duplicate title requests' }] }],
        },
        buildOpenCodeUrl: () => 'http://fixture.invalid/session',
        fetchImpl: async (_url, options) => {
          if (options.method === 'PATCH') {
            if (++patchAttempts === 1) return { ok: false };
            title = JSON.parse(options.body).title;
          }
          return { ok: true, json: async () => ({ title }) };
        },
        logger: { warn() {} },
      });
      const first = await titleRuntime.schedule({ sessionID, directory: config.workspace });
      const second = await titleRuntime.schedule({ sessionID, directory: config.workspace });
      result = { first, second, patchAttempts, title,
        passed: first === false && second === true && patchAttempts === 2 && title !== 'Untitled Session'
          && title.length <= 80 && /cursor|usage|title/i.test(title) };
    } else if (message.type === 'close') {
      await runtime?.dispose(); await native?.close(); process.send?.({ id: message.id, ok: true }); process.exit(0);
    } else throw new Error('Unknown study child command');
    process.send?.({ id: message.id, ok: true, result });
  } catch (error) { process.send?.({ id: message.id, ok: false, errorCode: error.code || error.name }); }
});
process.send?.({ ready: true, catalogApi: typeof Cursor.models.list === 'function' });

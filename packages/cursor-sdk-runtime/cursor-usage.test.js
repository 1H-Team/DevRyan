import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readdir, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createCursorSdkRuntime } from './index.js';
import { cursorRunUsageObservation, normalizeCursorUsage, normalizeCursorUsageObservation, mergeCursorUsageObservation } from './cursor-usage.js';
import { normalizeInteractionUpdateToSdkMessage } from './interaction-update-normalize.js';

// Explicit local QA uses the repository's Electron binary as the Node host.
// Normal deterministic validation uses Node and never reads installed apps.
const electronWorker = process.env.DEVRYAN_QA_CURSOR_ELECTRON_WORKER === '1';
const workerBinary = electronWorker
  ? createRequire(new URL('../electron/package.json', import.meta.url))('electron') : 'node';

const first = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 10, reasoningTokens: 20 };
const second = { inputTokens: 200, outputTokens: 40, cacheReadTokens: 600, cacheWriteTokens: 20, reasoningTokens: 25 };
const total = { inputTokens: 300, outputTokens: 70, cacheReadTokens: 1000, cacheWriteTokens: 30, totalTokens: 1400, reasoningTokens: 45 };

describe('Cursor consumption boundaries', () => {
  test('keeps unknown usage unknown and reasoning inside output', () => {
    expect(normalizeCursorUsage(undefined)).toBeNull();
    expect(normalizeCursorUsage({ inputTokens: 0 })).toBeNull();
    expect(normalizeCursorUsage({ ...first, outputTokens: -1 })).toBeNull();
    expect(normalizeCursorUsage(first)?.totalTokens).toBe(540);
    expect(normalizeInteractionUpdateToSdkMessage({ type: 'turn-ended', usage: first })?.tokens)
      .toEqual({ input: 100, output: 10, reasoning: 20, cache: { read: 400, write: 10 } });
  });

  test('projects identifiers and final cumulative usage without copying arbitrary SDK data', () => {
    const observation = cursorRunUsageObservation({ id: 'run-1', agentId: 'agent-1', requestId: 'request-1', usage: first }, {
      status: 'cancelled', usage: total, model: { id: 'fixture', params: [{ id: 'effort', value: 'high', secret: 'hidden' }] },
      headers: { authorization: 'hidden' }, result: 'private prompt',
    });
    expect(observation.tokens).toEqual(total);
    expect(observation.status).toBe('cancelled');
    expect(observation.source).toBe('sdk-run-result');
    expect(JSON.stringify(observation)).not.toContain('hidden');
    expect(JSON.stringify(observation)).not.toContain('private prompt');
    expect(normalizeCursorUsageObservation({ ...observation, secret: 'hidden' })).toEqual(observation);
  });

  test('late stream snapshots cannot erase a failed run total or reopen its status', () => {
    const failed = cursorRunUsageObservation({ id: 'run', status: 'error', usage: total });
    for (const usage of [undefined, first, total]) {
      expect(mergeCursorUsageObservation(failed, cursorRunUsageObservation({ id: 'run', status: 'running', usage }))).toBe(failed);
    }
    expect(mergeCursorUsageObservation(failed, failed)).toBe(failed);
    const final = cursorRunUsageObservation({ id: 'run' }, { status: 'error', usage: first });
    expect(mergeCursorUsageObservation(failed, final)).toEqual(final);
    expect(mergeCursorUsageObservation(final, failed)).toBe(final);
    const running = cursorRunUsageObservation({ id: 'run', status: 'running', usage: total });
    const unavailableFailure = cursorRunUsageObservation({ id: 'run', status: 'error' });
    expect(mergeCursorUsageObservation(running, unavailableFailure)).toEqual(failed);
  });
});

// Both SDK event surfaces report the same turns. run.wait() reports their sum.
// Exercise the actual direct and worker transports, including a wait failure.
const sdkFixture = `
  const first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)}, total = ${JSON.stringify(total)};
  const model = {id:'fixture',params:[{id:'effort',value:'high'}]};
  const makeAgent = () => ({ agentId:'agent-fixture', close(){}, async send(message, {onDelta}) {
    let finish; const complete = new Promise(resolve => {finish=resolve;});
    const failing = message.text.includes('fail');
    const cancelling = message.text.includes('cancel');
    const run = {id:'run-fixture',requestId:'request-fixture',agentId:'agent-fixture',model,status:'running',
      async *stream(){
        for(const usage of [first, second]) {
          run.usage=usage;
          onDelta({type:'turn-ended',usage});
          yield {type:'usage',usage};
          await new Promise(resolve=>setTimeout(resolve,20));
          if(cancelling){const keepAlive=setInterval(()=>{},1000);try{await complete;}finally{clearInterval(keepAlive);}return;}
        }
        run.usage=total; run.status=failing?'error':'finished'; finish();
      },
      async wait(){await complete;if(failing)throw new Error('fixture failure');return {id:run.id,requestId:run.requestId,status:run.status,model,usage:run.usage,result:'done'};},
      // Deliberately race native success against the already accepted local Stop.
      async cancel(){run.status='finished';finish();}
    }; return run;
  }});
  export const Agent = {async create(){return makeAgent();},async resume(){return makeAgent();},
    async prompt(){return {id:'title-run',requestId:'title-request',status:'finished',model:{id:'auto'},usage:first,result:'Fixture title'};}};
  export const Cursor = {models:{async list(){return [{id:'fixture'}];}}};
`;

for (const mode of ['direct', 'persistent', 'fallback']) {
  for (const outcome of ['completion', 'failure', 'cancellation']) {
    const failing = outcome === 'failure';
    const cancelling = outcome === 'cancellation';
    test(`${mode}: cumulative usage is not doubled or used as context after ${outcome}`, async () => {
      const qaDirectory = path.resolve(import.meta.dirname, '../../.cache/qa');
      await mkdir(qaDirectory, { recursive: true });
      const directory = await mkdtemp(path.join(qaDirectory, 'cursor-usage-unit-'));
      let runtime;
      try {
        for (const name of await readdir(import.meta.dirname)) {
          if (/\.(mjs|js)$/.test(name) && !name.includes('.test.')) {
            await copyFile(path.join(import.meta.dirname, name), path.join(directory, name));
          }
        }
        await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
        const sdkRoot = path.join(directory, 'node_modules/@cursor/sdk');
        await mkdir(sdkRoot, { recursive: true });
        await writeFile(path.join(sdkRoot, 'package.json'), '{"type":"module","exports":"./index.js"}');
        await writeFile(path.join(sdkRoot, 'index.js'), sdkFixture);
        const sdk = await import(pathToFileURL(path.join(sdkRoot, 'index.js')).href);
        const observations = [];
        const correlations = [];
        const titleObservations = [];
        runtime = createCursorSdkRuntime({
          storageDir: path.join(directory, 'state'), env: { PATH: process.env.PATH },
          readAuth: () => ({ 'cursor-acp': { key: 'fixture-key' } }),
          useNodeWorkerForPrompts: mode !== 'direct', usePersistentWorkerForPrompts: mode !== 'fallback',
          nodeBinary: workerBinary, workerPath: path.join(directory, 'node-worker.mjs'),
          persistentWorkerPath: path.join(directory, 'persistent-worker.mjs'),
          workerEnv: { PATH: process.env.PATH, ...(electronWorker ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, loadSdk: async () => sdk,
          getWorkspaceDiff: async () => '', logger: { warn() {}, error() {} },
          onUsageObservation: ({ observation, ...correlation }) => {
            observations.push(observation);
            correlations.push(correlation);
          },
          onTitleUsageObservation: (value) => {
            titleObservations.push(value);
            throw new Error('Fixture journal unavailable');
          },
        });
        await runtime.handlePromptAsync({ sessionID: 'ses_fixture', directory, body: {
          model: { providerID: 'cursor-acp', modelID: 'fixture' }, agent: 'reviewer',
          messageID: 'msg_fixture', parts: [{ type: 'text', text: cancelling ? 'cancel' : failing ? 'fail' : 'hello' }],
        } });
        if (cancelling) {
          for (let attempt = 0; attempt < 500 && !observations.some(row => row.tokens); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(observations.some(row => row.tokens)).toBe(true);
          await runtime.abortSession('ses_fixture');
        }
        let assistant;
        for (let attempt = 0; attempt < 500; attempt++) {
          assistant = (await runtime.getSessionMessages('ses_fixture')).find(row => row.info.role === 'assistant' && row.info.finish);
          if (assistant) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(assistant).toBeDefined();
        expect(correlations.at(-1)).toEqual({ sessionID: 'ses_fixture', messageID: assistant.info.id, userMessageID: 'msg_fixture', directory });
        expect(assistant.info.cursorUsage.tokens).toEqual(cancelling ? normalizeCursorUsage(first) : total);
        expect(assistant.info.cursorUsage.requestID).toBe('request-fixture');
        expect(assistant.info.tokens).toEqual(cancelling
          ? { input: 100, output: 10, reasoning: 20, cache: { read: 400, write: 10 } }
          : { input: 200, output: 15, reasoning: 25, cache: { read: 600, write: 20 } });
        expect(observations.filter(row => row.tokens?.totalTokens === 1400)).toHaveLength(cancelling ? 0 : 1);
        expect(assistant.info.finish).toBe(cancelling ? 'cancelled' : failing ? 'error' : 'stop');
        if (!cancelling) expect(assistant.info.cursorUsage.source).toBe(failing ? 'sdk-run-snapshot' : 'sdk-run-result');
        if (!failing && !cancelling) {
          expect(await runtime.generateTitle({ text: 'Generate a title', sessionID: 'ses_fixture', directory })).toBe('Fixture title');
          expect(titleObservations).toHaveLength(1);
          expect(titleObservations[0]).toMatchObject({ sessionID: 'ses_fixture', directory, observation: {
            requestID: 'title-request', runID: 'title-run', source: 'sdk-run-result', tokens: normalizeCursorUsage(first),
          } });
        }
        await runtime.dispose();
        runtime = createCursorSdkRuntime({ storageDir: path.join(directory, 'state'), env: {}, readAuth: () => ({}) });
        const restored = (await runtime.getSessionMessages('ses_fixture')).find(row => row.info.id === assistant.info.id);
        expect(restored.info.cursorUsage).toEqual(assistant.info.cursorUsage);
        expect(restored.info.tokens).toEqual(assistant.info.tokens);
      } finally {
        await runtime?.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }, electronWorker ? 45_000 : 15_000);
  }
}

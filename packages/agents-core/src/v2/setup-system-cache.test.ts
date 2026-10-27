import { expect, test } from 'bun:test';
import { Auth, CacheHint, LLM, Message, SystemPart } from '@opencode/ai/effect';
import * as Anthropic from '@opencode/ai/providers/anthropic';
import * as OpenAI from '@opencode/ai/providers/openai';
import { compileRequest } from '@opencode/ai/testing';
import type { PluginHooks } from '@opencode/core/plugin/hooks';
import { Location } from '@opencode/core/location';
import type {
  SessionCompaction,
  SessionContext,
} from '@opencode/plugin/effect/session';
import { Agent } from '@opencode/schema/agent';
import { Model } from '@opencode/schema/model';
import { Session } from '@opencode/schema/session';
import { Effect, Schema } from 'effect';
import { OperationPermitRef } from '../../../web/server/lib/opencode/runtime-host/native-admission-contract';
import { createNativeSessionContext } from '../../../web/server/lib/opencode/runtime-host/native-session-context';
import { nativeSlimSystemTransform } from '../../../web/server/lib/opencode/runtime-host/native-slim-runtime';
import {
  collapseSystemInPlace,
  collapseSystemPartsInPlace,
} from '../utils/system-collapse';
import {
  applySystemTransform,
  createSessionCompactionBridge,
  createSessionContextHandler,
} from './setup';

/**
 * Prompt-cache continuity across compaction. The host builds the summary
 * request from the normal request's system, tools and history so it can
 * reuse that request's prompt cache. Both requests run through the host's
 * Slim system transform, these context and compaction bridges and the
 * host's compaction-anchor decorator, and are then compiled to provider
 * wire bodies.
 */

const ANCHOR = '[devryan-compaction-anchor:v1]\nOwned original objective';
const SUMMARY_PROMPT = 'Summarize the conversation.';
const location = Schema.decodeUnknownSync(Location.Info)({
  directory: '/reviewed/project',
  project: {
    id: 'global',
    directory: '/reviewed/project',
    canonical: '/reviewed/project',
  },
});
const origin = {
  kind: 'plugin',
  id: 'devryan.harness-context',
  manifestDigest: 'c'.repeat(64),
  capabilities: ['control'],
} as const;
const permit = { token: 'private', revision: 2, sessionID: 'ses_owned' };
const tools = {
  read: {
    description: 'Read a file',
    input: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  grep: {
    description: 'Search files',
    input: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
};
// The two parts the host builds: the agent prompt and the initial block.
const coreSystem = () => [
  SystemPart.make('You are the builder agent.\nKeep owned tool policy.'),
  SystemPart.make(
    '<env>\nWorking directory: /reviewed/project\n</env>\nProject instructions.',
  ),
];
const JOINED =
  'You are the builder agent.\nKeep owned tool policy.\n\n<env>\nWorking directory: /reviewed/project\n</env>\nProject instructions.';
const history = () => [
  Message.user('Fix the failing parser test.'),
  Message.assistant('Reading the parser first.'),
  Message.user('Continue with the fix.'),
];
const anthropic = Anthropic.configure({ auth: Auth.none }).model(
  'claude-fixture',
);
const openai = OpenAI.configure({ auth: Auth.none }).responses(
  'gpt-5-fixture',
);

async function requestPair(
  preserveSystemCache: boolean,
  system: () => SystemPart[],
): Promise<{ normal: SessionContext; compaction: SessionCompaction }> {
  const transform = nativeSlimSystemTransform(
    { collapseSystemInPlace, collapseSystemPartsInPlace },
    preserveSystemCache,
  );
  const fields = () => ({
    sessionID: Session.ID.make('ses_owned'),
    agent: Agent.ID.make('builder'),
    model: Schema.decodeUnknownSync(Model.Ref)({
      providerID: 'anthropic',
      id: 'claude-fixture',
    }),
    system: system(),
    messages: history(),
    options: {},
    tools,
  });
  const normal: SessionContext = fields();
  await createSessionContextHandler({
    interviewHandleContext: async () => {},
    systemTransform: transform,
  })(normal);
  const compaction: SessionCompaction = fields();
  const bridge = createSessionCompactionBridge(undefined, transform);
  const factory = createNativeSessionContext({
    origin,
    preserveSystemCache,
    executeOwned: () => Effect.die(Error('unreviewed')),
    rpc: async () => ({ available: true, text: ANCHOR }),
  });
  const inner: PluginHooks.Interface = {
    has: () => Effect.succeed(false),
    register: () => Effect.die(Error('not called')),
    trigger: (_domain, _name, event) =>
      Effect.promise(async () => {
        await bridge(compaction);
        return event;
      }),
  };
  await Effect.runPromise(
    factory
      .decorateHooks(inner, location)
      .trigger('session', 'compaction', compaction)
      .pipe(Effect.provideService(OperationPermitRef, permit)),
  );
  return { normal, compaction };
}

/** Compile like the host: hook tools become definitions; compaction appends its prompt. */
async function wire(
  model: typeof anthropic | typeof openai,
  event: SessionContext,
  tail: readonly Message[] = [],
): Promise<Record<string, unknown>> {
  const request = LLM.request({
    model,
    system: event.system,
    messages: [...event.messages, ...tail],
    tools: Object.entries(event.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.input,
    })),
  });
  const compiled = await Effect.runPromise(compileRequest(request));
  const body: unknown = compiled.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('compiled body missing');
  }
  return Object.fromEntries(Object.entries(body));
}

test('a compaction request keeps the normal request system and tools bytes and puts the anchor after the history', async () => {
  const { normal, compaction } = await requestPair(true, coreSystem);
  expect(normal.system).toEqual([{ type: 'text', text: JOINED }]);
  expect(compaction.system).toEqual(normal.system);
  expect(
    JSON.stringify(compaction.messages.slice(0, normal.messages.length)),
  ).toBe(JSON.stringify(normal.messages));
  expect(compaction.messages.slice(normal.messages.length)).toEqual([
    Message.system(ANCHOR),
  ]);

  const summary = [Message.user(SUMMARY_PROMPT)];
  const anthropicNormal = await wire(anthropic, normal);
  const anthropicCompaction = await wire(anthropic, compaction, summary);
  // Byte snapshot of the shared Anthropic prefix: tools, then the system block.
  expect(
    JSON.stringify(anthropicNormal.tools) +
      JSON.stringify(anthropicNormal.system),
  ).toBe(
    '[{"name":"read","description":"Read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},' +
      '{"name":"grep","description":"Search files","input_schema":{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]},"cache_control":{"type":"ephemeral"}}]' +
      `[{"type":"text","text":${JSON.stringify(JOINED)},"cache_control":{"type":"ephemeral"}}]`,
  );

  const openaiNormal = await wire(openai, normal);
  const openaiCompaction = await wire(openai, compaction, summary);
  for (const [normalBody, compactionBody, systemKey, messagesKey] of [
    [anthropicNormal, anthropicCompaction, 'system', 'messages'],
    [openaiNormal, openaiCompaction, 'instructions', 'input'],
  ] as const) {
    for (const key of ['tools', systemKey]) {
      expect(JSON.stringify(compactionBody[key])).toBe(
        JSON.stringify(normalBody[key]),
      );
    }
    expect(JSON.stringify(compactionBody[systemKey])).not.toContain(
      'devryan-compaction-anchor',
    );
    const sent = JSON.stringify(compactionBody[messagesKey]);
    expect(sent.indexOf('devryan-compaction-anchor')).toBeGreaterThan(
      sent.lastIndexOf('Continue with the fix.'),
    );
  }
});

test('neighbouring system parts merge only with the same cache marker and keep marker and metadata', async () => {
  const cache = new CacheHint({ type: 'ephemeral' });
  const marked = () => [
    SystemPart.make('Base agent prompt.'),
    {
      ...SystemPart.make('Stable project block one.'),
      cache,
      metadata: { source: 'one' },
    },
    {
      ...SystemPart.make('Stable project block two.'),
      cache,
      metadata: { baseline: 'two' },
    },
    SystemPart.make('Volatile session block.'),
  ];
  const { normal, compaction } = await requestPair(true, marked);
  expect(normal.system).toEqual([
    { type: 'text', text: 'Base agent prompt.' },
    {
      type: 'text',
      text: 'Stable project block one.\n\nStable project block two.',
      cache,
      metadata: { source: 'one', baseline: 'two' },
    },
    { type: 'text', text: 'Volatile session block.' },
  ]);
  expect(normal.system[1]?.cache).toBe(cache);
  expect(compaction.system).toEqual(normal.system);
  const normalBody = await wire(anthropic, normal);
  const compactionBody = await wire(anthropic, compaction, [
    Message.user(SUMMARY_PROMPT),
  ]);
  expect(JSON.stringify(compactionBody.system)).toBe(
    JSON.stringify(normalBody.system),
  );
});

test('DEVRYAN_SYSTEM_CACHE_PRESERVE=0 restores the joined system and the anchor system part', async () => {
  const { normal, compaction } = await requestPair(false, coreSystem);
  expect(normal.system).toEqual([{ type: 'text', text: JOINED }]);
  expect(compaction.system.map((part) => part.text)).toEqual([
    ...coreSystem().map((part) => part.text),
    ANCHOR,
  ]);
  expect(JSON.stringify(compaction.messages)).toBe(JSON.stringify(history()));
  const normalBody = await wire(anthropic, normal);
  const compactionBody = await wire(anthropic, compaction, [
    Message.user(SUMMARY_PROMPT),
  ]);
  expect(JSON.stringify(compactionBody.system)).not.toBe(
    JSON.stringify(normalBody.system),
  );
});

test('a transform that edits only the strings gets bare text parts back', async () => {
  const cache = new CacheHint({ type: 'ephemeral' });
  const event = {
    sessionID: 'ses_owned',
    system: [{ ...SystemPart.make('kept'), cache, metadata: { a: 1 } }],
  };
  await applySystemTransform(
    event,
    async (_input, output) => {
      output.system.push('appended');
    },
    'context',
  );
  expect(event.system).toEqual([
    { type: 'text', text: 'kept' },
    { type: 'text', text: 'appended' },
  ]);
});

test('a failed compaction system transform leaves the host system unchanged', async () => {
  const compaction: SessionCompaction = {
    sessionID: Session.ID.make('ses_owned'),
    agent: Agent.ID.make('builder'),
    model: Schema.decodeUnknownSync(Model.Ref)({
      providerID: 'anthropic',
      id: 'claude-fixture',
    }),
    system: coreSystem(),
    messages: history(),
    options: {},
    tools,
  };
  const system = compaction.system;
  await createSessionCompactionBridge(undefined, async () => {
    throw new Error('transform failed');
  })(compaction);
  expect(compaction.system).toBe(system);
  expect(compaction.system.map((part) => part.text)).toEqual(
    coreSystem().map((part) => part.text),
  );
});

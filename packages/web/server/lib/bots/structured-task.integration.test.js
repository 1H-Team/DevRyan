import { describe, expect, it, vi } from 'vitest';

import {
  BOT_MEMORY_EXTRACTION_SCHEMA,
  classifyBotMemoryCandidates,
} from './memory-classifier.js';
import { createBotOpenCodeProvider } from './opencode-provider.js';
import { createOpenCodeReasoningAdapter } from './opencode-reasoning-adapter.js';
import { createBotRoutineDrafter } from './routine-drafter.js';
import { runBotStructuredTask } from './structured-task.js';

const RUN_ID = 'a0000000-0000-4000-8000-000000000001';
const SECOND_RUN_ID = 'a0000000-0000-4000-8000-000000000002';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const OWNER_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_MESSAGE_ID = 'f0000000-0000-4000-8000-000000000001';
const ASSISTANT_MESSAGE_ID = 'f0000000-0000-4000-8000-000000000002';
const TOKEN = 't'.repeat(43);
const HASH = 'a'.repeat(64);

const contract = Object.freeze({
  models: {
    primary: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
    fallbacks: [],
  },
});

const run = (id = RUN_ID) => ({
  id,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  ownerUserId: OWNER_ID,
});

const createHarness = (output) => {
  const client = {
    provider: { list: vi.fn(async () => ({ data: { all: [] } })) },
    session: {
      create: vi.fn(async () => ({ data: { id: 'ses_structured_1' } })),
      prompt: vi.fn(async () => ({
        data: {
          info: { id: 'msg_structured_1', role: 'assistant' },
          parts: [{ type: 'text', text: output }],
        },
      })),
      delete: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: true })),
      messages: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
    },
  };
  const model = { providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'high' };
  const modelSnapshot = {
    providerId: model.providerId,
    modelId: model.modelId,
    candidateIndex: 0,
    contextLimit: 100,
  };
  const modelCredentialBroker = {
    preflightRun: vi.fn(async () => ({ model, modelSnapshot, egressHosts: ['api.openai.com:443'] })),
    prepareRun: vi.fn(async () => ({ model, modelSnapshot, egressHosts: ['api.openai.com:443'] })),
    prepareProvisionalRun: vi.fn(async () => ({
      model,
      modelSnapshot,
      egressHosts: ['api.openai.com:443'],
      provisional: true,
    })),
    assertRuntimeReady: vi.fn(async () => {}),
    finalizeRun: vi.fn(async () => ({ removed: true })),
    discardRun: vi.fn(async () => ({ removed: true })),
  };
  const provider = createBotOpenCodeProvider({
    dockerProvider: {
      ensureReasoning: vi.fn(async () => ({
        endpoint: { host: '127.0.0.1', port: 55101, baseUrl: 'http://127.0.0.1:55101' },
      })),
      stopReasoning: vi.fn(async () => ({ state: 'stopped' })),
    },
    configCompiler: {
      compile: vi.fn(async () => ({ compiledHash: HASH, contract, directory: '/private/config' })),
    },
    modelCredentialBroker,
    gatewayHost: {
      start: vi.fn(async () => {}),
      issueCapability: vi.fn(() => ({
        token: TOKEN,
        dockerGatewayUrl: 'http://host.docker.internal:55100',
        expiresAt: Date.now() + 60_000,
      })),
      revokeRun: vi.fn(() => 1),
      shutdown: vi.fn(async () => {}),
    },
    artifactService: {
      materializeRun: vi.fn(async () => ({ attachments: [], objectCount: 0 })),
      cleanupRun: vi.fn(async () => ({ removed: true })),
    },
    environmentSecrets: {
      prepareRun: vi.fn(async () => ({ count: 0 })),
      finalizeRun: vi.fn(async () => ({ removed: true })),
    },
    createClient: vi.fn(() => client),
    waitForReady: vi.fn(async () => {}),
    subscribeToEvents: vi.fn(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', resolve, { once: true });
    })),
  });
  return {
    adapter: createOpenCodeReasoningAdapter({ provider }),
    client,
  };
};

describe('Bot structured task OpenCode integration', () => {
  it('round-trips string memory output through the no-tools provider and classifier', async () => {
    const harness = createHarness('{"candidates":[]}');
    const output = await runBotStructuredTask({
      adapter: harness.adapter,
      run: run(),
      contract,
      binding: { kind: 'opencode' },
      prompt: 'Extract reusable memory.',
      schema: BOT_MEMORY_EXTRACTION_SCHEMA,
      title: 'Bot Memory Extraction',
      system: 'Extract structured memory only. Do not call tools or perform actions.',
    });

    expect(output).toBe('{"candidates":[]}');
    expect(classifyBotMemoryCandidates({
      output,
      botId: BOT_ID,
      channelId: CHANNEL_ID,
      runId: RUN_ID,
      ownerUserId: OWNER_ID,
      messageIds: [USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID],
      transcript: 'Remember nothing from this turn.',
    })).toMatchObject({ accepted: [], rejected: [] });
    expect(harness.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
      tools: { '*': false },
      format: { type: 'json_schema', schema: BOT_MEMORY_EXTRACTION_SCHEMA, retryCount: 2 },
    }), { signal: expect.any(AbortSignal) });
  });

  it('drafts a reviewed routine through the same no-tools structured chain', async () => {
    const draft = {
      version: 1,
      rationale: 'Model draft.',
      trigger: { kind: 'daily', time: '09:30' },
      timezone: 'UTC',
      goal: 'Review the support queue.',
      inputs: { queue: 'priority' },
      allowedTools: [],
      allowedAccountIds: [],
      allowedOrigins: [],
      limits: { maxActions: 10, maxExternalWrites: 0 },
      approvalClass: 'none',
      timeoutSeconds: 600,
      missedPolicy: 'skip',
      missedRunCap: 1,
      completionCriteria: ['Every priority ticket is summarized.'],
    };
    const harness = createHarness(JSON.stringify(draft));
    const drafter = createBotRoutineDrafter({
      generateNoTools: ({ prompt, schema, title, system }) => runBotStructuredTask({
        adapter: harness.adapter,
        run: run(SECOND_RUN_ID),
        contract,
        binding: { kind: 'opencode' },
        prompt,
        schema,
        title,
        system,
      }),
    });

    await expect(drafter.draft({
      principal: { id: OWNER_ID },
      botId: BOT_ID,
      rationale: 'Summarize priority support tickets each morning.',
      timezone: 'Africa/Casablanca',
    })).resolves.toMatchObject({
      requiresManagerReview: true,
      contract: {
        rationale: 'Summarize priority support tickets each morning.',
        timezone: 'Africa/Casablanca',
      },
    });
    expect(harness.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
      tools: { '*': false },
      format: expect.objectContaining({ type: 'json_schema' }),
    }), { signal: expect.any(AbortSignal) });
  });
});

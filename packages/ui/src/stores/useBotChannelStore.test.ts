import { describe, expect, test } from 'bun:test';

import {
  BotsApiError,
  type BotChannel,
  type BotMessage,
  type BotRun,
  type BotSendMessageRequest,
  type BotsApi,
} from '@/lib/botsApi';
import { createBotChannelStore } from './useBotChannelStore';

const CHANNEL_A = 'c0000000-0000-4000-8000-000000000001';
const CHANNEL_B = 'c0000000-0000-4000-8000-000000000002';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'f0000000-0000-4000-8000-000000000001';
const RUN_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const CLIENT_MESSAGE_ID = 'd0000000-0000-4000-8000-000000000099';
const ACKNOWLEDGMENT_ID = 'd0000000-0000-4000-8000-000000000100';
const NOW = '2026-08-23T10:00:00.000Z';

const channel = (id: string): BotChannel => ({
  id,
  botId: BOT_ID,
  ownerUserId: USER_ID,
  accessRole: 'owner',
  canSend: true,
  lifecycle: 'active',
  currentCheckpointNumber: 0,
  lastMessageSequence: 0,
  lastMessageAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
});

const message = (
  channelId: string,
  sequence: number,
  overrides: Partial<BotMessage> = {},
): BotMessage => ({
  id: `d0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  channelId,
  runId: null,
  actorUserId: USER_ID,
  role: 'user',
  assistantPhase: null,
  sequence,
  body: { text: `Message ${sequence}`, attachmentIds: [] },
  attachmentCount: 0,
  createdAt: `2026-08-23T10:00:${String(sequence).padStart(2, '0')}.000Z`,
  finalizedAt: NOW,
  ...overrides,
});

const pendingResponse = (overrides: Partial<BotMessage> = {}): BotMessage => message(CHANNEL_A, 2, {
  id: ACKNOWLEDGMENT_ID,
  runId: RUN_ID,
  actorUserId: null,
  role: 'assistant',
  assistantPhase: 'pending',
  body: { text: '', attachmentIds: [] },
  attachmentCount: 0,
  finalizedAt: null,
  ...overrides,
});

const sequentialUuid = (...values: string[]) => {
  let index = 0;
  return () => values[index++] || values[values.length - 1];
};

const run = (): BotRun => ({
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_A,
  revisionId: REVISION_ID,
  modelSnapshot: null,
  computerScopeKey: `bot:${BOT_ID}`,
  queueSequence: 1,
  state: 'queued',
  retryable: false,
  interruptionKind: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: null,
  finishedAt: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

describe('Production Bot channel store', () => {
  test('coalesces owner-channel creation and exposes one authoritative handoff', async () => {
    const opened = deferred<{ channel: BotChannel }>();
    let calls = 0;
    const api = {
      getOrCreateOwnerChannel: () => {
        calls += 1;
        return opened.promise;
      },
    } as unknown as BotsApi;
    const store = createBotChannelStore({ api, getPrincipalId: () => USER_ID });

    const first = store.getState().ensureOwnerChannel(BOT_ID);
    const second = store.getState().ensureOwnerChannel(BOT_ID);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(store.getState().openingOwnerChannelByBotId[BOT_ID]).toBe(true);

    opened.resolve({ channel: channel(CHANNEL_A) });
    await first;
    expect(store.getState().channelsById[CHANNEL_A]).toEqual(channel(CHANNEL_A));
    expect(store.getState().openingOwnerChannelByBotId[BOT_ID]).toBe(undefined);

    await store.getState().ensureOwnerChannel(BOT_ID);
    expect(calls).toBe(1);
  });

  test('keeps unrelated channel selector references stable', () => {
    const store = createBotChannelStore();
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A), channel(CHANNEL_B)] });
    store.getState().upsertMessage(message(CHANNEL_A, 1));
    const channelAIds = store.getState().messageIdsByChannelId[CHANNEL_A];
    const channelARecord = store.getState().channelsById[CHANNEL_A];

    store.getState().upsertMessage(message(CHANNEL_B, 1));

    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toBe(channelAIds);
    expect(store.getState().channelsById[CHANNEL_A]).toBe(channelARecord);
  });

  test('keeps attachment projections stable while streamed text changes', () => {
    const store = createBotChannelStore();
    const attachmentId = 'a0000000-0000-4000-8000-000000000010';
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().upsertMessage(message(CHANNEL_A, 1, {
      body: { text: 'Starting', attachmentIds: [attachmentId] },
      attachmentCount: 1,
      finalizedAt: null,
    }));
    const attachmentIds = store.getState().attachmentIdsByChannelId[CHANNEL_A];

    store.getState().upsertMessage(message(CHANNEL_A, 1, {
      body: { text: 'Starting and continuing', attachmentIds: [attachmentId] },
      attachmentCount: 1,
      finalizedAt: null,
    }));

    expect(store.getState().attachmentIdsByChannelId[CHANNEL_A]).toBe(attachmentIds);
    expect(attachmentIds).toEqual([attachmentId]);
  });

  test('does not update or reorder roster previews until a streamed message is complete', () => {
    const store = createBotChannelStore();
    store.getState().replaceSnapshot({
      channels: [channel(CHANNEL_A)],
      channelPreviews: [{
        channelId: CHANNEL_A,
        messageId: 'd0000000-0000-4000-8000-000000000001',
        role: 'user',
        sequence: 1,
        text: 'Stable preview',
        attachmentCount: 0,
        createdAt: '2026-08-23T10:00:01.000Z',
        finalizedAt: NOW,
      }],
    });
    const stablePreview = store.getState().previewsByChannelId[CHANNEL_A];
    const streaming = message(CHANNEL_A, 2, {
      role: 'assistant',
      actorUserId: null,
      body: { text: 'Partial answer', attachmentIds: [] },
      finalizedAt: null,
    });

    store.getState().upsertMessage(streaming);
    store.getState().upsertMessage({
      ...streaming,
      body: { text: 'Longer partial answer', attachmentIds: [] },
    });
    expect(store.getState().previewsByChannelId[CHANNEL_A]).toBe(stablePreview);

    store.getState().upsertMessage({
      ...streaming,
      body: { text: 'Complete answer', attachmentIds: [] },
      finalizedAt: '2026-08-23T10:00:02.000Z',
    });
    const completedPreview = store.getState().previewsByChannelId[CHANNEL_A];
    expect(completedPreview.messageId).toBe(streaming.id);
    expect(completedPreview.text).toBe('Complete answer');
    expect(completedPreview.finalizedAt).toBe('2026-08-23T10:00:02.000Z');

    store.getState().upsertMessage(message(CHANNEL_A, 3, {
      role: 'assistant',
      actorUserId: null,
      body: { text: '   ', attachmentIds: [] },
      finalizedAt: '2026-08-23T10:00:03.000Z',
    }));
    expect(store.getState().previewsByChannelId[CHANNEL_A]).toBe(completedPreview);
  });

  test('hides historical acknowledgments from previews and uses the finalized result', () => {
    const store = createBotChannelStore();
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    const acknowledgment = message(CHANNEL_A, 1, {
      runId: RUN_ID,
      role: 'assistant',
      assistantPhase: 'acknowledgment',
      actorUserId: null,
      body: { text: "Sure — I'll check that and get back to you.", attachmentIds: [] },
      finalizedAt: '2026-08-23T10:00:01.000Z',
    });
    const result = message(CHANNEL_A, 2, {
      runId: RUN_ID,
      role: 'assistant',
      assistantPhase: 'result',
      actorUserId: null,
      body: { text: '', attachmentIds: [] },
      finalizedAt: null,
    });

    store.getState().upsertMessage(acknowledgment);
    store.getState().upsertMessage(result);
    expect(store.getState().previewsByChannelId[CHANNEL_A]).toBe(undefined);

    store.getState().upsertMessage({
      ...result,
      body: { text: 'The site is healthy and the deployment completed.', attachmentIds: [] },
      finalizedAt: '2026-08-23T10:00:02.000Z',
    });
    const completedPreview = store.getState().previewsByChannelId[CHANNEL_A];
    expect(completedPreview?.messageId).toBe(result.id);
    expect(completedPreview?.text).toBe('The site is healthy and the deployment completed.');
  });

  test('merges older pages by sequence without duplicating or replacing equal rows', () => {
    const store = createBotChannelStore();
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().mergeMessagePage(CHANNEL_A, {
      messages: [message(CHANNEL_A, 3), message(CHANNEL_A, 4)],
      nextCursor: 'older-page',
    }, true);
    const third = store.getState().messagesById[message(CHANNEL_A, 3).id];

    store.getState().mergeMessagePage(CHANNEL_A, {
      messages: [message(CHANNEL_A, 1), message(CHANNEL_A, 2), message(CHANNEL_A, 3)],
      nextCursor: null,
    });

    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([
      message(CHANNEL_A, 1).id,
      message(CHANNEL_A, 2).id,
      message(CHANNEL_A, 3).id,
      message(CHANNEL_A, 4).id,
    ]);
    expect(store.getState().messagesById[message(CHANNEL_A, 3).id]).toBe(third);
    expect(store.getState().nextCursorByChannelId[CHANNEL_A]).toBeNull();
  });

  test('refreshes the canonical latest page without erasing older history or rewinding its cursor', async () => {
    const older = message(CHANNEL_A, 1);
    const unchanged = message(CHANNEL_A, 3);
    const missedReply = message(CHANNEL_A, 4, {
      role: 'assistant',
      actorUserId: null,
      body: { text: 'Persisted while SSE was disconnected', attachmentIds: [] },
    });
    let listRequest: readonly unknown[] | null = null;
    const api = {
      listMessages: async (...input: readonly unknown[]) => {
        listRequest = input;
        return {
        messages: [unchanged, missedReply],
        nextCursor: 'server-latest-cursor',
        };
      },
    } as unknown as BotsApi;
    const store = createBotChannelStore({ api });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().mergeMessagePage(CHANNEL_A, {
      messages: [older, unchanged],
      nextCursor: 'older-history-cursor',
    }, true);
    const olderReference = store.getState().messagesById[older.id];
    const unchangedReference = store.getState().messagesById[unchanged.id];

    await store.getState().refreshLatestMessages(CHANNEL_A);

    expect(listRequest).toEqual([CHANNEL_A, { cursor: null, limit: 100 }]);
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([
      older.id,
      unchanged.id,
      missedReply.id,
    ]);
    expect(store.getState().messagesById[older.id]).toBe(olderReference);
    expect(store.getState().messagesById[unchanged.id]).toBe(unchangedReference);
    expect(store.getState().nextCursorByChannelId[CHANNEL_A]).toBe('older-history-cursor');
  });

  test('commits the optimistic row and clears the composer before acceptance settles', async () => {
    const accepted = deferred<Awaited<ReturnType<BotsApi['sendMessage']>>>();
    let request: BotSendMessageRequest | null = null;
    const api = {
      sendMessage: async (_channelId: string, input: BotSendMessageRequest) => {
        request = input;
        return accepted.promise;
      },
    } as BotsApi;
    const acceptedRuns: BotRun[] = [];
    const store = createBotChannelStore({
      api,
      uuid: sequentialUuid(CLIENT_MESSAGE_ID, ACKNOWLEDGMENT_ID),
      now: () => new Date(NOW),
      getPrincipalId: () => USER_ID,
      onRunAccepted: (acceptedRun) => acceptedRuns.push(acceptedRun),
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().setDraft(CHANNEL_A, { text: 'Ship it', attachmentIds: [] });

    const send = store.getState().sendDraft(CHANNEL_A);
    expect(request).toEqual({
      messageId: CLIENT_MESSAGE_ID,
      acknowledgmentId: ACKNOWLEDGMENT_ID,
      idempotencyKey: `bot-message:${CLIENT_MESSAGE_ID}`,
      text: 'Ship it',
      attachmentIds: [],
    });
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID].id).toBe(CLIENT_MESSAGE_ID);
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID].runId).toBeNull();
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID].body.text).toBe('Ship it');
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([
      CLIENT_MESSAGE_ID,
      ACKNOWLEDGMENT_ID,
    ]);
    expect(store.getState().messagesById[ACKNOWLEDGMENT_ID].assistantPhase)
      .toBe('pending');
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toBe(undefined);
    expect(store.getState().pendingMessageIdByChannelId[CHANNEL_A]).toBe(CLIENT_MESSAGE_ID);

    accepted.resolve({
      created: true,
      message: message(CHANNEL_A, 1, {
        id: CLIENT_MESSAGE_ID,
        runId: RUN_ID,
        body: { text: 'Ship it', attachmentIds: [] },
      }),
      acknowledgment: pendingResponse(),
      run: run(),
    });
    await send;

    expect(store.getState().messagesById[CLIENT_MESSAGE_ID].runId).toBe(RUN_ID);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toBe(undefined);
    expect(store.getState().pendingMessageIdByChannelId[CHANNEL_A]).toBe(undefined);
    expect(acceptedRuns).toEqual([run()]);
  });

  test('rolls back a 503 optimistic row while retaining text and attachments', async () => {
    const failed = deferred<Awaited<ReturnType<BotsApi['sendMessage']>>>();
    const api = { sendMessage: () => failed.promise } as unknown as BotsApi;
    const store = createBotChannelStore({
      api,
      uuid: sequentialUuid(CLIENT_MESSAGE_ID, ACKNOWLEDGMENT_ID),
      getPrincipalId: () => USER_ID,
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().setDraft(CHANNEL_A, {
      text: 'Do not lose this',
      attachmentIds: ['a0000000-0000-4000-8000-000000000010'],
    });

    const send = store.getState().sendDraft(CHANNEL_A);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toBe(undefined);
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID]?.body.text).toBe('Do not lose this');
    failed.reject(new BotsApiError('Docker Desktop is stopped', {
      status: 503,
      code: 'bot_runtime_docker_unavailable',
    }));
    const error = await send.catch((caught: unknown) => caught);
    expect((error as BotsApiError).code).toBe('bot_runtime_docker_unavailable');

    expect(store.getState().messagesById[CLIENT_MESSAGE_ID]).toBe(undefined);
    expect(store.getState().messagesById[ACKNOWLEDGMENT_ID]).toBe(undefined);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toEqual({
      text: 'Do not lose this',
      attachmentIds: ['a0000000-0000-4000-8000-000000000010'],
    });
    expect(store.getState().sendErrorCodeByChannelId[CHANNEL_A])
      .toBe('bot_runtime_docker_unavailable');
  });

  test('refreshes after an ambiguous failure and retries once with the same idempotency identity', async () => {
    const requests: BotSendMessageRequest[] = [];
    const acceptedMessage = message(CHANNEL_A, 1, {
      id: CLIENT_MESSAGE_ID,
      runId: RUN_ID,
      body: { text: 'Only once', attachmentIds: [] },
    });
    const api = {
      listMessages: async () => ({ messages: [], nextCursor: null }),
      sendMessage: async (_channelId: string, request: BotSendMessageRequest) => {
        requests.push({ ...request });
        if (requests.length === 1) {
          throw new BotsApiError('connection closed', { status: 0, code: 'network_error' });
        }
        return {
          created: true,
          message: acceptedMessage,
          acknowledgment: pendingResponse(),
          run: run(),
        };
      },
    } as unknown as BotsApi;
    const store = createBotChannelStore({
      api,
      uuid: sequentialUuid(CLIENT_MESSAGE_ID, ACKNOWLEDGMENT_ID),
      now: () => new Date(NOW),
      getPrincipalId: () => USER_ID,
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().setDraft(CHANNEL_A, { text: 'Only once', attachmentIds: [] });

    const response = await store.getState().sendDraft(CHANNEL_A);

    expect(response?.message.id).toBe(CLIENT_MESSAGE_ID);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]?.idempotencyKey).toBe(`bot-message:${CLIENT_MESSAGE_ID}`);
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([
      CLIENT_MESSAGE_ID,
      ACKNOWLEDGMENT_ID,
    ]);
    expect(store.getState().unconfirmedMessageIds[CLIENT_MESSAGE_ID]).toBe(undefined);
    expect(store.getState().pendingMessageIdByChannelId[CHANNEL_A]).toBe(undefined);
  });

  test('keeps one Not confirmed row when both idempotent acceptance attempts are ambiguous', async () => {
    const requests: BotSendMessageRequest[] = [];
    const api = {
      listMessages: async () => ({ messages: [], nextCursor: null }),
      sendMessage: async (_channelId: string, request: BotSendMessageRequest) => {
        requests.push({ ...request });
        throw new BotsApiError('invalid gateway response', {
          status: 502,
          code: 'bot_invalid_response',
        });
      },
    } as unknown as BotsApi;
    const store = createBotChannelStore({
      api,
      uuid: sequentialUuid(CLIENT_MESSAGE_ID, ACKNOWLEDGMENT_ID),
      getPrincipalId: () => USER_ID,
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().setDraft(CHANNEL_A, { text: 'Maybe accepted', attachmentIds: [] });

    const error = await store.getState().sendDraft(CHANNEL_A).catch((caught: unknown) => caught);

    expect((error as BotsApiError).code).toBe('bot_invalid_response');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([
      CLIENT_MESSAGE_ID,
      ACKNOWLEDGMENT_ID,
    ]);
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID]?.body.text).toBe('Maybe accepted');
    expect(store.getState().unconfirmedMessageIds[CLIENT_MESSAGE_ID]).toBe(true);
    expect(store.getState().pendingMessageIdByChannelId[CHANNEL_A]).toBe(undefined);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toBe(undefined);
    expect(store.getState().sendErrorCodeByChannelId[CHANNEL_A]).toBe('bot_message_not_confirmed');
  });

  test('uses canonical history after an ambiguous response instead of issuing a duplicate retry', async () => {
    let sendCalls = 0;
    const canonical = message(CHANNEL_A, 1, {
      id: CLIENT_MESSAGE_ID,
      runId: RUN_ID,
      body: { text: 'Already committed', attachmentIds: [] },
    });
    const api = {
      listMessages: async () => ({
        messages: [canonical, pendingResponse()],
        nextCursor: null,
      }),
      sendMessage: async () => {
        sendCalls += 1;
        throw new BotsApiError('connection closed', { status: 0, code: 'network_error' });
      },
    } as unknown as BotsApi;
    const store = createBotChannelStore({
      api,
      uuid: sequentialUuid(CLIENT_MESSAGE_ID, ACKNOWLEDGMENT_ID),
      getPrincipalId: () => USER_ID,
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().setDraft(CHANNEL_A, { text: 'Already committed', attachmentIds: [] });

    expect(await store.getState().sendDraft(CHANNEL_A)).toBeNull();
    expect(sendCalls).toBe(1);
    expect(store.getState().messagesById[CLIENT_MESSAGE_ID]).toEqual(canonical);
    expect(store.getState().unconfirmedMessageIds[CLIENT_MESSAGE_ID]).toBe(undefined);
  });

  test('requeues a retryable startup failure without creating a duplicate message', async () => {
    const retried = deferred<Awaited<ReturnType<BotsApi['retryRun']>>>();
    const retryIds: string[] = [];
    const api = {
      retryRun: async (runId: string) => {
        retryIds.push(runId);
        return retried.promise;
      },
    } as BotsApi;
    const attachmentId = 'a0000000-0000-4000-8000-000000000010';
    const source = message(CHANNEL_A, 1, {
      runId: RUN_ID,
      body: { text: 'Review the report', attachmentIds: [attachmentId] },
      attachmentCount: 1,
    });
    const acceptedRuns: BotRun[] = [];
    const store = createBotChannelStore({
      api,
      onRunAccepted: (acceptedRun) => acceptedRuns.push(acceptedRun),
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().upsertMessage(source);

    const retry = store.getState().retryRun(RUN_ID);
    expect(retryIds).toEqual([RUN_ID]);
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([source.id]);

    const queued = { ...run(), retryable: false, queueSequence: 2 };
    retried.resolve({ run: queued });
    await retry;
    expect(store.getState().messagesById[source.id]).toBe(source);
    expect(store.getState().messageIdsByChannelId[CHANNEL_A]).toEqual([source.id]);
    expect(acceptedRuns).toEqual([queued]);
  });

  test('keeps the original failed message when safe run retry is rejected', async () => {
    const attachmentId = 'a0000000-0000-4000-8000-000000000010';
    const refreshed = { ...run(), state: 'failed' as const, retryable: true };
    const acceptedRuns: BotRun[] = [];
    const api = {
      getRunStatus: async () => ({ run: refreshed }),
      retryRun: async () => {
        throw new BotsApiError('not retryable', { status: 409, code: 'bot_run_not_retryable', details: { retryReason: 'execution_started' } });
      },
    } as unknown as BotsApi;
    const source = message(CHANNEL_A, 1, {
      runId: RUN_ID,
      body: { text: 'Review the report', attachmentIds: [attachmentId] },
      attachmentCount: 1,
    });
    const store = createBotChannelStore({
      api, onRunAccepted: (current) => acceptedRuns.push(current),
    });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().upsertMessage(source);
    const partial = message(CHANNEL_A, 2, { role: 'assistant', runId: RUN_ID,
      actorUserId: null, body: { text: 'Partial response', attachmentIds: [] } });
    store.getState().upsertMessage(partial);
    store.getState().setDraft(CHANNEL_A, { text: 'Unsent follow-up', attachmentIds: [attachmentId] });
    const draft = store.draftStore.getState().draftsByChannelId[CHANNEL_A];


    const error = await store.getState().retryRun(RUN_ID)
      .catch((caught: unknown) => caught);
    expect(acceptedRuns).toEqual([{ ...refreshed, retryable: false }]);
    expect((error as BotsApiError).code).toBe('bot_run_not_retryable');
    expect(store.getState().messagesById[source.id]).toBe(source);
    expect(store.getState().messagesById[partial.id]).toBe(partial);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A]).toBe(draft);
    expect(store.getState().sendErrorCodeByChannelId[CHANNEL_A]).toBe('bot_run_not_retryable');
  });

  test('does not merge an old principal message page after account change', async () => {
    const page = deferred<{ messages: BotMessage[]; nextCursor: null }>();
    const api = { listMessages: () => page.promise } as unknown as BotsApi;
    const store = createBotChannelStore({ api });
    store.getState().resetPrincipal(USER_ID);
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    const load = store.getState().loadInitialMessages(CHANNEL_A);

    store.getState().resetPrincipal('a0000000-0000-4000-8000-000000000002');
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    page.resolve({ messages: [message(CHANNEL_A, 1)], nextCursor: null });
    await load;

    expect(store.getState().messagesById).toEqual({});
  });
});

describe('Bot transcript asynchronous reconciliation', () => {
  test('initial history preserves SSE additions, finalization, and deletion during the fetch', async () => {
    const page = deferred<{ messages: BotMessage[]; nextCursor: null }>();
    const store = createBotChannelStore({ api: { listMessages: () => page.promise } as unknown as BotsApi });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    const partial = pendingResponse({ body: { text: 'internal preamble', attachmentIds: [] } });
    store.getState().upsertMessage(partial);
    const request = store.getState().loadInitialMessages(CHANNEL_A);
    const final = { ...partial, assistantPhase: 'result' as const, finalizedAt: NOW, body: { text: 'Verified answer', attachmentIds: [] } };
    const added = message(CHANNEL_A, 3);
    store.getState().upsertMessage(final);
    store.getState().upsertMessage(added);
    store.getState().removeMessage(message(CHANNEL_A, 1).id);
    page.resolve({ messages: [message(CHANNEL_A, 1), partial], nextCursor: null });
    await request;
    expect(store.getState().messagesById[final.id]).toBe(final);
    expect(store.getState().messagesById[added.id]).toBe(added);
    expect(store.getState().messagesById[message(CHANNEL_A, 1).id]).toBeUndefined();
  });

  test('never regresses a finalized answer even after the fetch starts later', async () => {
    const final = pendingResponse({ assistantPhase: 'result', finalizedAt: NOW, body: { text: 'Final', attachmentIds: [] } });
    const store = createBotChannelStore({ api: {
      listMessages: async () => ({ messages: [{ ...final, finalizedAt: null, body: { text: 'Partial', attachmentIds: [] } }], nextCursor: null }),
    } as unknown as BotsApi });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    store.getState().upsertMessage(final);
    await store.getState().refreshLatestMessages(CHANNEL_A);
    expect(store.getState().messagesById[final.id]).toBe(final);
  });

  test('rejects old channel requests after revoke/regrant under the same principal', async () => {
    const page = deferred<{ messages: BotMessage[]; nextCursor: null }>();
    const store = createBotChannelStore({ api: { listMessages: () => page.promise } as unknown as BotsApi });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    const request = store.getState().loadInitialMessages(CHANNEL_A);
    store.getState().removeChannel(CHANNEL_A);
    store.getState().upsertChannel(channel(CHANNEL_A));
    page.resolve({ messages: [message(CHANNEL_A, 1)], nextCursor: null });
    await request;
    expect(store.getState().messagesById).toEqual({});
  });

  test('keeps draft keystrokes entirely outside transcript notifications', () => {
    const store = createBotChannelStore();
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    for (let index = 0; index < 100; index += 1) store.getState().setDraft(CHANNEL_A, { text: `Draft ${index}`, attachmentIds: [] });
    unsubscribe();
    expect(notifications).toBe(0);
    expect(store.draftStore.getState().draftsByChannelId[CHANNEL_A].text).toBe('Draft 99');
    store.getState().resetPrincipal(USER_ID);
    expect(store.draftStore.getState().draftsByChannelId).toEqual({});
  });

  test('retries startup 502/503 reads with a fixed bound, preserving explicit failure after exhaustion', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const store = createBotChannelStore({ delay: async (ms) => { delays.push(ms); }, api: {
      listMessages: async () => { attempts += 1; throw new BotsApiError('Starting', { status: 503, code: 'unavailable' }); },
    } as unknown as BotsApi });
    store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
    await expect(store.getState().loadInitialMessages(CHANNEL_A)).rejects.toThrow();
    expect(attempts).toBe(4);
    expect(delays).toEqual([250, 750, 1500]);
    expect(store.getState().loadingByChannelId[CHANNEL_A]).toBeUndefined();
    expect(store.getState().loadErrorCodeByChannelId[CHANNEL_A]).toBe('unavailable');
  });

  test('caps inactive history by both channels and bytes, preserving active, busy, and optimistic work', () => {
    const store = createBotChannelStore({ maxCachedChannels: 1, maxCachedBytes: 1500, isChannelBusy: (id) => id === 'busy' });
    const ids = ['active', 'busy', 'optimistic', 'old', 'new', 'oversized'];
    store.getState().replaceSnapshot({ channels: ids.map(channel) });
    store.getState().setActiveChannel('active');
    for (const [index, id] of ids.entries()) {
      store.getState().mergeMessagePage(id, { messages: [message(id, index + 1, {
        id: `message-${id}`, finalizedAt: id === 'optimistic' ? null : NOW,
        body: { text: id === 'oversized' ? 'x'.repeat(2000) : id, attachmentIds: [] },
      })], nextCursor: null });
    }
    expect(store.getState().messageIdsByChannelId.active).toEqual(['message-active']);
    expect(store.getState().messageIdsByChannelId.busy).toEqual(['message-busy']);
    expect(store.getState().messageIdsByChannelId.optimistic).toEqual(['message-optimistic']);
    expect(store.getState().messageIdsByChannelId.old).toBeUndefined();
    expect(store.getState().messageIdsByChannelId.oversized).toBeUndefined();
    expect(store.getState().channelsById.old).toBeDefined();
    expect(store.getState().nextCursorByChannelId.old).toBeUndefined();
  });
});

test('terminal run cache pruning releases previously busy transcript buckets', () => {
  let busy = true;
  const store = createBotChannelStore({ maxCachedChannels: 1, isChannelBusy: () => busy });
  store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A), channel(CHANNEL_B)] });
  store.getState().mergeMessagePage(CHANNEL_A, { messages: [message(CHANNEL_A, 1)], nextCursor: null });
  store.getState().mergeMessagePage(CHANNEL_B, { messages: [message(CHANNEL_B, 2)], nextCursor: null });
  expect(Object.keys(store.getState().messageIdsByChannelId)).toHaveLength(2);
  busy = false;
  store.getState().pruneInactiveCache();
  expect(Object.keys(store.getState().messageIdsByChannelId)).toHaveLength(1);
});

test('a fetched final answer outranks a partial event delivered during the read', async () => {
  const page = deferred<{ messages: BotMessage[]; nextCursor: null }>();
  const store = createBotChannelStore({ api: { listMessages: () => page.promise } as unknown as BotsApi });
  store.getState().replaceSnapshot({ channels: [channel(CHANNEL_A)] });
  const request = store.getState().loadInitialMessages(CHANNEL_A);
  const partial = pendingResponse({ assistantPhase: 'result', body: { text: 'Out-of-order partial', attachmentIds: [] } });
  store.getState().upsertMessage(partial);
  const final = { ...partial, finalizedAt: NOW, body: { text: 'Verified final', attachmentIds: [] } };
  page.resolve({ messages: [final], nextCursor: null });
  await request;
  expect(store.getState().messagesById[final.id]).toBe(final);
});

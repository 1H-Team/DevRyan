import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createKeyedSingleFlight,
  waitForSharedOperation,
  createManagedOpenCodeExecutor,
} from '@openchamber/orchestration-runtime';
import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';

import { resolveGen2OpenCodeClient } from '../opencode/opencode-client-seam.js';
import { stripMessageDiffSummary } from '../opencode/diff-summary.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// Session transcripts are unbounded: OpenCode attaches a full git diff snapshot
// to user messages, which for a repo with a large untracked tree can reach tens
// of megabytes. Reading one is not a fast control-plane call and must not share
// the 10s budget used by status/prompt/abort — a transcript that cannot be read
// inside the budget used to stall the managed task until its hard deadline.
const DEFAULT_MESSAGES_REQUEST_TIMEOUT_MS = 120_000;
// Creating a child session and posting its first prompt are NOT fast
// control-plane calls: OpenCode initializes the session, resolves the agent
// catalog, and (for a cold provider) may wait on a tool-catalog warm-up. Under
// the shared 10s budget a create that had already succeeded server-side threw
// client-side, orphaning the child session and leaving the orchestrator to
// re-dispatch — one of the ways duplicate subagents appear.
const DEFAULT_DISPATCH_REQUEST_TIMEOUT_MS = 30_000;
const CHILD_REGISTRATION_ATTEMPTS = 3;
const TRANSIENT_CHILD_REGISTRATION_CODES = new Set(['local_execution_timeout', 'execution_preparation_stalled',
  'LOCK_TIMEOUT', 'mutation_runtime_unavailable', 'execution_owner_unavailable']);

export const createWebManagedOpenCodeExecutor = (options = {}) => {
  const childRegistrationRetryDelayMs = options.childRegistrationRetryDelayMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const messagesRequestTimeoutMs = options.messagesRequestTimeoutMs
    ?? DEFAULT_MESSAGES_REQUEST_TIMEOUT_MS;
  const dispatchRequestTimeoutMs = options.dispatchRequestTimeoutMs
    ?? DEFAULT_DISPATCH_REQUEST_TIMEOUT_MS;
  const cursorSdkRuntime = options.cursorSdkRuntime ?? null;
  const openCodeClient = options.openCodeClient ?? null;
  if (openCodeClient !== null && typeof openCodeClient?.generation !== 'function') {
    throw new TypeError('openCodeClient must be an openCodeClient');
  }
  const statusSingleFlight = createKeyedSingleFlight();

  const buildPromptBody = (input) => ({
    ...(input.messageId ? { messageID: input.messageId } : {}),
    agent: input.agent,
    model: {
      providerID: input.providerId,
      modelID: input.modelId,
    },
    ...(input.variant ? { variant: input.variant } : {}),
    // Native OpenCode's empty variant clears an agent-configured effort.
    ...(input.variant === null && input.providerId !== CURSOR_PROVIDER_ID ? { variant: '' } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    parts: [{ type: 'text', text: input.prompt }],
  });

  const transport = {
    async createSession(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      const createNative = () => client.sessions.create({
          directory: input.directory,
          title: input.title,
          ...(input.parentSessionId ? { parentID: input.parentSessionId } : {}),
        }, { directory: input.directory, timeoutMs: dispatchRequestTimeoutMs });
      const child = await (options.nativeTaskDispatch
        ? options.nativeTaskDispatch({ operation: 'create', taskId: input.taskId, leaseToken: input.leaseToken,
          directory: input.directory, parentID: input.parentSessionId, parentCallID: input.parentCallID }, createNative)
        : createNative());
      if (input.parentSessionId && input.parentCallID && options.registerExecutionChild) {
        const registration = { directory: input.directory, sessionID: child.id,
          parentID: input.parentSessionId, parentCallID: input.parentCallID };
        // A transient failure may still have committed the registration (for
        // example an abort after a deadline-free commit); only a child whose
        // every attempt was definitively refused is provably unregistered.
        let ambiguous = false;
        try {
          for (let attempt = 1; ; attempt += 1) {
            try { await options.registerExecutionChild(registration); break; }
            catch (error) {
              // Contention on the execution ledger is transient; lineage and
              // revert fences are not and must fail the dispatch.
              const transient = TRANSIENT_CHILD_REGISTRATION_CODES.has(error?.code);
              ambiguous ||= transient;
              if (attempt >= CHILD_REGISTRATION_ATTEMPTS || !transient) throw error;
              await new Promise((resolve) => setTimeout(resolve, childRegistrationRetryDelayMs * attempt));
            }
          }
        } catch (error) {
          // A definitively unregistered child can never be admitted; remove it.
          if (!ambiguous) {
            await client.sessions.remove(child.id, { directory: input.directory, allowNotFound: true, timeoutMs: requestTimeoutMs }).catch(() => {});
          }
          throw error;
        }
      }
      return child;
    },
    async promptSession(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      const body = buildPromptBody(input);
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.handlePromptAsync !== 'function') {
          const error = new Error('Cursor managed orchestration is unavailable in this runtime');
          error.code = 'cursor_runtime_unavailable';
          error.statusCode = 503;
          throw error;
        }
        const result = await cursorSdkRuntime.handlePromptAsync({
          sessionID: input.sessionId,
          directory: input.directory,
          body,
        });
        const status = result?.status ?? 200;
        if (!result?.handled || status < 200 || status >= 300) {
          const error = new Error(
            typeof result?.body?.error === 'string'
              ? result.body.error
              : 'Cursor did not accept the managed prompt',
          );
          error.code = 'cursor_prompt_rejected';
          error.statusCode = status >= 400 && status <= 599 ? status : 502;
          throw error;
        }
        return;
      }
      // Gen 2: the admission module (B.5) owns selection switching and the
      // prompt; the dispatch budget and the caller's signal both apply.
      const promptNative = () => client.prompts.prompt(input.sessionId, body, {
        directory: input.directory,
        timeoutMs: dispatchRequestTimeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (options.nativeTaskDispatch) await options.nativeTaskDispatch({ operation: 'prompt',
        taskId: input.taskId, leaseToken: input.leaseToken, directory: input.directory, sessionID: input.sessionId,
        providerId: input.providerId, modelId: input.modelId, agent: input.agent, variant: input.variant }, promptNative);
      else await promptNative();
      return;
    },
    async readSession(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      return await client.sessions.get(input.sessionId, {
        directory: input.directory, allowNotFound: true, timeoutMs: requestTimeoutMs,
      });
    },
    async readStatus(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      if (input.providerId === CURSOR_PROVIDER_ID) {
        const statuses = cursorSdkRuntime && typeof cursorSdkRuntime.getSessionStatus === 'function'
          ? cursorSdkRuntime.getSessionStatus()
          : {};
        return statuses?.[input.sessionId] ?? null;
      }
      const directory = typeof input.directory === 'string' ? input.directory.trim() : '';
      // Keep overlapping status reads within the same directory and runtime incarnation.
      const runtimeKey = () => JSON.stringify([directory, options.readRuntimeStartedAt?.(), client.events?.url?.()]);
      const key = runtimeKey();
      const statuses = await statusSingleFlight.run(key, async () => (
        await client.sessions.status(directory ? { directory } : {}, { timeoutMs: requestTimeoutMs })
      ), { signal: input.signal });
      if (runtimeKey() !== key) throw Object.assign(new Error('Managed runtime changed during status observation'), { code: 'managed_observation_runtime_changed' });
      return statuses?.[input.sessionId] ?? null;
    },
    async readMessages(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.getSessionMessages !== 'function') return [];
        return await waitForSharedOperation(cursorSdkRuntime.getSessionMessages(input.sessionId), { signal: input.signal });
      }
      const page = await client.sessions.messages(input.sessionId, { limit: 100 }, {
        directory: input.directory,
        timeoutMs: messagesRequestTimeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const records = page?.records;
      return Array.isArray(records) ? records.map(stripMessageDiffSummary) : [];
    },
    ...(typeof options.readTerminalError === 'function' ? {
      async readTerminalError(input) {
        return await options.readTerminalError(input);
      },
    } : {}),
    ...(typeof options.readOperatorAbort === 'function' ? {
      async readOperatorAbort(input) {
        return await options.readOperatorAbort(input);
      },
    } : {}),
    ...(typeof options.readRuntimeStartedAt === 'function' ? {
      // Cursor children run inside this server and survive an OpenCode restart.
      readRuntimeStartedAt(input) {
        return input?.providerId === CURSOR_PROVIDER_ID ? null : options.readRuntimeStartedAt();
      },
    } : {}),
    async abortSession(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.abortSession !== 'function') return false;
        return await cursorSdkRuntime.abortSession(input.sessionId);
      }
      // The caller's signal replaces the request budget.
      await client.sessions.abort(input.sessionId, {
        directory: input.directory,
        ...(input.signal ? { signal: input.signal } : { timeoutMs: requestTimeoutMs }),
      });
      return true;
    },
    async deleteSession(input) {
      const client = resolveGen2OpenCodeClient(openCodeClient);
      const failures = [];
      if (
        input.providerId === CURSOR_PROVIDER_ID
        && cursorSdkRuntime
        && typeof cursorSdkRuntime.deleteSessionState === 'function'
      ) {
        try {
          await cursorSdkRuntime.deleteSessionState(input.sessionId);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        await client.sessions.remove(input.sessionId, {
          directory: input.directory, allowNotFound: true, timeoutMs: requestTimeoutMs,
        });
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to delete managed child ${input.sessionId}`);
      }
      return true;
    },
  };

  if (options.nativeTaskDispatch) {
    // The scheduler can outlive the submitting tool. Capture host setup so
    // registration, observation and cleanup never inherit its expired permit.
    // Native create/prompt still install fresh task authority inside the call.
    const runInHostContext = AsyncLocalStorage.snapshot();
    for (const [name, operation] of Object.entries(transport)) {
      transport[name] = (...args) => runInHostContext(operation, ...args);
    }
  }

  return createManagedOpenCodeExecutor({
    transport,
    subscribeAssistantActivity: options.subscribeAssistantActivity,
    bindAssistantActivity: options.bindAssistantActivity,
    subscribeSessionChanges: options.subscribeSessionChanges,
    onFirstAssistantActivity: options.onFirstAssistantActivity,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.eventReconcileIntervalMs === undefined ? {} : { eventReconcileIntervalMs: options.eventReconcileIntervalMs }),
    ...(options.idleStablePolls === undefined ? {} : { idleStablePolls: options.idleStablePolls }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.maxAssistantTurns === undefined ? {} : { maxAssistantTurns: options.maxAssistantTurns }),
    ...(typeof options.resolveTaskPromptPreamble === 'function'
      ? { resolveTaskPromptPreamble: options.resolveTaskPromptPreamble }
      : {}),
    ...(typeof options.resolveTaskTurnBudget === 'function'
      ? { resolveTaskTurnBudget: options.resolveTaskTurnBudget }
      : {}),
  });
};

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  createKeyedSingleFlight,
  waitForSharedOperation,
  createManagedOpenCodeExecutor,
  createManagedRecoveryMessageId,
} from '@devryan/orchestration-runtime';
import { CURSOR_PROVIDER_ID } from '@devryan/cursor-sdk-runtime';

import { resolveGen2OpenCodeClient } from '../opencode/opencode-client-seam.js';
import { stripMessageDiffSummary } from '../opencode/diff-summary.js';
import { NativeCommandRefusal } from '../opencode/runtime-host/native-command-refusal.js';

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
// A submission or native-selected dispatch made while the controller is
// replacing, checkpointing or recovering waits this long for it to be ready.
export const NATIVE_BACKEND_READY_WAIT_MS = 10_000;
// The native owner's proof that a managed-job command was never written to the
// controller it was refused by, because that controller was replaced.
const isUndispatchedControllerChange = error => error instanceof NativeCommandRefusal
  && error.settlement === 'not-dispatched' && error.code === 'native_managed_job_controller_changed';
const nativeJobUnavailable = () => Object.assign(new Error('Runtime capability unavailable: Native managed job execution is unavailable'), { code: 'native_managed_job_unavailable' });

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
  const nativeManagedJobs = options.nativeManagedJobs;
  const nativeReadyWaitMs = options.nativeReadyWaitMs ?? NATIVE_BACKEND_READY_WAIT_MS;
  // Only a ready controller without the capability (or shutdown) fails closed;
  // replacement, checkpoint and recovery are a bounded wait: until the task's
  // own deadline when it has one (as for count refusals), otherwise the default.
  const nativeJobsReady = async (signal, deadlineAt) => nativeManagedJobs.available?.() !== false
    || typeof nativeManagedJobs.awaitReady === 'function'
      && await nativeManagedJobs.awaitReady({
        timeoutMs: Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : nativeReadyWaitMs,
        ...(signal ? { signal } : {}),
      }) === 'ready';
  const nativeScope = (task, segment) => ({ taskId: task.taskId, rootSessionId: task.rootSessionId, leaseToken: task.leaseToken, directory: task.directory,
    sessionID: task.childSessionId, providerId: task.providerId, modelId: task.modelId, agent: task.agent, variant: task.variant, ...segment });

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
          parentID: input.parentSessionId, parentCallID: input.parentCallID, ...(input.prewarmExecutionView === true ? { prewarmView: true } : {}) };
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
      const dispatch = action => options.nativeTaskDispatch
        ? options.nativeTaskDispatch({ operation: 'prompt', taskId: input.taskId, leaseToken: input.leaseToken,
          directory: input.directory, sessionID: input.sessionId, providerId: input.providerId,
          modelId: input.modelId, agent: input.agent, variant: input.variant }, action)
        : action();
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.handlePromptAsync !== 'function') {
          const error = new Error('Cursor managed orchestration is unavailable in this runtime');
          error.code = 'cursor_runtime_unavailable';
          error.statusCode = 503;
          throw error;
        }
        const result = await dispatch(() => cursorSdkRuntime.handlePromptAsync({
          sessionID: input.sessionId,
          directory: input.directory,
          body,
        }));
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
      if (input.executionBackend === 'native-job') {
        // Count refusals of commands that never ran, and a controller that is
        // not ready yet, wait until this deadline or Stop.
        const deadlineAt = options.readManagedTask?.(input.taskId)?.timeoutAt;
        if (!nativeManagedJobs || typeof input.control?.reserveNativeJobSegment !== 'function'
          || typeof input.control?.recordNativeJobSegment !== 'function' || !await nativeJobsReady(input.signal, deadlineAt)) throw nativeJobUnavailable();
        const wait = { ...(input.signal ? { signal: input.signal } : {}), ...(Number.isFinite(deadlineAt) ? { deadlineAt } : {}) };
        const messageID = input.messageId ?? createManagedRecoveryMessageId(Date.now());
        const retained = options.readManagedTask?.(input.taskId)?.nativeJobSegments?.find(segment => segment.messageID === messageID);
        const segment = retained ?? { messageID, jobID: `dvr_job_${randomUUID().replaceAll('-', '')}`,
          notificationID: createManagedRecoveryMessageId(Date.now()) };
        if (await input.control.reserveNativeJobSegment(segment) !== true) throw new Error('Native job reservation lost task ownership');
        const scope = { taskId: input.taskId, rootSessionId: input.rootSessionId, leaseToken: input.leaseToken, directory: input.directory, sessionID: input.sessionId,
          providerId: input.providerId, modelId: input.modelId, agent: input.agent, variant: input.variant,
          messageID: segment.messageID, jobID: segment.jobID, notificationID: segment.notificationID };
        const prepare = async () => {
          for (;;) {
            try { return await nativeManagedJobs.prepare(scope, wait); } catch (error) {
              // The refused command never ran on the replaced controller. Its
              // successor may prepare it only while the ledger proves the
              // segment was never prepared on any controller.
              const state = options.readManagedTask?.(input.taskId)?.nativeJobSegments?.find(row => row.messageID === messageID)?.state;
              if (!isUndispatchedControllerChange(error) || state !== 'reserved'
                || Number.isFinite(deadlineAt) && Date.now() >= deadlineAt || !await nativeJobsReady(input.signal, deadlineAt)) throw error;
            }
          }
        };
        let preparationStarted = false, admissionStarted = false;
        try {
          input.signal?.throwIfAborted();
          preparationStarted = true;
          await prepare();
          if (await input.control.recordNativeJobSegment(messageID, 'prepared') !== true) throw new Error('Native job preparation lost task ownership');
          input.signal?.throwIfAborted();
          admissionStarted = true;
          await dispatch(() => client.prompts.prompt(input.sessionId, { ...body, messageID, noReply: true }, {
            directory: input.directory, timeoutMs: dispatchRequestTimeoutMs, ...(input.signal ? { signal: input.signal } : {}),
          }));
          await nativeManagedJobs.activate(scope, wait);
          if (await input.control.recordNativeJobSegment(messageID, 'accepted') !== true) throw new Error('Native job activation lost task ownership');
        } catch (error) {
          if (admissionStarted) {
            await input.control.recordNativeJobSegment(messageID, 'uncertain').catch(() => false);
            // Activation is exact-input and idempotent. A lost admission or
            // activation reply may be reconciled once without resending input.
            try {
              input.signal?.throwIfAborted();
              await nativeManagedJobs.activate(scope);
              if (await input.control.recordNativeJobSegment(messageID, 'accepted') === true) return;
            } catch { /* Canonical observation retains ownership until settlement or drained Stop. */ }
            return { state: 'native_admission_uncertain', messageID };
          } else {
            let cancelled = !preparationStarted;
            if (preparationStarted) {
              try { await nativeManagedJobs.cancelSegment(scope); cancelled = true; } catch { /* Retain an ambiguous prepared job for durable settlement. */ }
            }
            await input.control.recordNativeJobSegment(messageID, cancelled ? 'cancelled' : 'uncertain').catch(() => false);
          }
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
      await dispatch(promptNative);
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
      const task = options.readManagedTask?.(input.taskId);
      if (input.executionBackend === 'native-job' && task?.executionBackend !== 'native-job') return false;
      if (task?.executionBackend === 'native-job') {
        if (task.leaseToken !== input.leaseToken || task.childSessionId !== input.sessionId
          || task.directory !== input.directory || task.providerId !== input.providerId) return false;
        if (!nativeManagedJobs) return false;
        const result = await nativeManagedJobs.cancelTask({ ...nativeScope(task, {}), segments: (task.nativeJobSegments ?? []).map(({ jobID, notificationID, messageID }) => ({ jobID, notificationID, messageID })) });
        return result?.aborted === true;
      }
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.abortSession !== 'function') return false;
        return await cursorSdkRuntime.abortSession(input.sessionId);
      }
      // The caller's signal replaces the request budget.
      const abort = () => client.sessions.abort(input.sessionId, {
        directory: input.directory,
        ...(input.signal ? { signal: input.signal } : { timeoutMs: requestTimeoutMs }),
      });
      if (options.nativeTaskDispatch) {
        await options.nativeTaskDispatch({ operation: 'abort', taskId: input.taskId, leaseToken: input.leaseToken,
          directory: input.directory, sessionID: input.sessionId }, abort);
      } else await abort();
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

  const executorOptions = {
    transport,
    cursorReadOnly: options.cursorReadOnly === true && typeof options.nativeTaskDispatch === 'function',
    subscribeAssistantActivity: options.subscribeAssistantActivity,
    bindAssistantActivity: options.bindAssistantActivity,
    subscribeSessionChanges: options.subscribeSessionChanges,
    ...(typeof options.eventDrivenWait === 'function' ? { eventDrivenWait: options.eventDrivenWait } : {}),
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
    ...(typeof options.resolveTaskAssignment === 'function'
      ? { resolveTaskAssignment: options.resolveTaskAssignment }
      : {}),
  };
  // Cursor owns a separate attempt registry and shutdown path. Persisted native
  // attempts never fall through to the compatibility session transport.
  const cursorExecutor = createManagedOpenCodeExecutor(executorOptions);
  const legacyExecutor = createManagedOpenCodeExecutor(executorOptions);
  const nativeExecutor = createManagedOpenCodeExecutor(executorOptions);
  const executorFor = task => task.providerId === CURSOR_PROVIDER_ID ? cursorExecutor
    : task.executionBackend === 'native-job' ? nativeExecutor : legacyExecutor;
  return {
    start: (task, control) => executorFor(task).start(task, control),
    resume: (task, control) => executorFor(task).resume(task, control),
    retryInPlace: (task, control) => executorFor(task).retryInPlace(task, control),
    observe: (task, control) => executorFor(task).observe(task, control),
    abort: (task, input) => executorFor(task).abort(task, input),
    reconcile: task => task.executionBackend === 'native-job' && task.nativeJobSegments?.at(-1)?.state !== 'accepted'
      ? Promise.resolve({ state: 'transient', failureReason: 'Native managed prompt admission is not yet confirmed' })
      : executorFor(task).reconcile(task),
    readRecoverableResult: task => executorFor(task).readRecoverableResult(task),
    getLastRecoverableResult: task => executorFor(task).getLastRecoverableResult(task),
    shutdown: async () => { await Promise.all([cursorExecutor.shutdown(), legacyExecutor.shutdown(), nativeExecutor.shutdown()]); },
  };
};

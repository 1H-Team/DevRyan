// The scripted scenarios of the scheduler conformance harness (design file
// 30, package O0b; §5 F1-F11 and the ordinary lifecycle). Each scenario says
// what it is for (`purpose`) and drives a real scheduler through the driver
// (driver.mjs) under full virtual time. Scenarios record what the scheduler
// does today, and each states the facts that make it what it is (FACTS
// below, read from the scheduler), which scenario-facts.mjs checks exactly:
// a scenario fails when a driver check fails, when a fact differs from what
// it states or it states none, or when a script step meets a state it was
// not written for (reported by name).
//
// `runScenario` runs one, optionally crashing it at a save (§4.5: `durable`,
// the write landed and the process died before the promise resolved; `torn`,
// the write never landed) and restarting a fresh instance from what was on
// disk. `saves` on a scenario is its number of saves when run through; the
// self-test checks it, and the crash points are 1..saves.
import { encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import { createManagedTaskScheduler } from '../../packages/orchestration-runtime/scheduler.js';
import * as DRIVER from './driver.mjs';
import { EPOCH } from './trace.mjs';

const MINUTE = 60_000;
export const encodeSaved = (state) => encodeLedgerSnapshot(state);

/** A submission like the scheduler tests' (distinct prompts unless asked). */
export const taskInput = (key, overrides = {}) => ({
  idempotencyKey: key, rootSessionId: 'ses_root', parentTaskId: null, directory: '/workspace', mode: 'orchestrator',
  providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer', variant: null, label: key, prompt: `Perform ${key}.`, timeoutAt: null,
  ...overrides,
});
const range = (count, start = 1) => Array.from({ length: count }, (_, index) => index + start);
const PREREQUISITE = [{ taskId: 'dvr_task_producer', checkName: 'interface', paths: ['src/api.js'], contentHash: 'a'.repeat(64) }];
const LIMIT = "You've hit your session limit · resets 7:30pm";
const SEGMENT = { jobID: 'dvr_job_one', notificationID: 'msg_notification', messageID: 'msg_prompt' };

/** Builds the scheduler (with the scenario's ports and options) and initializes it in one step. */
async function boot(d, config = {}) {
  const inst = d.build(createManagedTaskScheduler, config);
  await d.step(d.call('initialize'));
  return inst;
}
/** The start calls still pending, oldest first. */
const starts = (d) => d.pending('executor.start');
/** Accepts every pending start (one group: setChildSessionId then markAccepted for each). */
async function acceptAll(d, entries = starts(d), childOf = (entry) => `ses_child_${entry.index}`) {
  if (entries.length === 0) return;
  await d.step(...entries.map((entry) => d.control(entry, 'setChildSessionId', childOf(entry))));
  await d.step(...entries.map((entry) => d.control(entry, 'markAccepted')));
}
const completed = { status: 'completed', recoverablePreview: 'done', canonicalRefs: [] };
/** restart-mixed: the reconcile answers in turn. */
const RECONCILE_MIX = [{ state: 'transient' }, { state: 'live' }, { state: 'terminal', result: completed }, { state: 'relaunch' }];
/** queue-order-ties: a queued record as the scheduler saves one (codec.js), created `ago` ms before the epoch. */
const queuedRecord = (taskId, key, ago) => ({
  taskId, idempotencyKey: key, rootSessionId: 'ses_root', dispatchGroupId: null, dispatchCallId: null, dispatchWaveId: null, parentTaskId: null, childSessionId: null, transportRecovery: null,
  directory: '/workspace', sequence: 1, mode: 'orchestrator', readOnly: false, providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer', variant: null, label: key, prompt: `Perform ${key}.`,
  attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: EPOCH - ago, timeoutAt: null, recoveryLineageId: null, owner: 'devryan', status: 'queued', leaseToken: null, startedAt: null, finishedAt: null,
  childPromptedAt: null, firstAssistantPartAt: null, waitingReason: null, failureReason: null, partial: false, recoverablePreview: '', canonicalRefs: [],
});
/** Two queued tasks of one sequence: the later task ID (`b…`) created first, so createdAt and the task ID disagree. */
const TIED_LEDGER = Object.freeze({ version: 1, tasks: [queuedRecord(`dvr_task_${'a'.repeat(32)}`, 'tie-created-second', 1_000), queuedRecord(`dvr_task_${'b'.repeat(32)}`, 'tie-created-first', 2_000)], resultEnvelopes: [] });

/** F1: N submits in one group, one root. */
const fanOut = (count, { samePrompt = false, allowDuplicate } = {}) => async (d) => {
  await boot(d);
  await d.step(...range(count).map((index) => d.call('submit', taskInput(`fan-${index}`, {
    ...(samePrompt ? { prompt: 'Perform the same task.', label: 'same' } : {}),
    ...(allowDuplicate === undefined ? {} : { allowDuplicate }),
  }))));
};

const DEFINED = [
  // ---------------------------------------------------------------- F1-F11
  ...[1, 8, 64].map((count) => ({
    name: `F1-fanout-${count}`, saves: 2 * count + 1, crashPoints: count === 8,
    purpose: `F1: ${count} simultaneous submits in one group (one root, distinct prompts): when each executor.start is called, in what order, in which step, and how many saves come before the first`,
    run: fanOut(count),
  })),
  ...[512, 2500].map((count) => ({
    name: `F1-fanout-${count}`, large: true,
    purpose: `F1 at ${count} (above the 2,048 native permits outside the scheduler, on purpose): the scheduler itself bounds nothing; run by the driver without the recorder (a recording holds every saved state, O(N^2) bytes)`,
    run: fanOut(count),
  })),
  { name: 'F1-fanout-8-same-prompt', purpose: 'F1 with one prompt eight times in one group and allowDuplicate unset: the duplicate-dispatch collapse (§2.2 place 12) looks only at starting or running tasks, so it is not taken for simultaneous copies', run: fanOut(8, { samePrompt: true }) },
  {
    name: 'duplicate-after-start', purpose: '§2.2 place 12 taken: the same prompt submitted again once the first copy is starting collapses onto it (no second launch); with allowDuplicate it launches',
    async run(d) {
      await boot(d);
      const same = { prompt: 'Perform the same task.', label: 'same' };
      await d.step(d.call('submit', taskInput('dup-1', same)));
      await d.step(d.call('submit', taskInput('dup-2', same)));
      await d.step(d.call('submit', taskInput('dup-3', { ...same, allowDuplicate: true })));
    },
  },
  { name: 'F1-fanout-8-same-prompt-allowed', purpose: 'F1 with one prompt eight times and allowDuplicate true: the collapse not taken, every task launches', run: fanOut(8, { samePrompt: true, allowDuplicate: true }) },
  {
    name: 'F2-fanout-64-roots', purpose: 'F2: 64 submits over 64 roots and 8 directories in one group: launch order across roots (queue order only)',
    async run(d) {
      await boot(d);
      await d.step(...range(64).map((index) => d.call('submit', taskInput(`root-${index}`, { rootSessionId: `ses_root_${String(index).padStart(2, '0')}`, directory: `/workspace/${index % 8}` }))));
    },
  },
  {
    name: 'F3-running-then-16', purpose: 'F3: 16 tasks running with executors that never settle, then 16 more submits in one group: whether the active count changes admission',
    async run(d) {
      await boot(d);
      await d.step(...range(16).map((index) => d.call('submit', taskInput(`first-${index}`))));
      await acceptAll(d);
      await d.step(...range(16).map((index) => d.call('submit', taskInput(`second-${index}`))));
    },
  },
  {
    name: 'F4-failures-and-submits', purpose: 'F4: 16 running; 8 of them fail in the same group as 8 new submits: whether new starts wait behind the failures',
    async run(d) {
      await boot(d);
      await d.step(...range(16).map((index) => d.call('submit', taskInput(`run-${index}`))));
      await acceptAll(d);
      const failing = starts(d).slice(0, 8);
      await d.step(...failing.map((entry) => d.answer(entry, { status: 'failed', failureReason: 'harness failure' })), ...range(8).map((index) => d.call('submit', taskInput(`late-${index}`))));
    },
  },
  {
    name: 'F5-slow-save', purpose: 'F5: the third save is held by the driver while more submits arrive behind it: launches happen when that save resolves, never before',
    config: { ports: { 'persistence.save': { mode: (entry) => (entry.index === 3 ? 'hold' : 'auto') } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(3).map((index) => d.call('submit', taskInput(`slow-${index}`))));
      await d.step(...range(2).map((index) => d.call('submit', taskInput(`behind-${index}`))));
      const [held] = d.pending('persistence.save');
      if (!held) throw new Error('F5: the third save was not pending');
      await d.step(d.answer(held, undefined));
    },
  },
  {
    name: 'F6-failing-admission-save', purpose: 'F6: the save of the second admission (save 8 of 5 submits) fails: the earlier admission still launches, one admission retry timer of 5,000 ms is armed, and the next queued pump admits the rest at once and clears it (scheduler.js:2087)',
    config: { ports: { 'persistence.save': { mode: 'auto', answer: (entry) => (entry.index === 8 ? { $reject: Object.assign(new Error('harness: save refused'), { code: 'harness_save_refused' }) } : undefined) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(5).map((index) => d.call('submit', taskInput(`admit-${index}`))));
      await d.advance(5_000);
    },
  },
  {
    name: 'F7-restart-recovery', crash: { index: 1 + 30 + 10, mode: 'durable' },
    purpose: 'F7: restart with 10 active and 20 queued tasks (30 submits, crash after the tenth admission save), reconciles answered one at a time (live, terminal, relaunch, transient, unavailable), 5 submits during initialize: recovery order, and when queued starts and new submits start',
    config: { ports: { 'executor.reconcile': { mode: 'hold' } } },
    async run(d) {
      await boot(d);
      await d.step(...range(30).map((index) => d.call('submit', taskInput(`restart-${index}`))));
    },
    async restart(d) {
      d.restart(createManagedTaskScheduler, this.config);
      await d.step(d.call('initialize'));
      await d.step(...range(5).map((index) => d.call('submit', taskInput(`during-${index}`))));
      const answers = [{ state: 'live' }, { state: 'terminal', result: completed }, { state: 'relaunch' }, { state: 'transient' }, { state: 'unavailable', failureReason: 'harness: gone' }];
      for (let round = 0; round < 12; round += 1) {
        const [pending] = d.pending('executor.reconcile');
        if (!pending) break;
        const number = d.pending('executor.reconcile', { all: true }).length - 1;
        await d.step(d.answer(pending, answers[number % answers.length]));
      }
      await d.advance(1_000);
      for (const pending of d.pending('executor.reconcile')) await d.step(d.answer(pending, { state: 'terminal', result: completed }));
    },
  },
  {
    name: 'F8-runtime-restart', purpose: 'F8: withRuntimeRestart while 5 queued tasks wait behind a held save; 10 submits during it are refused; at release the queued tasks launch (one pump)',
    config: { ports: { 'persistence.save': { mode: (entry) => (entry.index === 6 ? 'hold' : 'auto') } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(5).map((index) => d.call('submit', taskInput(`queued-${index}`))));
      const action = d.hook('restartAction');
      await d.step(d.call('withRuntimeRestart', action), ...range(10).map((index) => d.call('submit', taskInput(`refused-${index}`))));
      const [held] = d.pending('persistence.save');
      if (held) await d.step(d.answer(held, undefined));
      const [replacement] = d.pending('restartAction');
      if (replacement) await d.step(d.answer(replacement, 'replaced'));
    },
  },
  {
    name: 'F8-deferred-launches',
    purpose: 'F8 as designed: withRuntimeRestart (with 10 submits, refused managed_runtime_restarting) is called while the fifth admission save of 5 queued tasks (save 11) is held. When it resolves, the pump\'s finally launches its 5 admissions while dispatch is paused, so all 5 are deferred (scheduler.js:2088-2094, :1761). The restart waits for the lock (:3306), reconciles the first starting task, gets `live`, and throws bundle_task_unsettled before replacementStarted (:3310-3313); its finally replays the 5 deferred launches in insertion order (:3343-3351), then runs one pump (:3352), which finds nothing queued. The restart action is never called',
    config: { ports: { 'persistence.save': { mode: (entry) => (entry.index === 11 ? 'hold' : 'auto') }, 'executor.reconcile': { mode: 'auto', answer: () => ({ state: 'live' }) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(5).map((index) => d.call('submit', taskInput(`deferred-${index}`))));
      const action = d.hook('restartAction');
      await d.step(d.call('withRuntimeRestart', action), ...range(10).map((index) => d.call('submit', taskInput(`refused-${index}`))));
      const [held] = d.pending('persistence.save');
      if (!held || held.index !== 11) throw new Error('F8: the fifth admission save (save 11) was not pending');
      await d.step(d.answer(held, undefined));
    },
  },
  {
    name: 'F9-prerequisites', purpose: 'F9: 3 tasks with unverified prerequisites and 50 independent ones in one group. Today (recorded as such; its facts pin it): inside one pump (scheduler.js:2031-2096, in the lock :2034, queue order :2036-2046) the independent tasks wait for the prerequisite check (:2057) and the hold save (:2059 -> :2028, skipped only when kind, limit and activeCount are unchanged, :2011-2018) of every held task ahead of them, then for every admission save (:2080), and start together only in the pump\'s finally (:2088-2094); every later pump (each submit :2539, each finish :1186 and :1197, the 1,000 ms retry :2060) repeats those checks. The held tasks recheck at 1,000 ms and launch on the first ready recheck, each after its own launch-time recheck (:1753-1758)',
    async run(d) {
      const gate = { ready: false };
      await boot(d, { options: { verifyTaskPrerequisites: () => gate.ready } });
      await d.step(...range(3).map((index) => d.call('submit', taskInput(`held-${index}`, { taskPrerequisites: PREREQUISITE }))), ...range(50).map((index) => d.call('submit', taskInput(`free-${index}`))));
      await d.advance(1_000);
      gate.ready = true;
      await d.advance(1_000);
    },
  },
  ...[false, true].map((slowHost) => ({
    name: slowHost ? 'F10-auto-resume-slow-host' : 'F10-auto-resume',
    purpose: slowHost
      ? 'F10 with a host that answers each attempt only at the next whole minute: while an attempt is in flight the next parked result waits for the 60 s probe stagger'
      : 'F10: 4 results parked on a provider usage limit with reset at T = +30 min: the attempts at reset + 15 s, each answered by the host through acknowledgeResult as soon as it is made',
    async run(d) {
      const resetAt = d.time + 30 * MINUTE;
      await boot(d, { options: { autoResume: {
        resolveOwnerKey: () => 'owner-a', resolveBackupExecution: () => null,
        resolveProviderReset: () => ({ resetAt, limited: true }), attempt: () => undefined,
      } }, ports: { 'autoResume.attempt': { mode: 'hold' }, 'executor.retryInPlace': { mode: 'hold' }, 'executor.resume': { mode: 'hold' } } });
      await d.step(...range(4).map((index) => d.call('submit', taskInput(`parked-${index}`, { dispatchGroupId: 'msg_parent', providerId: 'anthropic', modelId: 'claude-opus' }))));
      await acceptAll(d);
      await d.step(...starts(d).map((entry) => d.answer(entry, { status: 'failed', failureReason: LIMIT, partial: true, recoverablePreview: 'partial work', canonicalRefs: [], resumable: true, providerResetAt: resetAt })));
      for (let round = 0; round < 60; round += 1) {
        for (const attempt of d.pending('autoResume.attempt')) {
          const params = attempt.args[0];
          const ack = await d.step(d.call('acknowledgeResult', params.taskId, { action: params.action, idempotencyKey: params.idempotencyKey, providerId: params.providerId, modelId: params.modelId, variant: params.variant, autoResumeGeneration: params.autoResumeGeneration }));
          const followUp = ack.state === 'resolved' ? ack.value?.followUpTask?.taskId ?? null : null;
          await d.step(d.answer(attempt, ack.state === 'resolved' ? { outcome: 'started', followUpTaskId: followUp } : { outcome: 'rejected', code: String(ack.error?.code ?? 'error'), message: 'harness: acknowledge refused' }));
        }
        const relaunched = [...d.pending('executor.retryInPlace'), ...d.pending('executor.resume'), ...starts(d)];
        if (relaunched.length) {
          await d.step(...relaunched.map((entry) => d.control(entry, 'markAccepted')));
          await d.step(...relaunched.map((entry) => d.answer(entry, completed)));
        }
        if (d.time >= resetAt + 5 * MINUTE) break;
        // The prompt host answers an attempt when it is made; the slow one at the next whole minute of the loop.
        await d.advance(MINUTE, slowHost ? {} : { until: () => d.pending('autoResume.attempt').length > 0 });
      }
    },
  })),
  {
    name: 'F11-handoff', purpose: 'F11: an orchestrator-to-builder handoff confirmed while 2 grouped tasks run (their aborts held), then 10 grouped and 10 ungrouped submits in one group: grouped work refused or held only during the lock',
    config: { ports: { 'executor.abort': { mode: 'hold' } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(2).map((index) => d.call('submit', taskInput(`grouped-${index}`, { dispatchGroupId: 'msg_dispatch_01' }))));
      await acceptAll(d);
      await d.step(d.call('confirmAgentHandoff', { rootSessionId: 'ses_root', fromMode: 'orchestrator', toMode: 'builder', idempotencyKey: 'switch-01' }));
      await d.step(...range(10).map((index) => d.call('submit', taskInput(`grouped-late-${index}`, { dispatchGroupId: 'msg_dispatch_02' }))), ...range(10).map((index) => d.call('submit', taskInput(`ungrouped-${index}`, { dispatchGroupId: null }))));
      await d.step(...d.pending('executor.abort').map((entry) => d.answer(entry, { aborted: true })));
      await d.step(...starts(d).slice(0, 2).map((entry) => d.answer(entry, { status: 'aborted' })));
    },
  },
  // ---------------------------------------------------------------- lifecycle
  {
    name: 'submit-complete', saves: 7, crashPoints: true,
    purpose: 'Lifecycle: one submit, accepted, completed, waited for and collected: the plain path, and the crash points between its saves',
    async run(d) {
      await boot(d);
      const [submitted] = [await d.step(d.call('submit', taskInput('one')))];
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed));
      const taskId = submitted.value?.taskId;
      await d.step(d.call('waitForTask', taskId));
      await d.step(d.call('acknowledgeResult', taskId, { action: 'collect', idempotencyKey: 'ack-one' }));
    },
  },
  {
    name: 'cancel-running', purpose: 'Lifecycle: cancelling a running task: the abort port, the 5,000 ms abort race timer set and cleared, the aborted record',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('cancel')));
      await acceptAll(d);
      await d.step(d.call('cancelTask', submitted.value?.taskId));
      await d.step(...starts(d).map((entry) => d.answer(entry, { status: 'aborted' })));
    },
  },
  {
    name: 'cancel-two', purpose: 'Lifecycle: two running tasks cancelled in one group: both abort calls are pending together, answered oldest first',
    async run(d) {
      await boot(d);
      const [first, second] = await d.step(d.call('submit', taskInput('cancel-a')), d.call('submit', taskInput('cancel-b')));
      await acceptAll(d);
      await d.step(d.call('cancelTask', first.value?.taskId), d.call('cancelTask', second.value?.taskId));
      await d.step(...starts(d).map((entry) => d.answer(entry, { status: 'aborted' })));
    },
  },
  {
    name: 'cancel-abort-timeout', purpose: 'Lifecycle: cancelling a running task whose executor never answers the abort: the abort race times out at 5,000 ms',
    config: { ports: { 'executor.abort': { mode: 'never' } } },
    async run(d) {
      await boot(d, this.config);
      const submitted = await d.step(d.call('submit', taskInput('stuck')));
      await acceptAll(d);
      await d.step(d.call('cancelTask', submitted.value?.taskId));
      await d.advance(5_000);
    },
  },
  {
    name: 'wait-timeout-and-abort', purpose: 'Lifecycle: waitForTask with a 2,000 ms timeout and another with an AbortSignal, delivered together; the timeout fires, the signal aborts (listener path), then the task completes',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('waited')));
      const taskId = submitted.value?.taskId;
      const controller = new AbortController();
      await d.step(d.call('waitForTask', taskId, { timeoutMs: 2_000 }), d.call('waitForTask', taskId, { signal: controller.signal }));
      await d.advance(2_000);
      await d.step(d.abort(controller, new Error('harness: wait aborted'), 'wait signal'));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed), d.call('waitForTask', taskId));
    },
  },
  {
    name: 'acknowledge-retry', purpose: 'Lifecycle: a failed resumable result acknowledged with retry: the follow-up task is submitted and launched from the acknowledgement',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('flaky')));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], { status: 'failed', failureReason: 'harness failure', partial: true, recoverablePreview: 'half', canonicalRefs: [], resumable: true }));
      await d.step(d.call('acknowledgeResult', submitted.value?.taskId, { action: 'retry', idempotencyKey: 'retry-one' }));
    },
  },
  {
    name: 'removal', purpose: 'Lifecycle: session removal fences dispatch (a late submit refused), then settles: the target aborted with native settlement, a foreign root untouched',
    async run(d) {
      await boot(d, { options: { abortTimeoutMs: 500 } });
      await d.step(d.call('submit', taskInput('target')), d.call('submit', taskInput('foreign', { rootSessionId: 'ses_foreign' })));
      await acceptAll(d, starts(d), (entry) => (entry.index === 1 ? 'ses_child_target' : 'ses_child_foreign'));
      const scope = { directory: '/workspace', sessions: ['ses_root', 'ses_child_target'], intentID: 'remove-fixture' };
      await d.step(d.call('cancelSessionsForRemoval', { ...scope, phase: 'fence' }));
      await d.step(d.call('submit', taskInput('late')));
      await d.step(d.call('cancelSessionsForRemoval', { ...scope, phase: 'settle', settled: { terminated: true, sessions: scope.sessions }, absentSessions: [] }));
    },
  },
  {
    name: 'run-cleanup', purpose: 'Lifecycle: a settled attempt\'s runs are stopped after the commit: the first stop fails, the retry 5,000 ms later succeeds; each outcome observed',
    async run(d) {
      await boot(d, { options: { stopAttemptRuns: (entry) => (entry.index === 1 ? { $reject: new Error('harness: stop failed') } : { stopped: 1 }), onRunCleanup: () => undefined } });
      await d.step(d.call('submit', taskInput('cleanup', { agent: 'designer' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed));
      await d.advance(5_000);
      await d.advance(30_000);
    },
  },
  {
    name: 'native-segments', purpose: 'Lifecycle: a native-job task reserves and records a segment through its control, completes, and is acknowledged after the terminal save; the first acknowledgement fails and is retried after 5,000 ms',
    async run(d) {
      await boot(d, { options: { resolveExecutionBackend: () => 'native-job', acknowledgeNativeJob: (entry) => (entry.index === 1 ? { $reject: Object.assign(new Error('harness: not yet'), { code: 'harness_pending' }) } : undefined) } });
      await d.step(d.call('submit', taskInput('native')));
      const [start] = starts(d);
      await d.step(d.control(start, 'setChildSessionId', 'ses_child'));
      await d.step(d.control(start, 'reserveNativeJobSegment', SEGMENT));
      await d.step(d.control(start, 'recordNativeJobSegment', SEGMENT.messageID, 'prepared'));
      await d.step(d.control(start, 'recordNativeJobSegment', SEGMENT.messageID, 'accepted'));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.answer(start, completed));
      await d.advance(5_000);
    },
  },
  {
    name: 'operator-stop', purpose: 'Lifecycle: an operator stop recorded for a running child (stop request ID a hidden draw), its expiry timer (requestedAt + 5,000 ms), accepted, then the child settles as user-stopped',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('stopped')));
      await acceptAll(d, starts(d), () => 'ses_stop_child');
      const recorded = await d.step(d.call('recordOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace', requestedAt: d.time }));
      const stop = recorded.state === 'resolved' ? recorded.value : null;
      if (stop) await d.step(d.call('acceptOperatorStop', stop));
      await d.step(d.answer(starts(d)[0], { status: 'aborted', terminationIntent: 'user_stopped' }));
      await d.advance(5_000);
    },
  },
  // Package O0d: a waiter that resolves only after the terminal save, and a shutdown with a starting lease armed
  // (its clear, the final save, executor.shutdown); the comparer's planted candidates need both.
  {
    name: 'wait-then-shutdown', purpose: 'Lifecycle: waitForTask pending while a task runs, resolved after its terminal save; a second task left starting (its 60,000 ms lease armed) when shutdown clears every timer, saves once more and shuts the executor down',
    async run(d) {
      await boot(d);
      const first = await d.step(d.call('submit', taskInput('waited')));
      await acceptAll(d);
      await d.step(d.call('waitForTask', first.value?.taskId));
      await d.step(d.answer(starts(d)[0], completed));
      await d.step(d.call('submit', taskInput('left-starting')));
      await d.step(d.call('shutdown'));
    },
  },
  // Package O0d: the crash point between a native job proof shard write and the main commit (design §4.5,
  // DOCUMENTATION.md "Shard first"). maxTerminalRecords 0 makes the completed native task a tombstone at its terminal
  // save, so its proof moves to a shard first (persistence.putNativeJobProofShard, answered), then the main commit
  // drops it. The shard store is the driver's (it survives the crash: a torn crash at the next save leaves the shard
  // written and the ledger without that commit).
  {
    name: 'native-proof-shard', saves: 10, crashPoints: true,
    purpose: 'Lifecycle: a native-job task completes with maxTerminalRecords 0: its proof is written to a shard before the commit that drops it, its acknowledgement is retried after 5,000 ms, and the shard is removed once acknowledged; the crash points include the one between the shard write and the main commit',
    config: {
      options: { maxTerminalRecords: 0, resolveExecutionBackend: () => 'native-job', acknowledgeNativeJob: (entry) => (entry.index === 1 ? { $reject: Object.assign(new Error('harness: not yet'), { code: 'harness_pending' }) } : undefined) },
      ports: {
        'persistence.loadNativeJobProofShards': { mode: 'auto', answer: (_entry, driver) => [...shardStore(driver)].map(([shard, text]) => ({ shard, value: JSON.parse(text) })) },
        'persistence.putNativeJobProofShard': { mode: 'auto', answer: (entry, driver) => { shardStore(driver).set(entry.args[0], entry.args[1]); } },
        'persistence.removeNativeJobProofShard': { mode: 'auto', answer: (entry, driver) => { shardStore(driver).delete(entry.args[0]); } },
      },
    },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('native-proof')));
      const [start] = starts(d);
      await d.step(d.control(start, 'setChildSessionId', 'ses_child'));
      await d.step(d.control(start, 'reserveNativeJobSegment', SEGMENT));
      await d.step(d.control(start, 'recordNativeJobSegment', SEGMENT.messageID, 'prepared'));
      await d.step(d.control(start, 'recordNativeJobSegment', SEGMENT.messageID, 'accepted'));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.answer(start, completed));
      await d.advance(5_000);
    },
  },
  // Package O0d fix round 1: what the corpus did not reach. A restart with several active tasks of mixed reconcile
  // answers at every save point (S4: a recovery reversed, run in parallel, without its starting leases or without its
  // pump differs here, per push); the second run-cleanup retry (design M5, RUN_CLEANUP_RETRY_MS[1]); two queued tasks
  // whose queue order only createdAt decides (design M11); a shutdown with a task deadline and an admission retry
  // armed (the timer census at shutdown).
  {
    name: 'restart-mixed', saves: 9, crashPoints: true,
    purpose: 'Restart with several active tasks of mixed reconcile answers: 3 submits in one group, the first accepted; at every crash point a fresh instance recovers the active tasks one at a time in queue order, its reconciles answered transient, live, terminal and relaunch in turn (a transient task stays starting, its lease re-armed by initialize, and is reconciled again after 1,000 ms), then pumps the queued ones',
    config: { ports: { 'executor.reconcile': { mode: 'auto', answer: (entry) => RECONCILE_MIX[(entry.index - 1) % RECONCILE_MIX.length] } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(3).map((index) => d.call('submit', taskInput(`mixed-${index}`))));
      const [first] = starts(d);
      await d.step(d.control(first, 'setChildSessionId', 'ses_child_mixed'));
      await d.step(d.control(first, 'markAccepted'));
    },
  },
  {
    name: 'run-cleanup-backoff', purpose: 'Lifecycle: a settled attempt\'s runs fail to stop twice: the first retry 5,000 ms after the commit, the second 30,000 ms after that (RUN_CLEANUP_RETRY_MS), the third stop succeeds; each outcome observed',
    async run(d) {
      await boot(d, { options: { stopAttemptRuns: (entry) => (entry.index <= 2 ? { $reject: new Error('harness: stop failed') } : { stopped: 1 }), onRunCleanup: () => undefined } });
      await d.step(d.call('submit', taskInput('backoff', { agent: 'designer' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed));
      await d.advance(5_000);
      await d.advance(30_000);
    },
  },
  {
    name: 'queue-order-ties', purpose: 'Queue order on a tie: a loaded ledger holds two queued tasks of one sequence, the one with the later task ID created first; initialize pumps them in queue order (compareManagedTaskQueueOrder: sequence, then createdAt, then task ID), so createdAt alone decides which launches first',
    config: { load: TIED_LEDGER },
    async run(d) {
      await boot(d, this.config);
    },
  },
  {
    name: 'shutdown-with-timers', purpose: 'Lifecycle: shutdown while a task deadline and an admission retry are armed: a task with timeoutAt starts (its deadline timer armed), a second submit\'s admission save fails (the 5,000 ms admission retry armed), then shutdown clears every timer, saves once more and shuts the executor down',
    config: { ports: { 'persistence.save': { mode: 'auto', answer: (entry) => (entry.index === 5 ? { $reject: Object.assign(new Error('harness: save refused'), { code: 'harness_save_refused' }) } : undefined) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('deadline', { timeoutAt: d.time + 10 * MINUTE })));
      await d.step(d.call('submit', taskInput('refused-admission')));
      await d.step(d.call('shutdown'));
    },
  },
];
/** The driver's native job proof shard store (its disk): it outlives a crashed instance, as a file would. */
const shardStore = (driver) => { driver.shardStore ??= new Map(); return driver.shardStore; };

// ------------------------------------------------------------------ facts
//
// What each scenario shows, stated here and checked exactly (scenario-facts.mjs; the keys are FACT_KEYS there):
// `steps`; `clock` (the virtual time of every step, +ms from the epoch: steps); `groups` (every step with more than
// one input, its inputs in delivery order); `ports` and `answers` (per port, the steps it was called and answered in:
// `5-9` each once, `12x4` four times, `rejected 11`); `launches` (in order: label, step, saves before it); `timers`
// (delay, set time, fired or cleared or live: count); `outcomes` (every member call in call order: how it ended);
// `final` (the last save of the last instance: labels by status). `i2` marks the instance built after a crash.
// They were read from the scheduler (the comments name its lines) and from a run, and change only by review:
// a change of the scheduler or the driver that moves one is a finding until a reviewer restates it.

/** F1 and F2: N submits in one group. scheduler.js: initialize loads (step 1, answered in 2) and saves once (:2349,
 * answered in 3); the N submits commit one queued save each under the lock (:2551-2555), serialized: save 2 in step 4,
 * each answer calls the next; every submit's launchCommittedTask queues a pump behind the commits (:2539); the first
 * pump admits all N, one starting save each (:2080), and launches them in its finally after the last (:2088-2094):
 * 1 + 2N saves, all N starts in step 2N + 4, in queue order; each save arms the 300,000 ms persistence-stall timer
 * (PERSISTENCE_STALL_MS, :85), cleared when it settles, and each admission the 60,000 ms starting lease (:245, :2122). */
export const fanOutFacts = (count, prefix) => {
  const last = 2 * count + 4;
  const times = (text) => (count > 1 ? `${text} x${count}` : text);
  return {
    steps: last,
    clock: [`+0 1-${last}`],
    groups: count > 1 ? [`4: call submit x${count}`] : [],
    ports: { 'persistence.load': '1', 'persistence.save': `2 4-${last - 1}`, publishEvent: `5-${last}`, 'executor.start': count > 1 ? `${last}x${count}` : `${last}` },
    answers: { 'persistence.load': '2', 'persistence.save': `3 5-${last}` },
    launches: [`${count > 1 ? `${prefix}-1..${count}` : `${prefix}-1`} @${last} after ${2 * count + 1}`],
    timers: { '300000 at +0 cleared +0': 2 * count + 1, '60000 at +0 live': count },
    outcomes: ['initialize resolved', times('submit resolved starting')],
    final: { starting: count > 1 ? `${prefix}-1..${count}` : `${prefix}-1` },
  };
};

const FACTS = {
  'F1-fanout-1': fanOutFacts(1, 'fan'),
  'F1-fanout-8': fanOutFacts(8, 'fan'),
  'F1-fanout-64': fanOutFacts(64, 'fan'),
  'F1-fanout-512': fanOutFacts(512, 'fan'),
  'F1-fanout-2500': fanOutFacts(2500, 'fan'),
  // F2: 64 roots and 8 directories change nothing: queue order only (admission.test.js:128).
  'F2-fanout-64-roots': fanOutFacts(64, 'root'),
  // Like F1 at 8: the duplicate collapse (:2441-2452) looks only at starting or running tasks (ACTIVE_STATUSES, :73),
  // and all 8 are queued when each is prepared.
  'F1-fanout-8-same-prompt': {
    steps: 20,
    clock: ['+0 1-20'],
    groups: ['4: call submit x8'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-19', publishEvent: '5-20', 'executor.start': '20x8' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-20' },
    launches: ['same @20 after 17 x8'],
    timers: { '300000 at +0 cleared +0': 17, '60000 at +0 live': 8 },
    outcomes: ['initialize resolved', 'submit resolved starting x8'],
    final: { starting: 'same x8' },
  },
  // Submit 2 arrives once dup-1 is starting and collapses onto it (:2449): no save, no launch; dup-3 has allowDuplicate
  // and launches. 3 submits, 2 launches.
  'duplicate-after-start': {
    steps: 10,
    clock: ['+0 1-10'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 8-9', publishEvent: '5-6 9-10', 'executor.start': '6 10' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 9-10' },
    launches: ['same @6 after 3', 'same @10 after 5'],
    timers: { '300000 at +0 cleared +0': 5, '60000 at +0 live': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x3'],
    final: { starting: 'same x2' },
  },
  // allowDuplicate skips the collapse lookup; the facts equal the same-prompt case (only reads differ in a trace).
  'F1-fanout-8-same-prompt-allowed': {
    steps: 20,
    clock: ['+0 1-20'],
    groups: ['4: call submit x8'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-19', publishEvent: '5-20', 'executor.start': '20x8' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-20' },
    launches: ['same @20 after 17 x8'],
    timers: { '300000 at +0 cleared +0': 17, '60000 at +0 live': 8 },
    outcomes: ['initialize resolved', 'submit resolved starting x8'],
    final: { starting: 'same x8' },
  },
  // 16 start in step 36 after 1 + 2x16 saves; accepted in two groups (each control a save, :1270, :1298); the second 16
  // start in one step after 32 more saves: 16 active tasks change nothing in admission (no admitLaunch hook: every
  // admission admits, :1975).
  'F3-running-then-16': {
    steps: 103,
    clock: ['+0 1-103'],
    groups: ['4: call submit x16', '37: control setChildSessionId of executor.start#1..16', '54: control markAccepted of executor.start#1..16', '71: call submit x16'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-35 37-52 54-69 71-102', publishEvent: '5-36 38-53 55-70 72-103', 'executor.start': '36x16 103x16' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-36 38-53 55-70 72-103' },
    launches: ['first-1..16 @36 after 33', 'second-1..16 @103 after 97'],
    timers: { '300000 at +0 cleared +0': 97, '60000 at +0 cleared +0': 16, '60000 at +0 live': 16 },
    outcomes: ['initialize resolved', 'submit resolved starting x16', 'control.setChildSessionId resolved true x16', 'control.markAccepted resolved true x16', 'submit resolved starting x16'],
    final: { running: 'first-1..16', starting: 'second-1..16' },
  },
  // The 8 failures (finishTask -> terminal saves, then pump, :1186) and the 8 submits are serialized under one lock:
  // their 24 saves (8 terminal, 8 queued, 8 admission) all come before the 8 new starts in step 95.
  'F4-failures-and-submits': {
    steps: 95,
    clock: ['+0 1-95'],
    groups: ['4: call submit x16', '37: control setChildSessionId of executor.start#1..16', '54: control markAccepted of executor.start#1..16', '71: answer executor.start#1..8 resolve, call submit x8'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-35 37-52 54-69 71-94', publishEvent: '5-36 38-53 55-70 72-95', 'executor.start': '36x16 95x8' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-36 38-53 55-70 72-95', 'executor.start': '71x8' },
    launches: ['run-1..16 @36 after 33', 'late-1..8 @95 after 89'],
    timers: { '300000 at +0 cleared +0': 89, '60000 at +0 cleared +0': 16, '60000 at +0 live': 8 },
    outcomes: ['initialize resolved', 'submit resolved starting x16', 'control.setChildSessionId resolved true x16', 'control.markAccepted resolved true x16', 'submit resolved starting x8'],
    final: { failed: 'run-1..8', running: 'run-9..16', starting: 'late-1..8' },
  },
  // Save 3 (the second queued commit) is held: the 2 later submits queue behind the lock; nothing launches until it is
  // answered (step 6 delivers the 2 submits, step 7 answers save 3); slow-1..3 start in step 11 after their 3 admission
  // saves, behind-1..2 in step 15.
  'F5-slow-save': {
    steps: 15,
    clock: ['+0 1-15'],
    groups: ['4: call submit x3', '6: call submit x2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7-14', publishEvent: '5 7-15', 'executor.start': '11x3 15x2' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5 7-15' },
    launches: ['slow-1..3 @11 after 7', 'behind-1..2 @15 after 11'],
    timers: { '300000 at +0 cleared +0': 11, '60000 at +0 live': 5 },
    outcomes: ['initialize resolved', 'submit resolved starting x5'],
    final: { starting: 'behind-1..2, slow-1..3' },
  },
  // Save 8 is the second admission save (1 initialize + 5 queued + admit-1 at 7) and is rejected (step 11): the pump
  // throws, its finally still launches admit-1 (earlier admissions are durable, :2088-2094), and submit 1's
  // launchCommittedTask catches it: logger.warn and the 5,000 ms admission retry (:2541-2543). The next queued pump
  // (submit 2's, :2539) runs at once: it re-admits admit-2 and admits admit-3..5 (saves 9-12) and, with nothing held,
  // clears the retry (:2087) at +0; admit-2..5 start in step 15. The retry never fires (the builder's report said it
  // did).
  'F6-failing-admission-save': {
    steps: 15,
    clock: ['+0 1-15'],
    groups: ['4: call submit x5'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-14', publishEvent: '5-10 12-15', 'executor.start': '11 15x4', 'logger.warn': '11' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-10 12-15 rejected 11' },
    launches: ['admit-1 @11 after 8', 'admit-2..5 @15 after 12'],
    timers: { '300000 at +0 cleared +0': 12, '60000 at +0 live': 5, '5000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x5'],
    final: { starting: 'admit-1..5' },
  },
  // Instance 1 crashes at save 41 (1 + 30 queued + 10 admissions) inside the pump: no launch. Instance 2 loads save 41
  // (10 starting, 20 queued), recovers one task at a time (:2354-2362: for ... await recoverTask): reconciles in steps
  // 46, 49, 52-54, 57, 59, 62-64, answered live, terminal, relaunch, transient, unavailable in turn (relaunch starts
  // restart-3 and restart-8 at once; transient arms a 1,000 ms retry; unavailable reads the recoverable result); the 20
  // queued start only after the last reconcile (step 87, pump at :2386) and the 5 submits made during initialize after
  // them (step 97). The two transient retries fire at +1000 and reconcile again (98-99), answered terminal.
  'F7-restart-recovery': {
    steps: 105,
    clock: ['+0 1-97', '+1000 98-105'],
    groups: ['4: call submit x30', '47: call submit x5'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-43', publishEvent: '5-43', 'i2 persistence.load': '44', 'i2 persistence.save': '45 48 50-51 56 58 60-61 66-96 100-101 103-104', 'i2 executor.reconcile': '46 49 52-54 57 59 62-64 98-99', 'i2 publishEvent': '49 51-52 57 59 61-62 67-97 101-102 104-105', 'i2 executor.observe': '49 59', 'i2 executor.start': '53 63 87x20 97x5', 'i2 executor.readRecoverableResult': '55 65' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-43', 'i2 persistence.load': '45', 'i2 persistence.save': '46 49 51-52 57 59 61-62 67-97 101-102 104-105', 'i2 executor.reconcile': '48 50 53-55 58 60 63-65 100 103', 'i2 executor.readRecoverableResult': '56 66' },
    launches: ['i2 restart-3 @53 after 45', 'i2 restart-8 @63 after 49', 'i2 restart-11..30 @87 after 70', 'i2 during-1..5 @97 after 80'],
    timers: { '300000 at +0 cleared +0': 40, '60000 at +0 live': 9, '300000 at +0 live': 1, 'i2 300000 at +0 cleared +0': 39, 'i2 1000 at +0 fired +1000': 2, 'i2 60000 at +0 live': 27, 'i2 60000 at +0 cleared +1000': 2, 'i2 300000 at +1000 cleared +1000': 4 },
    outcomes: ['initialize resolved', 'submit pending x30', 'i2 initialize resolved', 'i2 submit resolved starting x5'],
    final: { completed: 'restart-2, restart-4, restart-7, restart-9', interrupted: 'restart-5, restart-10', running: 'restart-1, restart-6', starting: 'during-1..5, restart-3, restart-8, restart-11..30' },
    restart: { crashedAfterSave: 41, portsAfterIt: [], loads: 'save 41' },
  },
  // The success path: withRuntimeRestart pauses dispatch (:3303), the 10 submits are refused managed_runtime_restarting,
  // the 5 tasks stay queued (submits resolve queued) while save 6 (the last queued commit) is held; with no active task
  // nothing is reconciled, the action is called (step 10) and answered, and the restart's final pump (:3351) admits and
  // starts all 5 in one step.
  'F8-runtime-restart': {
    steps: 16,
    clock: ['+0 1-16'],
    groups: ['4: call submit x5', '9: call withRuntimeRestart, call submit x10'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-8 11-15', publishEvent: '5-8 10 12-16', restartAction: '10', 'executor.start': '16x5' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10 12-16', restartAction: '11' },
    launches: ['queued-1..5 @16 after 11'],
    timers: { '300000 at +0 cleared +0': 11, '60000 at +0 live': 5 },
    outcomes: ['initialize resolved', 'submit resolved queued x5', 'withRuntimeRestart resolved replaced', 'submit rejected managed_runtime_restarting x10'],
    final: { starting: 'queued-1..5' },
  },
  // See the purpose: the 5 deferred launches replay in insertion order in step 16, the step of the reconcile answer.
  'F8-deferred-launches': {
    steps: 16,
    clock: ['+0 1-16'],
    groups: ['4: call submit x5', '14: call withRuntimeRestart, call submit x10'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-13', publishEvent: '5-13 15', 'executor.reconcile': '15', 'executor.start': '16x5' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-13 15', 'executor.reconcile': '16' },
    launches: ['deferred-1..5 @16 after 11'],
    timers: { '300000 at +0 cleared +0': 11, '60000 at +0 live': 5 },
    outcomes: ['initialize resolved', 'submit resolved starting x5', 'withRuntimeRestart rejected bundle_task_unsettled', 'submit rejected managed_runtime_restarting x10'],
    final: { starting: 'deferred-1..5' },
  },
  // Today's behaviour, pinned for the owner (scheduler.js lines). One pump (:2031-2096) runs inside the lock (:2034)
  // over the queue in order (:2036-2046). For each held task ahead (:2055) it awaits verifyTaskPrerequisites (:2057),
  // then the hold save (recordWaitingReasonLocked :2059 -> commitTaskUpdateLocked :2028, skipped only when kind, limit
  // and activeCount are unchanged, :2011-2018), arms the 1,000 ms retry (:2060) and moves on. So in the first pump the
  // verifier is called in steps 57, 59, 61 and the hold saves in 58, 60, 62, before the 50 admission saves (63-112,
  // :2080); the 50 independent starts come only in step 113 (:2090-2094). Every later pump repeats the 3 checks (submits
  // :2539, the retry timer): steps 113, 115, 117 with 3 more hold saves (114, 116, 118: activeCount changed from 0 to
  // 50), then 51 pumps of 3 checks each with no save (119-271), then the rechecks at +1000 (273-275) and +2000 (277,
  // 279, 281, 283x3); 168 verifier calls in all. The held tasks launch one per step on the first ready recheck
  // (284-286), each after its own launch-time recheck (:1753-1758).
  'F9-prerequisites': {
    steps: 286,
    clock: ['+0 1-272', '+1000 273-276', '+2000 277-286'],
    groups: ['4: call submit x53'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-56 58 60 62-112 114 116 118 278 280 282', publishEvent: '5-57 59 61 63-113 115 117 119 279 281 283', verifyTaskPrerequisites: '57 59 61 113 115 117 119-271 273-275 277 279 281 283x3', 'executor.start': '113x50 284-286' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-57 59 61 63-113 115 117 119 279 281 283', verifyTaskPrerequisites: '58 60 62 114 116 118 120-272 274-276 278 280 282 284-286' },
    launches: ['free-1..50 @113 after 107', 'held-1 @284 after 113', 'held-2 @285 after 113', 'held-3 @286 after 113'],
    timers: { '300000 at +0 cleared +0': 110, '1000 at +0 fired +1000': 1, '60000 at +0 live': 50, '1000 at +1000 fired +2000': 1, '300000 at +2000 cleared +2000': 3, '60000 at +2000 live': 3 },
    outcomes: ['initialize resolved', 'submit resolved queued x3', 'submit resolved starting x50'],
    final: { starting: 'free-1..50, held-1..3' },
  },
  // 4 results parked on a usage limit (reset at +30 min). Planning timers of delay 0 fire at +1 (the platform clamp),
  // all four in steps 32-35 before any port answer (one timers phase); each next delay is computed from +1 (1,814,999).
  // At +1,815,000 (reset + 15 s grace, :265) the four attempt timers fire in one instant; the host answers each attempt
  // at once, so each follow-up retries in place at once (retryInPlace in steps 62, 77, 90, 101) and the 60 s probe
  // stagger (:266) spaces the next attempt: +1,875,000, +1,935,000, +1,995,000.
  'F10-auto-resume': {
    steps: 107,
    clock: ['+0 1-31', '+1 32-51', '+1815000 52-68', '+1875000 69-83', '+1935000 84-96', '+1995000 97-107'],
    groups: ['4: call submit x4', '13: control setChildSessionId of executor.start#1..4', '18: control markAccepted of executor.start#1..4', '23: answer executor.start#1..4 resolve'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-11 13-16 18-21 23-30 44 48-50 52 56-58 60-61 64 66-67 69 72-73 75-76 79 81-82 84 86 88-89 92 94-95 97 99-100 103 105-106', publishEvent: '5-12 14-17 19-22 24-31 48-51 56-59 61x2 62 65 67-68 72-74 76x2 77 80 82-83 86-87 89x2 90 93 95-96 98 100x2 101 104 106-107', 'executor.start': '12x4', 'autoResume.resolveOwnerKey': '32-35', 'autoResume.resolveBackupExecution': '36-39', 'autoResume.resolveProviderReset': '40-43', 'autoResume.attempt': '56 72 86 98', 'executor.retryInPlace': '62 77 90 101' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-12 14-17 19-22 24-31 48-51 56-59 61-62 65 67-68 72-74 76-77 80 82-83 86-87 89-90 93 95-96 98 100-101 104 106-107', 'executor.start': '23x4', 'autoResume.resolveOwnerKey': '36-39', 'autoResume.resolveBackupExecution': '40-43', 'autoResume.resolveProviderReset': '44-47', 'autoResume.attempt': '63 78 91 102', 'executor.retryInPlace': '66 81 94 105' },
    launches: ['parked-1..4 @12 after 9', 'retryInPlace parked-1 @62 after 35', 'retryInPlace parked-2 @77 after 43', 'retryInPlace parked-3 @90 after 50', 'retryInPlace parked-4 @101 after 56'],
    timers: { '300000 at +0 cleared +0': 25, '60000 at +0 cleared +0': 4, '0 at +0 fired +1': 4, '300000 at +1 cleared +1': 4, '1814999 at +1 fired +1815000': 4, '300000 at +1815000 cleared +1815000': 9, '60000 at +1815000 fired +1875000': 3, '60000 at +1815000 cleared +1815000': 1, '300000 at +1875000 cleared +1875000': 8, '60000 at +1875000 fired +1935000': 2, '60000 at +1875000 cleared +1875000': 1, '300000 at +1935000 cleared +1935000': 7, '60000 at +1935000 fired +1995000': 1, '60000 at +1935000 cleared +1935000': 1, '300000 at +1995000 cleared +1995000': 6, '60000 at +1995000 cleared +1995000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x4', 'control.setChildSessionId resolved true x4', 'control.markAccepted resolved true x4', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true'],
    final: { completed: 'parked-1..4', failed: 'parked-1..4' },
  },
  // As F10, the host answering each attempt only at the next whole minute: the same steps, at the later virtual times of
  // the answers (+1,860,000, +1,920,000, +1,980,000, +2,040,000).
  'F10-auto-resume-slow-host': {
    steps: 107,
    clock: ['+0 1-31', '+1 32-51', '+1815000 52-59', '+1860000 60-68', '+1875000 69-74', '+1920000 75-83', '+1935000 84-87', '+1980000 88-96', '+1995000 97-98', '+2040000 99-107'],
    groups: ['4: call submit x4', '13: control setChildSessionId of executor.start#1..4', '18: control markAccepted of executor.start#1..4', '23: answer executor.start#1..4 resolve'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-11 13-16 18-21 23-30 44 48-50 52 56-58 60-61 64 66-67 69 72-73 75-76 79 81-82 84 86 88-89 92 94-95 97 99-100 103 105-106', publishEvent: '5-12 14-17 19-22 24-31 48-51 56-59 61x2 62 65 67-68 72-74 76x2 77 80 82-83 86-87 89x2 90 93 95-96 98 100x2 101 104 106-107', 'executor.start': '12x4', 'autoResume.resolveOwnerKey': '32-35', 'autoResume.resolveBackupExecution': '36-39', 'autoResume.resolveProviderReset': '40-43', 'autoResume.attempt': '56 72 86 98', 'executor.retryInPlace': '62 77 90 101' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-12 14-17 19-22 24-31 48-51 56-59 61-62 65 67-68 72-74 76-77 80 82-83 86-87 89-90 93 95-96 98 100-101 104 106-107', 'executor.start': '23x4', 'autoResume.resolveOwnerKey': '36-39', 'autoResume.resolveBackupExecution': '40-43', 'autoResume.resolveProviderReset': '44-47', 'autoResume.attempt': '63 78 91 102', 'executor.retryInPlace': '66 81 94 105' },
    launches: ['parked-1..4 @12 after 9', 'retryInPlace parked-1 @62 after 35', 'retryInPlace parked-2 @77 after 43', 'retryInPlace parked-3 @90 after 50', 'retryInPlace parked-4 @101 after 56'],
    timers: { '300000 at +0 cleared +0': 25, '60000 at +0 cleared +0': 4, '0 at +0 fired +1': 4, '300000 at +1 cleared +1': 4, '1814999 at +1 fired +1815000': 4, '300000 at +1815000 cleared +1815000': 4, '60000 at +1815000 fired +1875000': 3, '300000 at +1860000 cleared +1860000': 5, '60000 at +1860000 cleared +1860000': 1, '300000 at +1875000 cleared +1875000': 3, '60000 at +1875000 fired +1935000': 2, '300000 at +1920000 cleared +1920000': 5, '60000 at +1920000 cleared +1920000': 1, '300000 at +1935000 cleared +1935000': 2, '60000 at +1935000 fired +1995000': 1, '300000 at +1980000 cleared +1980000': 5, '60000 at +1980000 cleared +1980000': 1, '300000 at +1995000 cleared +1995000': 1, '300000 at +2040000 cleared +2040000': 5, '60000 at +2040000 cleared +2040000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x4', 'control.setChildSessionId resolved true x4', 'control.markAccepted resolved true x4', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true'],
    final: { completed: 'parked-1..4', failed: 'parked-1..4' },
  },
  // confirmAgentHandoff takes the root's handoff lock and aborts the grouped tasks one at a time (abort of grouped-1
  // held, answered in step 37; grouped-2's abort at step 40); while the lock is held the 10 grouped submits are refused
  // handoff_in_progress (:2459-2466) and the 10 ungrouped start in one step (36). The handoff is still pending at the
  // end.
  'F11-handoff': {
    steps: 41,
    clock: ['+0 1-41'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2', '16: call submit x20', '41: answer executor.start#1..2 resolve'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 16-35 38-39', publishEvent: '5-8 10-11 13-14 17-36 39-40', 'executor.start': '8x2 36x10', 'executor.getLastRecoverableResult': '15 40', 'executor.abort': '15 40', 'executor.readRecoverableResult': '37' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 17-36 39-40', 'executor.abort': '37', 'executor.readRecoverableResult': '38', 'executor.start': '41x2' },
    launches: ['grouped-1..2 @8 after 5', 'ungrouped-1..10 @36 after 29'],
    timers: { '300000 at +0 cleared +0': 31, '60000 at +0 cleared +0': 2, '5000 at +0 cleared +0': 1, '60000 at +0 live': 10, '5000 at +0 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'confirmAgentHandoff pending', 'submit rejected handoff_in_progress x10', 'submit resolved starting x10'],
    final: { aborted: 'grouped-1', running: 'grouped-2', starting: 'ungrouped-1..10' },
  },
  // The plain path: 7 saves (initialize, queued, starting, child session, accepted, completed, collected).
  'submit-complete': {
    steps: 15,
    clock: ['+0 1-15'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 14', publishEvent: '5-6 8 10 12 15', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 15', 'executor.start': '11' },
    launches: ['one @6 after 3'],
    timers: { '300000 at +0 cleared +0': 7, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'waitForTask resolved completed', 'acknowledgeResult resolved <object>'],
    final: { completed: 'one' },
  },
  // waitForTask waits on the running task (:2873) and is resolved by notifyTaskWaiters after the terminal save
  // (:854-870, step 12 answers save 6 at step 13); shutdown (:3357-3423) clears the second task's starting lease, saves
  // once more (save 9, step 17) and then calls executor.shutdown (step 18, answered 19).
  'wait-then-shutdown': {
    steps: 19,
    clock: ['+0 1-19'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 12 14-15 17', publishEvent: '5-6 8 10 13 15-16', 'executor.start': '6 16', 'executor.shutdown': '18' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 13 15-16 18', 'executor.start': '12', 'executor.shutdown': '19' },
    launches: ['waited @6 after 3', 'left-starting @16 after 8'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'waitForTask resolved completed', 'submit resolved starting', 'shutdown resolved'],
    final: { completed: 'waited', starting: 'left-starting' },
  },
  // initialize loads the shards (:2286, step 2); the terminal save of the native task (maxTerminalRecords 0) makes it a
  // tombstone whose proof is written to its shard first (:496-514, step 18, answered 19), then the main commit drops
  // the record (save 9, step 19); the first acknowledgement is refused (logged, :912 arms 5,000 ms), the retry at
  // +5,000 succeeds, the next save (10) releases the proof and its shard is removed (step 24, :473).
  'native-proof-shard': {
    steps: 25,
    clock: ['+0 1-21', '+5000 22-25'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.loadNativeJobProofShards': '2', 'persistence.save': '3 5-6 8 10 12 14 16 19 23', resolveExecutionBackend: '5', publishEvent: '6-7 9 17 20 24', 'executor.start': '7', 'persistence.putNativeJobProofShard': '18', acknowledgeNativeJob: '20 22', 'logger.warn': '21', 'persistence.removeNativeJobProofShard': '24' },
    answers: { 'persistence.load': '2', 'persistence.loadNativeJobProofShards': '3', 'persistence.save': '4 6-7 9 11 13 15 17 20 24', 'executor.start': '18', 'persistence.putNativeJobProofShard': '19', acknowledgeNativeJob: '23 rejected 21', 'persistence.removeNativeJobProofShard': '25' },
    launches: ['native-proof @7 after 3'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.reserveNativeJobSegment resolved true', 'control.recordNativeJobSegment resolved true x2', 'control.markAccepted resolved true'],
    final: {},
  },
  // cancelTask aborts through executor.abort with the 5,000 ms abort race timer (:231), cleared when the abort answers;
  // the task ends aborted.
  'cancel-running': {
    steps: 15,
    clock: ['+0 1-15'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 13', publishEvent: '5-6 8 10 14', 'executor.start': '6', 'executor.getLastRecoverableResult': '11', 'executor.abort': '11', 'executor.readRecoverableResult': '12' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 14', 'executor.abort': '12', 'executor.readRecoverableResult': '13', 'executor.start': '15' },
    launches: ['cancel @6 after 3'],
    timers: { '300000 at +0 cleared +0': 6, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'cancelTask resolved aborted'],
    final: { aborted: 'cancel' },
  },
  // Both abort calls are made in the group's step (15x2) and answered oldest first (16, 17).
  'cancel-two': {
    steps: 22,
    clock: ['+0 1-22'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2', '15: call cancelTask x2', '22: answer executor.start#1..2 resolve'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 18 20', publishEvent: '5-8 10-11 13-14 20-21', 'executor.start': '8x2', 'executor.getLastRecoverableResult': '15x2', 'executor.abort': '15x2', 'executor.readRecoverableResult': '16-17' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 20-21', 'executor.abort': '16-17', 'executor.readRecoverableResult': '18-19', 'executor.start': '22x2' },
    launches: ['cancel-a @8 after 5', 'cancel-b @8 after 5'],
    timers: { '300000 at +0 cleared +0': 11, '60000 at +0 cleared +0': 2, '5000 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'cancelTask resolved aborted x2'],
    final: { aborted: 'cancel-a, cancel-b' },
  },
  // The abort never answers: the 5,000 ms race timer fires at +5000, logger.warn, and the task ends interrupted.
  'cancel-abort-timeout': {
    steps: 14,
    clock: ['+0 1-11', '+5000 12-14'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 13', publishEvent: '5-6 8 10 14', 'executor.start': '6', 'executor.getLastRecoverableResult': '11', 'executor.abort': '11', 'executor.readRecoverableResult': '12', 'logger.warn': '13' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 14', 'executor.readRecoverableResult': '13' },
    launches: ['stuck @6 after 3'],
    timers: { '300000 at +0 cleared +0': 5, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'cancelTask resolved interrupted'],
    final: { interrupted: 'stuck' },
  },
  // The timed wait resolves with the starting snapshot when its 2,000 ms timer fires (step 8); the signal's wait rejects
  // with its reason; the last wait resolves completed.
  'wait-timeout-and-abort': {
    steps: 15,
    clock: ['+0 1-7', '+2000 8-15'],
    groups: ['7: call waitForTask x2', '14: answer executor.start#1 resolve, call waitForTask'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 10 12 14', publishEvent: '5-6 11 13 15', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 11 13 15', 'executor.start': '14' },
    launches: ['waited @6 after 3'],
    timers: { '300000 at +0 cleared +0': 3, '60000 at +0 cleared +2000': 1, '2000 at +0 fired +2000': 1, '300000 at +2000 cleared +2000': 3 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'waitForTask resolved starting', 'waitForTask rejected Error', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'waitForTask resolved completed'],
    final: { completed: 'waited' },
  },
  // The retry acknowledgement submits a follow-up (same label) and launches it from the acknowledgement (:3703).
  'acknowledge-retry': {
    steps: 15,
    clock: ['+0 1-15'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13-14', publishEvent: '5-6 8 10 12 14x2 15', 'executor.start': '6 15' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14-15', 'executor.start': '11' },
    launches: ['flaky @6 after 3', 'flaky @15 after 8'],
    timers: { '300000 at +0 cleared +0': 8, '60000 at +0 cleared +0': 1, '60000 at +0 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>'],
    final: { failed: 'flaky', starting: 'flaky' },
  },
  // fence, then a late submit refused session_removal_pending; settle aborts the target (native settlement, 500 ms abort
  // timeout); the foreign root stays running.
  'removal': {
    steps: 21,
    clock: ['+0 1-21'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 19', publishEvent: '5-8 10-11 13-14 20', 'executor.start': '8x2', 'executor.getLastRecoverableResult': '17', 'executor.abort': '17 20', 'executor.readRecoverableResult': '18' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 20', 'executor.abort': '18 21', 'executor.readRecoverableResult': '19' },
    launches: ['target @8 after 5', 'foreign @8 after 5'],
    timers: { '300000 at +0 cleared +0': 10, '60000 at +0 cleared +0': 2, '500 at +0 cleared +0': 1, '500 at +0 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'cancelSessionsForRemoval resolved <object>', 'submit rejected session_removal_pending', 'cancelSessionsForRemoval pending'],
    final: { aborted: 'target', running: 'foreign' },
  },
  // stopAttemptRuns after the terminal commit: the first rejects (step 13), the retry at +5000 (RUN_CLEANUP_RETRY_MS,
  // :924) succeeds; onRunCleanup observes both.
  'run-cleanup': {
    steps: 17,
    clock: ['+0 1-14', '+5000 15-17'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 16', publishEvent: '5-6 8 10 12 14 17', 'executor.start': '6', stopAttemptRuns: '12 15', onRunCleanup: '14 17' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 17', 'executor.start': '11', stopAttemptRuns: '16 rejected 13' },
    launches: ['cleanup @6 after 3'],
    timers: { '300000 at +0 cleared +0': 7, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true'],
    final: { completed: 'cleanup' },
  },
  // A native-job task (resolveExecutionBackend): segment reserved and recorded through the control; the first
  // acknowledgeNativeJob rejects (warned once), retried at +5000 (:914).
  'native-segments': {
    steps: 22,
    clock: ['+0 1-19', '+5000 20-22'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 15 17 21', resolveExecutionBackend: '4', publishEvent: '5-6 8 16 18', 'executor.start': '6', acknowledgeNativeJob: '18 20', 'logger.warn': '19' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 16 18 22', 'executor.start': '17', acknowledgeNativeJob: '21 rejected 19' },
    launches: ['native @6 after 3'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.reserveNativeJobSegment resolved true', 'control.recordNativeJobSegment resolved true x2', 'control.markAccepted resolved true'],
    final: { completed: 'native' },
  },
  // As F1 at 3 (1 + 2N saves, the starts in step 10), then the first task's child session and acceptance (saves 8, 9).
  // Its crash points state only which save the fresh instance loads; the recovery itself (reconciles one at a time in
  // queue order, answered from RECONCILE_MIX in turn, then initialize's leases and pump) is the recording's.
  'restart-mixed': {
    steps: 14,
    clock: ['+0 1-14'],
    groups: ['4: call submit x3'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-9 11 13', publishEvent: '5-10 12 14', 'executor.start': '10x3' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-10 12 14' },
    launches: ['mixed-1..3 @10 after 7'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 1, '60000 at +0 live': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x3', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true'],
    final: { running: 'mixed-1', starting: 'mixed-2..3' },
  },
  // As run-cleanup, the second stop failing too: the retry after it is armed with RUN_CLEANUP_RETRY_MS[1] (30,000 ms,
  // :924) at +5000 and fires at +35000, where the third stop succeeds.
  'run-cleanup-backoff': {
    steps: 20,
    clock: ['+0 1-14', '+5000 15-17', '+35000 18-20'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 16 19', publishEvent: '5-6 8 10 12 14 17 20', 'executor.start': '6', stopAttemptRuns: '12 15 18', onRunCleanup: '14 17 20' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 17 20', 'executor.start': '11', stopAttemptRuns: '19 rejected 13 16' },
    launches: ['backoff @6 after 3'],
    timers: { '300000 at +0 cleared +0': 7, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1, '30000 at +5000 fired +35000': 1, '300000 at +35000 cleared +35000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true'],
    final: { completed: 'backoff' },
  },
  // initialize loads the two queued records (step 2), saves once (:2349) and pumps (:2386): queue order (:198-202) puts
  // the record created first ahead though its task ID sorts later; two admission saves (3, 4), both starts in step 5.
  'queue-order-ties': {
    steps: 5,
    clock: ['+0 1-5'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2-4', publishEvent: '4-5', 'executor.start': '5x2' },
    answers: { 'persistence.load': '2', 'persistence.save': '3-5' },
    launches: ['tie-created-first @5 after 3', 'tie-created-second @5 after 3'],
    timers: { '300000 at +0 cleared +0': 3, '60000 at +0 live': 2 },
    outcomes: ['initialize resolved'],
    final: { starting: 'tie-created-first, tie-created-second' },
  },
  // The first task's admission arms its 600,000 ms deadline (timeoutAt, :2142) and its starting lease; the second
  // submit's admission save (save 5, step 8) is refused, logged (step 9) and arms the 5,000 ms admission retry (:1956);
  // shutdown (:3357-3423) clears the deadline, the lease and the retry, saves once more (step 10) and calls
  // executor.shutdown (step 11, answered 12).
  'shutdown-with-timers': {
    steps: 12,
    clock: ['+0 1-12'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7-8 10', publishEvent: '5-6 8', 'executor.start': '6', 'logger.warn': '9', 'executor.shutdown': '11' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 11 rejected 9', 'executor.shutdown': '12' },
    launches: ['deadline @6 after 3'],
    timers: { '300000 at +0 cleared +0': 6, '600000 at +0 cleared +0': 1, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'submit resolved queued', 'shutdown resolved'],
    final: { queued: 'refused-admission', starting: 'deadline' },
  },
  // recordOperatorStop then acceptOperatorStop; the 5,000 ms expiry timer and a 1,000 ms timer are set and cleared when
  // the child settles user-stopped.
  'operator-stop': {
    steps: 16,
    clock: ['+0 1-16'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 15', publishEvent: '5-6 8 10 12 14 16', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 16', 'executor.start': '15' },
    launches: ['stopped @6 after 3'],
    timers: { '300000 at +0 cleared +0': 8, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1, '1000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'recordOperatorStop resolved <object>', 'acceptOperatorStop resolved true'],
    final: { aborted: 'stopped' },
  },
};

/** The scenarios, each with its stated facts (null when it states none: the facts check then fails it). */
export const SCENARIOS = Object.freeze(DEFINED.map((scenario) => Object.freeze({ ...scenario, facts: FACTS[scenario.name] ?? null })));

/** How many entries a stated step list holds: `2 4-5 12x4` is 1 + 2 + 4. */
export const stepCount = (text) => String(text ?? '').split(' ').filter(Boolean).reduce((sum, part) => {
  const times = /^(\d+)x(\d+)$/.exec(part);
  const span = /^(\d+)-(\d+)$/.exec(part);
  return sum + (times ? Number(times[2]) : span ? Number(span[2]) - Number(span[1]) + 1 : 1);
}, 0);
/** A scenario's saves when run through (its first instance's, from its stated facts), or its own `saves`. */
export const savesOf = (scenario) => scenario.saves ?? stepCount(scenario.facts?.ports?.['persistence.save']);
/** The crash points of the sweep (package O0d, design §4.5): every save of every scenario, durable and torn. */
export const CRASH_SWEEP_ENV = 'DEVRYAN_SCHEDULER_CRASH_SWEEP';

/**
 * Every test the corpus defines: its name, scenario and crash point. A scenario that asks for them has its crash
 * points (every save, durable and torn) always; with `sweep` (default: the CRASH_SWEEP_ENV variable is `1`) every
 * other scenario has them too, except one whose script states its own crash (F7) and the large F1 sizes.
 */
export const corpusTests = ({ sweep = process.env[CRASH_SWEEP_ENV] === '1' } = {}) => SCENARIOS.filter((scenario) => !scenario.large).flatMap((scenario) => [
  { name: scenario.name, scenario, crash: null },
  ...(scenario.crashPoints || (sweep && !scenario.crash) ? Array.from({ length: savesOf(scenario) }, (_, index) => ['durable', 'torn'].map((mode) => ({ name: `${scenario.name} crash at save ${index + 1} ${mode}`, scenario, crash: { index: index + 1, mode } }))).flat() : []),
]);

export const scenarioNamed = (name) => SCENARIOS.find((scenario) => scenario.name === name) ?? null;

/** The scenario's restart after a crash point when it has none of its own: initialize, then let the 60 s starting lease and the 1 s reconciliation retry run. */
async function defaultRestart(d, scenario) {
  d.restart(createManagedTaskScheduler, scenario.config ?? {});
  await d.step(d.call('initialize'));
  await d.advance(MINUTE);
}

/**
 * Runs a scenario with a fresh driver. `crash`: `{ index, mode }` (1-based
 * save, `durable` or `torn`), or the scenario's own. Returns the driver's
 * log, its facts and the driver (disposed). Throws the driver's check errors.
 * `driver` is the driver module (a planted copy, driver-mutants.mjs).
 */
export async function runScenario(scenario, { drain = 'one', crash = null, driver = DRIVER } = {}) {
  const { CRASH_STOP, Driver, logFacts } = driver;
  const point = crash ?? scenario.crash ?? null;
  const d = new Driver({ name: point && !scenario.crash ? `${scenario.name}@${point.mode}-${point.index}` : scenario.name, drain, encodeSaved: point ? encodeSaved : null, crash: point });
  try {
    await d.start();
    try {
      await scenario.run.call(scenario, d);
    } catch (error) {
      if (error !== CRASH_STOP) throw error;
    }
    if (point) {
      if (scenario.restart && !crash) await scenario.restart.call(scenario, d);
      else await defaultRestart(d, scenario);
    }
    await d.finish();
    return { log: d.log, facts: logFacts(d.log), driver: d };
  } finally {
    d.dispose();
  }
}

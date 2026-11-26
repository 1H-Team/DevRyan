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
import { REQUIRED_CHECK_CORRECTION } from '../../packages/orchestration-runtime/check-correction.js';
import { encodeLedgerSnapshot } from '../../packages/orchestration-runtime/codec.js';
import { USER_CHECK_WAIVER } from '../../packages/orchestration-runtime/required-checks.js';
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
/** provider-recovery-unlinked: a settled record of the recovery group as the scheduler saves one (codec.js; queuedRecord's fields). */
const settledRecord = (taskId, key, overrides) => ({
  ...queuedRecord(taskId, key, 0), dispatchGroupId: 'msg_recovery_01', dispatchWaveId: `dvr_wave_${'c'.repeat(32)}`, childSessionId: 'ses_child_1', status: 'completed', startedAt: EPOCH, finishedAt: EPOCH, ...overrides,
});
/** provider-recovery-unlinked: a result envelope of `task` as the scheduler saves one (result-envelope.js). */
const savedEnvelope = (task, overrides) => ({
  owner: 'devryan', envelopeId: `dvr_result_${task.taskId.slice('dvr_task_'.length)}_${overrides.sequence}`, taskId: task.taskId, rootSessionId: task.rootSessionId, parentTaskId: null, childSessionId: task.childSessionId,
  directory: task.directory, status: task.status, partial: task.partial, failureReason: task.failureReason, attempt: task.attempt, priorTaskId: task.priorTaskId, executionKind: task.executionKind,
  recoverablePreview: task.recoverablePreview, canonicalRefs: [], resumable: false, createdAt: EPOCH, acknowledgedAt: null, action: null, followUpTaskId: null, providerResetAt: null, autoResume: null, ...overrides,
});
const RECOVERY_SOURCE = settledRecord(`dvr_task_${'d'.repeat(32)}`, 'recovering', { sequence: 1, status: 'failed', leaseToken: `dvr_lease_${'1'.repeat(32)}`, failureReason: 'harness failure', partial: true, recoverablePreview: 'half' });
const RECOVERY_FOLLOW_UP = settledRecord(`dvr_task_${'e'.repeat(32)}`, 'recover-1', { sequence: 2, attempt: 2, priorTaskId: RECOVERY_SOURCE.taskId, executionKind: 'retry_in_place', recoveryLineageId: `dvr_lineage_${'d'.repeat(32)}`, leaseToken: `dvr_lease_${'2'.repeat(32)}`, recoverablePreview: 'done' });
/** A ledger whose recovery source names another follow-up than the one that names it (as no commit of the scheduler writes, but a ledger on disk can hold). */
const UNLINKED_LEDGER = Object.freeze({ version: 1, tasks: [RECOVERY_SOURCE, RECOVERY_FOLLOW_UP], resultEnvelopes: [
  savedEnvelope(RECOVERY_SOURCE, { sequence: 2, resumable: true, acknowledgedAt: EPOCH, action: 'retry_in_place', followUpTaskId: `dvr_task_${'f'.repeat(32)}` }),
  savedEnvelope(RECOVERY_FOLLOW_UP, { sequence: 3 }),
] });

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
  // Package O0e2: the members, control methods, ports, options and gaps the census waived, each with its answer inside
  // a compared case (every input of a scenario is delivered at rest), on its ordinary path and the edge paths a port
  // would get wrong (an unknown id, a wrong lease or state, a double call, a call after shutdown, a rejecting port).
  {
    name: 'prerequisites-assert-at-launch',
    purpose: 'control.assertPrerequisites through a launch: while starting it rechecks the prerequisites (verifyTaskPrerequisites) and resolves, then rejects task_prerequisites_unverified once the evidence is gone; once running it does not recheck; once terminal it rejects task_lease_stale',
    async run(d) {
      const gate = { ready: true };
      await boot(d, { options: { verifyTaskPrerequisites: () => gate.ready } });
      await d.step(d.call('submit', taskInput('asserted', { taskPrerequisites: PREREQUISITE })));
      const [start] = starts(d);
      await d.step(d.control(start, 'assertPrerequisites'));
      gate.ready = false;
      await d.step(d.control(start, 'assertPrerequisites'));
      await d.step(d.control(start, 'setChildSessionId', 'ses_child_asserted'));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.control(start, 'assertPrerequisites'));
      await d.step(d.answer(start, completed));
      await d.step(d.control(start, 'assertPrerequisites'));
    },
  },
  {
    name: 'restart-starting-lease-retry', crash: { index: 4, mode: 'durable' },
    purpose: 'Restart on a starting task with a deadline, under a 1,500 ms starting lease (startingLeaseTimeoutMs), 1,000 ms after its start: the task starts at +0, records progress at +1000 and the crash lands on that save; initialize reconciles it (transient: the 1,000 ms retry), then arms its deadline (599,000 ms: from its timeoutAt, not its creation) and then its lease (500 ms: from its start, not now); the lease and the retry each reconcile it again while both answers are held, and the second transient answer finds the retry already armed and arms none',
    config: { options: { startingLeaseTimeoutMs: 1_500 }, ports: { 'executor.reconcile': { mode: 'hold' } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('lease-restart', { timeoutAt: d.time + 10 * MINUTE })));
      await d.advance(1_000);
      await d.step(d.control(starts(d)[0], 'recordProgress', { childPromptedAt: d.time }));
    },
    async restart(d) {
      d.restart(createManagedTaskScheduler, this.config);
      await d.step(d.call('initialize'));
      await d.step(d.answer(d.pending('executor.reconcile')[0], { state: 'transient' }));
      await d.advance(500);
      await d.advance(500);
      const [byLease, byRetry] = d.pending('executor.reconcile');
      await d.step(d.answer(byLease, { state: 'transient' }));
      await d.step(d.answer(byRetry, { state: 'transient' }));
      await d.advance(1_000);
      for (const pending of d.pending('executor.reconcile')) await d.step(d.answer(pending, { state: 'terminal', result: completed }));
    },
  },
  {
    name: 'retry-reads-prior-failure',
    purpose: 'control.readPriorFailureReason and control.recordTransportRecovery: a first attempt reads no prior failure; its retry (acknowledgeResult retry) reads the failure it follows; the retry records a transport recovery at the next revision (true), again at a stale revision (false), with a skipped revision (TypeError), and the settled first attempt records none (false)',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('prior')));
      const [first] = starts(d);
      await d.step(d.control(first, 'readPriorFailureReason'));
      await acceptAll(d);
      await d.step(d.answer(first, { status: 'failed', failureReason: 'harness failure', partial: true, recoverablePreview: 'half', canonicalRefs: [], resumable: true }));
      await d.step(d.call('acknowledgeResult', submitted.value?.taskId, { action: 'retry', idempotencyKey: 'retry-prior' }));
      const [retry] = starts(d);
      await d.step(d.control(retry, 'readPriorFailureReason'));
      await d.step(d.control(retry, 'recordTransportRecovery', transportRecovery(1), 0));
      await d.step(d.control(retry, 'recordTransportRecovery', transportRecovery(1), 0));
      await d.step(d.control(retry, 'recordTransportRecovery', transportRecovery(3), 1));
      await d.step(d.control(first, 'recordTransportRecovery', transportRecovery(1), 0));
    },
  },
  {
    name: 'handoff-clear',
    purpose: 'confirmAgentHandoff settling clear: inspectAgentHandoff before (confirmation_required) and after (clear) and with a bad scope (invalid_handoff_scope); confirmAgentHandoff without a key (missing_idempotency_key), then twice with one key and once with another in one group (the second joins the first, the third is handoff_conflict); both grouped tasks are aborted and abandoned; the pump after the lock admits a held task whose admission save fails (the only logger.error), and the admission retry then launches it',
    config: {
      // The driver's logger has only warn; this one has error too (the scheduler's only logger.error is here).
      options: { verifyTaskPrerequisites: (entry) => entry.index >= HANDOFF_READY_FROM, logger: { warn: () => undefined, error: () => undefined } },
      ports: { 'persistence.save': { mode: 'auto', answer: (entry) => (entry.index === HANDOFF_FAILED_SAVE ? { $reject: Object.assign(new Error('harness: save refused'), { code: 'harness_save_refused' }) } : undefined) } },
    },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(2).map((index) => d.call('submit', taskInput(`grouped-${index}`, { dispatchGroupId: 'msg_dispatch_01' }))));
      await acceptAll(d);
      await d.step(d.call('submit', taskInput('held', { taskPrerequisites: PREREQUISITE })));
      await d.step(d.call('inspectAgentHandoff', HANDOFF));
      await d.step(d.call('inspectAgentHandoff', { ...HANDOFF, toMode: 'orchestrator' }));
      await d.step(d.call('confirmAgentHandoff', HANDOFF));
      await d.step(d.call('confirmAgentHandoff', { ...HANDOFF, idempotencyKey: 'switch-01' }), d.call('confirmAgentHandoff', { ...HANDOFF, idempotencyKey: 'switch-01' }), d.call('confirmAgentHandoff', { ...HANDOFF, idempotencyKey: 'switch-02' }));
      await d.step(d.call('inspectAgentHandoff', HANDOFF));
      await d.advance(1_000);
    },
  },
  {
    name: 'handoff-abort-timeout',
    purpose: 'confirmAgentHandoff settling blocked: the first grouped task\'s abort never answers, so the abort race times out at 5,000 ms (its signal aborted with "Managed task abort exceeded"), the task stays running and is reported as a cleanup failure; the second is aborted and abandoned; inspectAgentHandoff then still requires confirmation',
    config: { ports: { 'executor.abort': { mode: (entry) => (entry.index === 1 ? 'never' : 'auto'), answer: () => ({ aborted: true }) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(...range(2).map((index) => d.call('submit', taskInput(`grouped-${index}`, { dispatchGroupId: 'msg_dispatch_01' }))));
      await acceptAll(d);
      await d.step(d.call('confirmAgentHandoff', { ...HANDOFF, idempotencyKey: 'switch-01' }));
      await d.advance(5_000);
      await d.step(d.call('inspectAgentHandoff', HANDOFF));
    },
  },
  {
    name: 'runtime-restart-crash', crash: { index: 7, mode: 'torn' },
    purpose: 'Crash during withRuntimeRestart after replacementStarted: the running task reconciles terminal inside the restart, its run cleanup (stopAttemptRuns) is held, the replacement action is called and held; the cleanup answer\'s save is torn. The fresh instance loads the terminal save with the cleanup pending, re-arms it at 0 ms and stops the runs again',
    config: { options: { stopAttemptRuns: () => ({ stopped: 1 }), onRunCleanup: () => undefined }, ports: { stopAttemptRuns: { mode: 'hold' }, 'executor.reconcile': { mode: 'auto', answer: () => ({ state: 'terminal', result: completed }) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('replaced')));
      await acceptAll(d);
      const action = d.hook('restartAction');
      await d.step(d.call('withRuntimeRestart', action));
      const [stop] = d.pending('stopAttemptRuns');
      if (!stop || d.pending('restartAction').length !== 1) throw new Error('runtime-restart-crash: the run cleanup and the replacement action were not both pending');
      await d.step(d.answer(stop, { stopped: 1 }));
    },
    async restart(d) {
      d.restart(createManagedTaskScheduler, this.config);
      await d.step(d.call('initialize'));
      await d.advance(1);
      for (const stop of d.pending('stopAttemptRuns')) await d.step(d.answer(stop, { stopped: 2 }));
    },
  },
  {
    name: 'operator-stop-restart', crash: { index: 7, mode: 'durable' },
    purpose: 'Crash with an operator stop pending, 2,000 ms after it was requested: the stop is recorded at +0, the task records progress at +2000 and the process dies on that save. The fresh instance re-arms the stop\'s expiry for what is left of its 5,000 ms (3,000 ms: from requestedAt, not now), reconciles the task (unavailable) but leaves it running while the stop is pending; readOperatorStop finds it (and no other session); withdrawOperatorStop with a wrong request is refused, with the right one withdraws it (expiry cleared, reconciliation retry armed); readOperatorStop then finds nothing and acceptOperatorStop is refused; the retry settles the task interrupted',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('stopped')));
      await acceptAll(d, starts(d), () => 'ses_stop_child');
      await d.step(d.call('recordOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace', requestedAt: d.time, requestId: 'stop_harness_1' }));
      await d.advance(2_000);
      await d.step(d.control(starts(d)[0], 'recordProgress', { childPromptedAt: d.time }));
    },
    async restart(d) {
      const [task] = JSON.parse(d.crashed.state).tasks;
      const stop = { taskId: task.taskId, leaseToken: task.leaseToken, requestedAt: task.operatorStop.requestedAt, requestId: 'stop_harness_1' };
      d.restart(createManagedTaskScheduler, {});
      await d.step(d.call('initialize'));
      await d.step(d.call('readOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace' }));
      await d.step(d.call('readOperatorStop', { sessionId: 'ses_other_child', directory: '/workspace' }));
      await d.step(d.call('withdrawOperatorStop', { ...stop, requestId: 'stop_harness_wrong' }));
      await d.step(d.call('withdrawOperatorStop', stop));
      await d.step(d.call('readOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace' }));
      await d.step(d.call('acceptOperatorStop', stop));
      await d.advance(1_000);
    },
  },
  {
    name: 'native-prompt-context',
    purpose: 'verifyTaskDispatch and verifyTaskSettlement with the current lease (the task) and a wrong one or an unknown task (native_managed_task_lease_invalid); getTask of an unknown task (null); withNativePromptContext around a terminal task: its action reads the dispatch barrier (authorize called again), marks the prompt observed with a stale attempt (native_prompt_context_revision_conflict, thrown synchronously) and then the right one, and resolves after one save; the barrier read after the action ends is fenced. (A context without authorize is not called: no caller can pass one, and what it would pin is the test runner\'s engine\'s TypeError text; native-prompt-context-fenced and native-prompt-context-refusals hold the refusals real callers meet)',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('context')));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      await d.step(d.call('verifyTaskDispatch', taskId, leaseToken));
      await d.step(d.call('verifyTaskDispatch', taskId, 'dvr_lease_wrong'));
      await d.step(d.call('verifyTaskSettlement', taskId, leaseToken));
      await d.step(d.call('verifyTaskSettlement', 'dvr_task_missing', leaseToken));
      await d.step(d.call('getTask', 'dvr_task_missing'));
      await acceptAll(d);
      await d.step(d.answer(start, completed));
      const authorize = d.hook('authorize', { mode: 'auto', answer: () => undefined });
      const scope = { rootSessionId: 'ses_root', directory: '/workspace' };
      await d.step(d.call('withNativePromptContext', { ...scope, authorize }, d.hook('promptAction')));
      const [context] = d.pending('promptAction');
      if (!context) throw new Error('native-prompt-context: the action was not called');
      const sequence = context.args[0].envelopes[0]?.sequence;
      await d.step(d.callback(context, '0.readBarrier', scope));
      await d.step(d.callback(context, '0.markPromptObserved', { taskId, attempt: 2, sequence }));
      await d.step(d.callback(context, '0.markPromptObserved', { taskId, attempt: 1, sequence }));
      await d.step(d.answer(context, 'observed'));
      await d.step(d.callback(context, '0.readBarrier', scope));
    },
  },
  {
    name: 'provider-recovery-continuation',
    purpose: 'Provider recovery continuations: a grouped task fails resumable and is retried in place with an explicit model; the completed follow-up is listed ready (not for another session); claimed (true), claimed again by another claimant (false, the first expiry), refused for a bad input, an unknown task and another directory; verifyRecoveredCollection answers only its claimant; a release by another claimant is refused, by the claimant released; afterwards nothing verifies, and the source (already acknowledged) is not claimable',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('recovering', { dispatchGroupId: 'msg_recovery_01' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], { status: 'failed', failureReason: 'harness failure', partial: true, recoverablePreview: 'half', canonicalRefs: [], resumable: true }));
      const source = submitted.value?.taskId;
      const acknowledged = await d.step(d.call('acknowledgeResult', source, { action: 'retry_in_place', idempotencyKey: 'recover-1', providerId: 'github-copilot', modelId: 'gpt-4.1', variant: null }));
      const [inPlace] = d.pending('executor.retryInPlace');
      if (!inPlace) throw new Error('provider-recovery-continuation: the retry in place was not launched');
      await d.step(d.control(inPlace, 'markAccepted'));
      await d.step(d.answer(inPlace, completed));
      const followUp = acknowledged.value?.followUpTask?.taskId;
      const claim = (claimantId, over = {}) => ({ taskId: followUp, rootSessionId: 'ses_root', directory: '/workspace', claimantId, ...over });
      await d.step(d.call('listReadyProviderRecoveryContinuations', {}));
      await d.step(d.call('listReadyProviderRecoveryContinuations', { sessionId: 'ses_other' }));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-1')));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-2')));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-2', { taskId: '' })));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-2', { taskId: 'dvr_task_missing' })));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-2', { directory: '/elsewhere' })));
      await d.step(d.call('verifyRecoveredCollection', claim('claimant-2')));
      await d.step(d.call('verifyRecoveredCollection', claim('claimant-1')));
      await d.step(d.call('releaseProviderRecoveryContinuation', claim('claimant-2')));
      await d.step(d.call('releaseProviderRecoveryContinuation', claim('claimant-1')));
      await d.step(d.call('verifyRecoveredCollection', claim('claimant-1')));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-1', { taskId: source })));
    },
  },
  {
    name: 'auto-resume-opt-out',
    purpose: 'setResultAutoResume and cancelAutoResumeForSession on a result parked on a provider usage limit: a non-boolean request and an unknown task are refused; disabling switches the automatic resume off, disabling again changes nothing, enabling plans it again (a 0 ms planning timer); cancelling for the session needs a session and a known reason, cancels the planned resume and then finds nothing more to cancel',
    async run(d) {
      const resetAt = d.time + 30 * MINUTE;
      await boot(d, { options: { autoResume: { resolveOwnerKey: () => 'owner-a', resolveBackupExecution: () => null, resolveProviderReset: () => ({ resetAt, limited: true }), attempt: () => undefined } }, ports: { 'autoResume.attempt': { mode: 'hold' } } });
      const submitted = await d.step(d.call('submit', taskInput('parked', { dispatchGroupId: 'msg_parent', providerId: 'anthropic', modelId: 'claude-opus' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], { status: 'failed', failureReason: LIMIT, partial: true, recoverablePreview: 'partial work', canonicalRefs: [], resumable: true, providerResetAt: resetAt }));
      const taskId = submitted.value?.taskId;
      await d.step(d.call('setResultAutoResume', taskId, { enabled: 'yes' }));
      await d.step(d.call('setResultAutoResume', 'dvr_task_missing', { enabled: false }));
      await d.step(d.call('setResultAutoResume', taskId, { enabled: false }));
      await d.step(d.call('setResultAutoResume', taskId, { enabled: false }));
      await d.step(d.call('setResultAutoResume', taskId, { enabled: true }));
      await d.step(d.call('cancelAutoResumeForSession', ' ', 'cancelled'));
      await d.step(d.call('cancelAutoResumeForSession', 'ses_root', 'forgotten'));
      await d.step(d.call('cancelAutoResumeForSession', 'ses_root', 'cancelled'));
      await d.step(d.call('cancelAutoResumeForSession', 'ses_root', 'session_deleted'));
    },
  },
  {
    name: 'persistence-observation',
    purpose: 'A save that stalls, a publication that fails and mutations that fail, with every observer passed: the queued save of a grouped submit is held; persistence.save\'s onProgress is called back (started, completed: the 1,000 ms stall watch re-armed; an unknown phase ignored); the stall watch fires (onPersistenceObservation needs_attention, logger.warn); the answer reports it settled; the first publication throws (logger.warn); onBarrierChange sees the group go active; releaseModeLease is refused for another mode and for the active one, each mutation timed failed',
    config: {
      options: { persistenceStallMs: 1_000, onPersistenceObservation: () => undefined, onMutationTiming: () => undefined, onBarrierChange: () => undefined },
      ports: { 'persistence.save': { mode: (entry) => (entry.index === 2 ? 'hold' : 'auto') }, publishEvent: { mode: 'sync', answer: (entry) => { if (entry.index === 1) throw Object.assign(new Error('harness: publish refused'), { code: 'harness_publish_refused' }); } } },
    },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('observed', { dispatchGroupId: 'msg_observed' })));
      const [held] = d.pending('persistence.save');
      if (!held) throw new Error('persistence-observation: the queued save was not held');
      await d.step(d.callback(held, '1.onProgress', { phase: 'write', state: 'started' }));
      await d.step(d.callback(held, '1.onProgress', { phase: 'write', state: 'completed' }));
      await d.step(d.callback(held, '1.onProgress', { phase: 'harness_phase', state: 'completed' }));
      await d.advance(1_000);
      await d.step(d.answer(held, undefined));
      await d.step(d.call('releaseModeLease', 'ses_root', 'builder'));
      await d.step(d.call('releaseModeLease', 'ses_root', 'orchestrator'));
    },
  },
  {
    name: 'designer-step-budget',
    purpose: 'The primary-prompt step budget of a designer task: control.readPrimaryStepBudget before and after; acceptPrimaryPrompt (true, again true without a save, a wrong lease null); recordPrimaryStep with 179 historical steps and one new (180 used) and for an unknown prompt (null); claimPrimaryStepBudgetWarning while starting (null), once running (the notice), and again (null)',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('designed', { agent: 'designer' })));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      const base = { taskId, leaseToken, sessionId: 'ses_child_designer', directory: '/workspace' };
      await d.step(d.control(start, 'readPrimaryStepBudget'));
      await d.step(d.control(start, 'setChildSessionId', 'ses_child_designer'));
      await d.step(d.call('acceptPrimaryPrompt', { ...base, createdAt: d.time, userMessageId: 'msg_user_1' }));
      await d.step(d.call('acceptPrimaryPrompt', { ...base, createdAt: d.time, userMessageId: 'msg_user_1' }));
      await d.step(d.call('acceptPrimaryPrompt', { ...base, leaseToken: 'dvr_lease_wrong', createdAt: d.time, userMessageId: 'msg_user_2' }));
      const historicalSteps = range(179).map((index) => ({ messageId: `msg_step_${String(index).padStart(3, '0')}`, createdAt: d.time }));
      await d.step(d.call('recordPrimaryStep', { ...base, createdAt: d.time, userMessageId: 'msg_user_1', messageId: 'msg_step_180', historicalSteps }));
      await d.step(d.call('recordPrimaryStep', { ...base, createdAt: d.time, userMessageId: 'msg_user_unknown', messageId: 'msg_step_181' }));
      await d.step(d.control(start, 'readPrimaryStepBudget'));
      await d.step(d.call('claimPrimaryStepBudgetWarning', { ...base, messageId: 'msg_step_180' }));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.call('claimPrimaryStepBudgetWarning', { ...base, messageId: 'msg_step_180' }));
      await d.step(d.call('claimPrimaryStepBudgetWarning', { ...base, messageId: 'msg_step_180' }));
    },
  },
  {
    name: 'waits-and-reads',
    purpose: 'The waits and reads with their refusals: waitForAnyTask (pending, then resolved by a completion; no task ids, another root, an aborted signal refused); waitForResultCommit (pending, then resolved; no directory refused); waitForResultAction (pending until the result is collected; a result not yet there and an unknown task refused); listResultEnvelopes, inspectDispatchBarrier (no root refused), getObjectiveRequiredChecks of a declared objective and of another; after shutdown initialize and waitForAnyTask reject scheduler_shut_down',
    async run(d) {
      await boot(d);
      const [first, second] = await d.step(d.call('submit', taskInput('wait-a')), d.call('submit', taskInput('wait-b')));
      const [a, b] = [first.value?.taskId, second.value?.taskId];
      const aborted = new AbortController();
      aborted.abort(new Error('harness: aborted before the wait'));
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [a, b], timeoutMs: 3_000 }));
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [] }));
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_other', taskIds: [a] }));
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [a], signal: aborted.signal }));
      await d.step(d.call('waitForResultCommit', { directory: '/workspace', timeoutMs: 3_000 }));
      await d.step(d.call('waitForResultCommit', {}));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed));
      await d.step(d.call('waitForResultAction', a));
      await d.step(d.call('waitForResultAction', b));
      await d.step(d.call('waitForResultAction', 'dvr_task_missing'));
      await d.step(d.call('listResultEnvelopes', {}));
      await d.step(d.call('listResultEnvelopes', { rootSessionId: 'ses_other' }));
      await d.step(d.call('inspectDispatchBarrier', 'ses_root'));
      await d.step(d.call('inspectDispatchBarrier', ''));
      await d.step(d.call('acknowledgeResult', a, { action: 'collect', idempotencyKey: 'collect-a' }));
      const objective = { rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'objective-1' };
      await d.step(d.call('declareObjectiveChecks', objective, [CHECK], [], d.hook('authorize', { mode: 'auto', answer: () => undefined })));
      await d.step(d.call('getObjectiveRequiredChecks', objective));
      await d.step(d.call('getObjectiveRequiredChecks', { ...objective, objectiveId: 'objective-2' }));
      await d.step(d.call('shutdown'));
      await d.step(d.call('initialize'));
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [b] }));
    },
  },
  {
    name: 'required-checks',
    purpose: 'Required checks of a task: getRequiredCheckTask (its directory, not another), getRequiredCheckTasks (by child and by root), getChildAssignment (active, later the settled one; an unknown session null); recordRequiredCheck start (true, again false, a wrong lease false), recordRequiredChecks with an unknown phase (TypeError), bind and complete (true; onRequiredCheckReceipt each); waiveRequiredChecks without authority (TypeError); after completion acknowledgeResult continue is refused while inspectRequiredChecks reports work remaining, then accepted',
    config: { options: { inspectRequiredChecks: (entry) => (entry.index === 1 ? { ready: false, remaining: [CHECK] } : { ready: true }), onRequiredCheckReceipt: () => undefined } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('checked', { requiredChecks: [CHECK] })));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      await d.step(d.control(start, 'setChildSessionId', 'ses_child_checked'));
      await d.step(d.call('getRequiredCheckTask', 'ses_child_checked', '/workspace'));
      await d.step(d.call('getRequiredCheckTask', 'ses_child_checked', '/elsewhere'));
      await d.step(d.call('getRequiredCheckTasks', 'ses_child_checked', '/workspace'));
      await d.step(d.call('getRequiredCheckTasks', 'ses_root', '/workspace'));
      await d.step(d.call('getChildAssignment', 'ses_child_checked', '/workspace'));
      await d.step(d.call('getChildAssignment', 'ses_child_unknown', '/workspace'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, receipt(), 'start'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, receipt(), 'start'));
      await d.step(d.call('recordRequiredCheck', taskId, 'dvr_lease_wrong', receipt(), 'start'));
      await d.step(d.call('recordRequiredChecks', taskId, leaseToken, [receipt()], 'finish'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, receipt({ messageId: 'msg_check' }), 'bind'));
      await d.step(d.call('recordRequiredChecks', taskId, leaseToken, [receipt({ messageId: 'msg_check', status: 'passed', exitCode: 0, contentHash: 'b'.repeat(64) })], 'complete'));
      await d.step(d.call('waiveRequiredChecks', taskId, [receipt()], {}));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.answer(start, completed));
      await d.step(d.call('getChildAssignment', 'ses_child_checked', '/workspace'));
      await d.step(d.call('acknowledgeResult', taskId, { action: 'continue', idempotencyKey: 'continue-1' }));
      await d.step(d.call('acknowledgeResult', taskId, { action: 'continue', idempotencyKey: 'continue-2' }));
    },
  },
  {
    name: 'publication-beside-launch',
    purpose: 'A launch right after a publication: a collected task ages out (maxHistoryAgeMs 2,000) while the admission save of a second is refused (save 9: logger.warn, the 5,000 ms admission retry); the retry\'s admission save also removes the aged task, so two publications follow that one commit (the removal, then the admission), and the second falls between the starting lease and executor.start',
    config: { options: { maxHistoryAgeMs: 2_000 }, ports: { 'persistence.save': { mode: 'auto', answer: (entry) => (entry.index === 9 ? { $reject: Object.assign(new Error('harness: save refused'), { code: 'harness_save_refused' }) } : undefined) } } },
    async run(d) {
      await boot(d, this.config);
      const aged = await d.step(d.call('submit', taskInput('aged')));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], completed));
      await d.step(d.call('acknowledgeResult', aged.value?.taskId, { action: 'collect', idempotencyKey: 'collect-aged' }));
      await d.step(d.call('submit', taskInput('retried')));
      await d.advance(5_000);
    },
  },
  // Package O0e2's fix round: the branches behind the door of what the scenarios above newly judge (the O0e2 review's
  // planted mistakes in them), so each such member rests on a second case: what it answers by state, not only its
  // refusals, and the re-armed timers of a restart measured from stored times after virtual time passed.
  {
    name: 'required-checks-waived',
    purpose: 'Required checks past their door: receipts of one check (lint) started and bound, a completion for another message refused, a bind to another message marking an identity conflict (false, committed); the user\'s waiver of another (unit, with the package\'s waiver authority) accepted, after which a bind of it is refused; the host runner\'s correction of a third (edge) accepted, so getRequiredCheckTask answers the corrected command; once completed, getRequiredCheckTasks by child answers nothing and by root the task, and getChildAssignment the settled task',
    config: { options: { onRequiredCheckReceipt: () => undefined } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('waived', { dispatchGroupId: 'msg_objective', requiredChecks: [CHECK, LINT_CHECK, EDGE_CHECK] })));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      const recheck = d.hook('recheck', { mode: 'auto', answer: () => undefined });
      await d.step(d.control(start, 'setChildSessionId', 'ses_child_waived'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, lintReceipt(), 'start'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, lintReceipt({ messageId: 'msg_lint' }), 'bind'));
      await d.step(d.call('recordRequiredChecks', taskId, leaseToken, [lintReceipt({ messageId: 'msg_other', status: 'passed', exitCode: 0, contentHash: 'b'.repeat(64) })], 'complete'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, lintReceipt({ messageId: 'msg_other' }), 'bind'));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, receipt(), 'start'));
      await d.step(d.call('waiveRequiredChecks', taskId, [WAIVED_RECEIPT], { [USER_CHECK_WAIVER]: true, recheck }));
      await d.step(d.call('recordRequiredCheck', taskId, leaseToken, receipt({ messageId: 'msg_check' }), 'bind'));
      await d.step(d.call('correctRequiredCheck', taskId, EDGE_CORRECTION, { [REQUIRED_CHECK_CORRECTION]: true, rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'msg_objective', recheck }));
      await d.step(d.call('getRequiredCheckTask', 'ses_child_waived', '/workspace'));
      await d.step(d.call('childAttempt', 'ses_child_waived', '/workspace'));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.answer(start, completed));
      await d.step(d.call('getRequiredCheckTasks', 'ses_child_waived', '/workspace'));
      await d.step(d.call('getRequiredCheckTasks', 'ses_root', '/workspace'));
      await d.step(d.call('getChildAssignment', 'ses_child_waived', '/workspace'));
      await d.step(d.call('childAttempt', 'ses_child_waived', '/workspace'));
      await d.step(d.call('childAttempt', 'ses_child_unknown', '/workspace'));
      const objective = { rootSessionId: 'ses_root', directory: '/workspace', objectiveId: 'objective-waived' };
      await d.step(d.call('declareObjectiveChecks', objective, [CHECK], [], d.hook('authorize', { mode: 'auto', answer: () => undefined })));
      await d.step(d.call('recordRequiredCheck', objective, null, receipt({ callId: 'call_objective' }), 'start'));
      await d.step(d.call('getObjectiveRequiredChecks', objective));
    },
  },
  {
    name: 'dispatch-barrier-states',
    purpose: 'inspectDispatchBarrier through a group\'s life, and a handoff of a result not yet collected: two grouped tasks running (active, both), one completed (active, the other), both completed (awaiting_acknowledgement, both), one collected (awaiting_acknowledgement, the other); inspectAgentHandoff then requires confirmation for the uncollected one, confirmAgentHandoff abandons it without an abort and settles clear, and the barrier is clear',
    async run(d) {
      await boot(d);
      await d.step(...range(2).map((index) => d.call('submit', taskInput(`grouped-${index}`, { dispatchGroupId: 'msg_dispatch_01' }))));
      const [first, second] = starts(d);
      await acceptAll(d);
      const inspect = () => d.call('inspectDispatchBarrier', 'ses_root');
      await d.step(inspect());
      await d.step(d.call('waitForDispatchBarrier', 'ses_root'));
      await d.step(d.answer(first, completed));
      await d.step(inspect());
      await d.step(d.answer(second, completed));
      await d.step(inspect());
      await d.step(d.call('acknowledgeResult', first.args[0].taskId, { action: 'collect', idempotencyKey: 'collect-grouped-1' }));
      await d.step(inspect());
      await d.step(d.call('inspectAgentHandoff', HANDOFF));
      await d.step(d.call('confirmAgentHandoff', { ...HANDOFF, idempotencyKey: 'switch-01' }));
      await d.step(inspect());
      await d.step(d.call('getSnapshot'));
    },
  },
  {
    name: 'persistence-stall-deadline',
    purpose: 'The stall watch against a task deadline: the queued save of a submit whose deadline is 1,500 ms on is held under a 1,000 ms stall watch; at +600 a completed onProgress phase moves the progress mark, so the watch is re-armed for the deadline (+1500, before the stall at +1600); at the deadline it reports needs_attention with reason task_deadline; the answer then reports it settled, and the deadline, already passed, ends the task',
    config: { options: { persistenceStallMs: 1_000, onPersistenceObservation: () => undefined }, ports: { 'persistence.save': { mode: (entry) => (entry.index === 2 ? 'hold' : 'auto') } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('due', { timeoutAt: d.time + 1_500 })));
      const [held] = d.pending('persistence.save');
      if (!held) throw new Error('persistence-stall-deadline: the queued save was not held');
      await d.step(d.call('flush'));
      await d.advance(600);
      await d.step(d.callback(held, '1.onProgress', { phase: 'write', state: 'completed' }));
      await d.advance(900);
      await d.step(d.answer(held, undefined));
      await d.advance(1);
    },
  },
  {
    name: 'provider-recovery-expiry',
    purpose: 'Provider recovery continuation claims over time: a grouped task fails resumable at +0 and is retried in place at +1000, its follow-up in the same child session; once the follow-up completes it is listed ready for that child session, and getChildAssignment answers the later of the child\'s two settled tasks; a claim at +1000 lasts 60,000 ms: at its expiry another claimant takes it over, verifyRecoveredCollection answers that claimant until its own claim expires at +121000 and nothing after; listResultEnvelopes then lists both results',
    async run(d) {
      await boot(d);
      const submitted = await d.step(d.call('submit', taskInput('recovering', { dispatchGroupId: 'msg_recovery_01' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], { status: 'failed', failureReason: 'harness failure', partial: true, recoverablePreview: 'half', canonicalRefs: [], resumable: true }));
      await d.advance(1_000);
      const source = submitted.value?.taskId;
      const acknowledged = await d.step(d.call('acknowledgeResult', source, { action: 'retry_in_place', idempotencyKey: 'recover-1', providerId: 'github-copilot', modelId: 'gpt-4.1', variant: null }));
      const [inPlace] = d.pending('executor.retryInPlace');
      if (!inPlace) throw new Error('provider-recovery-expiry: the retry in place was not launched');
      await d.step(d.control(inPlace, 'markAccepted'));
      await d.step(d.answer(inPlace, completed));
      const followUp = acknowledged.value?.followUpTask?.taskId;
      const claim = (claimantId) => ({ taskId: followUp, rootSessionId: 'ses_root', directory: '/workspace', claimantId });
      await d.step(d.call('listReadyProviderRecoveryContinuations', { sessionId: 'ses_child_1' }));
      await d.step(d.call('getChildAssignment', 'ses_child_1', '/workspace'));
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-1')));
      await d.advance(MINUTE);
      await d.step(d.call('claimProviderRecoveryContinuation', claim('claimant-2')));
      await d.step(d.call('verifyRecoveredCollection', claim('claimant-2')));
      await d.advance(MINUTE);
      await d.step(d.call('verifyRecoveredCollection', claim('claimant-2')));
      await d.step(d.call('releaseProviderRecoveryContinuation', claim('claimant-2')));
      await d.step(d.call('listResultEnvelopes', { rootSessionId: 'ses_root' }));
    },
  },
  {
    name: 'provider-recovery-unlinked',
    purpose: 'verifyRecoveredCollection on a loaded ledger whose recovery source names another follow-up than the completed retry in place that names it: the follow-up is listed ready and claimed, but nothing verifies (the link is checked both ways); the claim is released',
    config: { load: UNLINKED_LEDGER },
    async run(d) {
      await boot(d, this.config);
      const claim = { taskId: RECOVERY_FOLLOW_UP.taskId, rootSessionId: 'ses_root', directory: '/workspace', claimantId: 'claimant-1' };
      await d.step(d.call('listReadyProviderRecoveryContinuations', {}));
      await d.step(d.call('claimProviderRecoveryContinuation', claim));
      await d.step(d.call('verifyRecoveredCollection', claim));
      await d.step(d.call('releaseProviderRecoveryContinuation', claim));
    },
  },
  {
    name: 'auto-resume-child-cancel',
    purpose: 'The automatic resume cancelled by the child session and re-enabled at its time cap: a result parked on a provider usage limit at +0 plans its resume; cancelAutoResumeForSession for its child session (not its root) cancels it; at exactly the lineage\'s time cap, 6 h on, setResultAutoResume enabling it again finds it expired (exhausted, time_cap) and plans nothing',
    async run(d) {
      const resetAt = d.time + 30 * MINUTE;
      await boot(d, { options: { autoResume: { resolveOwnerKey: () => 'owner-a', resolveBackupExecution: () => null, resolveProviderReset: () => ({ resetAt, limited: true }), attempt: () => undefined } }, ports: { 'autoResume.attempt': { mode: 'hold' } } });
      const submitted = await d.step(d.call('submit', taskInput('parked', { dispatchGroupId: 'msg_parent', providerId: 'anthropic', modelId: 'claude-opus' })));
      await acceptAll(d);
      await d.step(d.answer(starts(d)[0], { status: 'failed', failureReason: LIMIT, partial: true, recoverablePreview: 'partial work', canonicalRefs: [], resumable: true, providerResetAt: resetAt }));
      const taskId = submitted.value?.taskId;
      await d.step(d.call('cancelAutoResumeForSession', 'ses_child_1', 'cancelled'));
      const envelope = await d.step(d.call('getResultEnvelope', taskId));
      const expiresAt = envelope.value?.autoResume?.expiresAt;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= d.time) throw new Error('auto-resume-child-cancel: no time cap ahead');
      await d.advance(expiresAt - d.time);
      await d.step(d.call('setResultAutoResume', taskId, { enabled: true }));
    },
  },
  {
    name: 'operator-stop-read',
    purpose: 'readOperatorStop and withdrawOperatorStop around an accepted stop: a recorded stop is not read with an `after` past its request and is read (pending) with `after` at it; acceptOperatorStop accepts it; readOperatorStop then reads it accepted, and withdrawOperatorStop of an accepted stop is refused; the accepted stop\'s reconciliation retry then settles the task',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('stopped')));
      await acceptAll(d, starts(d), () => 'ses_stop_child');
      const recorded = await d.step(d.call('recordOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace', requestedAt: d.time, requestId: 'stop_harness_1' }));
      const stop = { taskId: recorded.value?.taskId, leaseToken: recorded.value?.leaseToken, requestedAt: recorded.value?.requestedAt, requestId: 'stop_harness_1' };
      const read = (after) => d.call('readOperatorStop', { sessionId: 'ses_stop_child', directory: '/workspace', after });
      await d.step(read(stop.requestedAt + 1));
      await d.step(read(stop.requestedAt));
      await d.step(d.call('acceptOperatorStop', stop));
      await d.step(read(stop.requestedAt));
      await d.step(d.call('withdrawOperatorStop', stop));
      await d.advance(1_000);
    },
  },
  {
    name: 'designer-step-budget-next-prompt',
    purpose: 'The designer step budget across two prompts: two prompts accepted with one creation time (the second is not older than the first, so it is accepted); the first prompt\'s steps counted once each though its history repeats one (2); the first step of the second prompt counts afresh (181 with its 180 historical steps); the warning names the 181 steps; once the task completed, readPrimaryStepBudget answers nothing',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('designed', { agent: 'designer' })));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      const base = { taskId, leaseToken, sessionId: 'ses_child_designer', directory: '/workspace' };
      await d.step(d.control(start, 'setChildSessionId', 'ses_child_designer'));
      await d.step(d.call('acceptPrimaryPrompt', { ...base, createdAt: d.time, userMessageId: 'msg_user_1' }));
      await d.step(d.call('acceptPrimaryPrompt', { ...base, createdAt: d.time, userMessageId: 'msg_user_2' }));
      const repeated = [{ messageId: 'msg_step_a', createdAt: d.time }, { messageId: 'msg_step_a', createdAt: d.time }];
      await d.step(d.call('recordPrimaryStep', { ...base, createdAt: d.time, userMessageId: 'msg_user_1', messageId: 'msg_step_b', historicalSteps: repeated }));
      const history = range(180).map((index) => ({ messageId: `msg_history_${String(index).padStart(3, '0')}`, createdAt: d.time }));
      await d.step(d.call('recordPrimaryStep', { ...base, createdAt: d.time, userMessageId: 'msg_user_2', messageId: 'msg_step_181', historicalSteps: history }));
      await d.step(d.control(start, 'markAccepted'));
      await d.step(d.call('claimPrimaryStepBudgetWarning', { ...base, messageId: 'msg_step_181' }));
      await d.step(d.answer(start, completed));
      await d.step(d.control(start, 'readPrimaryStepBudget'));
    },
  },
  {
    name: 'waits-time-out',
    purpose: 'The waits that end without what they wait for, and one that waits past a change: waitForAnyTask and waitForResultCommit with 1,000 ms timeouts answer their snapshots when their timers fire; waitForAnyTask until settled on two tasks is not answered when one completes (a ready result, no attention) and is answered when the second does; waitForResultAction on an uncollected result waits and rejects when its signal aborts; listResultEnvelopes lists both results',
    async run(d) {
      await boot(d);
      const [first, second] = await d.step(d.call('submit', taskInput('wait-a')), d.call('submit', taskInput('wait-b')));
      const [a, b] = [first.value?.taskId, second.value?.taskId];
      await acceptAll(d);
      const [startA, startB] = starts(d);
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [a], timeoutMs: 1_000 }));
      await d.step(d.call('waitForResultCommit', { directory: '/workspace', timeoutMs: 1_000 }));
      await d.advance(1_000);
      await d.step(d.call('waitForAnyTask', { rootSessionId: 'ses_root', taskIds: [a, b], until: 'settled' }));
      await d.step(d.answer(startA, completed));
      await d.step(d.answer(startB, completed));
      const controller = new AbortController();
      await d.step(d.call('waitForResultAction', a, { signal: controller.signal }));
      await d.step(d.abort(controller, new Error('harness: action wait aborted'), 'action signal'));
      await d.step(d.call('listResultEnvelopes', { rootSessionId: 'ses_root' }));
    },
  },
  {
    name: 'native-prompt-context-fenced',
    purpose: 'Native dispatch verification during a cancellation, and prompt contexts that cannot open: while a running task\'s cancellation waits on its abort, verifyTaskDispatch refuses it (native_managed_task_lease_invalid) and verifyTaskSettlement still answers it; withNativePromptContext is fenced for a root with tasks in two directories (native_prompt_context_fenced) and unavailable for an empty directory (native_prompt_context_unavailable), each after one authorize',
    config: { ports: { 'executor.abort': { mode: 'hold' } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('cancelled')));
      const [start] = starts(d);
      const { taskId, leaseToken } = start.args[0];
      await acceptAll(d);
      await d.step(d.call('verifyTaskDispatch', taskId, leaseToken));
      await d.step(d.call('cancelTask', taskId));
      const [abort] = d.pending('executor.abort');
      if (!abort) throw new Error('native-prompt-context-fenced: the abort was not pending');
      await d.step(d.call('verifyTaskDispatch', taskId, leaseToken));
      await d.step(d.call('verifyTaskSettlement', taskId, leaseToken));
      await d.step(d.answer(abort, { aborted: true }));
      await d.step(d.call('submit', taskInput('split-a', { rootSessionId: 'ses_split' })));
      await d.step(d.call('submit', taskInput('split-b', { rootSessionId: 'ses_split', directory: '/elsewhere' })));
      const authorize = d.hook('authorize', { mode: 'auto', answer: () => undefined });
      await d.step(d.call('withNativePromptContext', { rootSessionId: 'ses_split', directory: '/workspace', authorize }, d.hook('promptAction')));
      await d.step(d.call('withNativePromptContext', { rootSessionId: 'ses_root', directory: '', authorize }, d.hook('promptAction')));
    },
  },
  {
    name: 'native-prompt-context-refusals',
    purpose: 'withNativePromptContext when its caller\'s checks fail, around a completed task: authorize rejecting before the context opens (the call rejects with that error, the action is never called); an action that rejects (its error, no further authorize, nothing saved); authorize rejecting after the action marked the prompt observed (nothing saved); the observation\'s save failing (the envelope put back, the call rejects with the save\'s error), so a later context saves nothing and the collect\'s save holds the result without the observation',
    config: { ports: { 'persistence.save': { mode: 'auto', answer: (entry) => (entry.args[0]?.resultEnvelopes?.some((envelope) => envelope.promptObserved) ? { $reject: Object.assign(new Error('harness: save refused'), { code: 'harness_save_refused' }) } : undefined) } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('context')));
      const [start] = starts(d);
      const { taskId } = start.args[0];
      await acceptAll(d);
      await d.step(d.answer(start, completed));
      const scope = { rootSessionId: 'ses_root', directory: '/workspace', authorize: d.hook('authorize', { mode: 'hold' }) };
      const pendingOne = (port) => {
        const [entry, more] = d.pending(port);
        if (!entry || more) throw new Error(`native-prompt-context-refusals: not one ${port} pending`);
        return entry;
      };
      const refused = () => Object.assign(new Error('harness: root revoked'), { code: 'harness_root_revoked' });
      const open = async () => { await d.step(d.call('withNativePromptContext', scope, d.hook('promptAction'))); await d.step(d.answer(pendingOne('authorize'), undefined)); return pendingOne('promptAction'); };
      await d.step(d.call('withNativePromptContext', scope, d.hook('promptAction')));
      await d.step(d.answer(pendingOne('authorize'), refused(), 'reject'));
      const failing = await open();
      await d.step(d.answer(failing, Object.assign(new Error('harness: action failed'), { code: 'harness_action_failed' }), 'reject'));
      const revoked = await open();
      const sequence = revoked.args[0].envelopes[0]?.sequence;
      await d.step(d.callback(revoked, '0.markPromptObserved', { taskId, attempt: 1, sequence }));
      await d.step(d.answer(revoked, 'observed'));
      await d.step(d.answer(pendingOne('authorize'), refused(), 'reject'));
      const unsaved = await open();
      await d.step(d.callback(unsaved, '0.markPromptObserved', { taskId, attempt: 1, sequence }));
      await d.step(d.answer(unsaved, 'observed'));
      await d.step(d.answer(pendingOne('authorize'), undefined));
      const after = await open();
      await d.step(d.answer(after, 'read'));
      await d.step(d.answer(pendingOne('authorize'), undefined));
      // The next save holds the envelope as it was put back: without the observation whose save failed.
      await d.step(d.call('acknowledgeResult', taskId, { action: 'collect', idempotencyKey: 'collect-context' }));
    },
  },
  {
    name: 'retry-transport-recovery',
    purpose: 'control.recordTransportRecovery against what it recorded: a first attempt (readPriorFailureReason: none) records revision 1 with its backup attempt spent; revision 2 that gives the backup attempt back is refused inside the lock (TypeError, nothing saved); revision 2 that keeps it spent is recorded (the same-model count is always 1: transport-recovery.js)',
    async run(d) {
      await boot(d);
      await d.step(d.call('submit', taskInput('transport')));
      const [start] = starts(d);
      await d.step(d.control(start, 'readPriorFailureReason'));
      await d.step(d.control(start, 'recordTransportRecovery', transportRecovery(1, { backupAttempts: 1 }), 0));
      await d.step(d.control(start, 'recordTransportRecovery', transportRecovery(2, { backupAttempts: 0 }), 1));
      await d.step(d.control(start, 'recordTransportRecovery', transportRecovery(2, { backupAttempts: 1, phase: 'submitted', submittedAt: EPOCH }), 1));
    },
  },
  {
    name: 'prerequisites-assert-cancelled',
    purpose: 'control.assertPrerequisites refused by its final fence: while its recheck of the prerequisites is held the task is cancelled (its abort held); the recheck then answers true and the assertion rejects task_lease_stale, the task being cancelled; the abort then settles the task',
    config: { options: { verifyTaskPrerequisites: () => true }, ports: { verifyTaskPrerequisites: { mode: (entry) => (entry.index === 3 ? 'hold' : 'auto'), answer: () => true }, 'executor.abort': { mode: 'hold' } } },
    async run(d) {
      await boot(d, this.config);
      await d.step(d.call('submit', taskInput('asserted', { taskPrerequisites: PREREQUISITE })));
      const [start] = starts(d);
      await d.step(d.control(start, 'assertPrerequisites'));
      const [recheck] = d.pending('verifyTaskPrerequisites');
      if (!recheck) throw new Error('prerequisites-assert-cancelled: the recheck was not held');
      await d.step(d.call('cancelTask', start.args[0].taskId));
      await d.step(d.answer(recheck, true));
      const [abort] = d.pending('executor.abort');
      if (!abort) throw new Error('prerequisites-assert-cancelled: the abort was not pending');
      await d.step(d.answer(abort, { aborted: true }));
    },
  },
];
const HANDOFF = Object.freeze({ rootSessionId: 'ses_root', fromMode: 'orchestrator', toMode: 'builder' });
// handoff-clear: the held task's prerequisites verify from this call on, and this save (its admission in the pump
// after the handoff lock) is refused. Both read from a run of today's scheduler.
const HANDOFF_READY_FROM = 4;
const HANDOFF_FAILED_SAVE = 18;
const CHECK = Object.freeze({ name: 'unit', command: 'bun test', paths: ['src/a.js'] });
/** required-checks: a receipt of CHECK as recorded at start (overrides for bind and complete). */
const receipt = (overrides = {}) => ({ name: 'unit', callId: 'call_unit', messageId: null, status: 'not-observed', exitCode: null, contentHash: null, observedAt: EPOCH, ...overrides });
/** required-checks-waived: a second command check, a check the host runner corrects (check-correction.js), the user's waiver of unit and the correction. */
const LINT_CHECK = Object.freeze({ name: 'lint', command: 'bun run lint', paths: ['src/a.js'] });
const lintReceipt = (overrides = {}) => receipt({ name: 'lint', callId: 'call_lint', ...overrides });
const EDGE_CHECK = Object.freeze({ name: 'edge', command: 'npx vitest run supabase/functions/booking-documents/__tests__', paths: ['supabase/functions/booking-documents'] });
const WAIVED_RECEIPT = Object.freeze({ ...receipt(), status: 'waived', contentHash: 'c'.repeat(64), waiver: { source: 'authenticated-user', userId: 'user_harness', reason: 'The harness user waives the unit check.' } });
const EDGE_CORRECTION = Object.freeze({
  name: 'edge', previousCommand: EDGE_CHECK.command, command: 'npm run test:edge -- --function booking-documents', reason: 'repository_edge_deno_runner', observedAt: EPOCH,
  runnerIdentity: { kind: 'edge-deno-function-v1', packagePath: 'package.json', packageSha256: 'd'.repeat(64), scriptPath: 'scripts/testing/run-deno-tests.mjs', scriptSha256: 'e'.repeat(64), functionName: 'booking-documents', selector: '--function', testPath: 'supabase/functions/booking-documents/__tests__', coverageHash: 'f'.repeat(64), verifiedBy: 'host-policy' },
});
/** retry-reads-prior-failure, retry-transport-recovery: a transport recovery receipt at `revision`. */
const transportRecovery = (revision, overrides = {}) => ({ revision, phase: 'reserved', kind: 'request_timeout', sameModelAttempts: 1, backupAttempts: 0, failedMessageId: 'msg_failed', failedUserMessageId: null, recoveryMessageId: 'msg_recovery', eventId: null, reservedAt: EPOCH, submittedAt: null, ...overrides });
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
  // The pump verifies the prerequisites (step 5) and launch rechecks them (:1767, step 7) before executor.start; each
  // assertPrerequisites while starting runs assertLaunchPrerequisites (:1274-1283), so verifies once more (9, 11), the second
  // time false; once running it skips the recheck (:1278) and resolves; once terminal it rejects task_lease_stale (:1277).
  'prerequisites-assert-at-launch': {
    steps: 20,
    clock: ['+0 1-20'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4 6 13 15 18', publishEvent: '5 7 14 16 19', verifyTaskPrerequisites: '5 7 9 11', 'executor.start': '8' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5 7 14 16 19', verifyTaskPrerequisites: '6 8 10 12', 'executor.start': '18' },
    launches: ['asserted @8 after 3'],
    timers: { '300000 at +0 cleared +0': 6, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.assertPrerequisites resolved', 'control.assertPrerequisites rejected task_prerequisites_unverified', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'control.assertPrerequisites resolved', 'control.assertPrerequisites rejected task_lease_stale'],
    final: { completed: 'asserted' },
  },
  // Instance 1 admits the task at +0 (its startedAt) and crashes at +1000 on the save of recordProgress (save 4, :1310-1348).
  // Instance 2 reconciles the loaded starting task (step 10, answered transient: the 1,000 ms retry, :1914-1937), then
  // arms its deadline and its lease (:2374-2375, in that order): the deadline from timeoutAt (599,000 ms, :2141), the
  // lease from startedAt (500 ms, :2125); the lease fires at +1500 (reconcile 12), the retry at +2000 (reconcile 13); the
  // first transient answer arms the retry again, the second finds it armed (:1916) and arms none (one 1,000 ms timer at
  // +2000); the retry at +3000 reconciles terminal: markAccepted and the completed save (:1856-1859).
  'restart-starting-lease-retry': {
    steps: 19,
    clock: ['+0 1-6', '+1000 7-11', '+1500 12', '+2000 13-15', '+3000 16-19'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7', publishEvent: '5-6', 'executor.start': '6', 'i2 persistence.load': '8', 'i2 persistence.save': '9 17-18', 'i2 executor.reconcile': '10 12-13 16', 'i2 publishEvent': '18-19' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6', 'i2 persistence.load': '9', 'i2 persistence.save': '10 18-19', 'i2 executor.reconcile': '11 14-15 17' },
    launches: ['lease-restart @6 after 3'],
    timers: { '300000 at +0 cleared +0': 3, '600000 at +0 live': 1, '1500 at +0 live': 1, '300000 at +1000 live': 1, 'i2 300000 at +1000 cleared +1000': 1, 'i2 1000 at +1000 fired +2000': 1, 'i2 599000 at +1000 cleared +3000': 1, 'i2 500 at +1000 fired +1500': 1, 'i2 1000 at +2000 fired +3000': 1, 'i2 300000 at +3000 cleared +3000': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.recordProgress pending', 'i2 initialize resolved'],
    final: { completed: 'lease-restart' },
    restart: { crashedAfterSave: 4, portsAfterIt: [], loads: 'save 4' },
  },
  // readPriorFailureReason is synchronous (:1231-1235): null for the first attempt, the source's failureReason for its
  // retry; recordTransportRecovery commits a same-status update at revision 1 (:1236-1255, the save in step 18), refuses a stale
  // expected revision (false), throws on a skipped revision before the lock, and answers false for a terminal task.
  'retry-reads-prior-failure': {
    steps: 22,
    clock: ['+0 1-22'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 8 10 12 14-15 18', publishEvent: '5-6 9 11 13 15x2 16 19', 'executor.start': '6 16' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 9 11 13 15-16 19', 'executor.start': '12' },
    launches: ['prior @6 after 3', 'prior @16 after 8'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 1, '60000 at +0 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.readPriorFailureReason returned', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.readPriorFailureReason returned harness failure', 'control.recordTransportRecovery resolved true', 'control.recordTransportRecovery resolved false', 'control.recordTransportRecovery rejected TypeError', 'control.recordTransportRecovery resolved false'],
    final: { failed: 'prior', starting: 'prior' },
  },
  // confirmAgentHandoff (:3899-3979): the three calls of step 22 resume in order; the second finds the lock with its own
  // key and awaits the first's promise, the third is handoff_conflict (:3905-3910). Each grouped task is aborted
  // (cancelTaskForAgentHandoff, :2730-2818) and abandoned; the held task's prerequisites re-save its hold as the active
  // count falls. The pump in the finally (:3972) verifies it ready (its fourth call, step 34); its admission save (the
  // 18th, called in step 35) is refused in step 36: logger.error there (:3973). The pump threw before it could clear the
  // 1,000 ms admission retry (:2086-2087), so the retry at +1000 admits and launches it.
  'handoff-clear': {
    steps: 41,
    clock: ['+0 1-37', '+1000 38-41'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2', '22: call confirmAgentHandoff x3'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 15 17 24 26-27 30 32-33 35 39', publishEvent: '5-8 10-11 13-14 16 18 25 27-28 31 33-34 40', 'executor.start': '8x2 41', verifyTaskPrerequisites: '16 25 31 34 38 40', 'executor.getLastRecoverableResult': '22 28', 'executor.abort': '22 28', 'executor.readRecoverableResult': '23 29', 'logger.error': '36' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 16 18 25 27-28 31 33-34 40 rejected 36', verifyTaskPrerequisites: '17 26 32 35 39 41', 'executor.abort': '23 29', 'executor.readRecoverableResult': '24 30' },
    launches: ['grouped-1..2 @8 after 5', 'held @41 after 19'],
    timers: { '300000 at +0 cleared +0': 18, '60000 at +0 cleared +0': 2, '1000 at +0 fired +1000': 1, '5000 at +0 cleared +0': 2, '300000 at +1000 cleared +1000': 1, '60000 at +1000 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'submit resolved queued', 'inspectAgentHandoff resolved <object>', 'inspectAgentHandoff rejected invalid_handoff_scope', 'confirmAgentHandoff rejected missing_idempotency_key', 'confirmAgentHandoff resolved <object> x2', 'confirmAgentHandoff rejected handoff_conflict', 'inspectAgentHandoff resolved <object>'],
    final: { aborted: 'grouped-1..2', starting: 'held' },
  },
  // The first abort never answers: the 5,000 ms race (:2577-2596) fires at +5000, aborts its signal, and
  // cancelTaskForAgentHandoff throws handoff_abort_unconfirmed (:2783-2788), a cleanup failure; the second task is aborted
  // and abandoned; the handoff resolves (blocked) and inspectAgentHandoff still lists the running first task.
  'handoff-abort-timeout': {
    steps: 21,
    clock: ['+0 1-15', '+5000 16-21'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 18-19', publishEvent: '5-8 10-11 13-14 19-20', 'executor.start': '8x2', 'executor.getLastRecoverableResult': '15-16', 'executor.abort': '15-16', 'executor.readRecoverableResult': '17' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 19-20', 'executor.abort': '17', 'executor.readRecoverableResult': '18' },
    launches: ['grouped-1..2 @8 after 5'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 2, '5000 at +0 fired +5000': 1, '5000 at +5000 cleared +5000': 1, '300000 at +5000 cleared +5000': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'confirmAgentHandoff resolved <object>', 'inspectAgentHandoff resolved <object>'],
    final: { aborted: 'grouped-2', running: 'grouped-1' },
  },
  // withRuntimeRestart (:3302-3355) reconciles the running task terminal (step 11) and commits it (the 6th save), whose run
  // cleanup (:867) calls stopAttemptRuns (held, step 13) after the lock; replacementStarted, the action is called (13).
  // The cleanup answer's save (the 7th) is torn; instance 2 loads save 6 (cleanup pending), re-arms it at 0 ms (:2383; fires at
  // +1, the platform clamp) and stops the runs again (onRunCleanup, step 20).
  'runtime-restart-crash': {
    steps: 20,
    clock: ['+0 1-17', '+1 18-20'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 12 14', publishEvent: '5-6 8 10 13', 'executor.start': '6', 'executor.reconcile': '11', stopAttemptRuns: '13', restartAction: '13', 'i2 persistence.load': '15', 'i2 persistence.save': '16 19', 'i2 stopAttemptRuns': '18', 'i2 publishEvent': '20', 'i2 onRunCleanup': '20' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 13', 'executor.reconcile': '12', stopAttemptRuns: '14', 'i2 persistence.load': '16', 'i2 persistence.save': '17 20', 'i2 stopAttemptRuns': '19' },
    launches: ['replaced @6 after 3'],
    timers: { '300000 at +0 cleared +0': 6, '60000 at +0 cleared +0': 1, '300000 at +0 live': 1, 'i2 300000 at +0 cleared +0': 1, 'i2 0 at +0 fired +1': 1, 'i2 300000 at +1 cleared +1': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'withRuntimeRestart pending', 'i2 initialize resolved'],
    final: { completed: 'replaced' },
    restart: { crashedAfterSave: 7, portsAfterIt: [], loads: 'save 6' },
  },
  // The stop is recorded at +0 (the 6th save); at +2000 the save of recordProgress (the 7th) lands and the process dies.
  // Instance 2 arms the expiry for what is left of abortTimeoutMs from requestedAt (3,000 ms, :2353, :2176), reconciles the
  // task (unavailable, default) but finishTask returns while the stop is pending (:1140); the right withdrawal saves (step
  // 22), clears the expiry and arms the reconciliation retry (:4187), which at +3000 settles the task interrupted.
  'operator-stop-restart': {
    steps: 29,
    clock: ['+0 1-12', '+2000 13-25', '+3000 26-29'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13', publishEvent: '5-6 8 10 12', 'executor.start': '6', 'i2 persistence.load': '14', 'i2 persistence.save': '15 22 28', 'i2 executor.reconcile': '16 26', 'i2 executor.readRecoverableResult': '17 27', 'i2 publishEvent': '23 29' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12', 'i2 persistence.load': '15', 'i2 persistence.save': '16 23 29', 'i2 executor.reconcile': '17 27', 'i2 executor.readRecoverableResult': '18 28' },
    launches: ['stopped @6 after 3'],
    timers: { '300000 at +0 cleared +0': 6, '60000 at +0 cleared +0': 1, '5000 at +0 live': 1, '300000 at +2000 live': 1, 'i2 300000 at +2000 cleared +2000': 2, 'i2 3000 at +2000 cleared +2000': 1, 'i2 1000 at +2000 fired +3000': 1, 'i2 300000 at +3000 cleared +3000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'recordOperatorStop resolved <object>', 'control.recordProgress pending', 'i2 initialize resolved', 'i2 readOperatorStop returned <object>', 'i2 readOperatorStop returned', 'i2 withdrawOperatorStop resolved false', 'i2 withdrawOperatorStop resolved true', 'i2 readOperatorStop returned', 'i2 acceptOperatorStop resolved false'],
    final: { interrupted: 'stopped' },
    restart: { crashedAfterSave: 7, portsAfterIt: [], loads: 'save 7' },
  },
  // verifyTaskDispatch and verifyTaskSettlement run in the lock (:4379-4389, :4432-4444); getTask of an unknown task is
  // null (cloneTask(undefined)). withNativePromptContext (:4451-4499) calls authorize (18), the action (19); readBarrier
  // authorizes again (20); a stale markPromptObserved throws synchronously (:4480-4483); the action's answer authorizes a
  // third time (step 24) and saves once (25).
  'native-prompt-context': {
    steps: 27,
    clock: ['+0 1-27'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 12 14 16 25', publishEvent: '5-6 13 15 17', 'executor.start': '6', authorize: '18 20 24', promptAction: '19' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 13 15 17 26', 'executor.start': '16', authorize: '19 21 25', promptAction: '24' },
    launches: ['context @6 after 3'],
    timers: { '300000 at +0 cleared +0': 7, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'verifyTaskDispatch resolved starting', 'verifyTaskDispatch rejected native_managed_task_lease_invalid', 'verifyTaskSettlement resolved starting', 'verifyTaskSettlement rejected native_managed_task_lease_invalid', 'getTask returned', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'withNativePromptContext resolved observed', 'callback.readBarrier resolved <object>', 'callback.markPromptObserved threw native_prompt_context_revision_conflict', 'callback.markPromptObserved returned', 'callback.readBarrier rejected native_prompt_context_fenced'],
    final: { completed: 'context' },
  },
  // The retry in place (:3568-3578, :3616-3657) launches executor.retryInPlace (step 15); once completed the follow-up
  // is ready (:3133-3170). Claims and releases (:3186-3238) save nothing; the claim lasts 60,000 ms
  // (providerRecoveryContinuationLeaseMs); verifyRecoveredCollection (:3240-3259) needs the claimant's live claim.
  'provider-recovery-continuation': {
    steps: 32,
    clock: ['+0 1-32'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13-14 16 18', publishEvent: '5-6 8 10 12 14x2 15 17 19', 'executor.start': '6', 'executor.retryInPlace': '15' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14-15 17 19', 'executor.start': '11', 'executor.retryInPlace': '18' },
    launches: ['recovering @6 after 3', 'retryInPlace recovering @15 after 8'],
    timers: { '300000 at +0 cleared +0': 10, '60000 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'listReadyProviderRecoveryContinuations returned <array 1>', 'listReadyProviderRecoveryContinuations returned <array 0>', 'claimProviderRecoveryContinuation resolved <object> x2', 'claimProviderRecoveryContinuation rejected invalid_recovery_continuation_claim', 'claimProviderRecoveryContinuation rejected task_not_found', 'claimProviderRecoveryContinuation rejected task_scope_mismatch', 'verifyRecoveredCollection resolved', 'verifyRecoveredCollection resolved <object>', 'releaseProviderRecoveryContinuation resolved <object> x2', 'verifyRecoveredCollection resolved', 'claimProviderRecoveryContinuation resolved <object>'],
    final: { completed: 'recovering', failed: 'recovering' },
  },
  // The usage-limit failure parks the result (a 0 ms planning timer); disabling clears it and saves (:3748-3751), the
  // second disable is unchanged (:3745-3746, no save), enabling saves and arms a 0 ms planning timer (:3775-3776), which
  // cancelAutoResumeForSession clears (:3798); the second cancel finds nothing active.
  'auto-resume-opt-out': {
    steps: 25,
    clock: ['+0 1-25'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11-12 16 19 23', publishEvent: '5-6 8 10 12-13 17 20 24', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12-13 17 20 24', 'executor.start': '11' },
    launches: ['parked @6 after 3'],
    timers: { '300000 at +0 cleared +0': 10, '60000 at +0 cleared +0': 1, '0 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'setResultAutoResume rejected invalid_auto_resume_request', 'setResultAutoResume rejected result_not_found', 'setResultAutoResume resolved <object> x3', 'cancelAutoResumeForSession rejected missing_session_id', 'cancelAutoResumeForSession rejected invalid_auto_resume_reason', 'cancelAutoResumeForSession resolved <object> x2'],
    final: { failed: 'parked' },
  },
  // Save 2 is held: its stall watch (persistenceStallMs 1,000, :569-574) is re-armed by the completed onProgress
  // (:581-584), not by the started one or an unknown phase (:578); at +1000 it reports needs_attention and warns
  // (:557-568); the answer reports settled (:592). The first publication throws (logger.warn, :417-426); onBarrierChange
  // sees the group active (:431-439); onMutationTiming is called for every mutation, the two refused releases failed.
  'persistence-observation': {
    steps: 12,
    clock: ['+0 1-7', '+1000 8-12'],
    groups: [],
    ports: { 'persistence.load': '1', onMutationTiming: '2 3x2 9-12', 'persistence.save': '2 4 9', onPersistenceObservation: '8-9', 'logger.warn': '8-9', onBarrierChange: '9', publishEvent: '9-10', 'executor.start': '10' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 9-10' },
    launches: ['observed @10 after 3'],
    timers: { '1000 at +0 cleared +0': 2, '1000 at +0 fired +1000': 1, '1000 at +1000 cleared +1000': 1, '60000 at +1000 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'callback.onProgress returned x3', 'releaseModeLease rejected mode_lease_conflict', 'releaseModeLease rejected mode_lease_active'],
    final: { starting: 'observed' },
  },
  // acceptPrimaryPrompt saves once (:4210-4235), a repeat is true without a save, a wrong lease null; recordPrimaryStep
  // saves 180 steps (:4237-4267); the warning (DESIGNER_PRIMARY_STEP_WARNING 180) is claimed only while running (:4273)
  // and only once (:4277).
  'designer-step-budget': {
    steps: 23,
    clock: ['+0 1-23'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 8 10 14 19 21', publishEvent: '5-6 9 11 15 20 22', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 9 11 15 20 22' },
    launches: ['designed @6 after 3'],
    timers: { '300000 at +0 cleared +0': 8, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.readPrimaryStepBudget resolved <object>', 'control.setChildSessionId resolved true', 'acceptPrimaryPrompt resolved true x2', 'acceptPrimaryPrompt resolved', 'recordPrimaryStep resolved <object>', 'recordPrimaryStep resolved', 'control.readPrimaryStepBudget resolved <object>', 'claimPrimaryStepBudgetWarning resolved', 'control.markAccepted resolved true', 'claimPrimaryStepBudgetWarning resolved <object>', 'claimPrimaryStepBudgetWarning resolved'],
    final: { running: 'designed' },
  },
  // Both timed waits register (3,000 ms timers) and resolve at the completion's commit (:870-871, :687), clearing their
  // timers; the refusals reject before or inside the lock. After shutdown (:3357-3424) initialize and every wait reject
  // scheduler_shut_down (:2313-2317, :2395-2400).
  'waits-and-reads': {
    steps: 41,
    clock: ['+0 1-41'],
    groups: ['4: call submit x2', '15: control setChildSessionId of executor.start#1..2', '18: control markAccepted of executor.start#1..2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 15-16 18-19 21 30 33 37', publishEvent: '5-8 16-17 19-20 22 31', 'executor.start': '8x2', authorize: '32', 'executor.shutdown': '38' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 16-17 19-20 22 31 34 38', 'executor.start': '21', authorize: '33', 'executor.shutdown': '39' },
    launches: ['wait-a @8 after 5', 'wait-b @8 after 5'],
    timers: { '300000 at +0 cleared +0': 13, '60000 at +0 cleared +0': 2, '3000 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'waitForAnyTask resolved <object>', 'waitForAnyTask rejected TypeError', 'waitForAnyTask rejected task_scope_mismatch', 'waitForAnyTask rejected Error', 'waitForResultCommit resolved <object>', 'waitForResultCommit rejected TypeError', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'waitForResultAction resolved completed', 'waitForResultAction rejected result_not_found', 'waitForResultAction rejected task_not_found', 'listResultEnvelopes returned <array 1>', 'listResultEnvelopes returned <array 0>', 'inspectDispatchBarrier resolved <object>', 'inspectDispatchBarrier rejected missing_root_session_id', 'acknowledgeResult resolved <object>', 'declareObjectiveChecks resolved <object>', 'getObjectiveRequiredChecks returned <object>', 'getObjectiveRequiredChecks returned', 'shutdown resolved', 'initialize rejected scheduler_shut_down', 'waitForAnyTask rejected scheduler_shut_down'],
    final: { completed: 'wait-a', running: 'wait-b' },
  },
  // Receipts commit same-status updates (:4083-4139), onRequiredCheckReceipt once per accepted receipt (16, 21, 23);
  // a repeated start and a wrong lease are false without a save; an unknown phase and a waiver without authority are
  // TypeErrors (:4084, :4303). acknowledgeResult continue calls inspectRequiredChecks (:3483-3487): not ready, refused
  // required_verification_pending; ready, the result is dispositioned (the save in step 33).
  'required-checks': {
    steps: 34,
    clock: ['+0 1-34'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 15 20 22 25 27 33', publishEvent: '5-6 8 16 21 23 26 28 34', 'executor.start': '6', onRequiredCheckReceipt: '16 21 23', inspectRequiredChecks: '30 32' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 16 21 23 26 28 34', 'executor.start': '27', inspectRequiredChecks: '31 33' },
    launches: ['checked @6 after 3'],
    timers: { '300000 at +0 cleared +0': 10, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'getRequiredCheckTask returned <object>', 'getRequiredCheckTask returned', 'getRequiredCheckTasks returned <array 1> x2', 'getChildAssignment returned starting', 'getChildAssignment returned', 'recordRequiredCheck resolved true', 'recordRequiredCheck resolved false x2', 'recordRequiredChecks rejected TypeError', 'recordRequiredCheck resolved true', 'recordRequiredChecks resolved true', 'waiveRequiredChecks rejected TypeError', 'control.markAccepted resolved true', 'getChildAssignment returned completed', 'acknowledgeResult rejected required_verification_pending', 'acknowledgeResult resolved <object>'],
    final: { completed: 'checked' },
  },
  // The collect at +0 leaves the aged task acknowledged. The second task's admission save (the 9th) is refused: the pump
  // throws, launchCommittedTask warns and arms the 5,000 ms admission retry (:2540-2543), and submit answers it queued.
  // At +5000 the retry admits it: that save (the 10th) compacts the aged task away (maxHistoryAgeMs), so the commit queues its
  // removal publication and then its own (:618-623, :659); both publish in step 19, the second after the starting lease
  // and right before executor.start.
  'publication-beside-launch': {
    steps: 19,
    clock: ['+0 1-17', '+5000 18-19'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 15-16 18', publishEvent: '5-6 8 10 12 14 16 19x2', 'executor.start': '6 19', 'logger.warn': '17' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 16 19 rejected 17', 'executor.start': '11' },
    launches: ['aged @6 after 3', 'retried @19 after 10'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 1, '5000 at +0 fired +5000': 1, '300000 at +5000 cleared +5000': 1, '60000 at +5000 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'submit resolved queued'],
    final: { starting: 'retried' },
  },
  // recordRequiredChecks (:4083-4139): a completion for another message than the bound one is false without a save (:4124-4125);
  // a bind to another message commits the identity conflict and answers false (:4120-4123); a bind of a waived receipt is
  // false (:4117-4118). waiveRequiredChecks (:4302-4318) and correctRequiredCheck (:4282-4301) read their authority's symbol,
  // call its recheck (steps 18, 22) and commit. Settled, the task leaves getRequiredCheckTasks by child (:4206-4209) and
  // childAttempt answers none (:4332-4341); the objective's receipt commits through the root scope (:4088-4091, :4131).
  'required-checks-waived': {
    steps: 41,
    clock: ['+0 1-41'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 14 16 19 23 27 29 37 39', publishEvent: '5-6 8 10 12 15 17 20 24 28 30', 'executor.start': '6', onRequiredCheckReceipt: '10 12 15 17', recheck: '18 22', authorize: '36' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 15 17 20 24 28 30 38 40', recheck: '19 23', 'executor.start': '29', authorize: '37' },
    launches: ['waived @6 after 3'],
    timers: { '300000 at +0 cleared +0': 14, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'recordRequiredCheck resolved true x2', 'recordRequiredChecks resolved false', 'recordRequiredCheck resolved false', 'recordRequiredCheck resolved true', 'waiveRequiredChecks resolved starting', 'recordRequiredCheck resolved false', 'correctRequiredCheck resolved starting', 'getRequiredCheckTask returned <object>', 'childAttempt returned <object>', 'control.markAccepted resolved true', 'getRequiredCheckTasks returned <array 0>', 'getRequiredCheckTasks returned <array 1>', 'getChildAssignment returned completed', 'childAttempt returned <object>', 'childAttempt returned', 'declareObjectiveChecks resolved <object>', 'recordRequiredCheck resolved true', 'getObjectiveRequiredChecks returned <object>'],
    final: { completed: 'waived' },
  },
  // getDispatchBarrierStateLocked (:1035-1075): active while a grouped task is not terminal, then awaiting_acknowledgement
  // for the uncollected ones, clear once none is; waitForDispatchBarrier (:3092-3109) waits on the running tasks and answers
  // awaiting_acknowledgement; confirmAgentHandoff (:3899-3979) abandons the terminal uncollected task without an abort.
  'dispatch-barrier-states': {
    steps: 30,
    clock: ['+0 1-30'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 17 20 23 27', publishEvent: '5-8 10-11 13-14 18 21 24 28', 'executor.start': '8x2' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 18 21 24 28', 'executor.start': '17 20' },
    launches: ['grouped-1..2 @8 after 5'],
    timers: { '300000 at +0 cleared +0': 13, '60000 at +0 cleared +0': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'inspectDispatchBarrier resolved <object>', 'waitForDispatchBarrier resolved <object>', 'inspectDispatchBarrier resolved <object> x2', 'acknowledgeResult resolved <object>', 'inspectDispatchBarrier resolved <object>', 'inspectAgentHandoff resolved <object>', 'confirmAgentHandoff resolved <object>', 'inspectDispatchBarrier resolved <object>', 'getSnapshot returned <object>'],
    final: { completed: 'grouped-1..2' },
  },
  // persistLocked (:543-594): the stall watch of save 2 is armed for the stall (+1000), re-armed at +600 by the completed
  // phase for the earlier of the stall (+1600) and the deadline (+1500, :569-573); at the deadline it reports task_deadline
  // (:559-563); flush (:3981-3987) waits behind the held save; the deadline timer armed after the commit (0 ms, fires at +1,
  // the platform clamp) fails the starting task.
  'persistence-stall-deadline': {
    steps: 13,
    clock: ['+0 1-5', '+600 6', '+1500 7-9', '+1501 10-13'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4 8 12', onPersistenceObservation: '7-8', 'logger.warn': '7', publishEvent: '8-9 13', 'executor.start': '9', 'executor.getLastRecoverableResult': '10', 'executor.abort': '10', 'executor.readRecoverableResult': '11' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 8-9 13', 'executor.abort': '11', 'executor.readRecoverableResult': '12' },
    launches: ['due @9 after 3'],
    timers: { '1000 at +0 cleared +0': 1, '1000 at +0 cleared +600': 1, '900 at +600 fired +1500': 1, '0 at +1500 fired +1501': 1, '0 at +1500 cleared +1500': 1, '60000 at +1500 cleared +1501': 1, '5000 at +1501 cleared +1501': 1, '0 at +1501 cleared +1501': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'flush resolved', 'callback.onProgress returned'],
    final: { failed: 'due' },
  },
  // The child filter of listReadyProviderRecoveryContinuations (:3145-3151); getChildAssignment takes the later settled task
  // (:4348); a claim blocks another claimant only while it has not expired (:3214); verifyRecoveredCollection needs the
  // claimant's unexpired claim (:3254). Claims, releases and reads save nothing.
  'provider-recovery-expiry': {
    steps: 27,
    clock: ['+0 1-12', '+1000 13-22', '+61000 23-24', '+121000 25-27'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13-14 16 18', publishEvent: '5-6 8 10 12 14x2 15 17 19', 'executor.start': '6', 'executor.retryInPlace': '15' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14-15 17 19', 'executor.start': '11', 'executor.retryInPlace': '18' },
    launches: ['recovering @6 after 3', 'retryInPlace recovering @15 after 8'],
    timers: { '300000 at +0 cleared +0': 6, '60000 at +0 cleared +0': 1, '300000 at +1000 cleared +1000': 4, '60000 at +1000 cleared +1000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'acknowledgeResult resolved <object>', 'control.markAccepted resolved true', 'listReadyProviderRecoveryContinuations returned <array 1>', 'getChildAssignment returned completed', 'claimProviderRecoveryContinuation resolved <object> x2', 'verifyRecoveredCollection resolved <object>', 'verifyRecoveredCollection resolved', 'releaseProviderRecoveryContinuation resolved <object>', 'listResultEnvelopes returned <array 2>'],
    final: { completed: 'recovering', failed: 'recovering' },
  },
  // The loaded source names another follow-up (:3252), so verifyRecoveredCollection answers null; listing, claiming and
  // releasing do not look at the link (:3133-3238).
  'provider-recovery-unlinked': {
    steps: 7,
    clock: ['+0 1-7'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2' },
    answers: { 'persistence.load': '2', 'persistence.save': '3' },
    launches: [],
    timers: { '300000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'listReadyProviderRecoveryContinuations returned <array 1>', 'claimProviderRecoveryContinuation resolved <object>', 'verifyRecoveredCollection resolved', 'releaseProviderRecoveryContinuation resolved <object>'],
    final: { completed: 'recover-1', failed: 'recovering' },
  },
  // cancelAutoResumeForSession matches the root or the child session (:3795) and clears the planning timer; re-enabled at
  // expiresAt (the lineage's start + AUTO_RESUME_MAX_LINEAGE_MS), the state is exhausted (:3770-3772) and nothing is planned.
  'auto-resume-child-cancel': {
    steps: 18,
    clock: ['+0 1-16', '+21600000 17-18'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11-12 14 17', publishEvent: '5-6 8 10 12-13 15 18', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12-13 15 18', 'executor.start': '11' },
    launches: ['parked @6 after 3'],
    timers: { '300000 at +0 cleared +0': 8, '60000 at +0 cleared +0': 1, '0 at +0 cleared +0': 1, '300000 at +21600000 cleared +21600000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'cancelAutoResumeForSession resolved <object>', 'getResultEnvelope returned failed', 'setResultAutoResume resolved <object>'],
    final: { failed: 'parked' },
  },
  // readOperatorStop (:4191-4200) reads a stop at or after `after` and its state; acceptOperatorStop commits accepted and
  // arms the deadline and the reconciliation retry (:4159-4176); withdrawOperatorStop refuses an accepted stop (:4182).
  'operator-stop-read': {
    steps: 22,
    clock: ['+0 1-18', '+1000 19-22'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 15 21', publishEvent: '5-6 8 10 12 16 22', 'executor.start': '6', 'executor.reconcile': '19', 'executor.readRecoverableResult': '20' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 16 22', 'executor.reconcile': '20', 'executor.readRecoverableResult': '21' },
    launches: ['stopped @6 after 3'],
    timers: { '300000 at +0 cleared +0': 7, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1, '1000 at +0 fired +1000': 1, '300000 at +1000 cleared +1000': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'recordOperatorStop resolved <object>', 'readOperatorStop returned', 'readOperatorStop returned <object>', 'acceptOperatorStop resolved true', 'readOperatorStop returned <object>', 'withdrawOperatorStop resolved false'],
    final: { interrupted: 'stopped' },
  },
  // acceptPrimaryPrompt refuses only an older prompt (:4221); recordPrimaryStep counts each message once (:4258) and starts a
  // new prompt afresh (:4251); the warning notice names the steps used (:4279); readPrimaryStepBudget answers null once the
  // task is terminal (:1303-1309).
  'designer-step-budget-next-prompt': {
    steps: 23,
    clock: ['+0 1-23'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 13 15 17 19 21', publishEvent: '5-6 8 10 12 14 16 18 20 22', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 14 16 18 20 22', 'executor.start': '21' },
    launches: ['designed @6 after 3'],
    timers: { '300000 at +0 cleared +0': 11, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'acceptPrimaryPrompt resolved true x2', 'recordPrimaryStep resolved <object> x2', 'control.markAccepted resolved true', 'claimPrimaryStepBudgetWarning resolved <object>', 'control.readPrimaryStepBudget resolved'],
    final: { completed: 'designed' },
  },
  // The timeouts of waitForAnyTask and waitForResultCommit answer the snapshot (:3027-3031, :2966-2968); until settled
  // waits for attention or settlement, not a ready result (:2997-2998); waitForResultAction rejects with its signal's
  // reason (:3078-3088).
  'waits-time-out': {
    steps: 26,
    clock: ['+0 1-16', '+1000 17-26'],
    groups: ['4: call submit x2', '9: control setChildSessionId of executor.start#1..2', '12: control markAccepted of executor.start#1..2'],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-7 9-10 12-13 20 22', publishEvent: '5-8 10-11 13-14 21 23', 'executor.start': '8x2' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-8 10-11 13-14 21 23', 'executor.start': '20 22' },
    launches: ['wait-a @8 after 5', 'wait-b @8 after 5'],
    timers: { '300000 at +0 cleared +0': 9, '60000 at +0 cleared +0': 2, '1000 at +0 fired +1000': 2, '300000 at +1000 cleared +1000': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting x2', 'control.setChildSessionId resolved true x2', 'control.markAccepted resolved true x2', 'waitForAnyTask resolved <object>', 'waitForResultCommit resolved <object>', 'waitForAnyTask resolved <object>', 'waitForResultAction rejected Error', 'listResultEnvelopes returned <array 2>'],
    final: { completed: 'wait-a, wait-b' },
  },
  // verifyTaskDispatch refuses a task whose cancellation is in progress (:4382), verifyTaskSettlement does not (:4437);
  // withNativePromptContext authorizes (:4464) and then refuses a root with another directory (fenced, :4460) or an
  // empty directory (unavailable, :4456-4458).
  'native-prompt-context-fenced': {
    steps: 27,
    clock: ['+0 1-27'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 16 18-19 21-22', publishEvent: '5-6 8 10 17 19-20 22-23', 'executor.start': '6 20 23', 'executor.getLastRecoverableResult': '12', 'executor.abort': '12', 'executor.readRecoverableResult': '15', authorize: '24 26' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 17 19-20 22-23', 'executor.abort': '15', 'executor.readRecoverableResult': '16', authorize: '25 27' },
    launches: ['cancelled @6 after 3', 'split-a @20 after 8', 'split-b @23 after 10'],
    timers: { '300000 at +0 cleared +0': 10, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1, '60000 at +0 live': 2 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'verifyTaskDispatch resolved running', 'cancelTask resolved aborted', 'verifyTaskDispatch rejected native_managed_task_lease_invalid', 'verifyTaskSettlement resolved running', 'submit resolved starting x2', 'withNativePromptContext rejected native_prompt_context_fenced', 'withNativePromptContext rejected native_prompt_context_unavailable'],
    final: { aborted: 'cancelled', starting: 'split-a, split-b' },
  },
  // withNativePromptContext (:4451-4499): a rejected authorize ends it before the action (:4464); a rejected action ends it
  // without the last authorize (:4468-4487); a rejected last authorize drops the observations (:4488); a failed save puts
  // the envelope back (:4490-4493), so the collect's save holds the result without promptObserved.
  'native-prompt-context-refusals': {
    steps: 34,
    clock: ['+0 1-34'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 7 9 11 27 33', publishEvent: '5-6 8 10 12 34', 'executor.start': '6', authorize: '13 15 18 21 23 26 29 31', promptAction: '16 19 24 30' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 8 10 12 34 rejected 28', 'executor.start': '11', authorize: '16 19 24 27 30 32 rejected 14 22', promptAction: '21 26 31 rejected 17' },
    launches: ['context @6 after 3'],
    timers: { '300000 at +0 cleared +0': 8, '60000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.setChildSessionId resolved true', 'control.markAccepted resolved true', 'withNativePromptContext rejected harness_root_revoked', 'withNativePromptContext rejected harness_action_failed', 'withNativePromptContext rejected harness_root_revoked', 'callback.markPromptObserved returned', 'withNativePromptContext rejected harness_save_refused', 'callback.markPromptObserved returned', 'withNativePromptContext resolved read', 'acknowledgeResult resolved <object>'],
    final: { completed: 'context' },
  },
  // recordTransportRecovery (:1236-1255) refuses, in the lock, attempts fewer than recorded (:1247-1251); the same-model
  // count is validated to be 1 (transport-recovery.js), so only a backup attempt can be given back.
  'retry-transport-recovery': {
    steps: 12,
    clock: ['+0 1-12'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4-5 8 11', publishEvent: '5-6 9 12', 'executor.start': '6' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5-6 9 12' },
    launches: ['transport @6 after 3'],
    timers: { '300000 at +0 cleared +0': 5, '60000 at +0 live': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.readPriorFailureReason returned', 'control.recordTransportRecovery resolved true', 'control.recordTransportRecovery rejected TypeError', 'control.recordTransportRecovery resolved true'],
    final: { starting: 'transport' },
  },
  // assertPrerequisites (:1274-1283) rechecks while starting (its third verifyTaskPrerequisites, held); the cancellation
  // takes the task's owner meanwhile, so the final fence (:1281-1282) rejects task_lease_stale.
  'prerequisites-assert-cancelled': {
    steps: 14,
    clock: ['+0 1-14'],
    groups: [],
    ports: { 'persistence.load': '1', 'persistence.save': '2 4 6 13', publishEvent: '5 7 14', verifyTaskPrerequisites: '5 7 9', 'executor.start': '8', 'executor.getLastRecoverableResult': '10', 'executor.abort': '10', 'executor.readRecoverableResult': '12' },
    answers: { 'persistence.load': '2', 'persistence.save': '3 5 7 14', verifyTaskPrerequisites: '6 8 11', 'executor.abort': '12', 'executor.readRecoverableResult': '13' },
    launches: ['asserted @8 after 3'],
    timers: { '300000 at +0 cleared +0': 4, '60000 at +0 cleared +0': 1, '5000 at +0 cleared +0': 1 },
    outcomes: ['initialize resolved', 'submit resolved starting', 'control.assertPrerequisites rejected task_lease_stale', 'cancelTask resolved aborted'],
    final: { aborted: 'asserted' },
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

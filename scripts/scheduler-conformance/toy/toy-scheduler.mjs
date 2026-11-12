// A scheduler-shaped toy for the recorder's self-test: the same kinds of
// boundary as packages/orchestration-runtime/scheduler.js (options with an
// executor, a persistence, hooks and publishEvent; the clock, timers and
// identifier factories; a control object handed to executor.start; hidden
// reads of randomUUID, performance.now and one environment variable), small
// enough that the self-test knows every event it must record.
const createRandomId = (prefix) => {
  const random = globalThis.crypto.randomUUID();
  return `${prefix}${random.replaceAll('-', '')}`;
};

export class ToyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToyError';
    this.code = code;
  }
}

export const createManagedTaskScheduler = (options = {}) => {
  const executor = options.executor;
  if (!executor || typeof executor.start !== 'function') throw new TypeError('executor.start is required');
  const persistence = options.persistence ?? { async load() { return null; }, async save() {} };
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.scheduleTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.cancelTimeout ?? globalThis.clearTimeout;
  const createTaskId = options.createTaskId ?? (() => createRandomId('toy_task_'));
  const createLeaseToken = options.createLeaseToken ?? (() => createRandomId('toy_lease_'));
  const publishEvent = options.publishEvent ?? (() => undefined);
  // A member read that answers undefined, as the scheduler's proof-store probe does.
  const proofStore = typeof persistence.putShard === 'function';
  const tasks = new Map();
  let tail = Promise.resolve();

  const runExclusive = (operation) => {
    const queuedAt = options.onMutationTiming ? performance.now() : 0;
    const run = async () => {
      const startedAt = options.onMutationTiming ? performance.now() : 0;
      try { return await operation(); }
      finally { if (options.onMutationTiming) options.onMutationTiming({ waitMs: startedAt - queuedAt, holdMs: performance.now() - startedAt }); }
    };
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };

  const persistLocked = async () => {
    const expire = globalThis.process?.env?.DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY !== '0';
    const owner = createRandomId('toy_save_');
    await persistence.save({ owner, expire, tasks: [...tasks.values()].map((task) => ({ ...task })) }, { onProgress: (progress) => progress.phase });
  };

  const controlFor = (taskId) => ({
    async markAccepted() {
      return runExclusive(async () => {
        const task = tasks.get(taskId);
        tasks.set(taskId, { ...task, status: 'running', startedAt: now() });
        await persistLocked();
        publishEvent({ type: 'running', taskId });
        return true;
      });
    },
  });

  return {
    async submit(input) {
      const task = await runExclusive(async () => {
        const created = { taskId: createTaskId(), leaseToken: createLeaseToken(), status: 'queued', createdAt: now(), prompt: input.prompt };
        tasks.set(created.taskId, created);
        await persistLocked();
        publishEvent({ type: 'queued', taskId: created.taskId });
        return created;
      });
      await executor.start({ ...task }, controlFor(task.taskId));
      return { ...tasks.get(task.taskId) };
    },
    getTask(taskId) {
      const task = tasks.get(taskId);
      return task ? { ...task } : null;
    },
    echo(value) { return value; },
    copy(value) { return { ...value }; },
    fail(code) { throw new ToyError(code, `toy failure ${code}`); },
    later(value, delay) {
      return new Promise((resolve) => { scheduleTimeout(() => resolve(value), delay); });
    },
    arm(delay) {
      const timer = scheduleTimeout(() => { publishEvent({ type: 'fired', at: now() }); }, delay);
      return { disarm: () => cancelTimeout(timer) };
    },
    pause(delay) {
      const timer = scheduleTimeout(() => undefined, delay);
      cancelTimeout(timer);
      return true;
    },
    laterAt(delay) {
      return new Promise((resolve) => { scheduleTimeout(() => resolve(now()), delay); });
    },
    abortPort() {
      const controller = new AbortController();
      // A listener of its own, put on before the signal is handed out: its effect must follow the abort in the trace.
      controller.signal.addEventListener('abort', () => { publishEvent({ type: 'aborted' }); });
      executor.watch({ signal: controller.signal });
      controller.abort(new ToyError('toy_abort', 'the toy aborted its own signal'));
      return controller.signal.aborted;
    },
    flags() {
      return { expire: options.expireUnacknowledged, timing: typeof options.onMutationTiming, proofStore, load: 'load' in persistence, hasNow: 'now' in options, ownLoad: Object.prototype.hasOwnProperty.call(persistence, 'load') };
    },
    initialize() {
      return persistence.load();
    },
    twoTimers(delay) {
      scheduleTimeout(() => undefined, delay);
      const second = scheduleTimeout(() => undefined, delay);
      cancelTimeout(second);
      return true;
    },
    waitForSignals({ first, second, nested }) {
      let deep = nested;
      while (!deep.signal) deep = Object.values(deep)[0];
      const order = [];
      return new Promise((resolve) => {
        for (const signal of [first, second, deep.signal]) signal.addEventListener('abort', () => { order.push(String(signal.reason)); if (order.length === 3) resolve(order); }, { once: true });
      });
    },
    waitForAbort({ signal }) {
      return new Promise((resolve) => { signal.addEventListener('abort', () => resolve(String(signal.reason)), { once: true }); });
    },
    async stop(taskId) {
      return runExclusive(async () => {
        const stop = { taskId, requestId: createRandomId('toy_stop_'), at: now() };
        await executor.abort?.(stop);
        return stop;
      });
    },
    async authorize(action, input) {
      await input.authorize();
      return action(input.value);
    },
  };
};

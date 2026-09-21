import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const backgroundGitSignal = () => context.getStore();

/** Coalesce only queued work. A request arriving after a run starts must
 * observe a later run, including when another project occupies the pool. */
export function createGitReadCoordinator({ concurrency = 4, timeoutMs = 30_000 } = {}) {
  const queued = new Map(), running = new Set(), queue = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency) {
      const index = queue.findIndex((job) => !running.has(job.key));
      if (index < 0) return;
      const [job] = queue.splice(index, 1);
      queued.delete(job.key); running.add(job.key); active++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('Git status timed out; retry.'), {
        code: 'GIT_BACKGROUND_TIMEOUT', statusCode: 503,
      })), timeoutMs);
      Promise.resolve().then(() => job.resume(() => context.run(controller.signal, job.action))).then((value) => {
        controller.signal.throwIfAborted(); return value;
      }).then(job.resolve, job.reject).finally(() => {
        clearTimeout(timer); running.delete(job.key); active--; pump();
      });
    }
  };
  return (key, action) => {
    const existing = queued.get(key);
    if (existing) return existing.promise;
    const job = { key, action, resume: AsyncLocalStorage.snapshot(), ...Promise.withResolvers() };
    queued.set(key, job); queue.push(job);
    // Batch requests from this turn before starting a fresh observation.
    queueMicrotask(pump);
    return job.promise;
  };
}

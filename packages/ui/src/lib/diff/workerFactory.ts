import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url';

export function workerFactory(): Worker {
  try {
    return new Worker(WorkerUrl, { type: 'module' });
  } catch (error) {
    console.error('Failed to create Shiki diff worker:', error);
    throw error;
  }
}

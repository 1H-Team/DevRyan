import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Fixed-size numerical records only. No heap dumps or application content.
export function createRuntimeMemoryMonitor({ log, role, version, getWork = () => ({}),
  now = Date.now, readMemory = () => ({ ...process.memoryUsage(), heapLimit: v8.getHeapStatistics().heap_size_limit }),
  schedule = setInterval, cancel = clearInterval } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let lastAt = -Infinity, pressure = false;
  const sample = () => {
    const memory = readMemory();
    const ratio = memory.heapLimit > 0 ? memory.heapUsed / memory.heapLimit : 0;
    const nextPressure = ratio >= (pressure ? 0.7 : 0.8);
    const transition = nextPressure !== pressure;
    pressure = nextPressure;
    if (!transition && now() - lastAt < 60_000) return;
    lastAt = now();
    const work = getWork() ?? {};
    const number = (value) => Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
    const record = { pid: process.pid, role, version, electron: process.versions.electron ?? null,
      pressure, rss: number(memory.rss), heapUsed: number(memory.heapUsed), heapLimit: number(memory.heapLimit),
      external: number(memory.external), arrayBuffers: number(memory.arrayBuffers),
      eventLoopDelayMaxMs: number(delay.max / 1e6) };
    for (const key of ['active', 'queued', 'scopes', 'activeResponses', 'responseBytes', 'peakResponseBytes']) record[key] = number(work[key]);
    log(record);
    delay.reset();
    return record;
  };
  // Diagnostics must not take down an otherwise healthy runtime if its log
  // sink or a shutting-down server can no longer be read.
  const poll = () => { try { sample(); } catch { /* Best-effort numerical telemetry. */ } };
  const timer = schedule(poll, 10_000); timer?.unref?.();
  poll();
  return { sample, stop() { cancel(timer); delay.disable(); } };
}

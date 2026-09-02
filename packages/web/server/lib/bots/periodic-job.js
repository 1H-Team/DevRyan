import { botErrorLogFields } from './error-normalization.js';

const DEFAULT_MAX_BACKOFF_MS = 60_000;
const JOB_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

// A self-rescheduling background job. One run is in flight at a time; a
// failure doubles the delay (bounded, with jitter) and is logged once per
// distinct code, so a Supabase outage produces a handful of lines rather
// than one per interval. Timers never keep the process alive.
export function createBotPeriodicJob({
  name,
  run,
  intervalMs,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  logger = null,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof name !== 'string' || !JOB_NAME.test(name) || typeof run !== 'function'
    || !Number.isInteger(intervalMs) || intervalMs < 10
    || !Number.isInteger(maxBackoffMs) || maxBackoffMs < intervalMs
    || typeof random !== 'function') {
    throw new Error('Bot periodic job configuration is invalid');
  }
  let started = false;
  let timer = null;
  let inFlight = null;
  let consecutiveFailures = 0;
  let currentDelay = intervalMs;
  let lastLoggedCode = null;

  const schedule = (delayMs) => {
    if (!started || timer) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      void tick();
    }, delayMs);
    timer.unref?.();
  };

  const onSuccess = () => {
    if (consecutiveFailures > 0) {
      logger?.info?.('[Bots] periodic job recovered', { job: name, consecutiveFailures });
    }
    consecutiveFailures = 0;
    currentDelay = intervalMs;
    lastLoggedCode = null;
    return intervalMs;
  };

  const onFailure = (error) => {
    consecutiveFailures += 1;
    const fields = botErrorLogFields(error, `${name}_failed`);
    if (fields.code !== lastLoggedCode) {
      logger?.warn?.('[Bots] periodic job failed', { job: name, ...fields, consecutiveFailures });
      lastLoggedCode = fields.code;
    }
    currentDelay = Math.min(maxBackoffMs, Math.max(intervalMs, currentDelay * 2));
    const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
    return Math.round(currentDelay * jitter);
  };

  const tick = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let delayMs = intervalMs;
      try {
        await run();
        delayMs = onSuccess();
      } catch (error) {
        delayMs = onFailure(error);
      }
      return delayMs;
    })().then((delayMs) => {
      inFlight = null;
      if (started) schedule(delayMs);
    });
    return inFlight;
  };

  return Object.freeze({
    name,
    start({ immediate = true } = {}) {
      if (started) return;
      started = true;
      if (immediate) void tick();
      else schedule(intervalMs);
    },
    async stop() {
      started = false;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
    trigger: () => tick(),
    get running() {
      return started;
    },
    get consecutiveFailures() {
      return consecutiveFailures;
    },
  });
}

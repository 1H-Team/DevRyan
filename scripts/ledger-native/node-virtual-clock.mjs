// A virtual clock under Node's own timers, for the JavaScript arms of the
// native ledger's virtual-time differential tests. Nothing here restates
// Node's timer rules: `setTimeout`, `setInterval` and their clearing are
// Node's (lib/internal/timers.js, its lists, ids and truncation), with only
// libuv's loop time replaced by this clock and Node's own `processTimers`
// called when the clock reaches an expiry. `Date.now()` reads the same
// clock. The process must run with --expose-internals.
//
// Each step runs in a macrotask of its own (a real `setImmediate`), so the
// microtasks of one step drain completely before the clock moves, and
// between timers Node's `processTimers` drains them itself.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { internalBinding } = require('internal/test/binding');
const binding = internalBinding('timers');
const { getTimerCallbacks, timerListMap, timerListQueue } = require('internal/timers');
const { setupTaskQueue } = require('internal/process/task_queues');
const linkedList = require('internal/linkedlist');

const realImmediate = setImmediate;
let now = 0;
// libuv's loop time and Date.now() are this clock; the real loop never runs a timer.
binding.getLibuvNow = () => now;
binding.scheduleTimer = () => {};
binding.toggleTimerRef = () => {};
Date.now = () => now;
// Node's processTimers with Node's own checkpoint between timers
// (`runNextTicks`: ticks, microtasks and the unhandled-rejection report),
// as Node itself passes it.
const { runNextTicks } = setupTaskQueue();
const { processTimers } = getTimerCallbacks(runNextTicks);

/** The clock's time. */
export const clockNow = () => now;

/** Forgets every timer and timer list, then sets the clock (between scenarios). */
export function resetClock(time) {
  for (const key of Object.keys(timerListMap)) {
    const list = timerListMap[key];
    for (let timer = linkedList.peek(list); timer; timer = linkedList.peek(list)) {
      clearTimeout(timer);
      if (linkedList.peek(list) === timer) linkedList.remove(timer);
    }
    delete timerListMap[key];
  }
  while (timerListQueue.peek()) timerListQueue.shift();
  now = time;
}

/** Runs `action` in a macrotask of its own; resolves once its microtasks drained. */
export const unit = (action) => new Promise((resolve, reject) => {
  realImmediate(() => {
    try { action(); } catch (error) { reject(error); return; }
    realImmediate(resolve);
  });
});

/** The expiry of the first timer list, or null. */
export const nextExpiry = () => timerListQueue.peek()?.expiry ?? null;

/** Moves the clock to the next expiry if it is at most `until`, running the timers due; false when none is. */
export async function step(until) {
  await unit(() => {});
  const next = nextExpiry();
  if (next === null || next > until) return false;
  await unit(() => { now = Math.max(now, next); processTimers(now); });
  return true;
}

/** Moves the clock forward to `time` (never back), running nothing. */
export function moveTo(time) { now = Math.max(now, time); }

/** Moves the clock to `until`, running every timer due by then. */
export async function advanceTo(until) {
  while (await step(until)) { /* The next expiry. */ }
  now = Math.max(now, until);
}

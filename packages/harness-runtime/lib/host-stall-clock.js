// Time during which this process's event loop did not run.
//
// A deadline measured with the wall clock also counts the time the host
// itself could not run: on 2026-09-29 other applications overloaded the
// machine, the runtime's event loop stalled for up to 109 s, and every local
// deadline fired on work that was slow but alive (73 execution timeouts in a
// day). Progress can neither happen nor be recorded while the loop is
// stalled, so that time is subtracted from a deadline, up to a finite cap.
//
// A 250 ms ticker notices a stall when it fires late. Stalls are kept for 30
// minutes. Kill switch, read per use: DEVRYAN_STALL_AWARE_DEADLINES=0 makes
// every deadline a wall-clock deadline again.

const TICK_MS = 250;
// A tick this late is a stall; shorter delays are ordinary scheduling.
const STALL_MS = 1_000;
const RETAIN_MS = 30 * 60_000;
const MAX_STALLS = 512;

export function createHostStallClock({ now = Date.now, tickMs = TICK_MS, stallMs = STALL_MS, onStall,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const stalls = [];
  let last = now(), timer = null, count = 0, total = 0, longest = 0;
  const tick = () => {
    const at = now(), late = at - last - tickMs;
    if (late >= stallMs) {
      const stall = { from: last + tickMs, to: at };
      stalls.push(stall); count += 1; total += late; longest = Math.max(longest, late);
      while (stalls.length > MAX_STALLS || (stalls.length && at - stalls[0].to > RETAIN_MS)) stalls.shift();
      try { onStall?.({ ...stall, ms: late }); } catch { /* Observer only. */ }
    }
    last = at;
  };
  const enabled = () => process.env.DEVRYAN_STALL_AWARE_DEADLINES !== '0';
  /** Stalled time inside [from, to], including a stall still in progress. */
  const stalledMsBetween = (from, to = now()) => {
    if (!enabled() || !(to > from)) return 0;
    let ms = 0;
    for (const stall of stalls) ms += Math.max(0, Math.min(to, stall.to) - Math.max(from, stall.from));
    // The ticker has not run since `last`: the loop is stalled right now, and
    // whoever asks is the first code to run after it.
    const at = now();
    if (at - last - tickMs >= stallMs) ms += Math.max(0, Math.min(to, at) - Math.max(from, last + tickMs));
    return Math.min(ms, to - from);
  };
  /** Time since `since` during which the host could run. */
  const activeMsSince = (since, at = now()) => Math.max(0, at - since - stalledMsBetween(since, at));
  /** True once `limitMs` of runnable time passed since `since`, or `capMs` of wall time. */
  const expired = (since, limitMs, capMs = Infinity, at = now()) => at - since >= capMs || activeMsSince(since, at) >= limitMs;
  return {
    start() {
      if (timer) return;
      last = now();
      timer = setIntervalImpl(tick, tickMs);
      timer?.unref?.();
    },
    stop() { if (timer) clearIntervalImpl(timer); timer = null; },
    tick, stalledMsBetween, activeMsSince, expired,
    snapshot: () => ({ stalls: count, stalledMs: total, longestStallMs: longest }),
  };
}

// One clock per process, started on first use.
let shared = null;
const listeners = new Set();
export const hostStallClock = () => {
  if (!shared) {
    shared = createHostStallClock({ onStall: (stall) => { for (const listener of listeners) { try { listener(stall); } catch { /* Observer only. */ } } } });
    shared.start();
  }
  return shared;
};
/** Tests only: forget the shared clock so the next use starts a new one. */
export const resetHostStallClock = () => { shared?.stop(); shared = null; };
/** Observes every stall of this process; returns the function that stops observing. */
export const onHostStall = (listener) => { hostStallClock(); listeners.add(listener); return () => listeners.delete(listener); };
export const hostActiveMsSince = (since) => hostStallClock().activeMsSince(since);
export const hostDeadlineExpired = (since, limitMs, capMs) => hostStallClock().expired(since, limitMs, capMs);

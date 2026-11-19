// When a child process is finished for a caller that reads what it printed.
// 'exit' says the process is gone, not that its pipes have been read: the
// last bytes of stderr can be delivered after it (a hosted Linux runner
// showed a refusal whose message arrived after the exit). 'close' comes once
// the pipes have ended as well.

/**
 * Calls `callback(code, signal)` once, when `child` has exited and its output
 * pipes have ended. If something else still holds a pipe open (a grandchild
 * that inherited it), the callback runs `graceMs` after the exit instead of
 * never.
 */
export function onceFinished(child, callback, { graceMs = 5_000 } = {}) {
  let timer = null;
  let done = false;
  const finish = (code, signal) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    callback(code, signal);
  };
  child.once('close', finish);
  child.once('exit', (code, signal) => { if (!done) timer = setTimeout(() => finish(code, signal), graceMs); });
}

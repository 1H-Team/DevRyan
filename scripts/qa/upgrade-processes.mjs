import { startOwnedProcess } from './process.mjs';
import { detachMountedDmgs } from './mounted-dmg.mjs';

const children = new Set();
export function trackUpgradeChild(child) {
  children.add(child);
  return () => children.delete(child);
}

let stopping;
export function stopUpgradeChildren() {
  return stopping ??= (async () => {
    await Promise.allSettled([...children].map(child => child.stop({ deadline: performance.now() + 30_000 })));
    // An interrupted attach may finish while its process is stopping.
    detachMountedDmgs();
  })();
}

export async function runUpgradeCommand(command, args, { timeout = 180_000, ...options } = {}) {
  // The POSIX qualification shell retains its PID across exec and waits until ownership is observed.
  const owned = startOwnedProcess('/bin/sh', ['-c', 'read -r start; exec "$@"', 'devryan-upgrade-command', command, ...args],
    { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const untrack = trackUpgradeChild(owned);
  let stdout = '', stderr = '';
  owned.child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16 * 1024 * 1024); });
  owned.child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-64 * 1024); });
  let timer;
  try {
    await owned.observe();
    owned.child.stdin.end('\n');
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Qualification command timed out')), timeout);
      owned.child.once('error', reject);
      owned.child.once('close', (code, signal) => signal ? reject(new Error('Qualification command interrupted')) : resolve(code));
    });
    if (code !== 0) throw Object.assign(new Error(`Qualification ${command.split('/').at(-1)} exited (${code})`), { code: 'qa_release_upgrade_command', command: command.split('/').at(-1), exitCode: code });
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    try { await owned.stop({ deadline: performance.now() + 30_000 }); }
    finally { untrack(); }
  }
}

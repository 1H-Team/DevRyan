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
  const owned = startOwnedProcess(command, args, options);
  const untrack = trackUpgradeChild(owned);
  let stdout = '', stderr = '';
  owned.child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16 * 1024 * 1024); });
  owned.child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-64 * 1024); });
  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Qualification command timed out')), timeout);
      owned.child.once('error', reject);
      owned.child.once('close', (code, signal) => signal ? reject(new Error('Qualification command interrupted')) : resolve(code));
    });
    if (code !== 0) throw Object.assign(new Error(`Qualification ${command.split('/').at(-1)} exited (${code})`), { code: 'qa_release_upgrade_command' });
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    try { await owned.stop({ deadline: performance.now() + 30_000 }); }
    finally { untrack(); }
  }
}

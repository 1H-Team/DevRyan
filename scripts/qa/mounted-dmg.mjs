import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
// Detach synchronously on interruption before run-root's asynchronous cleanup
// removes scratch. Normal completion still reports detach failures.
const mounted = new Set();
export function detachMountedDmgs() { for (const detach of mounted) detach(); }

export async function withMountedDmg(dmg, mount, operation, run = execute) {
  const emergencyDetach = () => {
    try { execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { timeout: 30_000, stdio: 'ignore' }); } catch { /* normal cleanup retries */ }
  };
  mounted.add(emergencyDetach);
  const events = ['SIGINT', 'SIGTERM', 'exit'];
  for (const event of events) process.on(event, emergencyDetach);
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 60_000 });
    return await operation();
  } finally {
    try { await run('/usr/bin/hdiutil', ['detach', mount, '-force'], { timeout: 30_000 }); }
    finally { mounted.delete(emergencyDetach); for (const event of events) process.removeListener(event, emergencyDetach); }
  }
}

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

// Only call after the lease's consumer and native termination guards pass.
// Symlinks are removed, never followed to chmod dependency/project inputs.
export async function removeExecutionDirectory(directory) {
  try { await fs.rm(directory, { recursive: true, force: true }); return; }
  catch (cause) { if (!['EACCES', 'EPERM'].includes(cause.code)) throw cause; }
  const writable = async (target) => {
    const stat = await fs.lstat(target).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (!stat?.isDirectory()) return;
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(stat.mode | 0o700); } finally { await handle.close(); }
    for (const name of await fs.readdir(target)) await writable(path.join(target, name));
  };
  await writable(directory);
  await fs.rm(directory, { recursive: true, force: true });
}

export async function cleanupExecutionLease(runtime, input, onDiagnostic) {
  try { return await runtime.cleanupLease(input); }
  catch (cause) {
    // Publication/cancellation is already durable. Cleanup is retryable work,
    // not a reason to replace the completed execution outcome with a failure.
    try { onDiagnostic?.({ event: 'session_execution', phase: 'cleanup_pending', code: cause.code || 'execution_cleanup_failed' }); } catch { /* Observer only. */ }
    return false;
  }
}

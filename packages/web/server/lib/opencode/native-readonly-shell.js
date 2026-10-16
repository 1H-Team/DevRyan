import fs from 'node:fs/promises';
import path from 'node:path';

/** Keep the owned supervisor/receipt root and original publication snapshot.
 * The execution profile grants only private scratch/view writes. The snapshot
 * is the logical cwd under the launcher's read-only host boundary. */
export async function readOnlyShellLease(lease, { platform = process.platform } = {}) {
  // The LPAC policy has no read-only workspace grant or network-free mode.
  if (!['darwin', 'linux'].includes(platform)) throw Object.assign(new Error('native_plan_confinement_unavailable'), { code: 'native_plan_confinement_unavailable', status: 503 });
  const viewDirectory = path.join(path.dirname(lease.viewDirectory), 'read-only-worktree');
  await fs.mkdir(viewDirectory, { mode: 0o700 });
  const logicalWorkingDirectory = lease.workingDirectory ?? lease.viewDirectory;
  return { ...lease, viewDirectory, workingDirectory: viewDirectory, logicalWorkingDirectory, readOnly: true,
    inputs: undefined, projectDirectory: undefined };
}

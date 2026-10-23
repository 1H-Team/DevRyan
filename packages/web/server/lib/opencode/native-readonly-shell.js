import fs from 'node:fs/promises';
import path from 'node:path';

const fail = (code, status) => Object.assign(new Error(code), { code, status });

/** Keep the owned supervisor/receipt root and original publication snapshot.
 * The execution profile grants only private scratch/view writes. The snapshot
 * is the logical cwd under the launcher's read-only host boundary.
 *
 * A lease prepared `read-only` has no snapshot (no view copy): on macOS its
 * logical cwd is the live project directory, read under the same read-only,
 * network-denied profile, exactly like a native read. */
export async function readOnlyShellLease(lease, { platform = process.platform } = {}) {
  // The LPAC policy has no read-only workspace grant or network-free mode.
  if (!['darwin', 'linux'].includes(platform)) throw fail('native_plan_confinement_unavailable', 503);
  // Only the macOS profile is verified to run from a real host directory.
  if (lease.preparation === 'read-only' && platform !== 'darwin') throw fail('native_plan_confinement_unavailable', 503);
  let logicalWorkingDirectory = lease.workingDirectory ?? lease.viewDirectory;
  if (lease.preparation === 'read-only') {
    const relative = path.relative(lease.viewDirectory, logicalWorkingDirectory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.isAbsolute(lease.projectDirectory ?? '')) {
      throw fail('invalid_execution_path', 409);
    }
    const project = await fs.realpath(lease.projectDirectory);
    logicalWorkingDirectory = await fs.realpath(path.join(project, relative));
    if (logicalWorkingDirectory !== project && !logicalWorkingDirectory.startsWith(`${project}${path.sep}`)) throw fail('invalid_execution_path', 409);
  }
  const viewDirectory = path.join(path.dirname(lease.viewDirectory), 'read-only-worktree');
  await fs.mkdir(viewDirectory, { mode: 0o700 });
  return { ...lease, viewDirectory, workingDirectory: viewDirectory, logicalWorkingDirectory, readOnly: true,
    inputs: undefined, projectDirectory: undefined };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readExistingBotDeploymentId } from './bot-secret-store.mjs';

const execute = promisify(execFile);

// Called after startup acceptance, never awaited by the startup gate. Docker
// being absent/stopped or an unavailable sealed key is an ordinary failure.
export async function stopRetiredBots({ dataDirectory, safeStorage, run = execute,
  readDeploymentId = readExistingBotDeploymentId } = {}) {
  const signal = AbortSignal.timeout(15_000);
  try {
    const deployment = await readDeploymentId({ dataDirectory, safeStorage });
    if (!deployment) return { status: 'absent' };
    if (!/^deployment-[0-9a-f]{24}$/.test(deployment)) throw new Error('Invalid deployment identity');
    const options = { signal, timeout: 15_000, maxBuffer: 64 * 1024 };
    const { stdout } = await run('docker', ['ps', '--all', '--quiet', '--no-trunc',
      '--filter', 'label=devryan.runtime=production-bots',
      '--filter', `label=devryan.deployment=${deployment}`], options);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return { status: 'absent' };
    if (ids.length > 256 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid container identities');
    // Keep containers and volumes, but do not let Docker restart retired work.
    await run('docker', ['update', '--restart=no', ...ids], options);
    await run('docker', ['stop', '--time', '5', ...ids], options);
    return { status: 'stopped', count: ids.length };
  } catch {
    return { status: 'unavailable' };
  }
}

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const exists = (file, fsPromises) => fsPromises.access(file).then(() => true, (error) => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});

// Called after startup acceptance, never awaited by the startup gate. Runs
// until it succeeds once, then a marker makes every later launch a single
// stat. It never reads the OS keychain: the sealed deployment key only gates
// whether Bots were ever set up here, and containers are found by the runtime
// label alone. Docker being stopped is an ordinary failure retried next launch.
export async function stopRetiredBots({ dataDirectory, run = execute, fsPromises = fs } = {}) {
  const signal = AbortSignal.timeout(15_000);
  try {
    const botsDirectory = path.join(dataDirectory, 'bots');
    const marker = path.join(botsDirectory, 'retired.v1');
    if (await exists(marker, fsPromises)) return { status: 'retired' };
    const retire = async (result) => {
      // The deployment key only decrypts retired Bot data; nothing reads it again.
      await fsPromises.rm(path.join(botsDirectory, 'keys'), { recursive: true, force: true });
      await fsPromises.mkdir(botsDirectory, { recursive: true, mode: 0o700 });
      await fsPromises.writeFile(marker, `${JSON.stringify({ version: 1, retiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      return result;
    };
    if (!await exists(path.join(botsDirectory, 'keys', 'deployment-key.v1'), fsPromises)) return retire({ status: 'absent' });
    const options = { signal, timeout: 15_000, maxBuffer: 64 * 1024 };
    let stdout;
    try {
      ({ stdout } = await run('docker', ['ps', '--all', '--quiet', '--no-trunc',
        '--filter', 'label=devryan.runtime=production-bots'], options));
    } catch (error) {
      // No Docker CLI means no container can run or restart.
      if (error?.code === 'ENOENT') return retire({ status: 'absent' });
      throw error;
    }
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length > 256 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid container identities');
    if (!ids.length) return retire({ status: 'absent' });
    // Keep containers and volumes, but do not let Docker restart retired work.
    await run('docker', ['update', '--restart=no', ...ids], options);
    await run('docker', ['stop', '--time', '5', ...ids], options);
    return retire({ status: 'stopped', count: ids.length });
  } catch {
    return { status: 'unavailable' };
  }
}

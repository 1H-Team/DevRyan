import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Apple's shim repeats Xcode discovery in each helper's empty, confined HOME.
export async function resolveControllerGitCommand(command, { platform = process.platform, run = execute } = {}) {
  if (platform !== 'darwin' || command !== '/usr/bin/git') return command;
  try {
    const { stdout } = await run('/usr/bin/xcrun', ['--find', 'git'], { timeout: 10_000, maxBuffer: 4096 });
    const resolved = stdout.trim();
    if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved || path.basename(resolved) !== 'git'
      || resolved === command || /[\r\n\0]/.test(resolved)) throw Error('Invalid selected Git executable');
    return resolved;
  } catch {
    throw Object.assign(new Error('mutation_runtime_unsupported'), { code: 'mutation_runtime_unsupported', status: 409, statusCode: 409 });
  }
}

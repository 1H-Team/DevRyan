import { spawn } from 'node:child_process';

export const useDetachedChildren = process.platform === 'darwin';

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDetachedProcessGroupRunning(child) {
  if (!child?.pid || !useDetachedChildren || process.platform === 'win32') {
    return false;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function isChildTreeRunning(child) {
  if (!child) {
    return false;
  }
  if (useDetachedChildren && process.platform !== 'win32') {
    return isDetachedProcessGroupRunning(child);
  }
  return child.exitCode === null && child.signalCode === null;
}

export function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!isChildTreeRunning(child)) {
      resolve();
      return;
    }

    const deadline = Date.now() + timeoutMs;
    let timer;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const check = () => {
      if (!isChildTreeRunning(child) || Date.now() >= deadline) {
        settle();
        return;
      }
      timer = setTimeout(check, Math.min(25, Math.max(1, deadline - Date.now())));
    };

    const onExit = () => {
      if (timer) clearTimeout(timer);
      check();
    };

    child.once('exit', onExit);
    check();
  });
}

export function signalChild(child, signal) {
  if (!child) {
    return;
  }

  try {
    if (child.pid && useDetachedChildren && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill(signal);
  } catch {
  }
}

export async function stopChildTree(child) {
  if (!isChildTreeRunning(child)) {
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (isChildTreeRunning(child)) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (isChildTreeRunning(child)) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

export function spawnManagedChild({ repoRoot, command, args, env = {}, cwd = repoRoot }) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
  });

  child.on('error', (error) => {
    console.error(`[dev] Failed to start child (${command} ${args.join(' ')}):`, error);
  });

  return child;
}

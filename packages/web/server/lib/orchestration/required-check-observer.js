import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRequiredCheckEvidence } from '@openchamber/orchestration-runtime';

// No source bytes are retained. Confinement, file count, byte count and race
// checks are independent of any declared read-only tool metadata.
export const fingerprintCheckContent = async (directory, paths) => {
  try {
    const root = await fs.realpath(directory);
    const hash = crypto.createHash('sha256');
    const identities = [];
    let bytes = 0;
    for (const target of [...paths].sort()) {
      const resolved = await fs.realpath(path.resolve(root, target));
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      const before = await fs.stat(resolved, { bigint: true });
      if (!before.isFile() || before.size > 8n * 1024n * 1024n) return null;
      bytes += Number(before.size);
      if (bytes > 32 * 1024 * 1024) return null;
      const content = await fs.readFile(resolved);
      const after = await fs.stat(resolved, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || await fs.realpath(path.resolve(root, target)) !== resolved) return null;
      hash.update(JSON.stringify([target, relative, content.length])).update(content);
      identities.push({ target, resolved, after });
    }
    for (const identity of identities) {
      const current = await fs.stat(identity.resolved, { bigint: true });
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((field) => identity.after[field] !== current[field])
        || await fs.realpath(path.resolve(root, identity.target)) !== identity.resolved) return null;
    }
    return hash.digest('hex');
  } catch { return null; }
};

export const createRequiredCheckObserver = ({ scheduler, now = Date.now }) => {
  const pending = new Map();
  const findTask = ({ sessionId, directory }) => scheduler.getRequiredCheckTask(sessionId, directory);
  return {
    async before(input) {
      if (input.tool !== 'bash' || typeof input.callId !== 'string' || !input.callId) return { tracked: false };
      const task = findTask(input);
      const checks = (task?.requiredChecks ?? []).filter((check) => check.command === input.command);
      if (!task || !checks.length) return { tracked: false };
      const key = `${input.sessionId}:${input.callId}`;
      let receipt = pending.get(key);
      if (!receipt) {
        // Reserve before resolving canonical identity or reading files. Even a
        // later rejected input or a lost hook must not preserve an older pass.
        const accepted = await scheduler.recordRequiredChecks(task.taskId, task.leaseToken, checks.map(check => ({ name: check.name,
            callId: input.callId, messageId: null, exitCode: null, observedAt: now(),
            status: 'not-observed', contentHash: null })), 'start');
        if (!accepted) return { tracked: false };
        try {
          const root = await fs.realpath(task.directory);
          if (input.workdir !== undefined && (typeof input.workdir !== 'string'
            || await fs.realpath(path.resolve(task.directory, input.workdir)) !== root)) return { tracked: false };
        } catch { return { tracked: false }; }
        const content = Object.fromEntries(await Promise.all(checks.map(async (check) => [check.name,
          await fingerprintCheckContent(task.directory, check.paths)])));
        receipt = { taskId: task.taskId, leaseToken: task.leaseToken, directory: task.directory,
          messageId: null, checks, content };
        pending.set(key, receipt);
        while (pending.size > 256) pending.delete(pending.keys().next().value);
      }
      if (receipt.taskId !== task.taskId || receipt.leaseToken !== task.leaseToken) return { tracked: false };
      if (typeof input.messageId !== 'string' || !input.messageId) return { tracked: false, needsIdentity: true };
      const accepted = await scheduler.recordRequiredChecks(task.taskId, task.leaseToken, receipt.checks.map(check => ({ name: check.name,
          callId: input.callId, messageId: input.messageId, exitCode: null, observedAt: now(),
          status: 'not-observed', contentHash: null })), 'bind');
      if (!accepted) { pending.delete(key); return { tracked: false }; }
      receipt.messageId = input.messageId;
      return { tracked: true };
    },
    async after(input) {
      const key = `${input.sessionId}:${input.callId}`;
      const receipt = pending.get(key);
      pending.delete(key);
      if (!receipt || !receipt.messageId || receipt.directory !== input.directory || receipt.messageId !== input.messageId) return { recorded: false };
      const exitCode = Number.isSafeInteger(input.exitCode) ? input.exitCode : null;
      const updates = await Promise.all(receipt.checks.map(async check => {
        const contentHash = await fingerprintCheckContent(receipt.directory, check.paths);
        const stable = contentHash !== null && contentHash === receipt.content[check.name];
        return { name: check.name,
          callId: input.callId, messageId: input.messageId, exitCode, observedAt: now(),
          status: exitCode !== null && exitCode !== 0 ? 'failed' : exitCode === 0 && stable ? 'passed' : 'not-observed',
          contentHash: stable ? contentHash : null };
      }));
      return { recorded: await scheduler.recordRequiredChecks(receipt.taskId, receipt.leaseToken, updates, 'complete') === true };
    },
    async project(task) {
      const checks = task.requiredChecks ?? [];
      const identities = Object.fromEntries(await Promise.all(checks.map(async (check) => [check.name,
        await fingerprintCheckContent(task.directory, check.paths)])));
      return projectRequiredCheckEvidence(checks, task.requiredCheckReceipts ?? [], identities);
    },
    dispose() { pending.clear(); },
  };
};

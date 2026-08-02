import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const locks = new Map();

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const refComponent = (value) => {
  const normalized = asString(value).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  if (normalized && normalized !== '.' && normalized !== '..') return normalized;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
};

const createEvidenceError = (message, code, cause) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'EvidenceGitError';
  error.code = code;
  return error;
};

const defaultExec = ({ cwd, args, env, signal, timeoutMs }) => new Promise((resolve, reject) => {
  const child = execFileCallback(
    'git',
    args,
    {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      signal,
    },
    (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    },
  );
  child.stdin?.end();
});

const withDirectoryLock = async (directory, callback) => {
  const key = path.resolve(directory);
  const existing = locks.get(key);
  const previous = existing ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  locks.set(key, tail);
  const contended = Boolean(existing);
  await previous.catch(() => undefined);
  try {
    return await callback({ contended });
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
};

export const createEvidenceGitRuntime = (options = {}) => {
  const harnessDirectory = path.resolve(options.directory);
  const exec = options.exec ?? defaultExec;
  const fsApi = options.fs ?? fs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const run = async (cwd, args, runOptions = {}) => {
    try {
      return await exec({
        cwd,
        args,
        env: runOptions.env ?? process.env,
        signal: runOptions.signal,
        timeoutMs: runOptions.timeoutMs ?? timeoutMs,
      });
    } catch (error) {
      if (runOptions.allowFailure) {
        return {
          stdout: typeof error?.stdout === 'string' ? error.stdout : '',
          stderr: typeof error?.stderr === 'string' ? error.stderr : '',
          failed: true,
        };
      }
      if (error?.name === 'AbortError' || runOptions.signal?.aborted) {
        throw createEvidenceError('Git evidence capture was aborted', 'EVIDENCE_ABORTED', error);
      }
      if (error?.killed || error?.code === 'ETIMEDOUT') {
        throw createEvidenceError('Git evidence capture timed out', 'EVIDENCE_TIMEOUT', error);
      }
      throw createEvidenceError(
        (typeof error?.stderr === 'string' && error.stderr.trim())
          || error?.message
          || 'Git evidence command failed',
        'EVIDENCE_GIT_FAILED',
        error,
      );
    }
  };

  const resolveRepository = async (directory, signal) => {
    const rootResult = await run(directory, ['rev-parse', '--show-toplevel'], { signal });
    const root = rootResult.stdout.trim();
    if (!root) throw createEvidenceError('Directory is not a Git repository', 'EVIDENCE_NOT_GIT');
    const headResult = await run(root, ['rev-parse', '--verify', 'HEAD'], {
      signal,
      allowFailure: true,
    });
    return {
      root,
      head: headResult.failed ? null : headResult.stdout.trim() || null,
    };
  };

  const capture = async (input = {}) => {
    const directory = path.resolve(asString(input.directory));
    const sessionID = asString(input.sessionID);
    const turnID = asString(input.turnID);
    const phase = input.phase === 'after' ? 'after' : 'before';
    if (!sessionID || !turnID) {
      throw createEvidenceError('sessionID and turnID are required', 'EVIDENCE_INPUT_INVALID');
    }

    return withDirectoryLock(directory, async ({ contended }) => {
      const repository = await resolveRepository(directory, input.signal);
      const capturedAt = now();
      const identityEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'DevRyan Evidence',
        GIT_AUTHOR_EMAIL: 'evidence@devryan.invalid',
        GIT_COMMITTER_NAME: 'DevRyan Evidence',
        GIT_COMMITTER_EMAIL: 'evidence@devryan.invalid',
        GIT_AUTHOR_DATE: new Date(capturedAt).toISOString(),
        GIT_COMMITTER_DATE: new Date(capturedAt).toISOString(),
      };
      const ref = `refs/devryan/evidence/${refComponent(sessionID)}/${refComponent(turnID)}/${phase}`;
      const beforeTree = asString(input.beforeTree);
      const beforeHead = asString(input.beforeHead);
      const beforeCommit = asString(input.beforeCommit);
      if (
        phase === 'after'
        && repository.head
        && beforeTree
        && beforeHead === repository.head
        && beforeCommit
      ) {
        const status = await run(repository.root, [
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
        ], {
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          signal: input.signal,
        });
        const headTree = await run(repository.root, ['rev-parse', 'HEAD^{tree}'], {
          signal: input.signal,
        });
        if (!status.stdout.trim() && headTree.stdout.trim() === beforeTree) {
          const commit = (await run(repository.root, [
            'commit-tree',
            beforeTree,
            '-p',
            beforeCommit,
            '-m',
            'DevRyan turn evidence after',
          ], { env: identityEnv, signal: input.signal })).stdout.trim();
          await run(repository.root, ['update-ref', ref, commit], { signal: input.signal });
          return {
            phase,
            directory: repository.root,
            ref,
            commit,
            tree: beforeTree,
            head: repository.head,
            parent: beforeCommit,
            contended,
            reusedTree: true,
            createdAt: capturedAt,
          };
        }
      }

      const captureDirectory = path.join(harnessDirectory, 'indexes');
      await fsApi.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
      const indexPath = path.join(
        captureDirectory,
        `${refComponent(sessionID)}-${refComponent(turnID)}-${phase}-${crypto.randomUUID()}.index`,
      );
      const env = {
        ...identityEnv,
        GIT_INDEX_FILE: indexPath,
        GIT_WORK_TREE: repository.root,
      };

      try {
        if (repository.head) {
          await run(repository.root, ['read-tree', repository.head], { env, signal: input.signal });
        } else {
          await run(repository.root, ['read-tree', '--empty'], { env, signal: input.signal });
        }
        await run(repository.root, ['add', '-A', '--', '.'], { env, signal: input.signal });
        const tree = (await run(repository.root, ['write-tree'], { env, signal: input.signal })).stdout.trim();
        const parent = phase === 'after'
          ? asString(input.beforeCommit)
          : repository.head;
        const commitArgs = ['commit-tree', tree];
        if (parent) commitArgs.push('-p', parent);
        commitArgs.push('-m', `DevRyan turn evidence ${phase}`);
        const commit = (await run(repository.root, commitArgs, { env, signal: input.signal })).stdout.trim();
        await run(repository.root, ['update-ref', ref, commit], { signal: input.signal });
        return {
          phase,
          directory: repository.root,
          ref,
          commit,
          tree,
          head: repository.head,
          parent: parent || null,
          contended,
          reusedTree: false,
          createdAt: capturedAt,
        };
      } finally {
        await fsApi.rm(indexPath, { force: true }).catch(() => undefined);
        await fsApi.rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
      }
    });
  };

  const diffSummary = async (input = {}) => {
    const directory = path.resolve(asString(input.directory));
    const before = asString(input.beforeCommit);
    const after = asString(input.afterCommit);
    if (!before || !after) throw createEvidenceError('beforeCommit and afterCommit are required', 'EVIDENCE_INPUT_INVALID');
    const result = await run(directory, [
      'diff',
      '--find-renames',
      '--numstat',
      '-z',
      before,
      after,
    ], { signal: input.signal });
    return result.stdout;
  };

  const diffFile = async (input = {}) => {
    const directory = path.resolve(asString(input.directory));
    const before = asString(input.beforeCommit);
    const after = asString(input.afterCommit);
    const file = asString(input.file);
    const beforeFile = asString(input.beforeFile) || file;
    if (!before || !after || !file) {
      throw createEvidenceError('beforeCommit, afterCommit, and file are required', 'EVIDENCE_INPUT_INVALID');
    }
    const result = await run(directory, [
      'diff',
      '--find-renames',
      '--binary',
      '--no-ext-diff',
      before,
      after,
      '--',
      ...(beforeFile !== file ? [beforeFile] : []),
      file,
    ], { signal: input.signal });
    return result.stdout;
  };

  const fileMetadata = async (input = {}) => {
    const directory = path.resolve(asString(input.directory));
    const before = asString(input.beforeCommit);
    const after = asString(input.afterCommit);
    const file = asString(input.file);
    const beforeFile = asString(input.beforeFile) || file;
    if (!before || !after || !file) {
      throw createEvidenceError('beforeCommit, afterCommit, and file are required', 'EVIDENCE_INPUT_INVALID');
    }
    const inspectSpec = async (spec) => {
      const exists = await run(directory, ['cat-file', '-e', spec], {
        signal: input.signal,
        allowFailure: true,
      });
      if (exists.failed) return null;
      const size = await run(directory, ['cat-file', '-s', spec], { signal: input.signal });
      return {
        spec,
        size: Number.parseInt(size.stdout.trim(), 10) || 0,
      };
    };
    const [beforeState, afterState] = await Promise.all([
      inspectSpec(`${before}:${beforeFile}`),
      inspectSpec(`${after}:${file}`),
    ]);
    const selected = afterState ?? beforeState;
    if (!selected) {
      throw createEvidenceError(
        'Evidence file is missing from both checkpoints',
        'EVIDENCE_FILE_NOT_FOUND',
      );
    }
    const spec = selected.spec;
    const objectResult = await run(directory, ['rev-parse', spec], { signal: input.signal });
    const sha256 = await new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(createEvidenceError('Git evidence metadata was aborted', 'EVIDENCE_ABORTED'));
        return;
      }
      const child = spawn('git', ['cat-file', 'blob', spec], {
        cwd: directory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const hash = crypto.createHash('sha256');
      let stderr = '';
      let settled = false;
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => reject(createEvidenceError('Git evidence metadata timed out', 'EVIDENCE_TIMEOUT')));
      }, timeoutMs);
      const onAbort = () => {
        child.kill('SIGKILL');
        settle(() => reject(createEvidenceError('Git evidence metadata was aborted', 'EVIDENCE_ABORTED')));
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => hash.update(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (error) => {
        settle(() => reject(createEvidenceError(error.message, 'EVIDENCE_GIT_FAILED', error)));
      });
      child.once('close', (code) => {
        settle(() => {
          if (code !== 0) {
            reject(createEvidenceError(stderr || 'Git evidence metadata failed', 'EVIDENCE_GIT_FAILED'));
            return;
          }
          resolve(hash.digest('hex'));
        });
      });
    });
    return {
      size: selected.size,
      beforeSize: beforeState?.size ?? null,
      afterSize: afterState?.size ?? null,
      sha256,
      gitBlob: objectResult.stdout.trim(),
      source: afterState ? 'after' : 'before',
    };
  };

  const deleteRef = async ({ directory, ref, signal }) => {
    if (!asString(ref).startsWith('refs/devryan/evidence/')) {
      throw createEvidenceError('Evidence ref is invalid', 'EVIDENCE_REF_INVALID');
    }
    await run(path.resolve(directory), ['update-ref', '-d', ref], { signal });
  };

  return {
    captureBefore: (input) => capture({ ...input, phase: 'before' }),
    captureAfter: (input) => capture({ ...input, phase: 'after' }),
    diffSummary,
    diffFile,
    fileMetadata,
    deleteRef,
  };
};

export {
  DEFAULT_TIMEOUT_MS as DEFAULT_EVIDENCE_TIMEOUT_MS,
  createEvidenceError,
};

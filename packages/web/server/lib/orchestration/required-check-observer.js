import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRequiredCheckEvidence, visualCheckPassed } from '@devryan/orchestration-runtime';
import { verifyRequiredCheckRunnerIdentity } from './required-check-runner.js';
import { requiredCheckCommandIssue, REQUIRED_CHECK_COMMAND_HINT } from './required-check-command.js';

// No source bytes are retained. Confinement, file count, byte count and race
// checks are independent of any declared read-only tool metadata.
export const fingerprintCheckContent = async (directory, paths) => {
  try {
    const root = await fs.realpath(directory);
    const hash = crypto.createHash('sha256');
    const identities = [];
    let bytes = 0;
    const visit = async (target, ancestors = new Set()) => {
      if (identities.length >= 2048 || ancestors.size > 32) throw Error('check_content_limit');
      const resolved = await fs.realpath(path.resolve(root, target));
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('check_content_scope');
      const before = await fs.stat(resolved, { bigint: true });
      if (before.isDirectory()) {
        if (ancestors.has(resolved)) throw Error('check_content_cycle');
        // Directory membership is part of the identity: adding a source or test
        // invalidates old evidence, including an otherwise empty directory.
        const entries = (await fs.readdir(resolved)).sort();
        if (entries.length > 2048) throw Error('check_content_limit');
        hash.update(JSON.stringify([target, relative, 'directory', entries]));
        identities.push({ target, resolved, after: before });
        const next = new Set(ancestors).add(resolved);
        for (const entry of entries) await visit(path.join(target, entry), next);
        return;
      }
      if (!before.isFile() || before.size > 8n * 1024n * 1024n) throw Error('check_content_limit');
      bytes += Number(before.size);
      if (bytes > 32 * 1024 * 1024) throw Error('check_content_limit');
      const content = await fs.readFile(resolved);
      const after = await fs.stat(resolved, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || await fs.realpath(path.resolve(root, target)) !== resolved) throw Error('check_content_changed');
      hash.update(JSON.stringify([target, relative, content.length])).update(content);
      identities.push({ target, resolved, after });
    };
    for (const target of [...paths].sort()) await visit(target);
    for (const identity of identities) {
      const current = await fs.stat(identity.resolved, { bigint: true });
      if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((field) => identity.after[field] !== current[field])
        || await fs.realpath(path.resolve(root, identity.target)) !== identity.resolved) return null;
    }
    return hash.digest('hex');
  } catch { return null; }
};

const readArtifact = async (directory, target, limit = 8 * 1024 * 1024) => {
  if (typeof target !== 'string' || !target || path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) return null;
  const before = await fingerprintCheckContent(directory, [target]);
  if (!before) return null;
  try {
    const file = path.resolve(directory, target), stat = await fs.stat(file);
    if (stat.size > limit) return null;
    const bytes = await fs.readFile(file);
    if (bytes.length > limit || before !== await fingerprintCheckContent(directory, [target])) return null;
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch { return null; }
};

export const readVisualCheckEvidence = async (directory, check) => {
  if (check.kind !== 'visual') return null;
  const report = await readArtifact(directory, check.visual.reportPath, 64 * 1024);
  if (!report) return null;
  try {
    const value = JSON.parse(report.bytes.toString('utf8'));
    if (!value || value.state !== 'populated' || value.dataSource !== check.visual.dataSource
      || !Array.isArray(value.assertions) || value.assertions.length > 32
      || value.assertions.some(item => !item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || !['passed', 'failed'].includes(item.status))
      || new Set(value.assertions.map(item => item.name)).size !== value.assertions.length
      || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 16) return null;
    let bytes = 0;
    const evidence = [];
    for (const reference of value.evidence) {
      if (!reference || typeof reference.path !== 'string' || reference.path.length > 512 || !/^[a-f0-9]{64}$/.test(reference.sha256)) return null;
      const artifact = await readArtifact(directory, reference.path);
      if (!artifact || artifact.sha256 !== reference.sha256 || (bytes += artifact.bytes.length) > 32 * 1024 * 1024) return null;
      evidence.push({ path: reference.path, sha256: artifact.sha256 });
    }
    return { state: value.state, dataSource: value.dataSource, assertions: value.assertions.map(({ name, status }) => ({ name, status })), evidence, reportHash: report.sha256 };
  } catch { return null; }
};

// Only canonical process output diagnoses prerequisites. It never supplies a pass,
// and application/SQL/assertion failures take precedence over environment wording.
export const diagnoseRequiredCheckEnvironment = output => {
  if (typeof output !== 'string' || output.length > 64 * 1024) return null;
  const text = output;
  if (/assertion(?:error| failed)|expect\([^\n]*\)|SQLSTATE|syntax error at or near|violates (?:check|foreign key|unique)|permission denied for (?:table|schema|relation)|(?:column|relation|table|schema|function|operator|type|constraint|database)\s+[^\n]{1,256}\s+does not exist|(?:FAIL|FAILED)\s+[^\n]*(?:test|spec)/i.test(text)) return null;
  const uidMapping = /(?:uid_map|gid_map|newuidmap|newgidmap)[^\n]*(?:operation not permitted|permission denied|not allowed)|(?:operation not permitted|permission denied)[^\n]*(?:uid_map|gid_map|newuidmap|newgidmap)/i;
  const uidResolution = /^(?:ssh:\s*)?No user exists for uid [0-9]+[.!]?$/i;
  const dockerSocket = /permission denied[^\n]*(?:docker\.sock|docker daemon)|(?:docker\.sock|docker daemon)[^\n]*permission denied/i;
  const dockerDaemon = /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|docker[^\n]*daemon[^\n]*unavailable/i;
  const dockerSocketMissing = /^ENOENT: no such file or directory, l?stat ['"](?:\/(?:var\/)?run\/docker\.sock|\/run\/user\/[0-9]+\/docker\.sock|\/(?:Users|home)\/[^/\r\n]+\/\.docker\/run\/docker\.sock)['"]$/i;
  for (const line of text.split(/\r?\n/)) {
    const diagnostic = line.trim().replace(/^(?:error|fatal):\s*/i, '');
    const prerequisite = uidMapping.test(diagnostic) || uidResolution.test(diagnostic) || dockerSocket.test(diagnostic) || dockerDaemon.test(diagnostic) || dockerSocketMissing.test(diagnostic);
    // A wrapper's Error: prefix is allowed only on a known prerequisite. Any
    // additional failure line keeps the check failed, even alongside Docker.
    const uidWriteFailure = /^(?:newuidmap|newgidmap): write to (?:uid_map|gid_map) failed: (?:operation not permitted|permission denied)$/i.test(diagnostic);
    if (!prerequisite && (/^\s*(?:error|fatal):/i.test(line) || /\bENOENT\b/i.test(diagnostic))
      || /\b(?:[a-z]*errors?|fatal|fail(?:ed|ure)?|exception)\b/i.test(diagnostic) && !uidWriteFailure) return null;
  }
  if (text.split(/\r?\n/).some(line => uidResolution.test(line.trim().replace(/^(?:error|fatal):\s*/i, ''))) || uidMapping.test(text)) {
    return { reason: 'uid_mapping_unavailable', hint: 'Run this check in the documented environment with the current UID resolvable and required user namespace mapping available. Retain the failed exit and continue independent checks; do not widen workspace access.' };
  }
  if (dockerSocket.test(text)) {
    return { reason: 'docker_socket_denied', hint: 'Use the documented Docker-enabled verification environment or ask the operator to restore daemon access; retain the failed exit and continue independent checks. Do not change socket permissions.' };
  }
  if (dockerDaemon.test(text) || text.split(/\r?\n/).some(line => dockerSocketMissing.test(line.trim().replace(/^(?:error|fatal):\s*/i, '')))) {
    return { reason: 'docker_daemon_unavailable', hint: 'Start the documented Docker daemon or use the documented integration runner, then rerun this exact check. Continue independent implementation and checks meanwhile.' };
  }
  return null;
};

export const createRequiredCheckObserver = ({ scheduler, now = Date.now, verifyCheckRunner }) => {
  const pending = new Map();
  const identityFor = async (task, check, directory = task.directory) => {
    const correction = task.requiredCheckCorrections?.findLast(entry => entry.name === check.name);
    const bind = content => content === null ? null : crypto.createHash('sha256').update(JSON.stringify([check.command, check.cwd ?? '.', check.environment ?? 'native', content])).digest('hex');
    if (!correction) return bind(await fingerprintCheckContent(directory, check.paths));
    try {
      if (check.command !== correction.command) return null;
      const runner = await verifyRequiredCheckRunnerIdentity({ directory, check, correction, verifyRunner: verifyCheckRunner, allowManifestRefresh: true });
      return bind(await fingerprintCheckContent(directory, [...new Set([...check.paths, runner.packagePath, runner.scriptPath])]));
    } catch { return null; }
  };
  const before = async (input, task) => {
    let checks = (task?.requiredChecks ?? []).filter(check => check.command === input.command
      && (check.environment ?? 'native') === (input.environment ?? 'native'));
    if (!task || !checks.length) return { tracked: false };
    const owner = task.taskId ?? { rootSessionId: task.rootSessionId, directory: task.directory, objectiveId: task.objectiveId };
    const key = `${JSON.stringify(owner)}:${input.sessionId}:${input.callId}`;
    let receipt = pending.get(key);
    if (!receipt) {
      const accepted = await scheduler.recordRequiredChecks(owner, task.leaseToken, checks.map(check => ({ name: check.name,
        callId: input.callId, messageId: null, exitCode: null, observedAt: now(), status: 'not-observed', contentHash: null })), 'start');
      if (!accepted) return { tracked: false };
      try {
        const root = await fs.realpath(task.directory);
        if (input.workdir !== undefined && typeof input.workdir !== 'string') return { tracked: false };
        const actual = await fs.realpath(path.resolve(task.directory, input.workdir ?? '.'));
        if (path.relative(root, actual).split(path.sep).includes('..')) return { tracked: false };
        const matched = [];
        for (const check of checks) if (actual === await fs.realpath(path.resolve(task.directory, check.cwd ?? '.'))) matched.push(check);
        checks = matched;
        if (!checks.length) return { tracked: false };
      } catch { return { tracked: false }; }
      // Only the native execution host supplies this private-view identity.
      // The compatibility RPC strips it; model arguments cannot select it.
      const executionDirectory=input.executionDirectory===undefined?task.directory:await fs.realpath(input.executionDirectory);
      const content = Object.fromEntries(await Promise.all(checks.map(async check => [check.name, await identityFor(task, check, executionDirectory)])));
      const published = Object.fromEntries(await Promise.all(checks.map(async check => [check.name, await identityFor(task, check)])));
      for(const check of checks)if(content[check.name]!==published[check.name])content[check.name]=null;
      receipt = { owner, taskId: task.taskId, leaseToken: task.leaseToken, directory: task.directory, sessionId: input.sessionId,
        callId: input.callId, messageId: null, checks, content, executionDirectory, task };
      pending.set(key, receipt);
      while (pending.size > 256) pending.delete(pending.keys().next().value);
    }
    if (JSON.stringify(receipt.owner) !== JSON.stringify(owner) || receipt.leaseToken !== task.leaseToken) return { tracked: false };
    if (typeof input.messageId !== 'string' || !input.messageId) return { tracked: false, needsIdentity: true };
    const accepted = await scheduler.recordRequiredChecks(owner, task.leaseToken, receipt.checks.map(check => ({ name: check.name,
      callId: input.callId, messageId: input.messageId, exitCode: null, observedAt: now(), status: 'not-observed', contentHash: null })), 'bind');
    if (!accepted) { pending.delete(key); return { tracked: false }; }
    receipt.messageId = input.messageId;
    return { tracked: true };
  };
  return {
    async before(input) {
      if (input.tool !== 'bash' || typeof input.callId !== 'string' || !input.callId) return { tracked: false };
      const tasks = scheduler.getRequiredCheckTasks?.(input.sessionId, input.directory)
        ?? [scheduler.getRequiredCheckTask(input.sessionId, input.directory)].filter(Boolean);
      const root = input.objectiveId ? scheduler.getObjectiveRequiredChecks?.({ rootSessionId: input.sessionId, directory: input.directory, objectiveId: input.objectiveId }) : null;
      const results = await Promise.all([...tasks, ...(root ? [root] : [])].map(task => before(input, task)));
      return { tracked: results.some(result => result.tracked), ...(results.some(result => result.needsIdentity) ? { needsIdentity: true } : {}) };
    },
    async after(input) {
      const results = [];
      for (const [key, receipt] of pending) {
        if (receipt.sessionId !== input.sessionId || receipt.callId !== input.callId) continue;
        pending.delete(key);
        if (!receipt.messageId || receipt.directory !== input.directory || receipt.messageId !== input.messageId
          || !receipt.taskId && input.objectiveId !== receipt.owner.objectiveId) continue;
        const exitCode = Number.isSafeInteger(input.exitCode) ? input.exitCode : null;
        const updates = await Promise.all(receipt.checks.map(async check => {
          const current = (receipt.taskId ? scheduler.getRequiredCheckTasks?.(input.sessionId, input.directory)?.find(task => task.taskId === receipt.taskId)
            : scheduler.getObjectiveRequiredChecks?.(receipt.owner)) ?? receipt.task;
          const currentCheck = current.requiredChecks?.find(entry => entry.name === check.name);
          const contentHash = currentCheck?.command === check.command ? await identityFor(current, currentCheck) : null;
          const executionHash = currentCheck?.command === check.command ? await identityFor(current, currentCheck, receipt.executionDirectory) : null;
          const stable = contentHash !== null && contentHash === receipt.content[check.name] && executionHash===contentHash;
          const visual = check.kind === 'visual' ? await readVisualCheckEvidence(receipt.directory, check) : undefined;
          const visualPassed = check.kind !== 'visual' || visualCheckPassed(check, visual);
          const commandIssue = requiredCheckCommandIssue(check.command);
          const environmentUnavailable = stable && input.outputComplete === true && exitCode !== null && exitCode !== 0 && !commandIssue
            && !visual?.assertions.some(item => item.status === 'failed') ? diagnoseRequiredCheckEnvironment(input.output) : null;
          return { name: check.name, callId: input.callId, messageId: input.messageId, exitCode, observedAt: now(),
            status: environmentUnavailable ? 'skipped' : exitCode !== null && exitCode !== 0 || visual?.assertions.some(item => item.status === 'failed') ? 'failed'
              : exitCode === 0 && stable && visualPassed && !commandIssue ? 'passed' : exitCode === 0 && (commandIssue || check.kind === 'visual' || current.requiredCheckCorrections?.some(entry => entry.name === check.name)) ? 'blocked' : 'not-observed',
            contentHash: stable ? contentHash : null, ...(environmentUnavailable ? { environmentUnavailable } : {}), ...(visual ? { visual } : {}) };
        }));
        results.push(await scheduler.recordRequiredChecks(receipt.owner, receipt.leaseToken, updates, 'complete') === true);
      }
      return { recorded: results.some(Boolean) };
    },
    async project(task) {
      const checks = task.requiredChecks ?? [];
      const identities = Object.fromEntries(await Promise.all(checks.map(async check => [check.name, await identityFor(task, check)])));
      const visualFreshness = Object.fromEntries(await Promise.all(checks.filter(check => check.kind === 'visual').map(async check => {
        const current = await readVisualCheckEvidence(task.directory, check);
        const receipt = task.requiredCheckReceipts?.find(receipt => receipt.name === check.name);
        return [check.name, current !== null && current.reportHash === receipt?.visual?.reportHash];
      })));
      return projectRequiredCheckEvidence(checks, task.requiredCheckReceipts ?? [], identities, visualFreshness).map(evidence => {
        if (['failed', 'waived', 'skipped'].includes(evidence.status)) return evidence;
        const issue = requiredCheckCommandIssue(checks.find(check => check.name === evidence.name).command);
        if (issue) return { ...evidence, status: 'blocked', reason: issue, hint: REQUIRED_CHECK_COMMAND_HINT };
        return identities[evidence.name] === null && task.requiredCheckCorrections?.some(entry => entry.name === evidence.name)
          ? { ...evidence, status: 'blocked', reason: 'required_check_runner_unverified' } : evidence;
      });
    },
    dispose() { pending.clear(); },
  };
};

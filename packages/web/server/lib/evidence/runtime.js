import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createEvidenceGitRuntime,
  createEvidenceLedger,
  createRecordStore,
  createTurnEvidenceRuntime,
  validateEvidenceRecord,
} from '@openchamber/harness-runtime';
import { createProjectIdFromPath } from '../projects/project-id.js';

const execFileAsync = promisify(execFile);

const resolvePrimaryRepository = async (directory) => {
  const resolvedDirectory = path.resolve(String(directory || ''));
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--git-common-dir'],
    {
      cwd: resolvedDirectory,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const commonDirectory = path.resolve(resolvedDirectory, String(stdout || '').trim());
  return path.dirname(commonDirectory);
};

export const createWebEvidenceRuntime = (options = {}) => {
  const evidenceDirectory = options.evidenceDirectory;
  const store = createRecordStore({
    directory: path.join(evidenceDirectory, 'records'),
    validateRecord: validateEvidenceRecord,
    logger: options.logger ?? console,
  });
  const git = createEvidenceGitRuntime({
    directory: evidenceDirectory,
    timeoutMs: options.timeoutMs,
  });
  const ledger = createEvidenceLedger({
    store,
    deleteRef: (input) => git.deleteRef(input),
    onTransition: (record) => {
      options.journal?.enqueue({
        type: 'evidence_transition',
        at: Date.now(),
        runtime: options.runtime ?? 'web',
        directory: record.directory,
        sessionID: record.sessionID,
        turnID: record.turnID,
        checkpointID: record.checkpointID,
        status: record.status,
        payload: record,
      });
    },
  });
  const projectCache = new Map();

  const resolveProject = async (directory) => {
    const key = path.resolve(String(directory || ''));
    const cached = projectCache.get(key);
    if (cached) return cached;
    const primaryDirectory = await resolvePrimaryRepository(key);
    const project = {
      primaryDirectory,
      projectID: createProjectIdFromPath(primaryDirectory),
    };
    projectCache.set(key, project);
    projectCache.set(primaryDirectory, project);
    return project;
  };

  const turnRuntime = createTurnEvidenceRuntime({
    ledger,
    git,
    resolveProjectDirectory: async (directory) => (
      (await resolveProject(directory)).primaryDirectory
    ),
    isEnabled: async (directory) => {
      try {
        const project = await resolveProject(directory);
        return (await options.projectConfigRuntime.getEvidenceCheckpoints(project.projectID)).enabled;
      } catch {
        return false;
      }
    },
    resolveSessionState: async (record) => {
      const status = options.getSessionActivity?.(record.sessionID)?.type;
      if (status === 'busy' || status === 'retry') return 'busy';
      if (status === 'idle' || status === 'cooldown') return 'idle';
      return 'unknown';
    },
    onGap: (input) => {
      options.journal?.enqueue({
        type: 'gap',
        at: Date.now(),
        runtime: options.runtime ?? 'web',
        reason: String(input.reason || 'evidence_capture_failed'),
        source: 'turn_evidence',
        payload: input,
      });
    },
  });

  return {
    initialize: () => turnRuntime.initialize(),
    processLifecycleEvent: (event) => turnRuntime.processLifecycleEvent(event),
    async processOpenCodeEvent(payload) {
      if (payload?.type !== 'session.deleted') return;
      const sessionID = payload?.properties?.info?.id
        ?? payload?.properties?.sessionID
        ?? null;
      if (typeof sessionID === 'string' && sessionID) {
        await turnRuntime.deleteSession(sessionID);
      }
    },
    async getProjectSetting(directory) {
      const project = await resolveProject(directory);
      return {
        ...await options.projectConfigRuntime.getEvidenceCheckpoints(project.projectID),
        projectID: project.projectID,
        directory: project.primaryDirectory,
      };
    },
    async setProjectSetting(directory, value) {
      const project = await resolveProject(directory);
      return {
        ...await options.projectConfigRuntime.setEvidenceCheckpoints(project.projectID, value),
        projectID: project.projectID,
        directory: project.primaryDirectory,
      };
    },
    listBySession: (input) => turnRuntime.listPublicBySession(input),
    getDiff: (checkpointID, file) => turnRuntime.getDiff(checkpointID, file),
    async clearProject(directory) {
      const project = await resolveProject(directory);
      return turnRuntime.clearProject(project.primaryDirectory);
    },
    async getRecords() {
      return turnRuntime.listBySession();
    },
    beginDrain: () => turnRuntime.beginDrain(),
    drain: () => turnRuntime.drain(),
  };
};

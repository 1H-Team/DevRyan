import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import type * as vscode from 'vscode';
import {
  createDiagnosticJournal,
  createDiagnosticSanitizer,
  createEvidenceGitRuntime,
  createEvidenceLedger,
  createHarnessPaths,
  createLifecycleTracker,
  createPromptAdmissionController,
  createRecordStore,
  createTurnEvidenceRuntime,
  type CommandDeadlineController,
  type CommandDeadlineRecord,
  type DiagnosticJournal,
  type DiagnosticSanitizer,
  type DiagnosticsStatus,
  type ContextModeRecoveryStatus,
  type HarnessPaths,
  type LifecycleTracker,
  type PromptAdmissionBlock,
  type RecordStore,
  type WorktreeBootstrapReceipt,
  type WorktreeBootstrapRuntime,
  type EvidenceRecord,
  type TurnEvidenceRuntime,
  validateCommandDeadlineRecord,
  validateEvidenceRecord,
  validateWorktreeBootstrapReceipt,
} from '@openchamber/harness-runtime';
import {
  configureWorktreeBootstrapRuntime,
  resolvePrimaryWorktreeDirectory,
} from './gitService';
import {
  persistProjectEvidenceCheckpointSetting,
  readProjectEvidenceCheckpointSetting,
} from './bridge-settings-runtime';
import { getSessionActivitySnapshot } from './sessionActivityWatcher';
import {
  getVsCodeHarnessRuntime,
  setVsCodeHarnessRuntime,
  takeVsCodeHarnessRuntime,
} from './harness-runtime-access';

type PromptInput = {
  sessionID?: string;
  messageID?: string;
  directory?: string;
  path?: string;
  body?: unknown;
};

type PublicEvidenceRecord = Pick<
  EvidenceRecord,
  | 'checkpointID'
  | 'directory'
  | 'sessionID'
  | 'turnID'
  | 'userMessageID'
  | 'status'
  | 'contended'
  | 'gapReason'
  | 'createdAt'
  | 'updatedAt'
>;

export interface VsCodeHarnessRuntime {
  paths: HarnessPaths;
  sanitizer: DiagnosticSanitizer;
  journal: DiagnosticJournal;
  lifecycle: LifecycleTracker;
  worktreeStore: RecordStore<WorktreeBootstrapReceipt>;
  commandDeadlineStore: RecordStore<CommandDeadlineRecord>;
  worktreeRuntime: WorktreeBootstrapRuntime;
  evidenceRuntime: TurnEvidenceRuntime;
  initialize(): Promise<void>;
  isReady(): boolean;
  isAcceptingPrompts(): boolean;
  getPromptAdmissionBlock(): PromptAdmissionBlock | null;
  acquirePromptAdmissionHold(
    name: string,
    block?: Partial<Omit<PromptAdmissionBlock, 'name'>>,
  ): () => boolean;
  setContextModeRecoveryStatusProvider(provider: () => ContextModeRecoveryStatus | null): void;
  setCommandDeadlineRuntime(runtime: CommandDeadlineController): void;
  observeCommandDeadlineEvent(payload: unknown, directory?: string | null): Promise<boolean>;
  reconcileCommandDeadlines(): Promise<void>;
  beginDrain(): void;
  record(entry: Record<string, unknown>): boolean;
  recordPrompt(input: PromptInput): void;
  recordControl(input: PromptInput & { action: string }): void;
  recordOpenCodeEvent(payload: unknown, directory?: string | null): void;
  getEvidenceProjectSetting(directory: string): Promise<{ enabled: boolean; projectID: string; directory: string }>;
  setEvidenceProjectSetting(directory: string, enabled: boolean): Promise<{ enabled: boolean; projectID: string; directory: string }>;
  listEvidence(
    sessionID: string,
    directory?: string,
    userMessageID?: string,
  ): Promise<PublicEvidenceRecord[]>;
  getEvidenceDiff(checkpointID: string, file?: string): Promise<Record<string, unknown>>;
  clearProjectEvidence(directory: string): Promise<number>;
  getEvidenceRecords(scope?: { scope?: string; sessionID?: string; directory?: string }): Promise<EvidenceRecord[]>;
  getWorktreeReceipts(): Promise<WorktreeBootstrapReceipt[]>;
  getStatus(): Promise<DiagnosticsStatus>;
  drain(): Promise<void>;
}

const getEventPayload = (value: unknown): {
  payload: unknown;
  directory: string | null;
} => {
  if (!value || typeof value !== 'object') {
    return { payload: value, directory: null };
  }
  const record = value as Record<string, unknown>;
  if ('payload' in record && typeof record.directory === 'string') {
    return {
      payload: record.payload,
      directory: record.directory,
    };
  }
  return { payload: value, directory: null };
};

const getEventSessionID = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const properties = (payload as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object') return null;
  const record = properties as Record<string, unknown>;
  if (typeof record.sessionID === 'string') return record.sessionID;
  const info = record.info;
  return info && typeof info === 'object' && typeof (info as { sessionID?: unknown }).sessionID === 'string'
    ? String((info as { sessionID: string }).sessionID)
    : null;
};

export const createVsCodeHarnessRuntime = (
  context: vscode.ExtensionContext,
): VsCodeHarnessRuntime => {
  const paths = createHarnessPaths({ rootDir: context.globalStorageUri.fsPath });
  const sanitizer = createDiagnosticSanitizer({
    homeDir: os.homedir(),
    dataDir: context.globalStorageUri.fsPath,
    knownSecrets: Object.entries(process.env)
      .filter(([key, value]) => (
        /(?:secret|token|password|api[_-]?key|authorization)/i.test(key)
        && typeof value === 'string'
        && value.length >= 6
      ))
      .map(([, value]) => value as string),
  });
  const journal = createDiagnosticJournal({
    directory: paths.journalDir,
    sanitizer,
    runtime: 'vscode',
    maxBytes: 256 * 1024 * 1024,
  });
  const worktreeStore = createRecordStore<WorktreeBootstrapReceipt>({
    directory: paths.worktreeOpsDir,
    validateRecord: validateWorktreeBootstrapReceipt,
    logger: console,
  });
  const commandDeadlineStore = createRecordStore<CommandDeadlineRecord>({
    directory: paths.commandDeadlineDir,
    validateRecord: validateCommandDeadlineRecord,
    logger: console,
  });
  const worktreeRuntime = configureWorktreeBootstrapRuntime({
    store: worktreeStore,
    onTransition: (receipt) => {
      journal.enqueue({
        type: 'worktree_transition',
        runtime: 'vscode',
        at: Date.now(),
        operationID: receipt.operationId,
        directory: receipt.directory,
        payload: receipt,
      });
    },
  });
  const evidenceStore = createRecordStore<EvidenceRecord>({
    directory: path.join(paths.evidenceDir, 'records'),
    validateRecord: validateEvidenceRecord,
    logger: console,
  });
  const evidenceGit = createEvidenceGitRuntime({
    directory: paths.evidenceDir,
  });
  const evidenceLedger = createEvidenceLedger({
    store: evidenceStore,
    deleteRef: (input) => evidenceGit.deleteRef(input),
    onTransition: (evidence) => {
      journal.enqueue({
        type: 'evidence_transition',
        at: Date.now(),
        runtime: 'vscode',
        directory: evidence.directory,
        sessionID: evidence.sessionID,
        turnID: evidence.turnID,
        checkpointID: evidence.checkpointID,
        status: evidence.status,
        payload: evidence,
      });
    },
  });
  const projectCache = new Map<string, { primaryDirectory: string; projectID: string }>();
  const resolveEvidenceProject = async (directory: string) => {
    const key = path.resolve(directory);
    const cached = projectCache.get(key);
    if (cached) return cached;
    const primaryDirectory = await resolvePrimaryWorktreeDirectory(key);
    const projectID = crypto.createHash('sha256').update(primaryDirectory).digest('hex');
    const project = { primaryDirectory, projectID };
    projectCache.set(key, project);
    projectCache.set(primaryDirectory, project);
    return project;
  };
  const evidenceRuntime = createTurnEvidenceRuntime({
    ledger: evidenceLedger,
    git: evidenceGit,
    resolveProjectDirectory: async (directory) => (
      (await resolveEvidenceProject(directory)).primaryDirectory
    ),
    isEnabled: async (directory) => {
      try {
        const project = await resolveEvidenceProject(directory);
        return readProjectEvidenceCheckpointSetting(project.projectID, { context }).enabled;
      } catch {
        return false;
      }
    },
    resolveSessionState: async (record) => {
      const status = getSessionActivitySnapshot()[record.sessionID]?.type;
      if (status === 'busy') return 'busy';
      if (status === 'idle' || status === 'cooldown') return 'idle';
      return 'unknown';
    },
    onGap: (input) => {
      journal.enqueue({
        type: 'gap',
        at: Date.now(),
        runtime: 'vscode',
        reason: String(input.reason || 'evidence_capture_failed'),
        source: 'turn_evidence',
        payload: input,
      });
    },
  });

  const promptAdmission = createPromptAdmissionController();
  let getContextModeRecoveryStatus: () => ContextModeRecoveryStatus | null = () => null;
  let commandDeadlineRuntime: CommandDeadlineController | null = null;
  let initialization: Promise<void> | null = null;

  const record = (entry: Record<string, unknown>): boolean => journal.enqueue({
    runtime: 'vscode',
    at: Date.now(),
    ...entry,
  });
  const lifecycle = createLifecycleTracker({
    onTurnEvent: (event) => {
      record({
        type: 'lifecycle',
        event: event.type,
        sessionID: event.sessionID,
        directory: event.directory,
        turnID: event.turnID,
        userMessageID: event.userMessageID,
        assistantMessageID: event.assistantMessageID,
        payload: event,
      });
      evidenceRuntime.processLifecycleEvent(event);
    },
  });

  const runtime: VsCodeHarnessRuntime = {
    paths,
    sanitizer,
    journal,
    lifecycle,
    worktreeStore,
    commandDeadlineStore,
    worktreeRuntime,
    evidenceRuntime,
    initialize() {
      initialization ??= Promise.all([
        journal.initialize(),
        commandDeadlineStore.initialize(),
        worktreeRuntime.initialize(),
        evidenceRuntime.initialize(),
      ])
        .then(async () => {
          await worktreeRuntime.reconcileOnStartup();
          promptAdmission.markReady();
        });
      return initialization;
    },
    isReady: promptAdmission.isReady,
    isAcceptingPrompts: promptAdmission.isAccepting,
    getPromptAdmissionBlock: promptAdmission.getBlock,
    acquirePromptAdmissionHold: promptAdmission.acquireHold,
    setContextModeRecoveryStatusProvider(provider) {
      getContextModeRecoveryStatus = provider;
    },
    setCommandDeadlineRuntime(nextRuntime) {
      commandDeadlineRuntime = nextRuntime;
    },
    observeCommandDeadlineEvent(payload, directory = null) {
      return commandDeadlineRuntime?.observe(payload, directory) ?? Promise.resolve(false);
    },
    reconcileCommandDeadlines() {
      return commandDeadlineRuntime?.reconcile() ?? Promise.resolve();
    },
    beginDrain() {
      promptAdmission.beginDrain();
    },
    record,
    recordPrompt(input) {
      record({
        type: 'prompt',
        sessionID: input.sessionID || null,
        directory: input.directory || null,
        messageID: input.messageID || null,
        payload: {
          path: input.path || null,
          body: input.body,
        },
      });
    },
    recordControl(input) {
      record({
        type: 'control',
        sessionID: input.sessionID || null,
        directory: input.directory || null,
        action: input.action,
        payload: {
          path: input.path || null,
          body: input.body,
        },
      });
    },
    recordOpenCodeEvent(value, directory = null) {
      const normalized = getEventPayload(value);
      const resolvedDirectory = normalized.directory || directory;
      record({
        type: 'open_code_event',
        directory: resolvedDirectory,
        sessionID: getEventSessionID(normalized.payload),
        payload: normalized.payload,
      });
      lifecycle.processEvent(normalized.payload);
      void commandDeadlineRuntime?.observe(normalized.payload, resolvedDirectory);
      if (
        normalized.payload
        && typeof normalized.payload === 'object'
        && (normalized.payload as { type?: unknown }).type === 'session.deleted'
      ) {
        const properties = (normalized.payload as { properties?: unknown }).properties;
        const sessionID = properties && typeof properties === 'object'
          ? String(
              (properties as { sessionID?: unknown }).sessionID
              || ((properties as { info?: { id?: unknown } }).info?.id)
              || '',
            )
          : '';
        if (sessionID) void evidenceRuntime.deleteSession(sessionID);
      }
    },
    async getEvidenceProjectSetting(directory) {
      const project = await resolveEvidenceProject(directory);
      return {
        ...readProjectEvidenceCheckpointSetting(project.projectID, { context }),
        projectID: project.projectID,
        directory: project.primaryDirectory,
      };
    },
    async setEvidenceProjectSetting(directory, enabled) {
      const project = await resolveEvidenceProject(directory);
      return {
        ...await persistProjectEvidenceCheckpointSetting(
          project.projectID,
          { enabled },
          { context },
        ),
        projectID: project.projectID,
        directory: project.primaryDirectory,
      };
    },
    listEvidence: (sessionID, directory, userMessageID) => evidenceRuntime.listPublicBySession({
      sessionID,
      directory,
      userMessageID,
    }),
    getEvidenceDiff: (checkpointID, file) => evidenceRuntime.getDiff(checkpointID, file),
    async clearProjectEvidence(directory) {
      const project = await resolveEvidenceProject(directory);
      return evidenceRuntime.clearProject(project.primaryDirectory);
    },
    getEvidenceRecords: () => evidenceRuntime.listBySession(),
    async getWorktreeReceipts() {
      return (await worktreeStore.listRecords()).map(({ record: receipt }) => receipt);
    },
    async getStatus() {
      return {
        ...await journal.getStatus(),
        contextModeRecovery: getContextModeRecoveryStatus(),
        commandDeadlineRecovery: commandDeadlineRuntime?.getStatus() ?? null,
      };
    },
    async drain() {
      promptAdmission.beginDrain();
      await Promise.allSettled([
        journal.close(),
        worktreeRuntime.drain(),
        evidenceRuntime.drain(),
        commandDeadlineRuntime?.drain(),
        worktreeStore.drain(),
        commandDeadlineStore.drain(),
        evidenceStore.drain(),
      ]);
    },
  };
  return runtime;
};

export const initializeVsCodeHarnessRuntime = async (
  context: vscode.ExtensionContext,
): Promise<VsCodeHarnessRuntime> => {
  let runtime = getVsCodeHarnessRuntime();
  if (!runtime) {
    runtime = createVsCodeHarnessRuntime(context);
    setVsCodeHarnessRuntime(runtime);
  }
  await runtime.initialize();
  return runtime;
};

export const drainVsCodeHarnessRuntime = async (): Promise<void> => {
  const runtime = takeVsCodeHarnessRuntime();
  await runtime?.drain();
};

export type CursorRuntimeStatus = {
  providerId: string;
  bridge: { kind: 'cursor-sdk' };
  sdkAuthConfigured: boolean;
  usageAuthConfigured: boolean;
  ripgrepConfigured?: boolean;
  ripgrepSource?: 'explicit' | 'electron-resources' | 'package' | 'path' | 'unsupported' | 'missing';
  ripgrepUsable?: boolean;
  ripgrepResolvedSource?: 'explicit' | 'electron-resources' | 'package' | 'path' | 'unsupported' | 'missing';
  ripgrepConfigureSupported?: boolean;
  workerMode?: 'direct' | 'node-worker' | 'persistent-node-worker';
  workerReady?: boolean;
  workerRestarts?: number;
  activeRuns: number;
  modelsSource: 'sdk' | 'fallback' | 'unavailable';
  modelCount?: number;
  modelsRefreshing?: boolean;
  lastModelRefreshStartedAt?: number | null;
  lastModelRefreshCompletedAt?: number | null;
  lastModelRefreshDurationMs?: number | null;
  lastModelRefreshReason?: string | null;
  lastModelRefreshTimedOut?: boolean;
  lastModelRefreshError?: string | null;
  lastWorkerTiming?: {
    sessionID?: string;
    messageID?: string | null;
    runtime?: 'node-worker' | 'persistent-node-worker';
    spawnedAt?: number;
    firstEventAt?: number | null;
    startupDurationMs?: number | null;
    exitAt?: number | null;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  lastError?: string | null;
  lastCancellation?: {
    sessionID: string;
    assistantMessageID: string;
    source: 'user_abort' | 'model_boundary' | 'provider_or_runtime';
    finalStatus: string;
    at: number;
  } | null;
  lastPostTaskEmptyFinish?: {
    sessionID: string;
    assistantMessageID: string;
    at: number;
  } | null;
};

export type CursorModelCapabilities = {
  attachment: boolean;
  input: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
  output: {
    text: boolean;
    audio: boolean;
    image: boolean;
    video: boolean;
    pdf: boolean;
  };
};

export type CursorModelRecord = {
  id: string;
  name: string;
  description?: string;
  limit?: {
    context?: number;
  };
  options?: {
    cursorSdkModel?: {
      id: string;
      params?: Array<{ id: string; value: string }>;
    };
  };
  variants?: Record<string, {
    limit?: {
      context?: number;
    };
    cursorSdkModel?: {
      id: string;
      params?: Array<{ id: string; value: string }>;
    };
  }>;
  capabilities: CursorModelCapabilities;
};

export type CursorSdkModelSelection = {
  id: string;
  params?: Array<{ id: string; value: string }>;
};

export type CursorSdkAgentDefinition = {
  description: string;
  prompt: string;
  model?: CursorSdkModelSelection | 'inherit';
};

export type CursorSdkAgentDefinitions = Record<string, CursorSdkAgentDefinition>;

export type CursorQuestionRequest = {
  id: string;
  sessionID: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }>;
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type CursorSdkRuntime = {
  getRuntimeStatus(): CursorRuntimeStatus;
  verifyConnection(): Promise<CursorRuntimeStatus & { ok: boolean; configured: boolean }>;
  prewarm(): Promise<CursorRuntimeStatus & { ok: boolean; configured: boolean }>;
  prewarmSession(input: {
    sessionID: string;
    directory?: string | null;
    modelID?: string | null;
    variant?: string | null;
    agent?: string | null;
    messageID?: string | null;
  }): Promise<{ ok: boolean; agentID?: string; cacheHit?: boolean; error?: string }>;
  getVirtualProvider(): Promise<{ id: string; name: string; models: Record<string, CursorModelRecord> }>;
  getCachedVirtualProvider(): { id: string; name: string; models: Record<string, CursorModelRecord> };
  refreshVirtualProvider(options?: { force?: boolean; reason?: string; timeoutMs?: number }): Promise<{ id: string; name: string; models: Record<string, CursorModelRecord> }>;
  generateTitle(input: {
    text: string;
    directory?: string | null;
  }): Promise<string | null>;
  handlePromptAsync(input: {
    sessionID: string;
    body: Record<string, unknown>;
    directory?: string | null;
  }): Promise<{ handled: boolean; status?: number; body?: Record<string, unknown> }>;
  getSessionStatus(): Record<string, { type: string }>;
  listPendingQuestions(options?: { directory?: string | null }): CursorQuestionRequest[];
  replyToQuestion(requestID: string, answers: string[][]): Promise<boolean>;
  rejectQuestion(requestID: string): Promise<boolean>;
  abortSession(sessionID: string): Promise<boolean>;
  getSessionMessages(sessionID: string): Promise<Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>>;
  deleteSessionState(sessionID: string): Promise<boolean>;
  dispose(): Promise<void>;
};

export type WorkspaceDiffFile = {
  relativePath: string;
  filePath: string;
  additions: number;
  deletions: number;
  patch: string;
};

export function filterWorkspaceDiffFilesAgainstBaseline(baselineDiff: string, currentDiff: string): WorkspaceDiffFile[];
export function isLossyStreamedTextVariant(streamedText: string, finalText: string): boolean;
export const MAX_UNTRACKED_FILE_BYTES: number;
export function resetUntrackedDiffCacheForTests(): void;
export function defaultGetWorkspaceDiff(directory: string): Promise<string>;

export const CURSOR_PROVIDER_ID: 'cursor-acp';
export function getCursorSdkApiKey(options?: { env?: Record<string, unknown>; readAuth?: () => CursorAuthFile }): string | null;
export function isCursorUsageAuthConfigured(auth: CursorAuthFile): boolean;
export function saveCursorSdkAuth(options: {
  readAuth: () => CursorAuthFile;
  writeAuth: (auth: CursorAuthFile) => void;
  key: string;
  type?: string;
}): void;
export function clearCursorSdkAuth(options: {
  readAuth: () => CursorAuthFile;
  writeAuth: (auth: CursorAuthFile) => void;
}): boolean;
export function resolveCursorSdkWorkerRuntimeConfig(options?: {
  env?: Record<string, unknown>;
  hasInjectedLoadSdk?: boolean;
  isBunRuntime?: boolean;
  isElectronRuntime?: boolean;
  execPath?: string;
  resourcesPath?: string;
  nodeBinaryEnv?: string;
  requestedNodeBinary?: string;
  requestedUseNodeWorkerForPrompts?: boolean;
  requestedWorkerCwd?: string;
  requestedWorkerEnv?: Record<string, unknown>;
  workerPath?: string;
  ripgrepPath?: string;
}): {
  useNodeWorkerForPrompts: boolean;
  nodeBinary: string;
  workerCwd: string;
  workerEnv: Record<string, string>;
};
export function createCursorSdkRuntime(options: Record<string, unknown> & {
  ripgrepPath?: string;
  resolveAgentPrompt?: (input: { agent?: string; directory?: string | null }) => Promise<string> | string;
  resolveAgentDefinitions?: (input: {
    agent?: string;
    selectedAgent?: string;
    directory?: string | null;
    modelID?: string;
    modelSelection?: CursorSdkModelSelection | null;
    resolveModelSelection?: (input: {
      modelID?: string | null;
      variant?: string | null;
    }) => Promise<CursorSdkModelSelection | null | undefined> | CursorSdkModelSelection | null | undefined;
  }) => Promise<CursorSdkAgentDefinitions | null | undefined> | CursorSdkAgentDefinitions | null | undefined;
}): CursorSdkRuntime;
export type CursorAuthFile = Record<string, Record<string, unknown>>;

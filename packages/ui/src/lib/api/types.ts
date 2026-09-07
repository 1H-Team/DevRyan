import type { WorktreeMetadata } from '@/types/worktree';

export type RuntimePlatform = 'web' | 'desktop';

export interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  label?: string;
}

export interface ApiError {
  message: string;
  code?: string;
  cause?: unknown;
}

export interface Subscription {

  close: () => void;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface TerminalTransportCapability {
  preferred?: 'ws' | 'http' | 'sse';
  transports?: Array<'ws' | 'http' | 'sse'>;
  ws?: {
    path: string;
    v?: number;
    enc?: string;
  };
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  capabilities?: {
    input?: TerminalTransportCapability;
    stream?: TerminalTransportCapability;
  };
}

export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

export interface CreateTerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalStreamOptions {
  retry?: Partial<RetryPolicy>;
  connectionTimeoutMs?: number;
}

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalAPI {
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers, options?: TerminalStreamOptions): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  close(sessionId: string): Promise<void>;
  keepAlive?(sessionId: string): Promise<boolean>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitStatus {
  headState?: 'branch' | 'detached' | 'unborn';
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
  /** Phase 1: reason for attention-required state */
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
}

export interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  /** Git status --porcelain output showing current state */
  statusPorcelain: string;
  /** List of unmerged file paths */
  unmergedFiles: string[];
  /** Git diff output showing current conflict state */
  diff: string;
  /** Information about MERGE_HEAD or REBASE_HEAD */
  headInfo: string;
  /** The operation type: 'merge' or 'rebase' */
  operation: 'merge' | 'rebase';
}

export interface GitIntegratePlan {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  commits: string[];
}

export interface GitIntegrateConflictDetails {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  currentPatchMeta: string;
  currentPatch: string;
}

export interface GitIntegrateState {
  operationId: string;
  repoRoot: string;
  tempWorktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  cleanTargetWorktrees: string[];
  remainingCommits: string[];
  currentCommit: string;
}

export type GitIntegrateResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'success'; moved: number }
  | { kind: 'conflict'; state: GitIntegrateState; details: GitIntegrateConflictDetails };

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

export interface GitIdentitySummary {
  userName: string | null;
  userEmail: string | null;
  sshCommand: string | null;
}

export type GitCommitSyncStatus = 'local' | 'remote';

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Whether this commit is present on the tracked upstream. Undefined when upstream is unknown for the log range. */
  syncStatus?: GitCommitSyncStatus;
  /** True when this commit hash matches local HEAD. */
  isHead?: boolean;
  /** True when this commit hash matches the tip of the tracked upstream. */
  isRemoteHead?: boolean;
  /** True when this commit hash is the merge-base between local HEAD and the tracked upstream. */
  isSyncPoint?: boolean;
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
  /** True when the log was computed against the current branch and an upstream exists. */
  hasUpstream?: boolean;
}

export interface CommitFileEntry {
  path: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

export interface GitWorktreeBootstrapStatus {
  operationId: string | null;
  idempotencyKey: string | null;
  directory: string;
  metadata?: Record<string, unknown>;
  stage:
    | 'prepare_remote'
    | 'create_worktree'
    | 'sync_project_metadata'
    | 'populate_worktree'
    | 'run_post_checkout_hook'
    | 'configure_upstream'
    | 'run_project_setup'
    | 'run_requested_setup'
    | 'complete';
  status:
    | 'queued'
    | 'running'
    | 'ready'
    | 'ready_with_warnings'
    | 'failed'
    | 'needs_attention'
    | 'removed'
    | 'not_applicable';
  error: string | null;
  updatedAt: number;
  attempt: number;
  warnings: Array<{ stage: string; message: string; at: number }>;
  stages: Record<string, {
    status: 'queued' | 'running' | 'completed' | 'warning' | 'failed' | 'needs_attention' | 'skipped';
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    output?: {
      presence?: boolean | null;
      exitStatus?: number | null;
      durationMs?: number;
      failureExcerpt?: string;
    };
  }>;
}

export interface CreateGitWorktreePayload {
  /** Stable caller-generated key used to join/replay worktree creation safely. */
  idempotencyKey?: string;
  mode?: 'new' | 'existing';
  /** Worktree folder name (falls back to OpenCode name generation when omitted). */
  worktreeName?: string;
  /** Backward-compatible alias for worktreeName. */
  name?: string;
  /** New local branch name for mode=new. */
  branchName?: string;
  /** Existing local/remote branch for mode=existing. */
  existingBranch?: string;
  /** Start ref for mode=new (local/remote branch or commit SHA). */
  startRef?: string;
  /** Additional startup script to run after project startup script. */
  startCommand?: string;
  /** Configure upstream tracking for the created/attached local branch. */
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  /** Optional remote provisioning (used for fork PR workflows). */
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  operationId: string;
  bootstrap: GitWorktreeBootstrapStatus;
}

export interface GitWorktreePreviewResult {
  name: string;
  branch: string;
  path: string;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitDeleteRemoteBranchPayload {
  branch: string;
  remote?: string;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  amend?: boolean;
  stagedOnly?: boolean;
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
  files?: string[];
}

export interface GitCommitMessageFileContext {
  path: string;
  index: string;
  workingDir: string;
  diff?: string;
  diffNote?: string;
  insertions?: number;
  deletions?: number;
}

export interface GitCommitMessageContext {
  branch: string;
  tracking: string | null;
  scope: 'staged-only' | 'staged-and-unstaged';
  stagedOnly: boolean;
  selectedFiles: GitCommitMessageFileContext[];
  recentCommitSubjects: string[];
  patch?: string;
  patchNote?: string;
  contextWarning?: string;
}

export interface GenerateGitCommitMessageRequest {
  context: GitCommitMessageContext;
  guidance?: string;
  zenModel?: string;
}

export interface GenerateGitCommitMessageDraftRequest {
  selectedFiles: string[];
  stagedOnly?: boolean;
  guidance?: string;
  zenModel?: string;
}

export interface GeneratedCommitWorkflowResult {
  status: 'complete' | 'blocked';
  commits: GeneratedCommitMessage[];
  message?: string;
  warnings?: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

export interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  primaryRoot?(directory: string): Promise<string>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  bootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  preview?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreePreviewResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  operation?(operationId: string): Promise<GitWorktreeBootstrapStatus>;
  activeOperations?(): Promise<GitWorktreeBootstrapStatus[]>;
  retry?(operationId: string): Promise<GitWorktreeBootstrapStatus>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean; removedPath?: string }>;
}

export interface GitAPI {
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus>;
  getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse>;
  getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  revertGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string): Promise<GitBranch>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  generateCommitMessage(directory: string, request: GenerateGitCommitMessageRequest): Promise<GeneratedCommitMessage>;
  generateCommitMessageDraft(
    directory: string,
    request: GenerateGitCommitMessageDraftRequest,
  ): Promise<GeneratedCommitWorkflowResult>;
  generatePullRequestDescription(
    directory: string,
    payload: { base: string; head: string; context?: string; prompt?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  getPrimaryWorktreeRoot?(directory: string): Promise<string>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  previewGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreePreviewResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  getGitWorktreeBootstrapOperation?(operationId: string): Promise<GitWorktreeBootstrapStatus>;
  listActiveGitWorktreeBootstrapOperations?(): Promise<GitWorktreeBootstrapStatus[]>;
  retryGitWorktreeBootstrapOperation?(operationId: string): Promise<GitWorktreeBootstrapStatus>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean; removedPath?: string }>;
  createGitCommit(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  getCommitFiles(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  discoverGitCredentials?(): Promise<DiscoveredGitCredential[]>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemoteUrl?(directory: string, remote?: string): Promise<string | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase(directory: string): Promise<{ success: boolean }>;
  continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge(directory: string): Promise<{ success: boolean }>;
  continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  computeIntegratePlan?(
    directory: string,
    input: { sourceBranch: string; targetBranch: string },
  ): Promise<GitIntegratePlan>;
  integrateCommits?(directory: string, plan: GitIntegratePlan): Promise<GitIntegrateResult>;
  isIntegrateInProgress?(directory: string, state: GitIntegrateState): Promise<boolean>;
  getIntegrateConflictDetails?(
    directory: string,
    state: GitIntegrateState,
  ): Promise<GitIntegrateConflictDetails>;
  abortIntegrate?(directory: string, state: GitIntegrateState): Promise<void>;
  continueIntegrate?(directory: string, state: GitIntegrateState): Promise<GitIntegrateResult>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails(directory: string): Promise<MergeConflictDetails>;
  /** Phase 1: validate that a cwd is inside a worktreeRoot */
  validateWorktreeDirectory?(directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }>;
  /** Phase 1: canonicalize a directory to full worktree state */
  canonicalizeWorktreeState?(directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }>;
  worktree?: GitWorktreeAPI;
}

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

export interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  optional?: boolean;
  directory?: string;
}

export interface FileStatResult {
  path: string;
  exists: boolean;
  isFile: boolean;
  size: number;
  mtimeMs?: number;
}

export interface FilesAPI {
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery): Promise<FileSearchResult[]>;
  createDirectory(path: string): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<FileStatResult>;
  readFile?(path: string, options?: FileReadOptions): Promise<{ content: string; path: string }>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  writeFile?(path: string, content: string): Promise<{ success: boolean; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  execCommands?(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }>;
  downloadFile?(path: string, options?: FileReadOptions): Promise<void>;
}

export interface SessionPlanRevisionIdentity {
  sessionId: string;
  sourceMessageId: string;
  directory: string;
  sessionCreated: number;
  sessionSlug: string;
}

export interface SessionPlanRevisionWrite extends SessionPlanRevisionIdentity {
  markdown: string;
}

export interface SessionPlansAPI {
  ensureRevision(input: SessionPlanRevisionWrite): Promise<{ path: string; created: boolean }>;
  readRevision(input: SessionPlanRevisionIdentity): Promise<{ path: string; content: string }>;
  updateRevision(input: SessionPlanRevisionWrite): Promise<{ path: string; saved: boolean }>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  branches?: Array<{
    name: string;
    directory: string;
    isDefault?: boolean;
  }>;
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsPayload {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  opencodeBinary?: string;
  desktopKeepAwakeEnabled?: boolean;
  agentBrowserControlEnabled?: boolean;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  approvedDirectories?: string[];
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  autoDeleteEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  queueModeEnabled?: boolean;
  gitmojiEnabled?: boolean;
  inputSpellcheckEnabled?: boolean;
  showToolFileIcons?: boolean;
  showExpandedBashTools?: boolean;
  showExpandedEditTools?: boolean;
  chatRenderMode?: 'sorted' | 'live';
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  activityRenderMode?: 'collapsed' | 'summary';
  mermaidRenderingMode?: 'svg' | 'ascii';
  showSplitAssistantMessageActions?: boolean;
  fontSize?: number;
  chatWidth?: number;
  terminalFontSize?: number;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  diffViewMode?: 'single' | 'stacked';
  gitChangesViewMode?: 'flat' | 'tree';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;
  openInAppId?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  mobileKeyboardMode?: 'native' | 'resize-content';

  [key: string]: unknown;
}

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;

  restartOpenCode?: () => Promise<{ restarted: boolean }>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

export interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
}

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

export interface DiagnosticsStatus {
  enabled: true;
  directory: string;
  diskBytes: number;
  maxBytes: number;
  segmentCount: number;
  sessionCount: number;
  queuedRecords: number;
  writtenRecords: number;
  gapRecords: number;
  lastError: string | null;
  contextModeRecovery?: {
    state: 'healthy' | 'draining' | 'restarting' | 'external_action_required';
    incidentId: string | null;
    detectedAt: number | null;
    updatedAt: number;
    recoveredAt: number | null;
    occurrenceCount: number;
    restartAttempts: number;
    lastRestartError: string | null;
    outcome: 'recovered' | 'external_action_required' | null;
    guidance: string | null;
    transitions: Array<{
      state: 'healthy' | 'draining' | 'restarting' | 'external_action_required';
      at: number;
      error?: string;
    }>;
  } | null;
}

export type DiagnosticsExportScope =
  | { scope: 'runtime' }
  | { scope: 'task'; sessionID: string; directory?: string };

export interface DiagnosticsExportResult {
  cancelled: boolean;
  fileName: string;
}

export type DiagnosticsClearRange = '24h' | '7d' | '14d' | 'all';

// OpenCode database maintenance (Settings → Data Retention → OpenCode Storage).
// Served by `GET /api/storage/opencode-db` / `POST /api/storage/opencode-db/compact`.
export type OpenCodeStorageVacuumReason =
  | 'not_evaluated'
  | 'not_requested'
  | 'other_opencode_process'
  | 'free_disk_unknown'
  | 'insufficient_free_disk'
  | 'forced'
  | 'freelist_above_threshold'
  | 'freelist_below_threshold'
  | 'time_budget_exhausted';

export interface OpenCodeStorageSnapshot {
  dbBytes: number;
  walBytes: number;
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  reclaimableBytes: number;
  eventRows: number;
}

export interface OpenCodeStorageRunSummary {
  at: number;
  reason: string;
  dryRun: boolean;
  status: 'ok' | 'skipped' | 'error';
  schema?: 'ok' | 'mismatch' | 'unknown';
  driver?: string | null;
  durationMs: number;
  deletedEvents: number;
  deletedOrphanEvents: number;
  deletedOrphanSequences: number;
  prunedEvents: number;
  prunedSessions: number;
  candidateSessions: number;
  orphanEvents: number;
  prunableEvents: number;
  partial: boolean;
  vacuum: { requested: 'never' | 'auto' | 'force'; decided: boolean; reason: OpenCodeStorageVacuumReason } | null;
  vacuumed: boolean;
  vacuumDurationMs: number;
  before: OpenCodeStorageSnapshot | null;
  after: OpenCodeStorageSnapshot | null;
  error: string | null;
}

export interface OpenCodeStorageMaintenanceSettings {
  enabled: boolean;
  idleHours: number;
  keepSeqPerAggregate: number;
}

export interface OpenCodeStorageStatus {
  dbPath: string;
  exists: boolean;
  schema: 'ok' | 'mismatch' | 'unknown';
  dbBytes: number;
  walBytes: number;
  reclaimableBytes: number;
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  eventRows: number;
  orphanEventRows: number;
  error: string | null;
  lastRun: OpenCodeStorageRunSummary | null;
  lastDryRun: OpenCodeStorageRunSummary | null;
  running: boolean;
  maintenance: OpenCodeStorageMaintenanceSettings;
  managedRuntime: boolean;
  compactionPending: boolean;
}

export interface OpenCodeStorageCompactResult {
  scheduled?: boolean;
  pending?: boolean;
  dryRun?: boolean;
  run?: OpenCodeStorageRunSummary;
}

export interface DiagnosticsAPI {
  getStatus(): Promise<DiagnosticsStatus>;
  export(scope: DiagnosticsExportScope): Promise<DiagnosticsExportResult>;
  sanitizeText(text: string): Promise<string>;
  clear(range?: DiagnosticsClearRange): Promise<DiagnosticsStatus>;
  // Optional: only the web/Electron runtime serves OpenCode storage maintenance.
  getOpenCodeStorage?(): Promise<OpenCodeStorageStatus>;
  compactOpenCodeStorage?(options?: { dryRun?: boolean }): Promise<OpenCodeStorageCompactResult>;
}

export interface EvidenceProjectSetting {
  enabled: boolean;
  projectID: string;
  directory: string;
}

export interface TurnEvidenceCheckpoint {
  checkpointID: string;
  directory: string;
  sessionID: string;
  turnID: string;
  userMessageID: string | null;
  status: 'capturing_before' | 'capturing_after' | 'complete' | 'gap';
  contended: boolean;
  gapReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TurnEvidenceFileSummary {
  path: string;
  oldPath?: string;
  changeType?: 'renamed';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface TurnEvidenceDiffSummary {
  checkpointID: string;
  contended: boolean;
  files: TurnEvidenceFileSummary[];
}

export interface TurnEvidenceFileDiff {
  checkpointID: string;
  contended: boolean;
  file: TurnEvidenceFileSummary & {
    kind: 'patch' | 'metadata';
    patch?: string;
    size?: number;
    sha256?: string;
  };
}

export interface EvidenceAPI {
  getProjectSetting(directory: string): Promise<EvidenceProjectSetting>;
  setProjectSetting(directory: string, enabled: boolean): Promise<EvidenceProjectSetting>;
  clearProject(directory: string): Promise<{ removed: number }>;
  listTurns(sessionID: string, directory?: string): Promise<TurnEvidenceCheckpoint[]>;
  getDiff(checkpointID: string, file?: string): Promise<TurnEvidenceDiffSummary | TurnEvidenceFileDiff>;
}

// ============== Processes (bottom-dock Processes tab) ==============

export type ManagedProcessCategory = 'dev_server' | 'agent_cli' | 'lsp' | 'mcp' | 'other';

export interface ManagedProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: number | null;
  ageMs: number | null;
  command: string;
  category: ManagedProcessCategory;
  ports: number[];
  sessionId: string | null;
  workingDirectory?: string | null;
}

export interface OrphanedOpenCodeServerInfo {
  pid: number;
  port: number | null;
  command: string;
  ageMs: number | null;
  startedAt: number | null;
}

export interface ProcessesSnapshot {
  supported: boolean;
  platform?: string;
  processes: ManagedProcessInfo[];
  orphanServers: OrphanedOpenCodeServerInfo[];
  generatedAt?: number;
}

export interface ProcessStopResult {
  pid: number;
  terminated: boolean;
  stoppedDescendants: number[];
}

export interface ProcessTrackingProjectSetting {
  directory: string;
  trackAgentProcesses: boolean;
  heavyCheckSlots: number;
}

export interface ProcessesAPI {
  list(directory?: string | null): Promise<ProcessesSnapshot>;
  stop(pid: number, startedAt: number | null): Promise<ProcessStopResult>;
  getProjectSetting(directory: string): Promise<ProcessTrackingProjectSetting>;
  setProjectSetting(
    directory: string,
    value: { trackAgentProcesses?: boolean; heavyCheckSlots?: number },
  ): Promise<ProcessTrackingProjectSetting>;
}

export type ProviderContextUsageSnapshot = {
  sessionID: string;
  status: 'available' | 'unavailable';
  source: 'meridian' | 'message-fallback';
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  activeInputTokens: number;
  lastOutputTokens: number;
  fetchedAt: number;
};

export interface ContextUsageAPI {
  getSessionUsage(
    sessionID: string,
    options?: { directory?: string; refreshSession?: boolean },
  ): Promise<ProviderContextUsageSnapshot>;
}

export interface ToolManifestEntry {
  id: string;
  aliases: string[];
  sourceRuntime: 'web' | 'desktop' | 'server';
  directory: string | null;
}

export interface ToolManifest {
  tools: ToolManifestEntry[];
  aliases: Record<string, string[]>;
  sourceRuntime: ToolManifestEntry['sourceRuntime'];
  directory: string | null;
}

export interface ToolsAPI {

  getAvailableTools(): Promise<string[]>;
  getToolManifest(): Promise<ToolManifest>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(
    original: string,
    modified: string,
    label?: string,
    options?: { line?: number; patch?: string },
  ): Promise<void>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  origin?: string;
}

export interface PushUnsubscribePayload {
  endpoint: string;
}

export interface PushAPI {
  getVapidPublicKey(): Promise<{ publicKey: string } | null>;
  subscribe(payload: PushSubscribePayload): Promise<{ ok: true } | null>;
  unsubscribe(payload: PushUnsubscribePayload): Promise<{ ok: true } | null>;
  setVisibility(payload: { visible: boolean }): Promise<{ ok: true } | null>;
}

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  pending: number;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  app?: {
    name?: string;
    slug?: string;
  };
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  job?: {
    runId?: number;
    jobId?: number;
    url?: string;
    name?: string;
    conclusion?: string | null;
    steps?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      number?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  annotations?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    level?: string;
    message: string;
    title?: string;
    rawDetails?: string;
  }>;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

export type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headRepo?: GitHubPullRequestHeadRepo | null;
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

export type GitHubPullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubPullRequestsListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  prs?: GitHubPullRequestSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubPullRequestContextResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  pr?: GitHubPullRequestSummary | null;
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  files?: GitHubPullRequestFile[];
  diff?: string;
  checks?: GitHubChecksSummary | null;
  checkRuns?: GitHubCheckRun[];
};

export type GitHubPullRequestStatus = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  branch?: string;
  pr?: GitHubPullRequest | null;
  checks?: GitHubChecksSummary | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
};

export type GitHubPullRequestCreateInput = {
  directory: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  /** Remote to create the PR against (target repo, e.g., 'upstream' for forks) */
  remote?: string;
  /** Remote where the head branch lives (source repo, e.g., 'origin' for forks) */
  headRemote?: string;
  /** Explicit target repo (alternative to remote, for auto-detected upstream) */
  targetRepo?: { owner: string; repo: string };
};

export type GitHubPullRequestUpdateInput = {
  directory: string;
  number: number;
  title: string;
  body?: string;
};

export type GitHubPullRequestMergeInput = {
  directory: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
};

export type GitHubPullRequestReadyInput = {
  directory: string;
  number: number;
};

export type GitHubPullRequestReadyResult = {
  ready: boolean;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  message?: string;
};

export type GitHubIssueLabel = {
  name: string;
  color?: string;
};

export type GitHubRepoSelector = {
  owner: string;
  repo: string;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  assignees?: GitHubUserSummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: GitHubIssueSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubRepoUpstreamResult = {
  connected: boolean;
  isFork: boolean;
  upstream: { owner: string; repo: string; url: string; defaultBranch: string; defaultBranchSha: string | null; remoteName: string | null } | null;
};

export type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: GitHubIssue | null;
};

export type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: GitHubIssueComment[];
};

export type GitHubAuthStatus = {
  connected: boolean;
  activeAccountId?: string | null;
  user?: GitHubUserSummary | null;
  scope?: string;
  accounts?: GitHubAuthAccount[];
  ghCli?: {
    available: boolean;
    disabled: boolean;
    active: boolean;
    user?: GitHubUserSummary | null;
  } | null;
};

export type GitHubAuthAccount = {
  id: string;
  user: GitHubUserSummary;
  scope?: string;
  current?: boolean;
};

export type GitHubDeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

export type GitHubDeviceFlowComplete =
  | { connected: true; user: GitHubUserSummary; scope?: string }
  | { connected: false; status?: string; error?: string };

export interface GitHubAPI {
  authStatus(): Promise<GitHubAuthStatus>;
  authStart(): Promise<GitHubDeviceFlowStart>;
  authComplete(deviceCode: string): Promise<GitHubDeviceFlowComplete>;
  authDisconnect(): Promise<{ removed: boolean }>;
  authActivate(accountId: string): Promise<GitHubAuthStatus>;
  authSetGhCliDisabled(disabled: boolean): Promise<{ disabled: boolean }>;
  me?(): Promise<GitHubUserSummary>;

  prStatus(directory: string, branch: string, remote?: string, options?: { force?: boolean }): Promise<GitHubPullRequestStatus>;
  prCreate(payload: GitHubPullRequestCreateInput): Promise<GitHubPullRequest>;
  prUpdate(payload: GitHubPullRequestUpdateInput): Promise<GitHubPullRequest>;
  prMerge(payload: GitHubPullRequestMergeInput): Promise<GitHubPullRequestMergeResult>;
  prReady(payload: GitHubPullRequestReadyInput): Promise<GitHubPullRequestReadyResult>;

  prsList(directory: string, options?: { page?: number; state?: 'open' | 'all' }): Promise<GitHubPullRequestsListResult>;
  prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean; sourceRepo?: GitHubRepoSelector | null }
  ): Promise<GitHubPullRequestContextResult>;

  issuesList(directory: string, options?: { page?: number }): Promise<GitHubIssuesListResult>;
  issueGet(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueGetResult>;
  issueComments(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueCommentsResult>;
  repoUpstream(directory: string): Promise<GitHubRepoUpstreamResult>;
  repoBranches(owner: string, repo: string): Promise<string[]>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  terminal: TerminalAPI;
  git: GitAPI;
  files: FilesAPI;
  sessionPlans: SessionPlansAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  github?: GitHubAPI;
  push?: PushAPI;
  diagnostics?: DiagnosticsAPI;
  evidence?: EvidenceAPI;
  processes?: ProcessesAPI;
  contextUsage?: ContextUsageAPI;
  tools: ToolsAPI;
  editor?: EditorAPI;

  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

// ============== Plugins Types ==============

export type PluginScope = 'user' | 'project';
export type PluginParsedKind = 'npm' | 'path';
export type DevRyanDefaultPluginId =
  | 'opencode-antigravity-auth'
  | '@rama_nigg/open-cursor'
  | 'oh-my-opencode-slim'
  | 'opencode-with-claude'
  | 'context-mode'
  | 'superpowers'
  | 'openai-tool-schema-sanitizer';

export interface DevRyanDefaultPlugin {
  id: string;
  pluginId: DevRyanDefaultPluginId;
  displayName: string;
  shippedSpec: string;
  effectiveSpec: string;
  version: string | null;
  delivery: 'installed-local' | 'bundled-file' | 'curated-skills';
  sourcePath: string;
  configuredSourcePath?: string;
  kind: 'default';
}

export interface PluginEntry {
  id: string;
  spec: string;
  options?: Record<string, unknown>;
  scope: PluginScope;
  kind: 'config';
  parsedKind: PluginParsedKind;
  sourcePath: string;
  defaultPluginId?: DevRyanDefaultPluginId;
}

export interface PluginFile {
  id: string;
  fileName: string;
  scope: PluginScope;
  kind: 'file';
  absolutePath: string;
  defaultPluginId?: DevRyanDefaultPluginId;
}

export interface PluginConfigError {
  scope: PluginScope;
  sourcePath: string;
  index: number | null;
  message: string;
}

export interface PluginsListResponse {
  defaults: DevRyanDefaultPlugin[];
  entries: PluginEntry[];
  files: PluginFile[];
  errors: PluginConfigError[];
}

export interface SlimSetupIssue {
  code: string;
  message: string;
}

export interface SlimWrapperStatus {
  configured: boolean;
  wrapperRegistered: boolean;
  wrapperFileExists: boolean;
  rawRegistered: boolean;
  path: string;
  spec: string;
}

export interface SlimSetupStatus {
  ok?: boolean;
  installedVersion: string | null;
  configDirectory?: string;
  configPath?: string;
  slimConfigPath?: string;
  wrapperPath?: string;
  packageJsonPath?: string;
  runtimeEnabled: boolean;
  wrapperConfigured: boolean;
  wrapperStatus?: SlimWrapperStatus;
  packageDependencyInstalled: boolean;
  slimConfigExists?: boolean;
  backgroundSubagentsEnv?: string;
  changedFiles?: string[];
  backupPaths?: string[];
  issues: SlimSetupIssue[];
  repair?: boolean;
  reload?: unknown;
}

// ============== Skills Catalog Types ==============

export type SkillsCatalogSourceId = string;

export type SkillsCatalogSourceType = 'github' | 'clawdhub';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
}

export interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

export interface ClawdHubSkillMetadata {
  slug: string;
  version: string;
  displayName?: string;
  owner?: string;
  downloads?: number;
  stars?: number;
  versionsCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SkillsCatalogItem {
  sourceId: SkillsCatalogSourceId;
  repoSource: string;
  repoSubpath?: string;
  gitIdentityId?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  installed?: SkillsCatalogItemInstalledBadge;
  /** ClawdHub-specific metadata (present only for ClawdHub sources) */
  clawdhub?: ClawdHubSkillMetadata;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  pageInfoBySource?: Record<SkillsCatalogSourceId, { nextCursor?: string | null }>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  nextCursor?: string | null;
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

export type ArchiveErrorCode =
  | 'ARCHIVE_DOWNLOAD_TOO_LARGE'
  | 'ARCHIVE_ENTRY_LIMIT'
  | 'ARCHIVE_INVALID_PATH'
  | 'ARCHIVE_PATH_COLLISION'
  | 'ARCHIVE_UNSAFE_ENTRY'
  | 'ARCHIVE_SIZE_LIMIT'
  | 'ARCHIVE_CORRUPT'
  | 'ARCHIVE_MISSING_SKILL_FILE'
  | 'ARCHIVE_DOWNLOAD_TIMEOUT';

export type SkillsRepoScanError =
  | { kind: 'authRequired'; message: string; sshOnly: true; identities?: Array<{ id: string; name: string }> }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'archiveRejected'; message: string; code: ArchiveErrorCode }
  | { kind: 'unknown'; message: string };

export interface SkillsRepoScanResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: SkillsRepoScanError;
}

export interface SkillsInstallSelection {
  skillDir: string;
  /** ClawdHub-specific metadata for installation */
  clawdhub?: {
    slug: string;
    version: string;
  };
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
  scope: 'user' | 'project';
  targetSource?: 'opencode' | 'agents';
  selections: SkillsInstallSelection[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export type SkillsInstallError = SkillsRepoScanError | {
  kind: 'conflicts';
  message: string;
  conflicts: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
};

export interface SkillsInstallResponse {
  ok: boolean;
  installed?: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{
    skillName: string;
    reason: string;
    code?: 'invalidSkillName' | 'versionUnavailable' | 'alreadyInstalled' | 'installFailed' | ArchiveErrorCode;
  }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  message?: string;
  reloadDelayMs?: number;
}

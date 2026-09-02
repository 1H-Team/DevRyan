export type BotLifecycle = 'draft' | 'active' | 'paused' | 'retired';
/** Every Bot runs one shared computer. 'personalized' only appears on records
 *  written before that change and resolves to the same shared computer. */
export type BotTenancy = 'team' | 'personalized';
export type BotMembershipRole = 'member' | 'operator' | 'manager';
export type BotRunState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'waiting_control'
  | 'needs_reconciliation'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type BotCapabilities = {
  available: boolean;
  state: string;
  code: string | null;
  owner: string;
  canManageRuntime: boolean;
  canCreateBot: boolean;
  requiredMigration?: string;
  runtime?: Readonly<Record<string, unknown>> | null;
};

export type BotSummary = {
  id: string;
  name: string;
  title: string;
  summary: string;
  avatarUrl: string | null;
  avatarFallback: string | null;
  lifecycle: BotLifecycle;
  tenancy: BotTenancy;
  activeRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type BotModelVariantOption = {
  id: string;
  name: string;
  available: boolean;
};

export type BotModelOption = {
  id: string;
  name: string;
  providerId: string;
  available: boolean;
  variants: readonly BotModelVariantOption[];
  contextLimit: number | null;
  reviewedEgressHosts: readonly string[];
  egressReviewed: boolean;
};

export type BotProviderOption = {
  id: string;
  name: string;
  available: boolean;
  authType: 'api' | 'oauth' | null;
  connections: readonly {
    id: string;
    label: string;
    kind: 'oauth';
    status: 'active';
  }[];
  models: readonly BotModelOption[];
};

export type BotModelOptions = {
  available: boolean;
  providers: readonly BotProviderOption[];
};

export type BotRevisionSummary = {
  id: string;
  botId: string;
  revisionNumber: number;
  compiledHash: string;
  specHash?: string | null;
  hasPortableSpec?: boolean;
  createdAt: string;
  updatedAt?: string;
  activatedAt: string | null;
  retiredAt: string | null;
};

export type BotModelBinding = {
  providerId: string;
  modelId: string;
  credentialId: string;
  egressHosts: readonly string[];
  variant?: string;
};

export type BotModelPolicy = {
  primary: BotModelBinding;
  fallbacks: readonly BotModelBinding[];
};

export type BotReasoningAgentBinding =
  | { kind: 'opencode'; models: BotModelPolicy }
  | {
    kind: 'ag_ui';
    connectionRef: string;
    connectionDigest: string;
    modelHint?: string;
  };

export type BotRuntimeTool = 'bash' | 'terminal' | 'git' | 'task';

export type BotActionPolicyRule = {
  id: string;
  effect: 'allow' | 'prompt' | 'deny';
  risk: 'low' | 'sensitive' | 'critical';
  match: {
    tool?: string;
    actions?: readonly string[];
    origins?: readonly string[];
    operationKinds?: readonly ('read' | 'write')[];
    actorRoles?: readonly BotMembershipRole[];
    urlPathGlobs?: readonly string[];
    filePaths?: {
      quantifier: 'any' | 'all';
      globs: readonly string[];
    };
    argumentPredicates?: readonly {
      pointer: string;
      op: 'exists' | 'eq' | 'in' | 'prefix' | 'suffix' | 'glob' | 'gte' | 'lte' | 'arrayContains';
      value?: unknown;
    }[];
  };
  retainEvidence?: boolean;
  ttlSeconds?: number;
  quota?: {
    scope: 'actor' | 'bot';
    limit: number;
    windowSeconds: number;
  };
};

type BotRevisionContractBase = {
  identity: { title: string; avatar: string };
  objectives: readonly string[];
  /** Personality, voice, and behavioral boundaries. Leads the system prompt. */
  soul: string;
  /** Superseded by `soul`; still present on revisions written before it. */
  tone: string;
  operatingInstructions: string;
  prohibitedInstructions: string;
  advancedPrompt: string;
  tenancy: BotTenancy;
  standingRole: string;
  reasoning: Readonly<Record<string, unknown>>;
  fileTools: readonly ('edit' | 'glob' | 'grep' | 'read' | 'write')[];
  /** Missing on legacy revisions, where these capabilities remain disabled. */
  runtimeTools?: readonly BotRuntimeTool[];
  /** Server-derived. Sent values are replaced at save time. */
  gatewayPluginVersion: string;
  /** Server-derived from the Bot's published Library sources. */
  libraryVersionIds: readonly string[];
  skillBindings?: readonly { id: string; digest: string }[];
  mcpBindings?: readonly {
    id: string;
    descriptorDigest: string;
    manifestDigest: string;
  }[];
  memoryPolicy: Readonly<Record<string, unknown>>;
  actionPolicy: {
    matcherVersion?: 2;
    defaultEffect: 'allow' | 'prompt' | 'deny';
    defaultRisk: 'low' | 'sensitive' | 'critical';
    rules: readonly BotActionPolicyRule[];
  };
  browserPolicy: {
    allowedOrigins: readonly string[];
    deniedOrigins: readonly string[];
    networkAccess?: {
      mode: 'public_only' | 'allowlist';
      hosts: readonly string[];
    };
  };
};

export type BotLegacyRevisionContract = BotRevisionContractBase & {
  contractVersion?: never;
  agent?: never;
  computerPolicy?: never;
  models: BotModelPolicy;
};

export type BotRevisionV3Contract = BotRevisionContractBase & {
  contractVersion: 3;
  agent: BotReasoningAgentBinding;
  computerPolicy?: { isolationTier: 'standard' | 'runsc' };
  models?: never;
};

export type BotRevisionContract = BotLegacyRevisionContract | BotRevisionV3Contract;

export const botRevisionModelPolicy = (contract: BotRevisionContract): BotModelPolicy | null => {
  if (contract.contractVersion === 3) {
    return contract.agent.kind === 'opencode' ? contract.agent.models : null;
  }
  return contract.models;
};

export const withBotRevisionModelPolicy = (
  contract: BotRevisionContract,
  models: BotModelPolicy,
): BotRevisionContract => contract.contractVersion === 3
  ? { ...contract, agent: { kind: 'opencode' as const, models } }
  : { ...contract, models };

export const withBotRevisionAgent = (
  contract: BotRevisionContract,
  agent: BotReasoningAgentBinding,
): BotRevisionV3Contract => {
  const base = contract.contractVersion === 3
    ? (({ contractVersion, agent: currentAgent, computerPolicy, ...rest }) => {
        void contractVersion;
        void currentAgent;
        void computerPolicy;
        return rest;
      })(contract)
    : (({ models, ...rest }) => {
        void models;
        return rest;
      })(contract);
  return {
    ...base,
    contractVersion: 3,
    agent,
    browserPolicy: {
      ...base.browserPolicy,
      networkAccess: base.browserPolicy.networkAccess || { mode: 'public_only', hosts: [] },
    },
    computerPolicy: contract.contractVersion === 3
      ? contract.computerPolicy || { isolationTier: 'standard' }
      : { isolationTier: 'standard' },
  };
};

export type BotAgentConnectionLimits = Readonly<{
  maximumStreamBytes?: number;
  maximumTextBytes?: number;
  maximumArgumentBytes?: number;
  maximumEventCount?: number;
  requestTimeoutMs?: number;
  healthTimeoutMs?: number;
}>;

export type BotAgentConnection = {
  id: string;
  botId: string;
  name: string;
  endpointUrl: string;
  protocolVersion: 'ag-ui/v1';
  authMode: 'none' | 'bearer';
  hasCredential: boolean;
  modelHint: string | null;
  limits: BotAgentConnectionLimits;
  descriptorDigest: string;
  status: 'active' | 'error' | 'revoked';
  health: Readonly<{
    state?: 'healthy' | 'failed' | 'revoked';
    checkedAt?: string;
    code?: string | null;
  }> | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type BotSpecBindingKind = 'credential' | 'agent_connection' | 'skill' | 'mcp' | 'library';

export type BotSpecImportMapping = {
  kind: BotSpecBindingKind;
  logicalKey: string;
  localResourceId: string;
};

export type BotSpecImportRequirement = {
  kind: BotSpecBindingKind;
  logicalKey: string;
  portableDigest: string;
  candidates: readonly {
    id: string;
    label: string;
    digest: string;
    exact: true;
  }[];
};

export type BotSpecImportPreview = {
  metadata: { name: string; revision: number };
  specHash: string;
  sourceCompiledHash: string;
  signer: {
    keyId: string;
    publicKey: string;
    status: 'trusted' | 'unknown';
    acknowledgementRequired: boolean;
  };
  target: { botId: string | null; name: string };
  requirements: readonly BotSpecImportRequirement[];
  readyForPublication: boolean;
};

export type BotSignerTrust = {
  id: string;
  scope: 'global' | 'bot';
  botId: string | null;
  signerKeyId: string;
  signerPublicKey: string;
  status: 'trusted' | 'revoked';
  trustedAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type BotRevisionDetail = BotRevisionSummary & {
  createdBy: string;
  updatedAt: string;
  contract: BotRevisionContract;
};

export type BotManagedMembership = BotMembershipSummary & {
  assignedBy: string;
  createdAt: string;
};

export type BotCredentialMetadata = {
  id: string;
  provider: string;
  label: string;
  kind: 'api_key' | 'oauth';
  scope: 'team' | 'user';
  maskedIdentifier: string | null;
  status: string;
  authState?: 'unknown' | 'ready' | 'reauth_required' | 'unavailable';
  version: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
};

export type BotEnvironmentSecretMetadata = {
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type BotActivationGate = {
  id: 'schema' | 'images' | 'agent' | 'models' | 'egress' | 'tools' | 'policy' | 'library' | 'skills' | 'mcp' | 'computer';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
};

export type BotActivationHealth = {
  ready: boolean;
  gates: readonly BotActivationGate[];
  revision: BotRevisionDetail;
};

export type BotManagementDetail = {
  bot: BotSummary;
  canManage: boolean;
  revisions: readonly (BotRevisionSummary | BotRevisionDetail)[];
  memberships: readonly BotManagedMembership[];
  credentials: readonly BotCredentialMetadata[];
};

export type BotSkillBindingSummary = {
  id: string;
  name: string;
  digest: string;
  fileCount: number;
  updateAvailable: boolean;
  integrity: 'pinned' | 'failed';
};

export type BotMcpBindingSummary = {
  id: string;
  serverName: string;
  transport: 'stdio' | 'streamable_http' | 'sse';
  descriptorDigest: string;
  manifestDigest: string;
  toolCount: number;
  credentialState: 'not-required' | 'connected' | 'required';
  updateAvailable: boolean;
  connectivity: 'not-checked' | 'connected' | 'manifest-drift' | 'unavailable';
  integrity: 'pinned' | 'failed';
};

export type BotCapabilityBindings = {
  bot: BotSummary;
  canManage: boolean;
  revision: (BotRevisionSummary | BotRevisionDetail) & { updatedAt: string };
  skills: readonly BotSkillBindingSummary[];
  mcp: readonly BotMcpBindingSummary[];
  availableSkills: readonly {
    name: string;
    description: string;
    scope: string;
  }[];
  availableMcp: readonly {
    name: string;
    type: 'local' | 'remote';
    scope: string;
  }[];
};

export type BotPurgeResource = {
  id: string;
  label: string;
  count: number | null;
  disposition: 'delete' | 'delete-local' | 'retain-by-policy';
};

export type BotPurgePreview = {
  bot: BotSummary;
  requiresTypedName: string;
  resources: readonly BotPurgeResource[];
  irreversible: true;
  resumable: true;
  policy: string;
};

export type BotPurgeStepResult = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  attempts: number;
  detail: string;
  code: string | null;
  completedAt: string | null;
};

export type BotPurgeExecutionResult = {
  id: string;
  botId: string;
  botName: string;
  state: 'pending' | 'running' | 'partial' | 'completed';
  complete: boolean;
  retryable: boolean;
  botDeleted: boolean;
  selectedResourceIds: readonly string[];
  steps: readonly BotPurgeStepResult[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type BotPurgeStartRequest = {
  typedName: string;
  confirm: true;
  expectedUpdatedAt: string;
  resourceIds: readonly string[];
};

export type BotCompleteDeleteRequest = {
  typedName: string;
  confirm: true;
  expectedUpdatedAt: string;
};

export type BotRoutineTrigger =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: readonly number[] }
  | { kind: 'cron'; expression: string }
  | { kind: 'once'; localDateTime: string };

export type BotRoutineContract = {
  version: 1;
  rationale: string;
  trigger: BotRoutineTrigger;
  timezone: string;
  goal: string;
  inputs: Readonly<Record<string, unknown>>;
  allowedTools: readonly string[];
  allowedAccountIds: readonly string[];
  allowedOrigins: readonly string[];
  limits: { maxActions: number; maxExternalWrites: number };
  approvalClass: 'none' | 'requester' | 'operator' | 'manager';
  timeoutSeconds: number;
  missedPolicy: 'skip' | 'run_once' | 'replay_capped';
  missedRunCap: number;
  completionCriteria: readonly string[];
};

export type BotRoutine = {
  id: string;
  botId: string;
  name: string;
  contract: BotRoutineContract;
  timezone: string;
  missedPolicy: BotRoutineContract['missedPolicy'];
  missedRunCap: number;
  status: 'draft' | 'active' | 'paused' | 'retired';
  revisionBehavior: 'current_active';
  nextOccurrenceAt: string | null;
  lastOccurrenceAt: string | null;
  createdBy: string;
  managedBy: string;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type BotMembershipSummary = {
  botId: string;
  userId: string;
  /** Resolved from the user directory; null when it cannot be reached. */
  displayName?: string | null;
  email?: string | null;
  role: BotMembershipRole;
  activatedAt: string;
  revokedAt: string | null;
  updatedAt: string;
};

export type BotDirectoryUser = {
  id: string;
  displayName: string | null;
  email: string | null;
  /** Set when this person already belongs to the Bot. */
  assignedRole: BotMembershipRole | null;
};

export type BotComputerFile = {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'special';
  size: number;
  modifiedAt: string | null;
  restricted: boolean;
};

export type BotComputerFiles = {
  available: boolean;
  state:
    | 'ready'
    | 'offline'
    | 'unsupported'
    | 'docker_not_installed'
    | 'docker_stopped'
    | 'setup_required'
    | 'image_update_available'
    | 'runtime_degraded'
    | 'runtime_unavailable';
  code?: string | null;
  scope: 'container' | 'workspace';
  rootLabel: 'Computer' | 'Workspace';
  path: string;
  entries: readonly BotComputerFile[];
  truncated: boolean;
};

export type BotComputerResource = {
  computerPath: string;
  sourcePath: string;
  kind: 'file' | 'directory';
  importedAt: string;
};

export type BotChannel = {
  id: string;
  botId: string;
  ownerUserId: string;
  accessRole: 'owner' | 'reader' | 'collaborator';
  canSend: boolean;
  lifecycle: 'active' | 'archived';
  currentCheckpointNumber: number;
  lastMessageSequence: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type BotChannelPreview = {
  channelId: string;
  messageId: string;
  role: 'user' | 'assistant';
  sequence: number;
  text: string;
  attachmentCount: number;
  createdAt: string;
  finalizedAt: string | null;
};

export type BotQuestionOption = {
  label: string;
  description: string | null;
};

// A quick-reply question the Bot asked inside its message. Tapping an option
// sends an ordinary reply; the run is already finished when it is shown.
export type BotQuestion = {
  version: 1;
  prompt: string;
  options: readonly BotQuestionOption[];
  multiple: boolean;
  allowFreeText: boolean;
};

export type BotMessage = {
  id: string;
  channelId: string;
  runId: string | null;
  actorUserId: string | null;
  role: 'user' | 'assistant' | 'system';
  assistantPhase: 'pending' | 'acknowledgment' | 'result' | null;
  sequence: number;
  body: {
    text: string;
    attachmentIds: readonly string[];
    question?: BotQuestion | null;
  };
  attachmentCount: number;
  createdAt: string;
  finalizedAt: string | null;
};

export type BotRun = {
  id: string;
  botId: string;
  channelId: string;
  revisionId: string;
  modelSnapshot: Readonly<Record<string, unknown>> | null;
  computerScopeKey: string;
  queueSequence: number | null;
  state: BotRunState;
  retryable: boolean;
  interruptionKind: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type BotActionAttempt = {
  id: string;
  runId: string;
  botId: string;
  revisionId: string;
  credentialId: string | null;
  computerScopeKey: string;
  actionHash: string;
  argsDigest: string;
  tool: string;
  action: string;
  target: Readonly<Record<string, unknown>>;
  risk: 'low' | 'sensitive' | 'critical';
  approvalClass: 'none' | 'requester' | 'operator' | 'manager';
  policyEffect: 'deny' | 'prompt' | 'allow';
  policyRuleIds: readonly string[];
  decisionExpiresAt: string;
  requiresDistinctApprover: boolean;
  retainEvidence: boolean;
  state: string;
  unknownOutcome: boolean;
  reconciliationDecision: 'complete' | 'retry_new' | 'abandon' | null;
  initiatedBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type BotActionReceipt = {
  operationKind: 'read' | 'write' | null;
  nativeExactlyOnce: boolean;
  writeGuarantee: string | null;
  evidenceObjectIds: readonly string[];
  evidenceIncomplete: boolean;
  executedAt: string | null;
  failureCode: string | null;
};

export type BotApproval = {
  id: string;
  actionAttemptId: string;
  actionHash: string;
  revisionId: string;
  argsDigest: string;
  approverUserId: string;
  decision: 'approved' | 'denied';
  expiresAt: string;
  createdAt: string;
};

export type BotComputerControl = {
  leaseId: string | null;
  actorId: string | null;
  actorType: string | null;
  takenAt: number | null;
  expiresAt: number | null;
};

export type BotComputerWebCapabilityState = 'enabled' | 'disabled' | 'unknown';

export type BotComputerBrowserTrailEntry = {
  kind: 'navigation' | 'failure' | 'dialog';
  origin: string | null;
  path: string;
  observedAt: number;
  statusCode?: number | null;
  redirectCount?: number;
  reason?: string;
  type?: 'alert' | 'beforeunload' | 'confirm' | 'prompt' | 'unknown';
  message?: string;
};

export type BotComputerCookieBlock = {
  origin: string | null;
  path: string;
  reason: string;
  observedAt: number;
};

export type BotComputerNavigationDiagnostic = {
  revision: number;
  observedAt: number;
  origin: string | null;
  statusCode: number | null;
  redirectCount: number;
  repetitionCount: number;
  kind:
    | 'healthy'
    | 'blocked_cookies'
    | 'subresource_failure'
    | 'egress_denied'
    | 'site_rejection';
  reason: string;
  blockedHost: string | null;
  trail?: readonly BotComputerBrowserTrailEntry[];
  cookieBlocks?: readonly BotComputerCookieBlock[];
  dialogs?: readonly BotComputerBrowserTrailEntry[];
};

export type BotComputerBrowserStatus = {
  running?: boolean;
  healthy?: boolean;
  launching?: boolean;
  lifecycleState?: 'stopped' | 'launching' | 'running';
  generation?: number;
  lastFailureCode?: string | null;
  screencastSubscribers?: number;
  activeTargetCount?: number;
  popupOpen?: boolean;
  mode?: 'headed_virtual' | 'headless_legacy';
  engineVersion?: string | null;
  displayReady?: boolean;
  webCapabilities?: {
    managedPolicy?: 'enforced' | 'missing' | 'unknown';
    javascript?: BotComputerWebCapabilityState;
    firstPartyCookies?: BotComputerWebCapabilityState;
    thirdPartyCookies?: BotComputerWebCapabilityState;
  };
  lastNavigationDiagnostic?: BotComputerNavigationDiagnostic | null;
};

export type BotComputerStatus = {
  botId: string;
  browser: Readonly<BotComputerBrowserStatus>;
  control: BotComputerControl | null;
  screencast: {
    subscribers: number;
    lastFrameAt: number | string | null;
    retainedFrames: 0;
  };
  framesRecorded: false;
  arbitraryWebsiteExactlyOnce: false;
};

export type BotComputerViewSession = {
  id: string;
  botId: string;
  channelId: string;
  streamUrl: string;
  startedAt: string;
  runId?: string;
};

export type BotHumanInputModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export type BotHumanInputEvent =
  | {
      type: 'pointer';
      phase: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button: 'none' | 'left' | 'middle' | 'right';
      buttons: number;
      clickCount: number;
    }
  | {
      type: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | {
      type: 'key';
      phase: 'down' | 'up';
      key: string;
      code: string;
      modifiers: readonly BotHumanInputModifier[];
      location: number;
      repeat: boolean;
    }
  | {
      type: 'text';
      text: string;
    };

export type BotObject = {
  id: string;
  botId: string;
  channelId: string | null;
  visibility: 'private' | 'library';
  ciphertextHash: string;
  ciphertextSize: number;
  contentType: string;
  provenance: Readonly<Record<string, unknown>>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
};

export type BotSharedFile = {
  id: string;
  botId: string;
  channelId: string;
  messageId: string;
  objectId: string;
  senderUserId: string | null;
  direction: 'user' | 'bot';
  filename: string;
  contentType: string;
  sha256: string | null;
  size: number | null;
  computerPath: string;
  copyState: 'pending' | 'copying' | 'ready' | 'failed';
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A Bot keeps one shared memory; 'user_private' is retained only so rows
 *  written before the migration still typecheck. */
export type BotMemoryScope = 'shared' | 'user_private';
export type BotMemorySensitivity = 'normal' | 'confidential' | 'restricted';

export type BotMemory = {
  id: string;
  botId: string;
  scope: BotMemoryScope;
  subjectUserId: string | null;
  logicalKey: string;
  content: { text: string };
  sensitivity: BotMemorySensitivity;
  confidence: number;
  activeVersionId: string | null;
  activeCreatorKind: 'classifier' | 'manager' | 'system' | null;
  createdAt: string;
  updatedAt: string;
  tombstonedAt: string | null;
  /** Present when the row could not be decrypted; `content.text` is empty. */
  unreadable?: boolean;
  unreadableCode?: string;
};

export type BotMemoryExtractionJob = {
  runId: string;
  channelId: string;
  state: 'queued' | 'leased' | 'succeeded' | 'terminal';
  phase: string | null;
  errorCode: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BotMemoryExtractionSummary = {
  pending: number;
  failed: number;
  workerStarted: boolean;
  recent: readonly BotMemoryExtractionJob[];
};

export type BotMemoryPage = {
  memories: BotMemory[];
  nextCursor: string | null;
  /** Only present on the first page. */
  extraction?: BotMemoryExtractionSummary | null;
};

export type BotMemoryVersion = {
  id: string;
  memoryId: string;
  versionNumber: number;
  content: { text: string };
  classifierMetadata: Readonly<Record<string, unknown>>;
  creatorKind: 'classifier' | 'manager' | 'system';
  createdBy: string | null;
  createdAt: string;
};

export type BotMemorySource = {
  id: string;
  memoryVersionId: string;
  channelId: string | null;
  runId: string | null;
  messageId: string | null;
  sourceKind: 'message' | 'run' | 'manager' | 'consolidation';
  sourceMetadata: Readonly<Record<string, unknown>>;
  sourceTombstonedAt: string | null;
  createdAt: string;
};

export type BotMemoryDetail = {
  memory: BotMemory;
  versions: BotMemoryVersion[];
  sources: BotMemorySource[];
};

export type BotLibraryVersion = {
  id: string;
  sourceId: string;
  versionNumber: number;
  objectIds: readonly string[];
  publishedBy: string;
  publishedAt: string;
};

export type BotLibrarySource = {
  id: string;
  botId: string;
  descriptor: { name?: string; kind?: 'filesystem' | 'artifact' };
  exclusions: {
    names?: readonly string[];
    extensions?: readonly string[];
    paths?: readonly string[];
  };
  provenance: Readonly<Record<string, unknown>>;
  hostPath: string | null;
  currentPublishedVersionId: string | null;
  currentVersion: BotLibraryVersion | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
};

export type BotLibrarySourcePage = {
  sources: BotLibrarySource[];
  nextCursor: string | null;
  available?: boolean;
  state?: 'ready' | 'runtime_unavailable';
  code?: string | null;
};

export type BotLibraryFinding = {
  code: string;
  relativePath: string;
  message: string;
  severity: string;
};

export type BotLibraryDiff = {
  added: readonly string[];
  changed: readonly string[];
  removed: readonly string[];
  previousBytes: number;
  candidateBytes: number;
  sizeDelta: number;
  securityFindingCount: number;
};

export type BotLibraryScan = {
  scanId: string;
  botId: string;
  sourceId: string;
  sourceExpectedUpdatedAt: string | null;
  descriptor: { name: string; kind: 'filesystem' | 'artifact' };
  scan: {
    rootKind: 'file' | 'directory';
    fileCount: number;
    totalBytes: number;
    files: readonly {
      relativePath: string;
      contentType: string;
      size: number;
      sha256: string;
      textBytes: number;
    }[];
    findings: readonly BotLibraryFinding[];
  };
  diff: BotLibraryDiff;
  expiresAt: string;
};

export type BotLibraryVersionDetail = {
  source: BotLibrarySource;
  version: BotLibraryVersion;
  manifest: Readonly<Record<string, unknown>>;
  diff: BotLibraryDiff | null;
};

export type BotLibraryPublication = {
  source: BotLibrarySource;
  version: BotLibraryVersion;
  diff: BotLibraryDiff;
  indexSynchronized: boolean;
};

export type BotSnapshot = {
  bots: readonly BotSummary[];
  revisions: readonly BotRevisionSummary[];
  memberships: readonly BotMembershipSummary[];
  channels: readonly BotChannel[];
  /** Optional during a rolling host/client upgrade; current hosts always emit it. */
  channelPreviews?: readonly BotChannelPreview[];
  runs: readonly BotRun[];
  /** Recent governed actions for Activity; optional during rolling upgrades. */
  recentActions?: readonly BotActionAttempt[];
  pendingApprovals: readonly BotActionAttempt[];
  computers: readonly BotComputerStatus[];
};

export type BotMessageEventPayload = Readonly<{
  message: BotMessage;
  run?: BotRun;
  streamRevision?: number;
  /** Present only when this finalized visible message becomes the roster preview. */
  channelPreview?: BotChannelPreview;
}>;

export type BotStreamingMessage = Readonly<{
  messageId: string;
  runId: string;
  channelId: string;
  sequence: number;
  createdAt: string;
  text: string;
  revision: number;
}>;

export type BotPrewarmState = Readonly<{
  state: 'warming' | 'ready' | 'skipped';
  leaseId: string | null;
  revisionId: string;
  expiresAt: string | null;
  reason: 'busy' | null;
}>;

export type BotEventEnvelope = {
  id: string;
  sequence: number;
  kind: string;
  botId?: string;
  channelId?: string;
  payload: Readonly<Record<string, unknown>>;
};

export type BotMessagePage = {
  messages: BotMessage[];
  nextCursor: string | null;
};

export type BotSendMessageRequest = {
  messageId: string;
  acknowledgmentId?: string;
  idempotencyKey: string;
  text: string;
  attachmentIds: readonly string[];
  attachmentDeliveryMode?: 'auto' | 'compatibility';
  prewarmLeaseId?: string;
};

export type BotSendMessageResponse = {
  created: boolean;
  message: BotMessage;
  acknowledgment: BotMessage;
  run: BotRun;
};

export type BotApprovalDecisionRequest = {
  actionHash: string;
  revisionId: string;
  argsDigest: string;
  decision: 'approved' | 'denied';
};

export type BotReconciliationRequest = {
  actionHash: string;
  revisionId: string;
  argsDigest: string;
  decision: 'complete' | 'retry_new' | 'abandon';
};

export class BotsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: { status: number; code: string; details?: unknown }) {
    super(message);
    this.name = 'BotsApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? null;
  }
}

export const BOT_RETRY_REASONS = [
  'not_found', 'wrong_actor', 'not_retryable', 'execution_started',
  'revision_changed', 'channel_unavailable', 'access_revoked',
  'concurrent_active_run', 'attachments_expired',
] as const;
export type BotRetryReason = typeof BOT_RETRY_REASONS[number];

export const getBotRetryReason = (error: unknown): BotRetryReason | null => {
  if (!(error instanceof BotsApiError) || !isRecord(error.details)) return null;
  const candidate = error.details.retryReason;
  return BOT_RETRY_REASONS.find((reason) => reason === candidate) ?? null;
};

export type BotTelegramDelivery = {
  id: string; state: string; errorCode: string | null; kind: string;
  partIndex: number; createdAt: string; updatedAt: string;
};
export type BotTelegramStatus = {
  hostOnline?: boolean; executionReady?: boolean;
  canPair?: boolean;
  enabled: boolean; configured: boolean; state: string; errorCode?: string | null;
  requiredMigration?: string; username?: string | null; botIdentity?: string | null;
  pairing: { id: string; state: string; telegramUserId: string | null; displayName: string | null;
    expiresAt: string; confirmedAt: string | null } | null;
  preferences: { routineDelivery: boolean; voiceReplies: boolean };
  deliveries: BotTelegramDelivery[];
};
export type BotSpeechConfiguration = {
  enabled: boolean;
  stt: { baseUrl: string; model: string; apiKey?: string } | null;
  tts: { baseUrl: string; model: string; voice: string; apiKey?: string } | null;
};
export type BotSpeechStatus = {
  botId: string; enabled: boolean; generation: string;
  stt: { baseUrl: string; model: string; hasApiKey: boolean; ready: boolean } | null;
  tts: { baseUrl: string; model: string; voice: string; hasApiKey: boolean; ready: boolean } | null;
  limits: { maximumInputSeconds: number; maximumInputBytes: number; maximumReplyCharacters: number };
};

export type BotsApi = {
  getTelegramStatus(botId: string): Promise<BotTelegramStatus>;
  configureTelegram(botId: string, request: { enabled: boolean; token?: string }): Promise<BotTelegramStatus>;
  disconnectTelegram(botId: string): Promise<BotTelegramStatus>;
  createTelegramPairing(botId: string): Promise<{ pairingId: string; expiresAt: string; url: string }>;
  confirmTelegramPairing(botId: string, pairingId: string): Promise<BotTelegramStatus>;
  revokeTelegramPairing(botId: string): Promise<BotTelegramStatus>;
  setTelegramPreferences(botId: string, preferences: BotTelegramStatus['preferences']): Promise<BotTelegramStatus>;
  retryTelegramDelivery(botId: string, deliveryId: string): Promise<{ retryQueued: boolean; mayDuplicateLastPart: boolean }>;
  getSpeechStatus(botId: string): Promise<BotSpeechStatus>;
  configureSpeech(botId: string, request: BotSpeechConfiguration): Promise<BotSpeechStatus>;
  checkSpeech(botId: string): Promise<{ stt: { ready: boolean; code: string | null }; tts: { ready: boolean; code: string | null } }>;
  getCapabilities(): Promise<BotCapabilities>;
  listBots(): Promise<{ bots: BotSummary[]; canCreateBot: boolean }>;
  createBot(request: {
    name: string;
    tenancy: BotTenancy;
    contract: BotRevisionContract;
  }): Promise<{
    bot: BotSummary;
    revision: BotRevisionDetail;
    membership: BotManagedMembership;
  }>;
  getBot(botId: string): Promise<BotManagementDetail>;
  updateBotProfile(botId: string, request: {
    name: string;
    title: string;
    summary: string;
    expectedUpdatedAt: string;
    avatar?: null | { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string };
  }): Promise<{ bot: BotSummary; avatarCleanupRequired: boolean }>;
  getBotModelOptions(botId: string): Promise<BotModelOptions>;
  listBotAgentConnections(botId: string): Promise<{ connections: BotAgentConnection[] }>;
  createBotAgentConnection(botId: string, request: {
    name: string;
    endpointUrl: string;
    authMode: 'none' | 'bearer';
    bearer?: string;
    modelHint: string | null;
    limits: BotAgentConnectionLimits;
  }): Promise<{ connection: BotAgentConnection }>;
  updateBotAgentConnection(botId: string, connectionId: string, request: {
    name: string;
    endpointUrl: string;
    authMode: 'none' | 'bearer';
    bearer?: string;
    modelHint: string | null;
    limits: BotAgentConnectionLimits;
    expectedUpdatedAt: string;
  }): Promise<{ connection: BotAgentConnection }>;
  testBotAgentConnection(botId: string, connectionId: string): Promise<{
    connection: BotAgentConnection;
  }>;
  revokeBotAgentConnection(botId: string, connectionId: string, expectedUpdatedAt: string): Promise<{
    connection: BotAgentConnection;
  }>;
  createBotRevision(botId: string, request: {
    contract: BotRevisionContract;
    basedOnRevisionId?: string;
  }): Promise<{ revision: BotRevisionDetail }>;
  updateBotRevision(botId: string, revisionId: string, request: {
    contract: BotRevisionContract;
    expectedUpdatedAt: string;
  }): Promise<{ revision: BotRevisionDetail }>;
  getBotCapabilityBindings(botId: string, revisionId: string, options?: {
    directory?: string | null;
    checkLive?: boolean;
  }): Promise<BotCapabilityBindings>;
  attachBotSkill(botId: string, revisionId: string, request: {
    skillName: string;
    directory?: string;
    expectedUpdatedAt: string;
  }): Promise<{ revision: BotRevisionDetail }>;
  detachBotSkill(botId: string, revisionId: string, bindingId: string, expectedUpdatedAt: string): Promise<{
    revision: BotRevisionDetail;
  }>;
  attachBotMcp(botId: string, revisionId: string, request: {
    serverName: string;
    directory?: string;
    expectedUpdatedAt: string;
    confirmSharedCredential: boolean;
  }): Promise<{ revision: BotRevisionDetail }>;
  detachBotMcp(botId: string, revisionId: string, bindingId: string, expectedUpdatedAt: string): Promise<{
    revision: BotRevisionDetail;
  }>;
  rotateBotMcpCredential(botId: string, revisionId: string, bindingId: string, request: {
    serverName: string;
    directory?: string;
    expectedUpdatedAt: string;
    confirmSharedCredential: boolean;
  }): Promise<{ revision: BotRevisionDetail }>;
  getBotActivationHealth(botId: string, revisionId: string): Promise<BotActivationHealth>;
  activateBotRevision(botId: string, revisionId: string): Promise<{
    bot: BotSummary;
    health: BotActivationHealth;
  }>;
  publishBotRevision(botId: string, revisionId: string, request: {
    contract: BotRevisionContract;
    expectedUpdatedAt: string;
    profile?: {
      name: string;
      title: string;
      summary: string;
      expectedUpdatedAt: string;
      avatar?: null | { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string };
    };
  }): Promise<{
    bot: BotSummary;
    revision: BotRevisionDetail;
    health: BotActivationHealth;
    futureRunsOnly: true;
    profileUpdated: boolean;
    avatarCleanupRequired: boolean;
  }>;
  exportBotSpec(botId: string, revisionId: string): Promise<{
    source: string;
    filename: string;
    specHash: string;
  }>;
  previewBotSpecImport(request: {
    source: string;
    botId?: string;
    newBotName?: string;
    mappings?: readonly BotSpecImportMapping[];
  }): Promise<BotSpecImportPreview>;
  importBotSpecDraft(request: {
    source: string;
    botId?: string;
    newBotName?: string;
    mappings: readonly BotSpecImportMapping[];
    acknowledgeUnknownSigner?: true;
  }): Promise<{
    bot: BotSummary;
    revision: BotRevisionDetail;
    membership?: BotManagedMembership;
    signerStatus: 'trusted' | 'unknown';
    unresolvedBindings: readonly Omit<BotSpecImportRequirement, 'candidates'>[];
    sourceCompiledHash: string;
    compiledHashMatches: boolean;
    activated: false;
  }>;
  resolveBotSpecBindings(botId: string, revisionId: string, request: {
    expectedUpdatedAt: string;
    mappings: readonly BotSpecImportMapping[];
  }): Promise<{
    revision: BotRevisionDetail;
    unresolvedBindings: readonly Omit<BotSpecImportRequirement, 'candidates'>[];
    sourceCompiledHash: null;
  }>;
  listBotSignerTrust(botId?: string): Promise<BotSignerTrust[]>;
  setBotSignerTrust(request: {
    scope: 'global' | 'bot';
    botId?: string;
    signerKeyId: string;
    signerPublicKey: string;
    status: 'trusted' | 'revoked';
  }): Promise<BotSignerTrust>;
  transitionBotLifecycle(botId: string, request: {
    lifecycle: 'active' | 'paused' | 'retired';
    expectedUpdatedAt: string;
  }): Promise<{ bot: BotSummary }>;
  setBotMembership(botId: string, request: {
    userId: string;
    role: BotMembershipRole;
    expectedUpdatedAt?: string;
  }): Promise<{ membership: BotManagedMembership }>;
  revokeBotMembership(botId: string, userId: string, expectedUpdatedAt: string): Promise<{
    membership: BotManagedMembership;
  }>;
  saveBotCredentialMetadata(botId: string, request: {
    provider: string;
    label: string;
    kind: 'api_key';
    credentialScope: 'team' | 'user';
    ownerUserId: string | null;
    secret: string;
  } | {
    provider: string;
    connectionId: string;
    label: string;
    kind: 'oauth';
    credentialScope: 'team' | 'user';
    ownerUserId: string | null;
  }): Promise<{ credential: BotCredentialMetadata }>;
  rotateBotCredential(botId: string, credentialId: string, request: {
    secret: string;
    expectedUpdatedAt: string;
  }): Promise<{ credential: BotCredentialMetadata }>;
  reconnectBotCredential(botId: string, credentialId: string, request: {
    connectionId: 'host:openai';
    expectedUpdatedAt: string;
  }): Promise<{ credential: BotCredentialMetadata }>;
  listBotEnvironmentSecrets(botId: string): Promise<{
    environmentSecrets: readonly BotEnvironmentSecretMetadata[];
  }>;
  putBotEnvironmentSecret(botId: string, name: string, request: {
    value: string;
    expectedUpdatedAt: string | null;
  }): Promise<{ environmentSecret: BotEnvironmentSecretMetadata }>;
  deleteBotEnvironmentSecret(botId: string, name: string, request: {
    expectedUpdatedAt: string;
  }): Promise<{ deleted: true; name: string }>;
  getBotPurgePreview(botId: string): Promise<BotPurgePreview>;
  getBotPurge(botId: string): Promise<{ purge: BotPurgeExecutionResult | null }>;
  startBotPurge(botId: string, request: BotPurgeStartRequest): Promise<{
    purge: BotPurgeExecutionResult;
  }>;
  deleteBotCompletely(botId: string, request: BotCompleteDeleteRequest): Promise<{
    purge: BotPurgeExecutionResult;
  }>;
  retryBotPurge(botId: string, request: { resourceIds: readonly string[] }): Promise<{
    purge: BotPurgeExecutionResult;
  }>;
  listBotRoutines(botId: string, options?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<{ routines: BotRoutine[]; nextCursor: string | null }>;
  draftBotRoutine(botId: string, request: {
    rationale: string;
    timezone: string;
  }): Promise<{ contract: BotRoutineContract; requiresManagerReview: true }>;
  createBotRoutineDraft(botId: string, request: {
    name: string;
    contract: BotRoutineContract;
  }): Promise<{ routine: BotRoutine }>;
  updateBotRoutineDraft(botId: string, routineId: string, request: {
    name: string;
    contract: BotRoutineContract;
    expectedUpdatedAt: string;
  }): Promise<{ routine: BotRoutine }>;
  transitionBotRoutine(botId: string, routineId: string, request: {
    target: 'active' | 'paused' | 'retired';
    expectedUpdatedAt: string;
    reviewed?: true;
  }): Promise<{ routine: BotRoutine }>;
  listBotLibrarySources(botId: string, options?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<BotLibrarySourcePage>;
  listBotComputerFiles(botId: string, options?: {
    path?: string | null;
    scope?: 'workspace' | 'container';
  }): Promise<BotComputerFiles>;
  listBotComputerResources(botId: string): Promise<{
    resources: readonly BotComputerResource[];
  }>;
  importBotComputerResource(botId: string, request: { path: string }): Promise<{
    imported: readonly {
      computerPath: string;
      sourcePath: string;
      kind: 'file';
      bytes: number;
      sha256: string;
    }[];
    skipped: readonly { path: string; reason: string }[];
    rootComputerPath: string;
    indexSynchronized: boolean;
  }>;
  searchBotDirectory(botId: string, options?: {
    query?: string;
    limit?: number;
  }): Promise<{ users: BotDirectoryUser[] }>;
  scanBotLibraryImport(botId: string, request: {
    path: string;
    name: string;
    exclusions: {
      names: readonly string[];
      extensions: readonly string[];
      paths: readonly string[];
    };
  }): Promise<BotLibraryScan>;
  scanBotLibraryRefresh(botId: string, sourceId: string): Promise<BotLibraryScan>;
  publishBotLibraryScan(botId: string, scanId: string, request: {
    confirmed: true;
    expectedSourceUpdatedAt: string | null;
  }): Promise<BotLibraryPublication>;
  getBotLibraryVersion(botId: string, versionId: string): Promise<BotLibraryVersionDetail>;
  rebuildBotLibraryIndex(botId: string): Promise<Readonly<Record<string, unknown>>>;
  listBotMemories(botId: string, options?: {
    cursor?: string | null;
    limit?: number;
    state?: 'active' | 'forgotten' | null;
  }): Promise<BotMemoryPage>;
  requeueBotMemoryExtraction(botId: string, runId: string): Promise<{ job: BotMemoryExtractionJob }>;
  getBotMemory(botId: string, memoryId: string): Promise<BotMemoryDetail>;
  editBotMemory(botId: string, memoryId: string, request: {
    text: string;
    sensitivity: BotMemorySensitivity;
    confidence: number;
    expectedUpdatedAt: string;
  }): Promise<{ memory: BotMemory; version: BotMemoryVersion; indexSynchronized: boolean }>;
  mergeBotMemories(botId: string, request: {
    targetMemoryId: string;
    sourceMemoryIds: readonly string[];
    text: string;
    sensitivity: BotMemorySensitivity;
    confidence: number;
    expectedUpdatedAt: string;
  }): Promise<{
    memory: BotMemory;
    version: BotMemoryVersion;
    tombstonedSourceIds: string[];
    conflicts: string[];
    indexSynchronized: boolean;
  }>;
  tombstoneBotMemory(botId: string, memoryId: string, expectedUpdatedAt: string): Promise<{
    memory: BotMemory;
    indexSynchronized: boolean;
  }>;
  restoreBotMemory(botId: string, memoryId: string, expectedUpdatedAt: string): Promise<{
    memory: BotMemory;
    indexSynchronized: boolean;
  }>;
  rebuildBotMemoryIndex(botId: string): Promise<{
    documentCount: number;
    memoryCount: number;
    channelSummaryCount: number;
  }>;
  deleteBotChannel(channelId: string): Promise<{
    deleted: true;
    channelId: string;
    retainedSharedMemories: number;
    deletedMessages: number;
    deletedObjects: number;
    notice: string;
  }>;
  getOrCreateOwnerChannel(botId: string): Promise<{ channel: BotChannel }>;
  listMessages(channelId: string, options?: {
    cursor?: string | null;
    limit?: number;
    breakGlassReason?: string | null;
  }): Promise<BotMessagePage>;
  sendMessage(channelId: string, request: BotSendMessageRequest): Promise<BotSendMessageResponse>;
  prewarmChannel(channelId: string): Promise<BotPrewarmState>;
  releasePrewarmChannel(channelId: string, leaseId: string): Promise<{ released: boolean }>;
  getRunStatus(runId: string): Promise<{ run: BotRun }>;
  retryRun(runId: string): Promise<{ run: BotRun }>;
  cancelRun(runId: string): Promise<{ run: BotRun }>;
  listPendingActions(limit?: number): Promise<{ actions: BotActionAttempt[]; nextCursor: string | null }>;
  decideAction(actionId: string, request: BotApprovalDecisionRequest): Promise<{
    action: BotActionAttempt;
    approval: BotApproval;
  }>;
  getAction(actionId: string): Promise<{ action: BotActionAttempt; receipt: BotActionReceipt | null }>;
  reconcileAction(actionId: string, request: BotReconciliationRequest): Promise<{
    action: BotActionAttempt;
    receipt: BotActionReceipt | null;
    retryIdempotencyKey: string | null;
    replayed: false;
  }>;
  getActionEvidence(actionId: string, objectId: string): Promise<Blob>;
  getComputerStatus(botId: string): Promise<BotComputerStatus>;
  startComputerView(botId: string, channelId: string, runId?: string): Promise<{ view: BotComputerViewSession }>;
  stopComputerView(botId: string, viewId: string): Promise<{ stopped: boolean }>;
  takeComputerControl(botId: string): Promise<{ botId: string; control: BotComputerControl | null }>;
  heartbeatComputerControl(botId: string, leaseId: string): Promise<{
    botId: string;
    control: BotComputerControl | null;
  }>;
  returnComputerControl(botId: string, leaseId: string): Promise<{
    botId: string;
    control: BotComputerControl | null;
  }>;
  sendHumanComputerCommand(botId: string, request: {
    viewId?: string;
    leaseId: string;
    command: string;
    args: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<{ result: unknown }>;
  uploadObject(botId: string, channelId: string, request: {
    contentType: string;
    dataBase64: string;
    provenance?: Readonly<Record<string, unknown>>;
  }): Promise<{ object: BotObject }>;
  listSharedFiles(botId: string, channelId: string): Promise<{
    sharedFiles: BotSharedFile[];
    nextCursor: string | null;
  }>;
  retrySharedFile(botId: string, channelId: string, sharedFileId: string): Promise<{
    sharedFile: BotSharedFile;
  }>;
  downloadObject(
    botId: string,
    objectId: string,
    breakGlassReason?: string | null,
    signal?: AbortSignal,
  ): Promise<Blob>;
  deleteObject(botId: string, objectId: string): Promise<{
    object: BotObject;
    storageDeleted: boolean;
    cleanupRequired: boolean;
    errorCode?: string;
  }>;
  publishObject(botId: string, objectId: string, request: {
    name: string;
    sourceId?: string;
    provenance?: Readonly<Record<string, unknown>>;
  }): Promise<BotLibraryPublication>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const errorFromPayload = (status: number, payload: unknown): BotsApiError => {
  const record = isRecord(payload) ? payload : {};
  const nested = isRecord(record.error) ? record.error : {};
  const code = typeof record.code === 'string' && record.code.trim()
    ? record.code
    : typeof nested.code === 'string' && nested.code.trim()
      ? nested.code
      : 'bot_request_failed';
  const message = typeof record.error === 'string' && record.error.trim()
    ? record.error
    : typeof nested.message === 'string' && nested.message.trim()
      ? nested.message
      : `Production Bots request failed (${status})`;
  return new BotsApiError(message, {
    status,
    code,
    details: Object.hasOwn(record, 'details') ? record.details : null,
  });
};

const encoded = (value: string): string => encodeURIComponent(value);

// Every Bot request has a deadline. A hung acceptance or upload used to leave
// the composer frozen forever; now it fails as `bot_request_timeout`, which the
// send path treats as ambiguous (refresh, then one idempotent retry).
export const BOT_REQUEST_TIMEOUT_MS = 30_000;
export const BOT_UPLOAD_TIMEOUT_MS = 120_000;

type BotRequestInit = RequestInit & { timeoutMs?: number };

const deadlineSignal = (
  outer: AbortSignal | null | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; release: () => void } => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort();
  if (outer?.aborted) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    release: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
};

export const createBotsApi = ({
  fetchImpl = fetch,
  defaultTimeoutMs = BOT_REQUEST_TIMEOUT_MS,
}: { fetchImpl?: typeof fetch; defaultTimeoutMs?: number } = {}): BotsApi => {
  const request = async (input: string, init: BotRequestInit = {}): Promise<Response> => {
    const { timeoutMs = defaultTimeoutMs, signal: outerSignal, ...rest } = init;
    const deadline = deadlineSignal(outerSignal, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(input, {
        credentials: 'same-origin',
        cache: rest.method && rest.method !== 'GET' ? rest.cache : 'no-store',
        ...rest,
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.timedOut()) {
        throw new BotsApiError('Production Bots request timed out', {
          status: 504,
          code: 'bot_request_timeout',
        });
      }
      throw new BotsApiError(
        error instanceof Error ? error.message : 'Production Bots request failed',
        { status: 0, code: 'network_error' },
      );
    } finally {
      deadline.release();
    }
    if (response.ok) return response;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw errorFromPayload(response.status, payload);
  };

  const requestJson = async <T>(input: string, init: BotRequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    const response = await request(input, {
      ...init,
      headers,
    });
    try {
      return await response.json() as T;
    } catch {
      throw new BotsApiError('Production Bots returned an invalid response', {
        status: 502,
        code: 'bot_invalid_response',
      });
    }
  };

  const mutateJson = <T>(
    input: string,
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> => (
    (() => {
      const headers = new Headers();
      headers.set('Content-Type', 'application/json');
      headers.set('X-DevRyan-CSRF', '1');
      return requestJson<T>(input, {
        method,
        headers,
        ...(signal ? { signal } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    })()
  );

  const control = (
    botId: string,
    operation: 'take' | 'heartbeat' | 'return',
    leaseId?: string,
  ) => mutateJson<{ botId: string; control: BotComputerControl | null }>(
    `/api/bots/${encoded(botId)}/computer/control/${operation}`,
    'POST',
    leaseId === undefined ? {} : { leaseId },
  );

  const api: BotsApi = {
    getTelegramStatus: (botId) => requestJson(`/api/bots/${encoded(botId)}/telegram`),
    configureTelegram: (botId, body) => mutateJson(`/api/bots/${encoded(botId)}/telegram`, 'PUT', body),
    disconnectTelegram: (botId) => mutateJson(`/api/bots/${encoded(botId)}/telegram`, 'DELETE'),
    createTelegramPairing: (botId) => mutateJson(`/api/bots/${encoded(botId)}/telegram/pairing`, 'POST'),
    confirmTelegramPairing: (botId, pairingId) => mutateJson(`/api/bots/${encoded(botId)}/telegram/pairing/confirm`, 'POST', { pairingId }),
    revokeTelegramPairing: (botId) => mutateJson(`/api/bots/${encoded(botId)}/telegram/pairing`, 'DELETE'),
    setTelegramPreferences: (botId, body) => mutateJson(`/api/bots/${encoded(botId)}/telegram/preferences`, 'PUT', body),
    retryTelegramDelivery: (botId, deliveryId) => mutateJson(`/api/bots/${encoded(botId)}/telegram/deliveries/retry`, 'POST', { deliveryId }),
    getSpeechStatus: (botId) => requestJson(`/api/bots/${encoded(botId)}/speech`),
    configureSpeech: (botId, body) => mutateJson(`/api/bots/${encoded(botId)}/speech`, 'PUT', body),
    checkSpeech: (botId) => mutateJson(`/api/bots/${encoded(botId)}/speech/check`, 'POST'),
    getCapabilities: () => requestJson('/api/bots/capabilities'),
    listBots: () => requestJson('/api/bots'),
    createBot: (body) => mutateJson('/api/bots', 'POST', body),
    getBot: (botId) => requestJson(`/api/bots/${encoded(botId)}`),
    updateBotProfile: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/profile`,
      'PATCH',
      body,
    ),
    getBotModelOptions: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/model-options`,
    ),
    listBotAgentConnections: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/agent-connections`,
    ),
    createBotAgentConnection: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/agent-connections`,
      'POST',
      body,
    ),
    updateBotAgentConnection: (botId, connectionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/agent-connections/${encoded(connectionId)}`,
      'PUT',
      body,
    ),
    testBotAgentConnection: (botId, connectionId) => mutateJson(
      `/api/bots/${encoded(botId)}/agent-connections/${encoded(connectionId)}/test`,
      'POST',
      {},
    ),
    revokeBotAgentConnection: (botId, connectionId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/agent-connections/${encoded(connectionId)}`,
      'DELETE',
      { expectedUpdatedAt },
    ),
    createBotRevision: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions`,
      'POST',
      body,
    ),
    updateBotRevision: (botId, revisionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}`,
      'PATCH',
      body,
    ),
    getBotCapabilityBindings(botId, revisionId, options = {}) {
      const query = new URLSearchParams();
      if (options.directory) query.set('directory', options.directory);
      if (options.checkLive) query.set('checkLive', 'true');
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(
        `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/capability-bindings${suffix}`,
      );
    },
    attachBotSkill: (botId, revisionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/skill-bindings`,
      'POST',
      body,
    ),
    detachBotSkill: (botId, revisionId, bindingId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/skill-bindings/${encoded(bindingId)}`,
      'DELETE',
      { expectedUpdatedAt },
    ),
    attachBotMcp: (botId, revisionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/mcp-bindings`,
      'POST',
      body,
    ),
    detachBotMcp: (botId, revisionId, bindingId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/mcp-bindings/${encoded(bindingId)}`,
      'DELETE',
      { expectedUpdatedAt },
    ),
    rotateBotMcpCredential: (botId, revisionId, bindingId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/mcp-bindings/${encoded(bindingId)}/credential`,
      'POST',
      body,
    ),
    getBotActivationHealth: (botId, revisionId) => requestJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/activation-health`,
    ),
    activateBotRevision: (botId, revisionId) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/activate`,
      'POST',
      {},
    ),
    publishBotRevision: (botId, revisionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/publish`,
      'POST',
      body,
    ),
    async exportBotSpec(botId, revisionId) {
      const response = await request(
        `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/export`,
        { headers: { Accept: 'application/vnd.devryan.bot-revision+json' } },
      );
      const disposition = response.headers.get('Content-Disposition') || '';
      const filenameMatch = /filename="([^"\\/]+)"/u.exec(disposition);
      return {
        source: await response.text(),
        filename: filenameMatch?.[1] || `DevRyan-Bot-revision.devryan-bot.json`,
        specHash: response.headers.get('X-DevRyan-Bot-Spec-Hash') || '',
      };
    },
    previewBotSpecImport: (body) => mutateJson(
      '/api/bot-specs/import/preview',
      'POST',
      body,
    ),
    importBotSpecDraft: (body) => mutateJson(
      '/api/bot-specs/import',
      'POST',
      body,
    ),
    resolveBotSpecBindings: (botId, revisionId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/revisions/${encoded(revisionId)}/import-bindings`,
      'PUT',
      body,
    ),
    listBotSignerTrust(botId) {
      const query = botId ? `?botId=${encoded(botId)}` : '';
      return requestJson(`/api/bot-signers/trust${query}`);
    },
    setBotSignerTrust: (body) => mutateJson('/api/bot-signers/trust', 'PUT', body),
    transitionBotLifecycle: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/lifecycle`,
      'POST',
      body,
    ),
    setBotMembership: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/memberships`,
      'POST',
      body,
    ),
    revokeBotMembership: (botId, userId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/memberships/${encoded(userId)}`,
      'DELETE',
      { expectedUpdatedAt },
    ),
    saveBotCredentialMetadata: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/credentials`,
      'POST',
      body,
    ),
    rotateBotCredential: (botId, credentialId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/credentials/${encoded(credentialId)}/rotate`,
      'POST',
      body,
    ),
    reconnectBotCredential: (botId, credentialId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/credentials/${encoded(credentialId)}/reconnect`, 'POST', body,
    ),
    getBotPurgePreview: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/purge-preview`,
    ),
    getBotPurge: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/purge`,
    ),
    startBotPurge: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/purge`,
      'POST',
      body,
    ),
    deleteBotCompletely: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/purge/complete`,
      'POST',
      body,
    ),
    retryBotPurge: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/purge/retry`,
      'POST',
      body,
    ),
    listBotRoutines(botId, options = {}) {
      const query = new URLSearchParams();
      if (options.cursor) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bots/${encoded(botId)}/routines${suffix}`);
    },
    draftBotRoutine: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/routines/draft`,
      'POST',
      body,
    ),
    createBotRoutineDraft: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/routines`,
      'POST',
      body,
    ),
    updateBotRoutineDraft: (botId, routineId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/routines/${encoded(routineId)}`,
      'PATCH',
      body,
    ),
    transitionBotRoutine: (botId, routineId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/routines/${encoded(routineId)}/lifecycle`,
      'POST',
      body,
    ),
    listBotLibrarySources(botId, options = {}) {
      const query = new URLSearchParams();
      if (options.cursor) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bots/${encoded(botId)}/library-sources${suffix}`);
    },
    listBotComputerFiles(botId, options = {}) {
      const query = new URLSearchParams();
      if (options.path) query.set('path', options.path);
      if (options.scope) query.set('scope', options.scope);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bots/${encoded(botId)}/computer-files${suffix}`);
    },
    listBotComputerResources: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/computer-resources`,
    ),
    importBotComputerResource: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/computer-resources/import`,
      'POST',
      body,
    ),
    listBotEnvironmentSecrets: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/environment-secrets`,
    ),
    putBotEnvironmentSecret: (botId, name, body) => mutateJson(
      `/api/bots/${encoded(botId)}/environment-secrets/${encoded(name)}`,
      'PUT',
      body,
    ),
    deleteBotEnvironmentSecret: (botId, name, body) => mutateJson(
      `/api/bots/${encoded(botId)}/environment-secrets/${encoded(name)}`,
      'DELETE',
      body,
    ),
    searchBotDirectory(botId, options = {}) {
      const query = new URLSearchParams();
      if (options.query) query.set('q', options.query);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bots/${encoded(botId)}/directory${suffix}`);
    },
    scanBotLibraryImport: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/library-sources/scan`,
      'POST',
      body,
    ),
    scanBotLibraryRefresh: (botId, sourceId) => mutateJson(
      `/api/bots/${encoded(botId)}/library-sources/${encoded(sourceId)}/scan`,
      'POST',
      {},
    ),
    publishBotLibraryScan: (botId, scanId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/library-scans/${encoded(scanId)}/publish`,
      'POST',
      body,
    ),
    getBotLibraryVersion: (botId, versionId) => requestJson(
      `/api/bots/${encoded(botId)}/library-versions/${encoded(versionId)}`,
    ),
    rebuildBotLibraryIndex: (botId) => mutateJson(
      `/api/bots/${encoded(botId)}/library-index/rebuild`,
      'POST',
      {},
    ),
    listBotMemories(botId, options = {}) {
      const query = new URLSearchParams();
      if (options.cursor) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.state) query.set('state', options.state);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bots/${encoded(botId)}/memories${suffix}`);
    },
    requeueBotMemoryExtraction: (botId, runId) => mutateJson(
      `/api/bots/${encoded(botId)}/memories/extraction/${encoded(runId)}/requeue`,
      'POST',
      {},
    ),
    getBotMemory: (botId, memoryId) => requestJson(
      `/api/bots/${encoded(botId)}/memories/${encoded(memoryId)}`,
    ),
    editBotMemory: (botId, memoryId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/memories/${encoded(memoryId)}`,
      'PATCH',
      body,
    ),
    mergeBotMemories: (botId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/memories/merge`,
      'POST',
      body,
    ),
    tombstoneBotMemory: (botId, memoryId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/memories/${encoded(memoryId)}/tombstone`,
      'POST',
      { expectedUpdatedAt },
    ),
    restoreBotMemory: (botId, memoryId, expectedUpdatedAt) => mutateJson(
      `/api/bots/${encoded(botId)}/memories/${encoded(memoryId)}/restore`,
      'POST',
      { expectedUpdatedAt },
    ),
    rebuildBotMemoryIndex: (botId) => mutateJson(
      `/api/bots/${encoded(botId)}/memory-index/rebuild`,
      'POST',
      {},
    ),
    deleteBotChannel: (channelId) => mutateJson(
      `/api/bot-channels/${encoded(channelId)}`,
      'DELETE',
      { sharedMemorySurvives: true },
    ),
    getOrCreateOwnerChannel: (botId) => mutateJson(
      `/api/bots/${encoded(botId)}/channel`,
      'POST',
      {},
    ),
    listMessages(channelId, options = {}) {
      const query = new URLSearchParams();
      if (options.cursor) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/bot-channels/${encoded(channelId)}/messages${suffix}`, {
        headers: options.breakGlassReason
          ? { 'X-DevRyan-Break-Glass-Reason': options.breakGlassReason }
          : undefined,
      });
    },
    sendMessage: (channelId, body) => mutateJson(
      `/api/bot-channels/${encoded(channelId)}/messages`,
      'POST',
      body,
    ),
    prewarmChannel: (channelId) => mutateJson(
      `/api/bot-channels/${encoded(channelId)}/prewarm`,
      'POST',
      {},
    ),
    releasePrewarmChannel: (channelId, leaseId) => mutateJson(
      `/api/bot-channels/${encoded(channelId)}/prewarm/${encoded(leaseId)}`,
      'DELETE',
    ),
    getRunStatus: (runId) => requestJson(`/api/bot-runs/${encoded(runId)}/status`),
    retryRun: (runId) => mutateJson(`/api/bot-runs/${encoded(runId)}/retry`, 'POST', {}),
    cancelRun: (runId) => mutateJson(`/api/bot-runs/${encoded(runId)}/cancel`, 'POST', {}),
    listPendingActions(limit = 100) {
      const query = new URLSearchParams({ limit: String(limit) });
      return requestJson(`/api/bot-actions/pending?${query.toString()}`);
    },
    decideAction: (actionId, body) => mutateJson(
      `/api/bot-actions/${encoded(actionId)}/decision`,
      'POST',
      body,
    ),
    getAction: (actionId) => requestJson(`/api/bot-actions/${encoded(actionId)}`),
    reconcileAction: (actionId, body) => mutateJson(
      `/api/bot-actions/${encoded(actionId)}/reconcile`,
      'POST',
      body,
    ),
    async getActionEvidence(actionId, objectId) {
      return (await request(
        `/api/bot-actions/${encoded(actionId)}/evidence/${encoded(objectId)}`,
      )).blob();
    },
    getComputerStatus: (botId) => requestJson(
      `/api/bots/${encoded(botId)}/computer/status`,
    ),
    startComputerView: (botId, channelId, runId) => mutateJson(
      `/api/bots/${encoded(botId)}/computer/view`,
      'POST',
      { channelId, ...(runId ? { runId } : {}) },
    ),
    stopComputerView: (botId, viewId) => mutateJson(
      `/api/bots/${encoded(botId)}/computer/view/${encoded(viewId)}`,
      'DELETE',
    ),
    takeComputerControl: (botId) => control(botId, 'take'),
    heartbeatComputerControl: (botId, leaseId) => control(botId, 'heartbeat', leaseId),
    returnComputerControl: (botId, leaseId) => control(botId, 'return', leaseId),
    sendHumanComputerCommand: (botId, body, signal) => mutateJson(
      `/api/bots/${encoded(botId)}/computer/control/command`,
      'POST',
      body,
      signal,
    ),
    uploadObject: (botId, channelId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/channels/${encoded(channelId)}/objects`,
      'POST',
      body,
      undefined,
      BOT_UPLOAD_TIMEOUT_MS,
    ),
    listSharedFiles: (botId, channelId) => requestJson(
      `/api/bots/${encoded(botId)}/channels/${encoded(channelId)}/shared-files`,
    ),
    retrySharedFile: (botId, channelId, sharedFileId) => mutateJson(
      `/api/bots/${encoded(botId)}/channels/${encoded(channelId)}/shared-files/${encoded(sharedFileId)}/retry`,
      'POST',
      {},
    ),
    async downloadObject(botId, objectId, breakGlassReason = null, signal) {
      return (await request(`/api/bots/${encoded(botId)}/objects/${encoded(objectId)}`, {
        signal,
        headers: breakGlassReason
          ? { 'X-DevRyan-Break-Glass-Reason': breakGlassReason }
          : undefined,
      })).blob();
    },
    deleteObject: (botId, objectId) => mutateJson(
      `/api/bots/${encoded(botId)}/objects/${encoded(objectId)}`,
      'DELETE',
    ),
    publishObject: (botId, objectId, body) => mutateJson(
      `/api/bots/${encoded(botId)}/objects/${encoded(objectId)}/publish`,
      'POST',
      body,
    ),
  };
  return Object.freeze(api);
};

export const botsApi = createBotsApi();

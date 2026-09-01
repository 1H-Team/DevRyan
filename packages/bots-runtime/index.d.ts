export type BotJsonPrimitive = string | number | boolean | null;
export type BotJsonValue = BotJsonPrimitive | BotJsonValue[] | BotJsonObject;
export interface BotJsonObject {
  [key: string]: BotJsonValue;
}

export class StrictJsonError extends SyntaxError {
  code: string;
}
export function parseStrictJson(
  source: string,
  options?: {
    maximumBytes?: number;
    maximumDepth?: number;
    maximumNodes?: number;
  },
): unknown;

export type BotLifecycle = 'draft' | 'active' | 'paused' | 'retired';
export type BotTenancy = 'team' | 'personalized';
export type BotMemberRole = 'member' | 'operator' | 'manager';
export type BotChannelAclRole = 'reader' | 'collaborator';
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
export type BotActionState =
  | 'proposed'
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'waiting_control'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciled'
  | 'denied'
  | 'cancelled';
export type BotPolicyEffect = 'deny' | 'prompt' | 'allow';
export type BotRiskLevel = 'low' | 'sensitive' | 'critical';
export type BotApprovalClass = 'none' | 'requester' | 'operator' | 'manager';
export type BotAuthorizationOperation =
  | 'read_channel'
  | 'send_channel'
  | 'operate_bot'
  | 'manage_bot';
export type BotRoutineMissedPolicy = 'skip' | 'run_once' | 'replay_capped';

export const BOT_LIFECYCLES: readonly BotLifecycle[];
export const BOT_TENANCIES: readonly BotTenancy[];
export const BOT_MEMBER_ROLES: readonly BotMemberRole[];
export const BOT_RUN_STATES: readonly BotRunState[];
export const BOT_ACTION_STATES: readonly BotActionState[];
export const BOT_CHANNEL_ACL_ROLES: readonly BotChannelAclRole[];
export const BOT_POLICY_EFFECTS: readonly BotPolicyEffect[];
export const BOT_RISK_LEVELS: readonly BotRiskLevel[];
export const BOT_APPROVAL_CLASSES: readonly BotApprovalClass[];
export const BOT_AUTHORIZATION_OPERATIONS: readonly BotAuthorizationOperation[];
export const BOT_ROUTINE_MISSED_POLICIES: readonly BotRoutineMissedPolicy[];

export const BOT_ERROR_CODES: Readonly<{
  unavailable: 'bots_unavailable';
  migrationRequired: 'bot_schema_migration_required';
  dockerNotInstalled: 'bot_runtime_docker_not_installed';
  dockerUnavailable: 'bot_runtime_docker_unavailable';
  runtimeSetupRequired: 'bot_runtime_setup_required';
  runtimeUpdateRequired: 'bot_runtime_update_required';
  botPaused: 'bot_paused';
  botRetired: 'bot_retired';
  membershipRequired: 'bot_membership_required';
  managerRequired: 'bot_manager_required';
  channelForbidden: 'bot_channel_forbidden';
  modelUnavailable: 'bot_model_unavailable';
  approvalRequired: 'bot_approval_required';
  actionNeedsReconciliation: 'bot_action_needs_reconciliation';
  revisionConflict: 'bot_revision_conflict';
}>;

export function isPlainBotJsonObject(value: unknown): value is Record<string, unknown>;
export function assertBotBoundaryObject(
  value: unknown,
  options: {
    label: string;
    required?: readonly string[];
    optional?: readonly string[];
  },
): Record<string, unknown>;
export function assertBotString(
  value: unknown,
  field: string,
  options?: { nullable?: boolean },
): string | null;
export function assertBotBoolean(value: unknown, field: string): boolean;
export function assertBotTimestamp(
  value: unknown,
  field: string,
  options?: { nullable?: boolean },
): number | null;
export function assertBotEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T;
export function assertBotJsonValue(value: unknown, path?: string): BotJsonValue;
export function canonicalizeBotJson(value: unknown): string;
export function hashCanonicalBotJson(value: unknown): string;

export function resolveComputerScopeKey(input: {
  botId: string;
  tenancy: BotTenancy;
  ownerUserId: string;
}): string;
export function resolveReasoningScopeKey(input: { channelId: string }): string;

export interface BotRevisionRecord {
  revisionId: string;
  botId: string;
  revisionNumber: number;
  contract: BotJsonObject;
  compiledHash: string;
  createdBy: string;
  createdAt: number;
  activatedAt: number | null;
  retiredAt: number | null;
}

export function canTransitionBotLifecycle(from: BotLifecycle, to: BotLifecycle): boolean;
export function assertBotLifecycleTransition(input: {
  from: BotLifecycle;
  to: BotLifecycle;
}): BotLifecycle;
export function validateBotRevisionRecord<T extends BotRevisionRecord>(revision: T): T;
export function assertBotRevisionUpdate<T extends BotRevisionRecord>(
  previous: BotRevisionRecord,
  next: T,
): T;

export type BotAuthorizationReason =
  | 'channel_owner'
  | 'channel_reader'
  | 'channel_collaborator'
  | 'channel_acl_required'
  | 'channel_collaborator_required'
  | 'active_membership_required'
  | 'operator'
  | 'manager'
  | 'operator_required'
  | 'manager_required'
  | 'global_admin'
  | 'global_admin_break_glass';

export interface BotAuthorizationDecision {
  allowed: boolean;
  reason: BotAuthorizationReason;
  breakGlass: boolean;
}

export function authorizeBotOperation(input: {
  operation: BotAuthorizationOperation;
  actorUserId: string;
  ownerUserId: string;
  membershipRole: BotMemberRole | null;
  channelAclRole: BotChannelAclRole | null;
  isGlobalAdmin: boolean;
  breakGlass: boolean;
}): BotAuthorizationDecision;

export function resolveBotApprovalClass(input: {
  effect: BotPolicyEffect;
  risk: BotRiskLevel;
}): BotApprovalClass;

export function canApproveBotAction(input: {
  approvalClass: BotApprovalClass;
  requesterUserId: string;
  approverUserId: string;
  approverRole: BotMemberRole;
  requireDistinctApprover: boolean;
}): boolean;

export interface BotActionDescriptor {
  botId: string;
  revisionId: string;
  runId: string;
  channelId: string;
  initiatorUserId: string;
  tool: string;
  action: string;
  target: BotJsonObject;
  credentialScopeKey: string | null;
  computerScopeKey: string;
  args: BotJsonObject;
  limits: BotJsonObject;
}

export function validateBotActionDescriptor<T extends BotActionDescriptor>(action: T): T;
export function hashBotAction(action: BotActionDescriptor): `sha256:${string}`;

export function isBotRunTerminalState(state: unknown): state is Extract<
  BotRunState,
  'completed' | 'failed' | 'cancelled' | 'interrupted'
>;
export function isBotActionTerminalState(state: unknown): state is Extract<
  BotActionState,
  'succeeded' | 'failed' | 'reconciled' | 'denied' | 'cancelled'
>;
export function isBotActionUnknownWriteState(state: unknown): state is 'unknown';
export function canTransitionBotRunState(from: BotRunState, to: BotRunState): boolean;
export function assertBotRunStateTransition(input: {
  from: BotRunState;
  to: BotRunState;
}): BotRunState;
export function canTransitionBotActionState(from: BotActionState, to: BotActionState): boolean;
export function assertBotActionStateTransition(input: {
  from: BotActionState;
  to: BotActionState;
}): BotActionState;

export interface BotComputerLease {
  runId: string;
  computerScopeKey: string;
  leaseGeneration: number;
  leaseUntil: number;
}

export type BotRunAdmissionDecision =
  | { admitted: true; reason: 'available'; leaseGeneration: 1 }
  | { admitted: true; reason: 'expired' | 'already_owned'; leaseGeneration: number }
  | { admitted: false; reason: 'scope_leased'; leaseGeneration: number };

export function decideBotRunAdmission(input: {
  runId: string;
  computerScopeKey: string;
  currentLease: BotComputerLease | null;
  now: number;
}): BotRunAdmissionDecision;

export function resolveInterruptedBotAction(input: {
  currentState: BotActionState;
  operationKind: 'read' | 'write';
}): BotActionState;

export function resolveDefaultBotRoutineMissedPolicy(input: {
  performsExternalWrites: boolean;
}): Extract<BotRoutineMissedPolicy, 'skip' | 'run_once'>;

export interface BotRoutineRecoveryPlan {
  disposition: BotRoutineMissedPolicy;
  occurrences: number[];
  approvalRequired: boolean;
}

export function resolveMissedBotRoutineOccurrences(input: {
  missedPolicy: BotRoutineMissedPolicy;
  missedRunCap: number;
  scheduledFor: number[];
  performsExternalWrites: boolean;
}): BotRoutineRecoveryPlan;

export class StrictJsonError extends SyntaxError {
  code: string;
}

export function parseStrictJson(source: string, options?: {
  maximumBytes?: number;
  maximumDepth?: number;
  maximumNodes?: number;
}): unknown;

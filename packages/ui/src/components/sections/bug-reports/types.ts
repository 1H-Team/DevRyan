export type BugReportStatus = 'submitted' | 'in_progress' | 'resolved';
export type ErrorLogKind = 'session' | 'tool' | 'managed_task' | 'client';
export type ErrorLogClearRange = '24h' | '7d' | '14d' | 'all';
export type DiagnosticImpact = 'low' | 'medium' | 'high' | 'critical';
export type DiagnosticDisposition = 'actionable' | 'expected';
export type DiagnosticClassificationSource = 'observed' | 'inferred';
export type DiagnosticOutcome = 'recovered' | 'unresolved' | 'unknown';
export type DiagnosticFailureClass =
  | 'filesystem_target'
  | 'input'
  | 'patch_context'
  | 'command_exit'
  | 'tool_runtime'
  | 'integration_runtime'
  | 'session_runtime'
  | 'managed_task'
  | 'client_runtime'
  | 'platform_security'
  | 'platform_integrity'
  | 'unknown';
export type BotAuditResult = 'failure' | 'partial' | 'unknown' | 'denied' | 'success';
export type BotAuditResultFilter = BotAuditResult | 'issues' | 'all';

export interface BugReportReporter {
  id: string | null;
  displayName: string;
  email: string;
  role: 'admin' | 'senior_developer' | 'developer';
}

export interface BugReportSummary {
  id: string;
  title: string;
  status: BugReportStatus;
  reporter: BugReportReporter;
  createdAt: string;
  updatedAt: string;
}

export interface BugReportDetail extends BugReportSummary {
  description: string;
}

export interface ErrorLogActor {
  id: string;
  displayName: string;
  email: string;
  role: 'admin' | 'senior_developer' | 'developer';
}

export interface ErrorLogProject {
  id: string;
  label: string;
}

export interface ErrorLogActorOption {
  id: string;
  displayName: string;
}

export interface BotAuditBot {
  id: string | null;
  name: string;
  title: string | null;
  lifecycle: 'draft' | 'active' | 'paused' | 'retired' | null;
  deleted: boolean;
}

export interface BotAuditBotOption {
  id: string;
  name: string;
  title: string | null;
  lifecycle: 'draft' | 'active' | 'paused' | 'retired';
}

export interface BotAuditActor {
  id: string | null;
  displayName: string;
  email: string;
  role: 'admin' | 'senior_developer' | 'developer' | null;
  former: boolean;
}

export interface BotAuditTarget {
  type: string;
  id: string | null;
}

export interface BotAuditSummary {
  eventId: string;
  action: string;
  result: BotAuditResult;
  timestamp: string;
  summary: string;
  diagnosticCode: string | null;
  bot: BotAuditBot;
  actor: BotAuditActor;
  target: BotAuditTarget;
  resolvedAt?: string | null;
  resolvedByEventId?: string | null;
}

export interface BotAuditDetail extends BotAuditSummary {
  metadata: Record<string, unknown>;
  metadataRedacted: boolean;
}

export interface ErrorLogSummary {
  eventId: string;
  kind: ErrorLogKind;
  action: 'session.error' | 'tool.failed' | 'managed_task.failed' | 'client.error';
  createdAt: string;
  actor: ErrorLogActor | null;
  project: ErrorLogProject | null;
  sessionId: string | null;
  impact: DiagnosticImpact;
  disposition: DiagnosticDisposition;
  classificationSource: DiagnosticClassificationSource;
  failureClass: DiagnosticFailureClass;
  outcome: DiagnosticOutcome;
  summary: string;
  occurrenceCount: number | null;
  errorName: string | null;
  tool: string | null;
  statusCode: number | null;
}

export interface ErrorLogDetail extends Omit<ErrorLogSummary, 'errorName' | 'tool' | 'statusCode'> {
  failureText: string | null;
  stack: string | null;
  context: Record<string, unknown>;
}

export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

export class BugReportsRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code?: string | null; retryable?: boolean }) {
    super(message);
    this.name = 'BugReportsRequestError';
    this.status = options.status;
    this.code = options.code ?? null;
    this.retryable = options.retryable === true;
  }
}

export const bugReportStatusLabelKey = (status: BugReportStatus) => {
  if (status === 'in_progress') return 'settings.bugReports.status.inProgress' as const;
  if (status === 'resolved') return 'settings.bugReports.status.resolved' as const;
  return 'settings.bugReports.status.submitted' as const;
};

export const errorLogKindLabelKey = (kind: ErrorLogKind) => {
  if (kind === 'managed_task') return 'settings.bugReports.errors.kind.managedTask' as const;
  if (kind === 'tool') return 'settings.bugReports.errors.kind.tool' as const;
  if (kind === 'client') return 'settings.bugReports.errors.kind.client' as const;
  return 'settings.bugReports.errors.kind.session' as const;
};

export const diagnosticImpactLabelKey = (impact: DiagnosticImpact) => {
  if (impact === 'critical') return 'settings.bugReports.errors.impact.critical' as const;
  if (impact === 'high') return 'settings.bugReports.errors.impact.high' as const;
  if (impact === 'medium') return 'settings.bugReports.errors.impact.medium' as const;
  return 'settings.bugReports.errors.impact.low' as const;
};

export const diagnosticDispositionLabelKey = (disposition: DiagnosticDisposition) => (
  disposition === 'expected'
    ? 'settings.bugReports.errors.disposition.expected' as const
    : 'settings.bugReports.errors.disposition.actionable' as const
);

export const diagnosticOutcomeLabelKey = (outcome: DiagnosticOutcome) => {
  if (outcome === 'recovered') return 'settings.bugReports.errors.outcome.recovered' as const;
  if (outcome === 'unresolved') return 'settings.bugReports.errors.outcome.unresolved' as const;
  return 'settings.bugReports.errors.outcome.unknown' as const;
};

export const botAuditResultLabelKey = (result: BotAuditResult | 'issues' | 'all') => {
  if (result === 'issues') return 'settings.bugReports.botAudit.result.issues' as const;
  if (result === 'failure') return 'settings.bugReports.botAudit.result.failure' as const;
  if (result === 'partial') return 'settings.bugReports.botAudit.result.partial' as const;
  if (result === 'unknown') return 'settings.bugReports.botAudit.result.unknown' as const;
  if (result === 'denied') return 'settings.bugReports.botAudit.result.denied' as const;
  if (result === 'success') return 'settings.bugReports.botAudit.result.success' as const;
  return 'settings.bugReports.botAudit.result.all' as const;
};

export const selectClassName =
  'h-9 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 typography-ui-label text-foreground outline-none transition focus:ring-2 focus:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';

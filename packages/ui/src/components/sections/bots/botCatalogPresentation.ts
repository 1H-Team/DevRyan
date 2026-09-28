import type { BotCatalogBackup, BotCatalogStatus } from '@/lib/botsApi';

// Exactly one recovery control per catalog state. Order matters: a running
// operation outranks recovery, recovery outranks the activation hold, and the
// hold outranks import notices.
export type BotCatalogAction =
  | { kind: 'maintenance' }
  | { kind: 'import_running' }
  | { kind: 'restore'; backup: BotCatalogBackup }
  | { kind: 'start_empty' }
  | { kind: 'owner_required' }
  | { kind: 'resume_activation' }
  | { kind: 'import_blocked' }
  | { kind: 'import_failed'; code: string; message: string; retry: boolean }
  | { kind: 'import_pending' }
  | { kind: 'discovery_checking' }
  | { kind: 'discovery_failed'; code: string };

// A fresh import cannot fix these: the owner has to resolve them first.
const TERMINAL_IMPORT_CODES = new Set([
  'bot_import_bot_conflict',
  'bot_import_conflict',
  'bot_import_local_not_empty',
  'bot_import_source_schema_unsupported',
  'bot_import_source_unconfigured',
]);

export const resolveBotCatalogAction = (
  status: BotCatalogStatus | null,
  backups: readonly BotCatalogBackup[] | null,
): BotCatalogAction | null => {
  if (!status) return null;
  const current = status.import?.import ?? null;
  if (current?.running) return { kind: 'import_running' };
  if (status.maintenance || status.state === 'maintenance') return { kind: 'maintenance' };
  if (status.state === 'recovery_required') {
    if (!status.viewerIsOwner) return { kind: 'owner_required' };
    const latest = backups?.[0];
    return latest ? { kind: 'restore', backup: latest } : { kind: 'start_empty' };
  }
  if (!status.viewerIsOwner) return null;
  if (status.activationHold) return { kind: 'resume_activation' };
  if (current?.phase === 'blocked') return { kind: 'import_blocked' };
  if (current?.phase === 'failed' && current.error) {
    return {
      kind: 'import_failed',
      code: current.error.code,
      message: current.error.message,
      retry: !TERMINAL_IMPORT_CODES.has(current.error.code),
    };
  }
  if (status.import?.checking) return { kind: 'discovery_checking' };
  if (status.import?.cloud?.code) return { kind: 'discovery_failed', code: status.import.cloud.code };
  if (status.import?.pending) return { kind: 'import_pending' };
  return null;
};

// A saved hosted project is contacted only when the owner asks. The request
// is offered quietly while nothing else about the import needs attention.
export const canCheckHostedBots = (
  status: BotCatalogStatus | null,
  action: BotCatalogAction | null,
): boolean => Boolean(
  status?.viewerIsOwner
  && status.import?.sourceConfigured === true
  && status.state === 'ready'
  && action === null,
);

const BACKUP_KIND_LABELS: Readonly<Record<BotCatalogBackup['kind'], string>> = {
  daily: 'Daily',
  manual: 'Manual',
  pre_migration: 'Before Update',
  pre_import: 'Before Import',
  pre_restore: 'Before Restore',
  pre_start_empty: 'Before Start Empty',
};

export const botCatalogBackupLabel = (backup: BotCatalogBackup): string => (
  BACKUP_KIND_LABELS[backup.kind] ?? 'Backup'
);

export const formatBotCatalogBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const IMPORT_PHASE_LABELS: Readonly<Record<string, string>> = {
  exporting: 'Reading hosted Bots…',
  exporting_objects: 'Reading hosted files…',
  verifying: 'Verifying the hosted copy…',
  loading_source: 'Preparing the import…',
  merging: 'Adding Bots to this computer…',
};

// Why hosted discovery failed and what the owner can do about it. The hosted
// Bots themselves are untouched by any of these.
export const botCatalogDiscoveryFailure = (code: string): { title: string; detail: string } => {
  if (code === 'bot_import_source_quota_exceeded') {
    return {
      title: 'Hosted Project Is Over Its Quota',
      detail: 'The hosted project refuses reads until its usage quota is restored, so hosted Bots cannot be checked or imported yet. They have not been deleted. Restore service in the Supabase dashboard, then check again.',
    };
  }
  if (code === 'bot_import_source_forbidden') {
    return {
      title: 'Hosted Project Rejected the Saved Key',
      detail: 'The saved Supabase key is no longer accepted, so hosted Bots cannot be checked. Update the key, then check again.',
    };
  }
  return {
    title: 'Could Not Check Hosted Bots',
    detail: `The hosted source could not be checked (${code}).`,
  };
};

export const botCatalogImportPhaseLabel = (phase: string | null | undefined): string => (
  (phase && IMPORT_PHASE_LABELS[phase]) || 'Importing hosted Bots…'
);

// Catalog states that need the owner's attention in place of the chat.
export const isBotCatalogRecoveryState = (
  capabilities: { state?: string; database?: { state?: string } | null } | null | undefined,
): boolean => (
  capabilities?.state === 'database_recovery_required'
  || capabilities?.state === 'bots_maintenance'
  || capabilities?.database?.state === 'recovery_required'
  || capabilities?.database?.state === 'maintenance'
);

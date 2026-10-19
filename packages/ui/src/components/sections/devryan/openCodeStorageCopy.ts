import { formatBytes } from '@/lib/formatBytes';
import type { useI18n } from '@/lib/i18n';
import type { OpenCodeStorageRunSummary, OpenCodeStorageVacuumReason } from '@/lib/api/types';

// Copy helpers for the OpenCode Storage block, kept out of the component file
// so React Fast Refresh sees a components-only module.

export type Translate = ReturnType<typeof useI18n>['t'];

export const formatWhen = (at: number): string => {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return new Date(at).toISOString();
  }
};

export const formatCount = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '0'
);

export const describeVacuumReason = (t: Translate, reason: OpenCodeStorageVacuumReason | string | null | undefined): string => {
  switch (reason) {
    case 'not_requested':
      return t('settings.devryan.storage.vacuumReason.not_requested');
    case 'other_opencode_process':
      return t('settings.devryan.storage.vacuumReason.other_opencode_process');
    case 'free_disk_unknown':
      return t('settings.devryan.storage.vacuumReason.free_disk_unknown');
    case 'insufficient_free_disk':
      return t('settings.devryan.storage.vacuumReason.insufficient_free_disk');
    case 'freelist_below_threshold':
      return t('settings.devryan.storage.vacuumReason.freelist_below_threshold');
    case 'time_budget_exhausted':
      return t('settings.devryan.storage.vacuumReason.time_budget_exhausted');
    case 'forced':
    case 'freelist_above_threshold':
      return t('settings.devryan.storage.dryRun.vacuumYes');
    default:
      return t('settings.devryan.storage.vacuumReason.not_evaluated');
  }
};

export const describeRunFailure = (t: Translate, error: string | null): string => {
  if (!error) return t('settings.devryan.storage.vacuumReason.not_evaluated');
  if (error === 'missing_database') return t('settings.devryan.storage.reason.missing_database');
  if (error === 'other_opencode_process') return t('settings.devryan.storage.vacuumReason.other_opencode_process');
  if (error === 'no_sqlite_driver') return t('settings.devryan.storage.reason.no_sqlite_driver');
  if (error === 'runtime_selection_unavailable') return t('settings.devryan.storage.reason.runtime_selection_unavailable');
  if (error === 'v2_database') return t('settings.devryan.storage.reason.v2_database');
  if (error === 'runtime_generation_unknown') return t('settings.devryan.storage.reason.runtime_generation_unknown');
  if (error === 'runtime_generation_unsupported') return t('settings.devryan.storage.reason.runtime_generation_unsupported');
  if (error === 'database_generation_unknown') return t('settings.devryan.storage.reason.database_generation_unknown');
  if (error.startsWith('schema_mismatch')) return t('settings.devryan.storage.reason.schema_mismatch');
  return error;
};

export const describeLastRun = (t: Translate, run: OpenCodeStorageRunSummary | null): string => {
  if (!run) return t('settings.devryan.storage.lastRun.never');
  const when = formatWhen(run.at);
  if (run.status === 'error') {
    return t('settings.devryan.storage.lastRun.error', { when, reason: describeRunFailure(t, run.error) });
  }
  if (run.status === 'skipped') {
    return t('settings.devryan.storage.lastRun.skipped', { when, reason: describeRunFailure(t, run.error) });
  }
  const suffixes: string[] = [];
  if (run.vacuumed) suffixes.push(t('settings.devryan.storage.lastRun.vacuumed'));
  if (run.partial) suffixes.push(t('settings.devryan.storage.lastRun.partial'));
  return t('settings.devryan.storage.lastRun.ok', {
    when,
    events: formatCount(run.deletedEvents),
    before: formatBytes(run.before?.dbBytes ?? 0),
    after: formatBytes(run.after?.dbBytes ?? 0),
    vacuum: suffixes.join(''),
  });
};

export const describeDryRun = (t: Translate, run: OpenCodeStorageRunSummary): string => {
  if (run.status !== 'ok') {
    return t('settings.devryan.storage.lastRun.skipped', { when: formatWhen(run.at), reason: describeRunFailure(t, run.error) });
  }
  const vacuum = run.vacuum?.decided
    ? t('settings.devryan.storage.dryRun.vacuumYes')
    : t('settings.devryan.storage.dryRun.vacuumNo', { reason: describeVacuumReason(t, run.vacuum?.reason) });
  return t('settings.devryan.storage.dryRun.result', {
    events: formatCount(run.orphanEvents + run.prunableEvents),
    orphans: formatCount(run.orphanEvents),
    idle: formatCount(run.prunableEvents),
    sessions: formatCount(run.candidateSessions),
    vacuum,
  });
};

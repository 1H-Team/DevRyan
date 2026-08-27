import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiShutDownLine,
} from '@remixicon/react';

import type { RuntimeServiceStatus } from '@/lib/botsDesktopApi';

export const runtimeServicePresentation = (status: RuntimeServiceStatus | null, loading: boolean) => {
  if (loading && !status) return {
    label: 'Checking background runtime…',
    detail: 'Reading launchd registration and ownership state.',
    tone: 'border-border bg-[var(--surface-subtle)]',
    Icon: RiLoader4Line,
    spin: true,
  };
  if (status?.registration.code === 'runtime_service_packaged_build_required') return {
    label: 'Background runtime unavailable in development',
    detail: 'Use an installed packaged DevRyan build to test signed background Bots.',
    tone: 'border-border bg-[var(--surface-subtle)]',
    Icon: RiShutDownLine,
    spin: false,
  };
  if (status?.registration.state === 'not_found'
    || status?.registration.code?.startsWith('runtime_service_helper_')) return {
    label: 'Background runtime unavailable in this build',
    detail: 'Install a repaired DevRyan build containing the signed background service.',
    tone: 'border-[var(--status-error)]/35 bg-[var(--status-error)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
  if (status?.registration.state === 'unavailable') return {
    label: 'Background runtime control unavailable',
    detail: 'DevRyan could not inspect the signed background service. Retry after reopening the app.',
    tone: 'border-[var(--status-error)]/35 bg-[var(--status-error)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
  if (status?.registration.state === 'requires_approval') return {
    label: 'Approval required',
    detail: 'Allow DevRyan in System Settings → Login Items to finish enabling background Bots.',
    tone: 'border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
  if (status?.connected && status.handshake?.health === 'starting') return {
    label: 'Starting background runtime',
    detail: 'The signed service owns the data directory and is bringing Bot services online.',
    tone: 'border-[var(--status-info)]/35 bg-[var(--status-info)]/10',
    Icon: RiLoader4Line,
    spin: true,
  };
  if (status?.connected && status.handshake?.health === 'updating') return {
    label: 'Updating background runtime',
    detail: 'Bot work is checkpointed while the signed service update completes.',
    tone: 'border-[var(--status-info)]/35 bg-[var(--status-info)]/10',
    Icon: RiLoader4Line,
    spin: true,
  };
  if (status?.connected && status.handshake?.health === 'healthy') return {
    label: 'Background Bots connected',
    detail: status.handshake.desktopHost.state === 'connected'
      ? 'Routines, memory, and computer supervision continue when this window closes.'
      : 'Bot services are running; browser integrations will resume when the desktop host reconnects.',
    tone: 'border-[var(--status-success)]/35 bg-[var(--status-success)]/10',
    Icon: RiCheckboxCircleLine,
    spin: false,
  };
  if (status?.connected && status.handshake?.health === 'degraded') return {
    label: 'Background runtime degraded',
    detail: 'The service remains the fenced owner; affected Bot capabilities are fail-closed until health recovers.',
    tone: 'border-[var(--status-error)]/35 bg-[var(--status-error)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
  if (status?.configuredMode === 'disabled') return {
    label: 'Background Bots disabled',
    detail: 'Bot configuration is preserved, but routine and run execution is unavailable.',
    tone: 'border-border bg-[var(--surface-subtle)]',
    Icon: RiShutDownLine,
    spin: false,
  };
  if (status?.configuredMode === 'service') return {
    label: 'Background runtime degraded',
    detail: 'DevRyan will not start a second server while service ownership is unresolved.',
    tone: 'border-[var(--status-error)]/35 bg-[var(--status-error)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
  return {
    label: 'Bots stop when DevRyan quits',
    detail: 'Enable the signed background runtime so scheduled work and supervision remain reliable.',
    tone: 'border-[var(--status-warning)]/35 bg-[var(--status-warning)]/10',
    Icon: RiErrorWarningLine,
    spin: false,
  };
};

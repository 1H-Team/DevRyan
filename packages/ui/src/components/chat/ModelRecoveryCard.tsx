import React from 'react';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatDurationMilliseconds } from '@/lib/duration';
import { useI18n } from '@/lib/i18n';
import type { ManagedTaskAutoResumeError, ManagedTaskAutoResumeState } from '@/lib/orchestrationApi';
import { cn } from '@/lib/utils';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import {
  ControlledModelPicker,
  ControlledVariantPicker,
  type ControlledModelPickerProvider,
} from './ControlledModelPicker';

/** Presentation slice of a usage-limit envelope's auto-resume block. */
export type ModelRecoveryAutoResume = {
  enabled: boolean;
  state: ManagedTaskAutoResumeState;
  nextAttemptAt: number | null;
  expiresAt: number | null;
  attemptCount: number;
  targetLabel: string | null;
  resetAt: number | null;
  lastError: ManagedTaskAutoResumeError | null;
  reason?: string | null;
};

const DEFAULT_NOW = () => Date.now();

/** Milliseconds until `target`, re-read once a second while `ticking`. */
const useCountdown = (target: number | null, now: () => number, ticking: boolean) => {
  const [remaining, setRemaining] = React.useState<number | null>(() => (
    target === null ? null : Math.max(0, target - now())
  ));
  React.useEffect(() => {
    if (target === null) {
      setRemaining(null);
      return undefined;
    }
    const tick = () => setRemaining(Math.max(0, target - now()));
    tick();
    if (!ticking) return undefined;
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [now, target, ticking]);
  return remaining;
};

export function ModelRecoveryCard({
  title,
  detail,
  originalModelLabel,
  providers,
  selection,
  pending,
  actionError,
  failureMessage,
  onSelectionChange,
  onRetry,
  retryLabel,
  retryingLabel,
  embedded = false,
  autoResume,
  onAutoResumeChange,
  autoResumePending = false,
  now = DEFAULT_NOW,
}: {
  title: string;
  detail?: string | null;
  originalModelLabel: string;
  providers: ControlledModelPickerProvider[];
  selection: ProviderRecoverySelection;
  pending: boolean;
  actionError: string | null;
  failureMessage?: string | null;
  onSelectionChange(selection: ProviderRecoverySelection): void;
  onRetry(): void | Promise<void>;
  retryLabel?: string;
  retryingLabel?: string;
  embedded?: boolean;
  /** Omit (or pass null) to render the card without the auto-resume row. */
  autoResume?: ModelRecoveryAutoResume | null;
  onAutoResumeChange?(enabled: boolean): void | Promise<void>;
  autoResumePending?: boolean;
  /** Clock used for the countdown; injectable for tests. */
  now?: () => number;
}) {
  const { t } = useI18n();
  const scheduled = Boolean(autoResume?.enabled && autoResume.state === 'scheduled');
  const countdown = useCountdown(scheduled ? autoResume?.nextAttemptAt ?? null : null, now, scheduled);
  const autoResumeModel = autoResume?.targetLabel ?? originalModelLabel;
  const autoResumeStatus = (() => {
    if (!autoResume) return null;
    if (autoResume.state === 'exhausted') {
      const reason = autoResume.reason ?? autoResume.lastError?.message ?? null;
      return reason
        ? t('chat.modelRecovery.autoResume.exhausted', { reason })
        : t('chat.modelRecovery.autoResume.exhaustedNoReason');
    }
    if (!autoResume.enabled) return t('chat.modelRecovery.autoResume.off');
    if (autoResume.state === 'attempting') {
      return t('chat.modelRecovery.autoResume.attempting', { model: autoResumeModel });
    }
    if (autoResume.state === 'scheduled' && countdown !== null) {
      return t('chat.modelRecovery.autoResume.scheduled', {
        countdown: formatDurationMilliseconds(countdown).label,
        model: autoResumeModel,
      });
    }
    if (autoResume.state === 'planning' || autoResume.state === 'scheduled') {
      return t('chat.modelRecovery.autoResume.planning');
    }
    return null;
  })();
  const autoResumeError = autoResume && autoResume.state !== 'exhausted'
    ? autoResume.lastError?.message ?? null
    : null;
  return (
    <section
      aria-label={t('chat.modelRecovery.title')}
      className={cn(!embedded && 'chat-message-column px-4 pb-2 pt-3')}
    >
      <div className={cn(
        'overflow-hidden bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]',
        embedded
          ? 'border-t border-border/70'
          : 'rounded-xl border border-[color-mix(in_srgb,var(--primary-base)_16%,var(--border))]',
      )}>
        <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <RiErrorWarningLine
            className={cn(
              'size-3.5',
              failureMessage ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]',
            )}
            aria-hidden="true"
          />
          <h3 className="typography-ui-label font-semibold text-foreground">
            {t('chat.modelRecovery.title')}
          </h3>
        </header>
        <div className="space-y-3 px-3 py-3">
          {failureMessage ? (
            <p role="alert" className="typography-micro text-[var(--status-error)]">
              {failureMessage}
            </p>
          ) : null}
          <div className="space-y-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h4 className="typography-ui-label font-medium text-foreground">{title}</h4>
              <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                <ControlledModelPicker
                  providers={providers}
                  value={selection}
                  onChange={onSelectionChange}
                  disabled={pending}
                  align="end"
                />
                <ControlledVariantPicker
                  providers={providers}
                  value={selection}
                  onChange={onSelectionChange}
                  disabled={pending}
                />
              </div>
            </div>
            {detail ? (
              <p className="typography-micro text-muted-foreground">{detail}</p>
            ) : null}
            <p className="typography-micro text-muted-foreground">
              {t('chat.modelRecovery.failedModel', { model: originalModelLabel })}
            </p>
          </div>
          <div
            className={cn(
              'flex min-w-0 items-center gap-3 border-t border-border/60 pt-2',
              autoResume ? 'justify-between' : 'justify-end',
            )}
          >
            {autoResume ? (
              <div className="min-w-0 flex-1 space-y-1">
                <label className="flex w-fit cursor-pointer items-center gap-2 typography-micro text-foreground">
                  <Checkbox
                    checked={autoResume.enabled}
                    onChange={(next) => void onAutoResumeChange?.(next)}
                    disabled={pending || autoResumePending || !onAutoResumeChange}
                    ariaLabel={t('chat.modelRecovery.autoResume.label')}
                  />
                  <span>{t('chat.modelRecovery.autoResume.label')}</span>
                </label>
                {autoResumeStatus ? (
                  <p className="typography-micro text-muted-foreground">{autoResumeStatus}</p>
                ) : null}
                {autoResumeError ? (
                  <p role="alert" className="typography-micro text-[var(--status-error)]">{autoResumeError}</p>
                ) : null}
              </div>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-auto max-w-full whitespace-normal py-2 text-center leading-snug normal-case"
              disabled={pending}
              onClick={() => void onRetry()}
            >
              <RiRefreshLine className={pending ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {pending
                ? retryingLabel ?? t('chat.modelRecovery.retrying')
                : retryLabel ?? t('chat.modelRecovery.retry')}
            </Button>
          </div>
          {actionError ? (
            <p role="alert" className="typography-micro text-[var(--status-error)]">{actionError}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

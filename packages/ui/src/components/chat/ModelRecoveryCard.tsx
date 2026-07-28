import React from 'react';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import {
  ControlledModelPicker,
  ControlledVariantPicker,
  type ControlledModelPickerProvider,
} from './ControlledModelPicker';

export function ModelRecoveryCard({
  title,
  originalModelLabel,
  providers,
  selection,
  pending,
  actionError,
  failureMessage,
  onSelectionChange,
  onRetry,
  embedded = false,
}: {
  title: string;
  originalModelLabel: string;
  providers: ControlledModelPickerProvider[];
  selection: ProviderRecoverySelection;
  pending: boolean;
  actionError: string | null;
  failureMessage?: string | null;
  onSelectionChange(selection: ProviderRecoverySelection): void;
  onRetry(): void | Promise<void>;
  embedded?: boolean;
}) {
  const { t } = useI18n();
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
              <div className="flex min-w-0 items-center gap-2">
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
            <p className="typography-micro text-muted-foreground">
              {t('chat.modelRecovery.failedModel', { model: originalModelLabel })}
            </p>
          </div>
          <div className="flex min-w-0 justify-end border-t border-border/60 pt-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="normal-case"
              disabled={pending}
              onClick={() => void onRetry()}
            >
              <RiRefreshLine className={pending ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {pending ? t('chat.modelRecovery.retrying') : t('chat.modelRecovery.retry')}
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

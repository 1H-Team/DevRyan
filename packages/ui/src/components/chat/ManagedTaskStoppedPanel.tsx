import React from 'react';
import { RiPlayLine, RiStopCircleLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { resolveChatThinkingVariant } from '@/lib/providers/chatThinking';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import {
  ControlledModelPicker,
  type ControlledModelPickerProvider,
} from './ControlledModelPicker';

/**
 * The resumable state of a stopped subtask. Nothing failed, so this is not a
 * Model Recovery: Resume as Task continues on the last model, and choosing
 * another model stays behind a secondary control.
 */
export function ManagedTaskStoppedPanel({
  title,
  detail,
  lastModelLabel,
  providers,
  selection,
  onSelectionChange,
  pending,
  waitingForEvents = false,
  onCancelWaiting,
  actionError,
  onResume,
  onDismiss,
}: {
  title: string;
  detail: string;
  lastModelLabel: string;
  providers: ControlledModelPickerProvider[];
  selection: ProviderRecoverySelection;
  onSelectionChange(selection: ProviderRecoverySelection): void;
  pending: boolean;
  waitingForEvents?: boolean;
  onCancelWaiting?(): void;
  actionError: string | null;
  onResume(selection: ProviderRecoverySelection): void | Promise<void>;
  onDismiss?(): void | Promise<void>;
}) {
  const { t } = useI18n();
  const [choosingModel, setChoosingModel] = React.useState(false);
  const resume = () => void onResume({
    ...selection,
    variant: resolveChatThinkingVariant(
      providers.find((provider) => provider.id === selection.providerId),
      selection.modelId,
      selection.variant,
    ) ?? null,
  });
  return (
    <section
      aria-label={title}
      className="border-t border-border/70 bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]"
    >
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-center gap-2">
          <RiStopCircleLine className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
        </div>
        <p className="typography-micro text-muted-foreground">{detail}</p>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/60 pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {choosingModel ? (
              <ControlledModelPicker
                providers={providers}
                value={selection}
                onChange={onSelectionChange}
                disabled={pending}
              />
            ) : (
              <>
                <p className="typography-micro text-muted-foreground">
                  {t('chat.managedTasks.stoppedPanel.lastModel', { model: lastModelLabel })}
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="normal-case"
                  disabled={pending}
                  onClick={() => setChoosingModel(true)}
                >
                  {t('chat.managedTasks.stoppedPanel.changeModel')}
                </Button>
              </>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {waitingForEvents && onCancelWaiting ? <Button type="button" size="sm" variant="ghost" onClick={onCancelWaiting}>Cancel Recovery</Button> : null}
            {onDismiss ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="normal-case"
                disabled={pending}
                onClick={() => void onDismiss()}
              >
                {t('chat.managedTasks.dismissStopped')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="default"
              className="normal-case"
              disabled={pending}
              onClick={resume}
            >
              <RiPlayLine className={pending ? 'size-3.5 animate-pulse' : 'size-3.5'} />
              {pending ? t('chat.managedTasks.resumingAsTask') : t('chat.managedTasks.resumeAsTask')}
            </Button>
          </div>
        </div>
        {waitingForEvents ? <p role="status" className="typography-micro">Waiting for live events to reconnect. Your recovery choice is retained.</p> : null}
        {actionError ? (
          <p role="alert" className="typography-micro text-[var(--status-error)]">{actionError}</p>
        ) : null}
      </div>
    </section>
  );
}

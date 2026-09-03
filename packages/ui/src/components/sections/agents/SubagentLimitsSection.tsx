import React from 'react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Switch } from '@/components/ui/switch';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  CONCURRENT_SUBAGENTS_DEFAULT,
  CONCURRENT_SUBAGENTS_MAX,
  CONCURRENT_SUBAGENTS_MIN,
  useAgentsStore,
  type OrchestrationLimitsInput,
  type OrchestrationMemoryPressureState,
} from '@/stores/useAgentsStore';

const PRESSURE_STATE_KEYS: Record<OrchestrationMemoryPressureState, I18nKey> = {
  normal: 'settings.agents.limits.pressure.state.normal',
  elevated: 'settings.agents.limits.pressure.state.elevated',
  critical: 'settings.agents.limits.pressure.state.critical',
};

/** Typing 1 → 12 → 16 should reach the host once, not three times. */
const CONCURRENCY_SAVE_DEBOUNCE_MS = 400;

type SubagentLimitsSectionProps = {
  /** Host admins edit; everyone else who can reach the page reads the effective values. */
  canEdit: boolean;
};

/**
 * Host-wide sub-agent pacing (concurrency cap + memory-pressure pause). Lives
 * with the other per-host agent policy, never inside a single agent's editor.
 * Renders nothing until the limits load, and stays hidden on hosts without the route.
 */
export const SubagentLimitsSection: React.FC<SubagentLimitsSectionProps> = ({ canEdit }) => {
  const { t } = useI18n();
  const limits = useAgentsStore((state) => state.orchestrationLimits);
  const getOrchestrationLimits = useAgentsStore((state) => state.getOrchestrationLimits);
  const saveOrchestrationLimits = useAgentsStore((state) => state.saveOrchestrationLimits);
  const pendingConcurrencyRef = React.useRef<{ timer: number; value: number } | null>(null);

  // The store applies the change optimistically; a rejected save reverts it and we toast.
  const save = React.useCallback((input: OrchestrationLimitsInput) => (
    saveOrchestrationLimits(input).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t('settings.agents.limits.toast.saveFailed'));
    })
  ), [saveOrchestrationLimits, t]);

  React.useEffect(() => {
    let cancelled = false;
    getOrchestrationLimits().catch((error: unknown) => {
      if (cancelled) return;
      toast.error(error instanceof Error ? error.message : t('settings.agents.limits.toast.loadFailed'));
    });
    return () => {
      cancelled = true;
    };
  }, [getOrchestrationLimits, t]);

  // Flush a debounced concurrency change if the section goes away first.
  React.useEffect(() => () => {
    const pending = pendingConcurrencyRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingConcurrencyRef.current = null;
    void save({ maxConcurrentSubagents: pending.value });
  }, [save]);

  const scheduleConcurrencySave = React.useCallback((value: number) => {
    const pending = pendingConcurrencyRef.current;
    if (pending) window.clearTimeout(pending.timer);
    const timer = window.setTimeout(() => {
      pendingConcurrencyRef.current = null;
      void save({ maxConcurrentSubagents: value });
    }, CONCURRENCY_SAVE_DEBOUNCE_MS);
    pendingConcurrencyRef.current = { timer, value };
  }, [save]);

  if (!limits) return null;

  const pressureVisible = limits.pressure.source !== 'unavailable';

  return (
    <div>
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">
          {t('settings.agents.limits.title')}
        </h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0">
        <div className="flex items-start justify-between gap-4 py-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="typography-ui-label text-foreground">{t('settings.agents.limits.concurrent.label')}</span>
            <span className="typography-meta text-muted-foreground">{t('settings.agents.limits.concurrent.description')}</span>
          </div>
          <div className="shrink-0">
            {canEdit ? (
              <NumberInput
                value={limits.maxConcurrentSubagents}
                fallbackValue={CONCURRENT_SUBAGENTS_DEFAULT}
                onValueChange={scheduleConcurrencySave}
                min={CONCURRENT_SUBAGENTS_MIN}
                max={CONCURRENT_SUBAGENTS_MAX}
                step={1}
                inputMode="numeric"
                aria-label={t('settings.agents.limits.concurrent.label')}
                className="w-16"
              />
            ) : (
              <span className="typography-ui-label text-muted-foreground">{limits.maxConcurrentSubagents}</span>
            )}
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 py-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="typography-ui-label text-foreground">{t('settings.agents.limits.pressure.label')}</span>
            <span className="typography-meta text-muted-foreground">{t('settings.agents.limits.pressure.description')}</span>
          </div>
          <div className="shrink-0 pt-0.5">
            {canEdit ? (
              <Switch
                checked={limits.pauseUnderMemoryPressure}
                onCheckedChange={(checked) => { void save({ pauseUnderMemoryPressure: checked }); }}
                aria-label={t('settings.agents.limits.pressure.label')}
              />
            ) : (
              <span className="typography-ui-label text-muted-foreground">
                {limits.pauseUnderMemoryPressure
                  ? t('settings.agents.limits.readOnly.on')
                  : t('settings.agents.limits.readOnly.off')}
              </span>
            )}
          </div>
        </div>

        {pressureVisible ? (
          <p className="typography-meta pt-1 text-muted-foreground" role="status">
            {t('settings.agents.limits.pressure.status', { state: t(PRESSURE_STATE_KEYS[limits.pressure.state]) })}
          </p>
        ) : null}
      </section>
    </div>
  );
};

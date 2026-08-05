import React from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { usePreviewDiagnostics } from './previewDiagnostics';

type PreviewConsolePanelProps = Pick<ReturnType<typeof usePreviewDiagnostics>,
  | 'consoleEvents'
  | 'filteredConsoleEvents'
  | 'consoleFilter'
  | 'setConsoleFilter'
  | 'setConsoleEvents'
  | 'copyConsoleEvents'
  | 'attachConsoleEvents'
>;

export const PreviewConsolePanel: React.FC<PreviewConsolePanelProps> = ({
  consoleEvents,
  filteredConsoleEvents,
  consoleFilter,
  setConsoleFilter,
  setConsoleEvents,
  copyConsoleEvents,
  attachConsoleEvents,
}) => {
  const { t } = useI18n();
  return (
    <div className="absolute inset-x-3 bottom-3 z-10 max-h-[45%] overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] shadow-lg">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="typography-ui-label text-foreground">{t('contextPanel.preview.console.title')}</div>
        <div className="flex items-center gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={attachConsoleEvents} disabled={consoleEvents.length === 0}>
            {t('contextPanel.preview.console.attach')}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={copyConsoleEvents} disabled={consoleEvents.length === 0}>
            {t('contextPanel.preview.console.copy')}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setConsoleEvents([])} disabled={consoleEvents.length === 0}>
            {t('contextPanel.preview.console.clear')}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-1 border-b border-border/30 px-3 py-1.5">
        {(['all', 'errors', 'warnings', 'logs'] as const).map((filter) => (
          <Button
            key={filter}
            type="button"
            size="xs"
            variant={consoleFilter === filter ? 'secondary' : 'ghost'}
            onClick={() => setConsoleFilter(filter)}
          >
            {filter === 'all'
              ? t('contextPanel.preview.console.filter.all')
              : filter === 'errors'
                ? t('contextPanel.preview.console.filter.errors')
                : filter === 'warnings'
                  ? t('contextPanel.preview.console.filter.warnings')
                  : t('contextPanel.preview.console.filter.logs')}
          </Button>
        ))}
      </div>
      <div className="max-h-64 overflow-auto p-2 typography-code text-xs">
        {consoleEvents.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.empty')}</div>
        ) : filteredConsoleEvents.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.noFilteredEvents')}</div>
        ) : filteredConsoleEvents.map((event) => (
          <div key={event.id} className="border-b border-border/30 px-2 py-1 last:border-b-0">
            <div className="flex gap-2">
              <span className={cn(
                'shrink-0 uppercase',
                event.level === 'error' || event.level === 'runtime' || event.level === 'resource'
                  ? 'text-status-error'
                  : event.level === 'warn'
                    ? 'text-status-warning'
                    : 'text-muted-foreground',
              )}>
                {event.level}
              </span>
              <span className="min-w-0 break-words text-foreground">{event.message}</span>
            </div>
            {event.details ? <pre className="mt-1 whitespace-pre-wrap text-muted-foreground">{event.details}</pre> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

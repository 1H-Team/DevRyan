import React from 'react';

import { useI18n } from '@/lib/i18n';

export const SettingsLoadFallback: React.FC = () => {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center bg-background p-6"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex w-full max-w-xs flex-col items-center gap-3 text-muted-foreground">
        <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/70" />
        </div>
        <span className="typography-ui-label">{t('common.loading')}</span>
      </div>
    </div>
  );
};

import React from 'react';

import { useI18n } from '@/lib/i18n';

export const SettingsLoadFallback: React.FC = () => {
  const { t } = useI18n();

  return (
    <div
      className="flex w-full items-center gap-3 p-6 text-muted-foreground"
      data-settings-section-loading="true"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
      <span className="typography-ui-label">{t('common.loading')}</span>
    </div>
  );
};

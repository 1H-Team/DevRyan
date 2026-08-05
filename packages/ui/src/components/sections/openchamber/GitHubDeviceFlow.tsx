import * as React from 'react';

import { Button } from '@/components/ui/button';
import type { GitHubDeviceFlowStart } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

export const GitHubDeviceFlowPanel: React.FC<{
  flow: GitHubDeviceFlowStart;
  onCancel: () => void;
}> = ({ flow, onCancel }) => {
  const { t } = useI18n();
  return (
    <div className="mt-4 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)]/70 p-4">
      <div className="space-y-1">
        <h4 className="typography-ui-label text-foreground">{t('settings.github.page.flow.title')}</h4>
        <p className="typography-meta text-muted-foreground">{t('settings.github.page.flow.description')}</p>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)] px-3 py-1.5 font-mono text-xl tracking-widest text-foreground">
          {flow.userCode}
        </div>
        <Button size="sm" asChild>
          <a href={flow.verificationUriComplete || flow.verificationUri} target="_blank" rel="noopener noreferrer">
            {t('settings.github.page.actions.openGithub')}
          </a>
        </Button>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="typography-micro animate-pulse text-muted-foreground">{t('settings.github.page.flow.waiting')}</span>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('settings.common.actions.cancel')}</Button>
      </div>
    </div>
  );
};

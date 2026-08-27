import React from 'react';

import { useI18n } from '@/lib/i18n';

export const BotAuditPanel: React.FC = () => {
  const { t } = useI18n();

  return (
    <section aria-labelledby="bot-audit-heading" className="space-y-5">
      <div className="space-y-1">
        <h2 id="bot-audit-heading" className="typography-ui-header font-semibold text-foreground">
          {t('settings.bugReports.botAudit.title')}
        </h2>
        <p className="typography-ui text-muted-foreground">
          {t('settings.bugReports.botAudit.description')}
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center typography-meta text-muted-foreground">
        {t('settings.bugReports.botAudit.empty')}
      </div>
    </section>
  );
};

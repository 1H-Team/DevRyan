import type { UsageSourceMetadata } from '@/types';
import { useI18n } from '@/lib/i18n';

export function UsageSourceDetails({ source, account }: UsageSourceMetadata) {
  const { t } = useI18n();
  if (!source) return null;
  return <p className="typography-micro text-muted-foreground break-words">
    {t(source === 'codex-app-server' ? 'settings.providers.codexUsage.source' : 'settings.providers.codexUsage.siwcSource')}
    {' · '}{account?.email || t('settings.providers.codexUsage.unknownAccount')}
    {account?.planType ? ` · ${account.planType}` : ''}
  </p>;
}

import React from 'react';
import { RiErrorWarningLine, RiExternalLinkLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { quotaRefreshCoordinator } from '@/stores/useQuotaStore';
import { requestClaudeAgent, type ClaudeAgentStatus } from './claudeAgentApi';

type LoadState = { status: 'loading' } | { status: 'unavailable' } | { status: 'error' } | { status: 'ready'; value: ClaudeAgentStatus };

interface ClaudeAgentConnectionProps {
  directory: string | null;
  disabled?: boolean;
  /** Called after connecting or disconnecting so the page reloads its provider catalog. */
  onChanged?: () => void;
  fetchImpl?: typeof fetch;
}

/** Claude Code's own login as the claude-agent connection: state, connect, disconnect, recheck. */
export function ClaudeAgentConnection({ directory, disabled = false, onChanged, fetchImpl }: ClaudeAgentConnectionProps) {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [reload, setReload] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    requestClaudeAgent('status', directory, { fetchImpl, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setState(value ? { status: 'ready', value } : { status: 'unavailable' }); })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error' }); });
    return () => controller.abort();
  }, [directory, fetchImpl, reload]);

  const change = async (action: 'connect' | 'disconnect') => {
    setBusy(true);
    try {
      const value = await requestClaudeAgent(action, directory, { fetchImpl });
      setState(value ? { status: 'ready', value } : { status: 'unavailable' });
      quotaRefreshCoordinator.settingsChanged();
      onChanged?.();
    } catch {
      toast.error(t(action === 'connect' ? 'settings.providers.page.claudeAgent.connectFailed' : 'settings.providers.page.claudeAgent.disconnectFailed'));
    } finally { setBusy(false); }
  };

  const ready = state.status === 'ready' ? state.value : null;
  return (
    <div className="mb-8" data-claude-agent-connection>
      <div className="mb-1 px-1 flex items-center justify-between gap-2">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.claudeAgent.title')}</h3>
        {ready?.connected ? (
          <span className="typography-meta text-[var(--status-success)]">{t('settings.providers.page.claudeAgent.connected')}</span>
        ) : ready ? (
          <span className="typography-meta text-muted-foreground">{t('settings.providers.page.claudeAgent.notConnected')}</span>
        ) : null}
      </div>
      <section className="px-2 pb-2 pt-0">
        <p className="typography-meta text-muted-foreground py-1">{t('settings.providers.page.claudeAgent.description')}</p>
        {state.status === 'loading' && (
          <p className="typography-meta text-muted-foreground py-1.5">{t('settings.providers.page.claudeAgent.loading')}</p>
        )}
        {state.status === 'unavailable' && (
          <p className="typography-meta text-muted-foreground py-1.5">{t('settings.providers.page.claudeAgent.unavailable')}</p>
        )}
        {state.status === 'error' && (
          <p className="typography-meta text-[var(--status-error)] py-1.5">{t('settings.providers.page.claudeAgent.loadFailed')}</p>
        )}
        {ready?.problem && (
          <div className="flex items-start gap-2 py-1.5" role="status">
            <RiErrorWarningLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-warning)]" />
            <p className="typography-meta text-foreground">{ready.problem.message}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {ready && !ready.connected && ready.available && (
            <Button size="xs" onClick={() => void change('connect')} disabled={disabled || busy}>
              {t('settings.providers.page.claudeAgent.connect')}
            </Button>
          )}
          {ready?.connected && (
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => void change('disconnect')} disabled={disabled || busy}>
              {t('settings.providers.page.claudeAgent.disconnect')}
            </Button>
          )}
          {state.status !== 'unavailable' && (
            <Button variant="ghost" size="xs" className="!font-normal" onClick={() => setReload((value) => value + 1)} disabled={busy}>
              {t('settings.providers.page.claudeAgent.checkAgain')}
            </Button>
          )}
          {ready?.problem?.url && (
            <Button variant="ghost" size="xs" className="!font-normal" onClick={() => { if (ready.problem?.url) void openExternalUrl(ready.problem.url); }}>
              <RiExternalLinkLine className="h-3.5 w-3.5" />
              {t('settings.providers.page.claudeAgent.openSetup')}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}

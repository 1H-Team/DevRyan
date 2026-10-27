import React from 'react';
import { RiAddLine, RiErrorWarningLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { quotaRefreshCoordinator, useQuotaStore } from '@/stores/useQuotaStore';
import {
  fetchProviderAccounts,
  mutateProviderAccount,
  ProviderAccountRequestError,
  supportsProviderAccounts,
  type ProviderAccount,
} from './providerAccountApi';

type LoadState =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'error' }
  | { status: 'ready'; accounts: ProviderAccount[] };

interface ProviderAccountsProps {
  providerId: string;
  directory: string | null;
  /** Bumped by the page after a sign-in or key save so a new account appears. */
  refreshKey: number;
  disabled?: boolean;
  onAddAccount: () => void;
  fetchImpl?: typeof fetch;
}

const methodKeys = {
  key: 'settings.providers.page.accounts.method.key',
  oauth: 'settings.providers.page.accounts.method.oauth',
  external: 'settings.providers.page.accounts.method.external',
} as const;

/**
 * Saved accounts for one provider: the active marker, switch, rename, remove
 * (confirmed) and an entry into the existing connect flow to add another.
 * Mount it keyed by provider so no state carries across providers.
 */
export function ProviderAccounts({ providerId, directory, refreshKey, disabled = false, onAddAccount, fetchImpl }: ProviderAccountsProps) {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [reload, setReload] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; value: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<ProviderAccount | null>(null);
  const supported = supportsProviderAccounts(providerId);

  React.useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    setState((current) => current.status === 'ready' ? current : { status: 'loading' });
    fetchProviderAccounts(providerId, directory, { fetchImpl, signal: controller.signal })
      .then((accounts) => {
        if (!controller.signal.aborted) setState(accounts ? { status: 'ready', accounts } : { status: 'unsupported' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [directory, fetchImpl, providerId, refreshKey, reload, supported]);

  const accountName = (account: ProviderAccount) => account.label.trim() || t('settings.providers.page.accounts.unnamed');

  const run = async (account: ProviderAccount, mutation: Parameters<typeof mutateProviderAccount>[1], success: string) => {
    setBusy(account.id);
    try {
      await mutateProviderAccount(account.id, mutation, directory, { fetchImpl });
      if (providerId === 'openai' && mutation.operation !== 'rename') useQuotaStore.getState().invalidateProviderQuota('codex');
      if (mutation.operation !== 'rename') quotaRefreshCoordinator.settingsChanged();
      toast.success(success);
      return true;
    } catch (error) {
      const changed = error instanceof ProviderAccountRequestError && error.code === 'native_credential_changed';
      const detail = !changed && error instanceof Error && error.message ? `: ${error.message}` : '';
      toast.error(changed ? t('settings.providers.page.accounts.toast.changed') : `${t('settings.providers.page.accounts.toast.failed')}${detail}`);
      return false;
    } finally {
      setBusy(null);
      setReload((value) => value + 1);
    }
  };

  if (!supported || state.status === 'unsupported') return null;

  const accounts = state.status === 'ready' ? state.accounts : [];
  const controlsDisabled = disabled || busy !== null;

  return (
    <div className="mb-8" data-provider-accounts={providerId}>
      <div className="mb-1 px-1 flex items-center justify-between gap-2">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.accounts.title')}</h3>
        <Button variant="outline" size="xs" className="!font-normal" onClick={onAddAccount} disabled={disabled}>
          <RiAddLine className="h-3.5 w-3.5" />
          {t('settings.providers.page.accounts.add')}
        </Button>
      </div>
      <section className="px-2 pb-2 pt-0">
        <p className="typography-meta text-muted-foreground py-1">{t('settings.providers.page.accounts.description')}</p>
        {state.status === 'loading' ? (
          <p className="typography-meta text-muted-foreground py-1.5">{t('settings.providers.page.accounts.loading')}</p>
        ) : state.status === 'error' ? (
          <div className="flex items-center justify-between gap-2 py-1.5">
            <p className="typography-meta text-[var(--status-error)]">{t('settings.providers.page.accounts.loadFailed')}</p>
            <Button variant="ghost" size="xs" className="!font-normal" onClick={() => setReload((value) => value + 1)}>
              {t('settings.providers.page.actions.retry')}
            </Button>
          </div>
        ) : accounts.length === 0 ? (
          <p className="typography-meta text-muted-foreground py-1.5">{t('settings.providers.page.accounts.empty')}</p>
        ) : (
          <ul className="divide-y divide-[var(--surface-subtle)]" role="radiogroup" aria-label={t('settings.providers.page.accounts.title')}>
            {accounts.map((account) => {
              const name = accountName(account);
              const isRenaming = renaming?.id === account.id;
              return (
                <li key={account.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between" data-account-id={account.id}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Radio
                      checked={account.active}
                      disabled={controlsDisabled}
                      ariaLabel={t('settings.providers.page.accounts.useAria', { name })}
                      onChange={() => void run(account, { operation: 'activate' }, t('settings.providers.page.accounts.toast.switched', { name }))}
                    />
                    {isRenaming ? (
                      <Input
                        value={renaming.value}
                        maxLength={256}
                        autoFocus
                        aria-label={t('settings.providers.page.accounts.renameAria', { name })}
                        placeholder={t('settings.providers.page.accounts.labelPlaceholder')}
                        onChange={(event) => setRenaming({ id: account.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRenaming(null);
                          if (event.key === 'Enter' && renaming.value.trim()) {
                            event.preventDefault();
                            void run(account, { operation: 'rename', label: renaming.value }, t('settings.providers.page.accounts.toast.renamed'))
                              .then((ok) => { if (ok) setRenaming(null); });
                          }
                        }}
                        className="h-7 max-w-64 text-xs"
                      />
                    ) : (
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="typography-ui-label text-foreground truncate" title={name}>{name}</span>
                          {account.active ? (
                            <span className="typography-micro rounded-full bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)] px-1.5 py-0.5 text-[var(--primary-base)]">
                              {t('settings.providers.page.accounts.active')}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1.5 typography-meta text-muted-foreground">
                          <span>{t(methodKeys[account.method])}</span>
                          {account.needsAuth ? (
                            <span className="inline-flex items-center gap-1 text-[var(--status-warning)]">
                              <RiErrorWarningLine className="h-3.5 w-3.5" />
                              {t('settings.providers.page.accounts.needsAuth')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className={cn('flex shrink-0 items-center gap-1', 'pl-6 sm:pl-0')}>
                    {isRenaming ? (
                      <>
                        <Button
                          size="xs"
                          className="!font-normal"
                          disabled={controlsDisabled || !renaming.value.trim()}
                          onClick={() => void run(account, { operation: 'rename', label: renaming.value }, t('settings.providers.page.accounts.toast.renamed'))
                            .then((ok) => { if (ok) setRenaming(null); })}
                        >
                          {t('settings.providers.page.actions.save')}
                        </Button>
                        <Button variant="ghost" size="xs" className="!font-normal" onClick={() => setRenaming(null)}>
                          {t('settings.providers.page.accounts.cancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        {!account.active ? (
                          <Button
                            variant="outline"
                            size="xs"
                            className="!font-normal"
                            disabled={controlsDisabled}
                            aria-label={t('settings.providers.page.accounts.useAria', { name })}
                            onClick={() => void run(account, { operation: 'activate' }, t('settings.providers.page.accounts.toast.switched', { name }))}
                          >
                            {t('settings.providers.page.accounts.use')}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="xs"
                          className="!font-normal"
                          disabled={controlsDisabled}
                          aria-label={t('settings.providers.page.accounts.renameAria', { name })}
                          onClick={() => setRenaming({ id: account.id, value: account.label })}
                        >
                          {t('settings.providers.page.accounts.rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                          disabled={controlsDisabled}
                          aria-label={t('settings.providers.page.accounts.removeAria', { name })}
                          onClick={() => setConfirmRemove(account)}
                        >
                          {t('settings.providers.page.accounts.remove')}
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={confirmRemove !== null} onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.providers.page.accounts.removeConfirmTitle', { name: confirmRemove ? accountName(confirmRemove) : '' })}</DialogTitle>
            <DialogDescription>
              {t('settings.providers.page.accounts.removeConfirmDescription')}
              {confirmRemove?.active ? ` ${t('settings.providers.page.accounts.removeConfirmActive')}` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(null)}>{t('settings.providers.page.accounts.cancel')}</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                const account = confirmRemove;
                if (!account) return;
                setConfirmRemove(null);
                void run(account, { operation: 'remove' }, t('settings.providers.page.accounts.toast.removed', { name: accountName(account) }));
              }}
            >
              {t('settings.providers.page.accounts.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

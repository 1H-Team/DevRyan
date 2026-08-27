import React from 'react';
import { RiDeleteBinLine, RiKey2Line, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  botsApi,
  type BotEnvironmentSecretMetadata,
  type BotsApi,
} from '@/lib/botsApi';

type EnvironmentSecretsApi = Pick<
  BotsApi,
  'listBotEnvironmentSecrets' | 'putBotEnvironmentSecret' | 'deleteBotEnvironmentSecret'
>;

export const BotEnvironmentSecrets: React.FC<{
  botId: string;
  readOnly?: boolean;
  api?: EnvironmentSecretsApi;
}> = ({ botId, readOnly = false, api = botsApi }) => {
  const [items, setItems] = React.useState<readonly BotEnvironmentSecretMetadata[]>([]);
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState('');
  const [replacing, setReplacing] = React.useState<BotEnvironmentSecretMetadata | null>(null);
  const [deletePending, setDeletePending] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listBotEnvironmentSecrets(botId);
      setItems(result.environmentSecrets);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load environment secrets.');
    } finally {
      setLoading(false);
    }
  }, [api, botId]);

  React.useEffect(() => { void load(); }, [load]);

  const resetEditor = () => {
    setName('');
    setValue('');
    setReplacing(null);
  };

  const save = async () => {
    const normalizedName = replacing?.name || name.trim();
    setBusy(true);
    try {
      await api.putBotEnvironmentSecret(botId, normalizedName, {
        value,
        expectedUpdatedAt: replacing?.updatedAt || null,
      });
      resetEditor();
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the environment secret.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: BotEnvironmentSecretMetadata) => {
    if (deletePending !== item.name) {
      setDeletePending(item.name);
      return;
    }
    setBusy(true);
    try {
      await api.deleteBotEnvironmentSecret(botId, item.name, {
        expectedUpdatedAt: item.updatedAt,
      });
      setDeletePending(null);
      if (replacing?.name === item.name) resetEditor();
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete the environment secret.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 border-t border-border pt-7" aria-labelledby="bot-environment-secrets-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="bot-environment-secrets-heading" className="flex items-center gap-2 typography-ui-header font-semibold text-foreground">
            <RiKey2Line className="h-4 w-4 text-muted-foreground" aria-hidden />
            Environment secrets (.env)
          </h3>
        </div>
        <Button type="button" size="xs" variant="ghost" disabled={loading || busy} onClick={() => void load()}>
          <RiRefreshLine className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      {!readOnly ? (
        <form
          className="grid gap-3 rounded-xl border border-border/70 bg-[var(--surface-elevated)]/25 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <label className="space-y-1 typography-meta text-muted-foreground">
            <span>Name</span>
            <Input
              value={replacing?.name || name}
              readOnly={Boolean(replacing)}
              maxLength={128}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="SERVICE_API_KEY"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="space-y-1 typography-meta text-muted-foreground">
            <span>{replacing ? 'Replacement Value' : 'Value'}</span>
            <Input
              type="password"
              value={value}
              autoComplete="new-password"
              spellCheck={false}
              placeholder="Enter secret value"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            {replacing ? <Button type="button" size="sm" variant="ghost" onClick={resetEditor}>Cancel</Button> : null}
            <Button type="submit" size="sm" disabled={busy || !value || (!replacing && !name.trim())}>
              {busy ? 'Saving…' : replacing ? 'Replace' : 'Add Secret'}
            </Button>
          </div>
        </form>
      ) : null}

      {error ? <p className="typography-ui text-[var(--status-error)]" role="alert">{error}</p> : null}
      <div className="overflow-hidden rounded-xl border border-border/70">
        {loading ? (
          <p className="p-5 typography-ui text-muted-foreground" role="status">Loading environment secrets…</p>
        ) : items.length === 0 ? (
          <p className="p-5 typography-ui text-muted-foreground">No environment secrets are configured.</p>
        ) : items.map((item) => (
          <article key={item.name} className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 p-4 last:border-b-0">
            <div className="min-w-0">
              <p className="truncate typography-ui-label font-medium text-foreground">{item.name}</p>
              <p className="typography-micro text-muted-foreground">
                Write-only · updated {new Date(item.updatedAt).toLocaleString()}
              </p>
            </div>
            {!readOnly ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(item);
                    setName(item.name);
                    setValue('');
                    setDeletePending(null);
                  }}
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={deletePending === item.name ? 'destructive' : 'ghost'}
                  disabled={busy}
                  onClick={() => void remove(item)}
                >
                  <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden />
                  {deletePending === item.name ? 'Confirm Delete' : 'Delete'}
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
};

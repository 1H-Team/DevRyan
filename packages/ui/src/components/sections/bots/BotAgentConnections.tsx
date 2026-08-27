import React from 'react';
import {
  RiAddLine,
  RiArrowRightLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFlashlightLine,
  RiLockLine,
  RiRefreshLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  botRevisionModelPolicy,
  botsApi,
  type BotAgentConnection,
  type BotModelPolicy,
  type BotRevisionContract,
  type BotsApi,
  withBotRevisionAgent,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { createDefaultBotRevisionContract } from './botManagementPresentation';

const DEFAULT_LIMITS = Object.freeze({
  maximumStreamBytes: 256 * 1024,
  maximumTextBytes: 192 * 1024,
  maximumArgumentBytes: 64 * 1024,
  maximumEventCount: 4_096,
  requestTimeoutMs: 15 * 60 * 1_000,
  healthTimeoutMs: 10_000,
});

type ConnectionDraft = {
  id: string | null;
  name: string;
  endpointUrl: string;
  authMode: 'none' | 'bearer';
  bearer: string;
  modelHint: string;
  expectedUpdatedAt: string | null;
};

const emptyDraft = (): ConnectionDraft => ({
  id: null,
  name: '',
  endpointUrl: '',
  authMode: 'none',
  bearer: '',
  modelHint: '',
  expectedUpdatedAt: null,
});

const connectionDraft = (connection: BotAgentConnection): ConnectionDraft => ({
  id: connection.id,
  name: connection.name,
  endpointUrl: connection.endpointUrl,
  authMode: connection.authMode,
  bearer: '',
  modelHint: connection.modelHint || '',
  expectedUpdatedAt: connection.updatedAt,
});

const healthLabel = (connection: BotAgentConnection): string => {
  if (connection.status === 'revoked') return 'Revoked';
  if (connection.health?.state === 'healthy') return 'Healthy';
  if (connection.health?.state === 'failed' || connection.status === 'error') return 'Failed';
  return 'Not tested';
};

const healthTone = (connection: BotAgentConnection): string => {
  if (connection.status === 'revoked' || connection.health?.state === 'failed' || connection.status === 'error') {
    return 'border-[var(--status-error)]/35 bg-[var(--status-error)]/10 text-[var(--status-error)]';
  }
  if (connection.health?.state === 'healthy') {
    return 'border-[var(--status-success)]/35 bg-[var(--status-success)]/10 text-[var(--status-success)]';
  }
  return 'border-border bg-[var(--surface-subtle)] text-muted-foreground';
};

const validPublicHttps = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

export type BotAgentConnectionsProps = {
  botId: string;
  value: BotRevisionContract;
  readOnly?: boolean;
  api?: BotsApi;
  onChange: (value: BotRevisionContract) => void;
};

export const BotAgentConnections: React.FC<BotAgentConnectionsProps> = ({
  botId,
  value,
  readOnly = false,
  api = botsApi,
  onChange,
}) => {
  const currentModels = botRevisionModelPolicy(value);
  const rememberedModels = React.useRef<BotModelPolicy>(
    currentModels || createDefaultBotRevisionContract(value.identity.title).models,
  );
  const [connections, setConnections] = React.useState<readonly BotAgentConnection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<ConnectionDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const selectedId = value.contractVersion === 3 && value.agent.kind === 'ag_ui'
    ? value.agent.connectionRef
    : null;
  const adapterKind = selectedId ? 'ag_ui' : 'opencode';

  React.useEffect(() => {
    if (currentModels) rememberedModels.current = currentModels;
  }, [currentModels]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listBotAgentConnections(botId);
      setConnections(result.connections);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load agent connections.');
    } finally {
      setLoading(false);
    }
  }, [api, botId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const replaceConnection = React.useCallback((connection: BotAgentConnection) => {
    setConnections((current) => {
      const index = current.findIndex((entry) => entry.id === connection.id);
      if (index < 0) return [...current, connection];
      const next = [...current];
      next[index] = connection;
      return next;
    });
  }, []);

  const selectOpenCode = () => {
    onChange(withBotRevisionAgent(value, {
      kind: 'opencode',
      models: rememberedModels.current,
    }));
  };

  const selectConnection = (connection: BotAgentConnection) => {
    if (connection.status === 'revoked') return;
    onChange(withBotRevisionAgent(value, {
      kind: 'ag_ui',
      connectionRef: connection.id,
      connectionDigest: connection.descriptorDigest,
      ...(connection.modelHint ? { modelHint: connection.modelHint } : {}),
    }));
  };

  const saveDraft = async () => {
    if (!draft || !validPublicHttps(draft.endpointUrl)
      || !draft.name.trim() || (draft.authMode === 'bearer' && !draft.bearer.trim())) return;
    const operationId = draft.id || 'new';
    setBusyId(operationId);
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        endpointUrl: draft.endpointUrl.trim(),
        authMode: draft.authMode,
        ...(draft.authMode === 'bearer' ? { bearer: draft.bearer } : {}),
        modelHint: draft.modelHint.trim() || null,
        limits: DEFAULT_LIMITS,
      } as const;
      const result = draft.id && draft.expectedUpdatedAt
        ? await api.updateBotAgentConnection(botId, draft.id, {
            ...body,
            expectedUpdatedAt: draft.expectedUpdatedAt,
          })
        : await api.createBotAgentConnection(botId, body);
      replaceConnection(result.connection);
      if (selectedId === result.connection.id) selectConnection(result.connection);
      setDraft(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save the agent connection.');
    } finally {
      setBusyId(null);
    }
  };

  const testConnection = async (connection: BotAgentConnection) => {
    setBusyId(connection.id);
    setError(null);
    try {
      const result = await api.testBotAgentConnection(botId, connection.id);
      replaceConnection(result.connection);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to test the agent connection.');
    } finally {
      setBusyId(null);
    }
  };

  const revokeConnection = async (connection: BotAgentConnection) => {
    setBusyId(connection.id);
    setError(null);
    try {
      const result = await api.revokeBotAgentConnection(botId, connection.id, connection.updatedAt);
      replaceConnection(result.connection);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to revoke the agent connection.');
    } finally {
      setBusyId(null);
    }
  };

  const formValid = Boolean(
    draft?.name.trim()
      && validPublicHttps(draft.endpointUrl)
      && (draft.authMode === 'none' || draft.bearer.trim()),
  );

  return (
    <section className="space-y-4" aria-labelledby="bot-agent-connections-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="bot-agent-connections-heading" className="typography-ui-header font-semibold text-foreground">Reasoning agent</h3>
          <p className="typography-ui text-muted-foreground">Choose who reasons. DevRyan remains the only authority that can act.</p>
        </div>
        {!readOnly ? (
          <Button type="button" size="xs" variant="outline" onClick={() => setDraft(emptyDraft())}>
            <RiAddLine className="h-3.5 w-3.5" aria-hidden /> Add AG-UI Endpoint
          </Button>
        ) : null}
      </div>

      <div className="grid gap-2 rounded-xl border border-border/70 bg-[var(--surface-elevated)]/30 p-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center" aria-label="Governance Path">
        <div className="rounded-lg border border-border/70 bg-background px-3 py-2">
          <p className="typography-micro uppercase tracking-wide text-muted-foreground">Reason</p>
          <p className="typography-ui-label font-medium text-foreground">{adapterKind === 'ag_ui' ? 'AG-UI endpoint' : 'Managed OpenCode'}</p>
        </div>
        <RiArrowRightLine className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
        <div className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2">
          <p className="typography-micro uppercase tracking-wide text-muted-foreground">Govern</p>
          <p className="typography-ui-label font-medium text-foreground">devryan_bot</p>
        </div>
        <RiArrowRightLine className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
        <div className="rounded-lg border border-border/70 bg-background px-3 py-2">
          <p className="typography-micro uppercase tracking-wide text-muted-foreground">Act</p>
          <p className="typography-ui-label font-medium text-foreground">Policy + approval</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={readOnly}
          aria-pressed={adapterKind === 'opencode'}
          onClick={selectOpenCode}
          className={cn(
            'rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-default',
            adapterKind === 'opencode' ? 'border-primary/45 bg-primary/8' : 'border-border/70 bg-background hover:bg-interactive-hover',
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="typography-ui-label font-semibold text-foreground">Managed OpenCode</span>
            {adapterKind === 'opencode' ? <RiCheckLine className="h-4 w-4 text-primary" aria-hidden /> : null}
          </span>
          <span className="mt-1 block typography-micro text-muted-foreground">Local Default. Model Credentials Stay in DevRyan.</span>
        </button>
        <div className={cn(
          'rounded-xl border p-3',
          adapterKind === 'ag_ui' ? 'border-primary/45 bg-primary/8' : 'border-border/70 bg-background',
        )}>
          <p className="typography-ui-label font-semibold text-foreground">Registered AG-UI</p>
          <p className="mt-1 typography-micro text-muted-foreground">Remote reasoning over exact public HTTPS/SSE.</p>
          <Select
            value={selectedId || '__none__'}
            onValueChange={(id) => {
              const connection = connections.find((entry) => entry.id === id);
              if (connection) selectConnection(connection);
            }}
            disabled={readOnly || loading || connections.every((entry) => entry.status === 'revoked')}
          >
            <SelectTrigger size="lg" className="mt-2 w-full"><SelectValue placeholder="Select endpoint" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" disabled>{loading ? 'Loading Endpoints…' : 'Select Endpoint'}</SelectItem>
              {connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id} disabled={connection.status === 'revoked'}>
                  {connection.name} · {healthLabel(connection)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-[var(--status-warning)]/35 bg-[var(--status-warning)]/8 p-3">
        <RiLockLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden />
        <p className="typography-micro text-foreground">
          The selected endpoint receives prompts and tool results. It never receives gateway credentials, stored bearer values, computer tokens, local callback URLs, or direct tool authority.
        </p>
      </div>

      {draft ? (
        <form
          className="space-y-3 rounded-xl border border-primary/30 bg-[var(--surface-elevated)]/40 p-4"
          aria-label={draft.id ? 'Edit AG-UI Endpoint' : 'Add AG-UI Endpoint'}
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h4 className="typography-ui-label font-semibold text-foreground">{draft.id ? 'Edit endpoint' : 'New endpoint'}</h4>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Close Endpoint Editor" onClick={() => setDraft(null)}>
              <RiCloseLine className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Name</span>
              <Input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Model Hint · Optional</span>
              <Input value={draft.modelHint} maxLength={256} onChange={(event) => setDraft({ ...draft, modelHint: event.target.value })} />
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground sm:col-span-2">
              <span>Exact Public HTTPS/SSE Endpoint</span>
              <Input type="url" inputMode="url" placeholder="https://agent.example.com/ag-ui" value={draft.endpointUrl} onChange={(event) => setDraft({ ...draft, endpointUrl: event.target.value })} />
              {draft.endpointUrl && !validPublicHttps(draft.endpointUrl) ? <span className="block typography-micro text-[var(--status-error)]">Enter an exact HTTPS URL without embedded credentials.</span> : null}
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Authentication</span>
              <Select value={draft.authMode} onValueChange={(authMode) => setDraft({ ...draft, authMode: authMode as 'none' | 'bearer', bearer: '' })}>
                <SelectTrigger size="lg" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {draft.authMode === 'bearer' ? (
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Bearer Token {draft.id ? '· Re-Enter to Save' : ''}</span>
                <Input type="password" autoComplete="new-password" value={draft.bearer} onChange={(event) => setDraft({ ...draft, bearer: event.target.value })} />
              </label>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!formValid || busyId !== null}>{busyId ? 'Saving…' : 'Save Endpoint'}</Button>
          </div>
        </form>
      ) : null}

      {error ? <p role="alert" className="rounded-lg border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 p-3 typography-ui text-foreground">{error}</p> : null}

      <div className="space-y-2" aria-live="polite">
        {loading ? (
          <p role="status" className="rounded-lg border border-dashed border-border p-3 typography-ui text-muted-foreground">Loading registered endpoints…</p>
        ) : connections.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 typography-ui text-muted-foreground">No AG-UI endpoints registered. OpenCode remains the default.</p>
        ) : connections.map((connection) => (
          <article key={connection.id} className={cn('rounded-xl border p-3', selectedId === connection.id ? 'border-primary/45 bg-primary/5' : 'border-border/70')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="typography-ui-label font-semibold text-foreground">{connection.name}</h4>
                  <span className={cn('rounded-full border px-2 py-0.5 typography-micro', healthTone(connection))}>{healthLabel(connection)}</span>
                  {selectedId === connection.id ? <span className="rounded-full border border-primary/35 bg-primary/8 px-2 py-0.5 typography-micro text-primary">Selected</span> : null}
                </div>
                <p className="mt-1 truncate typography-micro text-muted-foreground">{connection.endpointUrl}</p>
                <p className="mt-1 typography-micro text-muted-foreground">AG-UI v1 · {connection.authMode === 'bearer' ? 'Encrypted bearer' : 'No authentication'}{connection.modelHint ? ` · ${connection.modelHint}` : ''}</p>
                {connection.health?.code ? <p className="mt-1 typography-micro text-[var(--status-error)]">{connection.health.code}</p> : null}
              </div>
              {!readOnly && connection.status !== 'revoked' ? (
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={`Test ${connection.name}`} disabled={busyId !== null} onClick={() => void testConnection(connection)}>
                    {busyId === connection.id ? <RiRefreshLine className="h-4 w-4 animate-spin" aria-hidden /> : <RiFlashlightLine className="h-4 w-4" aria-hidden />}
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label={`Edit ${connection.name}`} disabled={busyId !== null} onClick={() => setDraft(connectionDraft(connection))}>
                    <RiEditLine className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 text-[var(--status-error)]" aria-label={`Revoke ${connection.name}`} disabled={busyId !== null} onClick={() => void revokeConnection(connection)}>
                    <RiDeleteBinLine className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

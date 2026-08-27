import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BotCredentialMetadata, BotModelOptions } from '@/lib/botsApi';

export type SaveBotCredentialInput =
  | {
      provider: string;
      label: string;
      kind: 'api_key';
      credentialScope: 'team' | 'user';
      ownerUserId: string | null;
      secret: string;
    }
  | {
      provider: string;
      connectionId: string;
      label: string;
      kind: 'oauth';
      credentialScope: 'team' | 'user';
      ownerUserId: string | null;
    };

type MutationResult = boolean | void | Promise<boolean | void>;

export const BotCredentials: React.FC<{
  credentials: readonly BotCredentialMetadata[];
  providers: BotModelOptions['providers'];
  readOnly: boolean;
  busy: boolean;
  onSave: (input: SaveBotCredentialInput) => MutationResult;
  onRotate?: (credential: BotCredentialMetadata, secret: string) => MutationResult;
}> = ({ credentials, providers, readOnly, busy, onSave, onRotate }) => {
  const [provider, setProvider] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [kind, setKind] = React.useState<'api_key' | 'oauth'>('api_key');
  const [connectionId, setConnectionId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [rotatingId, setRotatingId] = React.useState<string | null>(null);
  const [rotationSecret, setRotationSecret] = React.useState('');
  const selectedProvider = providers.find((option) => option.id === provider);
  const oauthConnections = React.useMemo(
    () => selectedProvider?.connections ?? [],
    [selectedProvider],
  );
  const oauthConnection = oauthConnections.find((connection) => connection.id === connectionId) ?? null;

  React.useEffect(() => {
    if (kind !== 'oauth') return;
    setConnectionId((current) => oauthConnections.some((connection) => connection.id === current)
      ? current
      : oauthConnections[0]?.id || '');
  }, [kind, oauthConnections]);

  const save = async () => {
    const result = await onSave(kind === 'api_key' ? {
      provider,
      label: label.trim(),
      kind,
      credentialScope: 'team',
      ownerUserId: null,
      secret,
    } : {
      provider,
      connectionId,
      label: oauthConnection?.label || '',
      kind,
      credentialScope: 'team',
      ownerUserId: null,
    });
    if (result === false) return;
    setLabel('');
    setSecret('');
  };

  return (
    <section className="space-y-4 border-t border-border pt-7" aria-labelledby="bot-credentials-heading">
      <div>
        <h3 id="bot-credentials-heading" className="typography-ui-header font-semibold text-foreground">API Keys and Accounts</h3>
        <p className="typography-ui text-muted-foreground">Credentials are write-only and protected by the host vault.</p>
      </div>

      {!readOnly ? (
        <form className="space-y-3 rounded-xl border border-border/70 p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="grid gap-3 lg:grid-cols-3">
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Provider</span>
              <Select value={provider || '__none__'} onValueChange={(value) => {
                if (value === '__none__') return;
                setProvider(value);
                setConnectionId('');
                if (kind === 'oauth' && providers.find((option) => option.id === value)?.authType !== 'oauth') setKind('api_key');
              }}>
                <SelectTrigger size="lg" className="w-full"><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  {providers.length === 0 ? <SelectItem value="__none__" disabled>Provider Catalog Unavailable</SelectItem> : null}
                  {providers.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Kind</span>
              <Select value={kind} onValueChange={(value) => setKind(value as 'api_key' | 'oauth')}>
                <SelectTrigger size="lg" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="api_key">API Key</SelectItem>
                  <SelectItem value="oauth" disabled={selectedProvider?.authType !== 'oauth'}>Connected Account</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {kind === 'oauth' ? (
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Account</span>
                <Select value={connectionId || '__none__'} onValueChange={(value) => value !== '__none__' && setConnectionId(value)} disabled={!provider}>
                  <SelectTrigger size="lg" className="w-full"><SelectValue placeholder="Select account" /></SelectTrigger>
                  <SelectContent>
                    {oauthConnections.length === 0 ? <SelectItem value="__none__" disabled>No Connected Account</SelectItem> : null}
                    {oauthConnections.map((connection) => <SelectItem key={connection.id} value={connection.id}>{connection.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <label className="space-y-1 typography-meta text-muted-foreground">
                <span>Label</span>
                <Input value={label} maxLength={120} placeholder="Production account" onChange={(event) => setLabel(event.target.value)} />
              </label>
            )}
          </div>
          {kind === 'api_key' ? (
            <label className="block space-y-1 typography-meta text-muted-foreground">
              <span>API Key</span>
              <Input type="password" autoComplete="new-password" spellCheck={false} value={secret} placeholder="Enter key" onChange={(event) => setSecret(event.target.value)} />
            </label>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={busy || !selectedProvider?.available || (kind === 'oauth' ? !oauthConnection : !label.trim() || !secret)}>
              {busy ? 'Connecting…' : kind === 'api_key' ? 'Add API Key' : 'Add Account'}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border/70">
        {credentials.length === 0 ? (
          <p className="p-5 typography-ui text-muted-foreground">No credentials are configured.</p>
        ) : credentials.map((credential) => (
          <article key={credential.id} className="border-b border-border/70 p-4 last:border-b-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="typography-ui-label font-medium text-foreground">{credential.label || credential.provider}</p>
                <p className="typography-micro text-muted-foreground">{credential.provider} · {credential.maskedIdentifier || 'Stored securely'} · {credential.status}</p>
              </div>
              {!readOnly && credential.kind === 'api_key' && onRotate ? (
                <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => { setRotatingId((current) => current === credential.id ? null : credential.id); setRotationSecret(''); }}>
                  Replace
                </Button>
              ) : null}
            </div>
            {rotatingId === credential.id && onRotate ? (
              <form className="mt-3 flex gap-2" onSubmit={(event) => {
                event.preventDefault();
                void Promise.resolve(onRotate(credential, rotationSecret)).then((result) => {
                  if (result === false) return;
                  setRotatingId(null);
                  setRotationSecret('');
                });
              }}>
                <Input className="min-w-0 flex-1" type="password" autoComplete="new-password" value={rotationSecret} onChange={(event) => setRotationSecret(event.target.value)} />
                <Button type="submit" size="sm" disabled={busy || !rotationSecret}>Save</Button>
              </form>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
};

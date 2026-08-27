import React from 'react';
import { RiCloseCircleLine, RiSearchLine, RiShieldUserLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { botsApi, type BotDirectoryUser, type BotManagedMembership, type BotMembershipRole } from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import { canRevokeBotMembership } from './botManagementPresentation';

export type BotMembershipsProps = {
  botId: string;
  memberships: readonly BotManagedMembership[];
  readOnly?: boolean;
  busyUserId?: string | null;
  error?: string | null;
  onAssign: (input: {
    userId: string;
    role: BotMembershipRole;
    expectedUpdatedAt?: string;
  }) => void;
  onRevoke: (membership: BotManagedMembership) => void;
};

/** What to call someone: their name, then their email, then their id. */
const personLabel = (person: { displayName?: string | null; email?: string | null; userId?: string; id?: string }): string => (
  person.displayName?.trim()
  || person.email?.trim()
  || person.userId
  || person.id
  || 'Unknown person'
);

const personDetail = (person: { displayName?: string | null; email?: string | null }): string | null => (
  person.displayName?.trim() && person.email?.trim() ? person.email.trim() : null
);

export const BotMemberships: React.FC<BotMembershipsProps> = ({
  botId,
  memberships,
  readOnly = false,
  busyUserId = null,
  error = null,
  onAssign,
  onRevoke,
}) => {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<readonly BotDirectoryUser[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState<string | null>(null);
  const active = memberships.filter((membership) => membership.revokedAt === null);
  const revoked = memberships.filter((membership) => membership.revokedAt !== null);

  // Debounced so typing a name does not fire a request per keystroke.
  React.useEffect(() => {
    if (readOnly) return undefined;
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      botsApi.searchBotDirectory(botId, { query: query.trim(), limit: 12 })
        .then((response) => {
          if (cancelled) return;
          setResults(response.users);
          setDirectoryError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setResults([]);
          setDirectoryError(cause instanceof Error ? cause.message : 'The user directory is unavailable.');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [botId, query, readOnly]);

  const assign = (userId: string) => {
    const current = memberships.find((membership) => membership.userId === userId);
    // The legacy role value remains an internal settings-authorization detail.
    // Every active member can operate the Bot.
    onAssign({ userId, role: current?.role || 'member', expectedUpdatedAt: current?.updatedAt });
  };

  return (
    <section className="space-y-5" aria-labelledby="bot-memberships-heading">
      <div>
        <h3 id="bot-memberships-heading" className="typography-ui-header font-semibold text-foreground">Members</h3>
        <p className="typography-ui text-muted-foreground">
          Anyone added here can message this Bot and ask it to perform work.
        </p>
      </div>

      {!readOnly ? (
        <div className="space-y-3 rounded-lg border border-border/70 bg-[var(--surface-subtle)]/30 p-3" aria-label="Add a Member">
          <div>
            <label className="space-y-1 typography-meta text-muted-foreground">
              <span>Find a Person</span>
              <div className="relative">
                <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  className="pl-8"
                  placeholder="Search by name or email"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </label>
          </div>

          {directoryError ? (
            <p role="alert" className="typography-meta text-[var(--status-error)]">{directoryError}</p>
          ) : searching && results.length === 0 ? (
            <p className="typography-meta text-muted-foreground" role="status">Searching…</p>
          ) : results.length === 0 ? (
            <p className="typography-meta text-muted-foreground">No one matches that search.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto" aria-label="Directory Results">
              {results.map((person) => {
                const alreadyOnBot = person.assignedRole !== null;
                return (
                  <li key={person.id}>
                    <button
                      type="button"
                      disabled={alreadyOnBot}
                      onClick={() => assign(person.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors',
                        'hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                        'disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent',
                      )}
                    >
                      <RiShieldUserLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate typography-ui-label text-foreground">{personLabel(person)}</span>
                        {personDetail(person) ? (
                          <span className="block truncate typography-micro text-muted-foreground">{personDetail(person)}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 typography-micro capitalize text-muted-foreground">
                        {alreadyOnBot ? 'Already Added' : 'Add'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {error ? <p role="alert" className="typography-ui text-[var(--status-error)]">{error}</p> : null}

      <div className="overflow-hidden rounded-lg border border-border/70">
        <div className="grid grid-cols-[1fr_5rem] gap-2 border-b border-border bg-[var(--surface-subtle)]/50 px-3 py-2 typography-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">
          <span>Person</span><span className="text-right">Action</span>
        </div>
        {active.length === 0 ? (
          <p className="px-3 py-5 typography-ui text-muted-foreground">Nobody has been added to this Bot yet.</p>
        ) : active.map((membership) => {
          const revocation = canRevokeBotMembership(memberships, membership.userId);
          const label = personLabel(membership);
          return (
            <div key={membership.userId} className="grid grid-cols-[1fr_5rem] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
              <span className="flex min-w-0 items-center gap-2">
                <RiShieldUserLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate typography-ui-label text-foreground">{label}</span>
                  {personDetail(membership) ? (
                    <span className="block truncate typography-micro text-muted-foreground">{personDetail(membership)}</span>
                  ) : null}
                </span>
              </span>
              <span className="text-right">
                {!readOnly ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${label}`}
                    title={revocation.reason || 'Remove from This Bot'}
                    disabled={!revocation.allowed || busyUserId === membership.userId}
                    onClick={() => onRevoke(membership)}
                  >
                    <RiCloseCircleLine className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {revoked.length > 0 ? (
        <details className="rounded-lg border border-border/60 p-3">
          <summary className="cursor-pointer typography-ui-label text-muted-foreground">Previously removed ({revoked.length})</summary>
          <ul className="mt-2 space-y-1 typography-micro text-muted-foreground">
            {revoked.map((membership) => (
              <li key={membership.userId}>{personLabel(membership)}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
};

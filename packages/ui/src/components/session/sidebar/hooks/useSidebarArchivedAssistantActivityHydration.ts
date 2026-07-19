import React from 'react';
import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';
import { getLastVisibleAssistantResponseAt, type SessionAssistantActivity } from '@/sync/session-assistant-activity';
import { stripMessageDiffSnapshots } from '@/sync/sanitize';
import { useChildStoreManager } from '@/sync/sync-context';
import {
  getSidebarSessionDirectory,
  isActiveSidebarHydrationDirectory,
  isSessionNotFoundHydrationError,
} from './sidebarHydrationUtils';

const PAGE_SIZE = 50;
const MAX_PAGES_PER_SESSION = 8;
const MAX_CONCURRENT_REQUESTS = 3;

const getParentSessionId = (session: Session): string => {
  return (session as Session & { parentID?: string | null }).parentID || session.id;
};

type HydrationCandidate =
  | { type: 'cached'; parentSessionId: string; value: number }
  | { type: 'fetch'; parentSessionId: string; parentSession: Session | undefined; directory: string; key: string };

type CollectHydrationCandidatesInput = {
  activeSessions: Session[];
  archivedSessions: Session[];
  activityByParentSessionId: SessionAssistantActivity;
  getCachedMessages: (directory: string, parentSessionId: string) => Message[] | undefined;
  activeDirectory: string | null;
  resolvedKeys: Set<string>;
  inFlightKeys: Set<string>;
};

const collectHydrationCandidates = ({
  activeSessions,
  archivedSessions,
  activityByParentSessionId,
  getCachedMessages,
  activeDirectory,
  resolvedKeys,
  inFlightKeys,
}: CollectHydrationCandidatesInput): { cached: Extract<HydrationCandidate, { type: 'cached' }>[]; fetch: Extract<HydrationCandidate, { type: 'fetch' }>[] } => {
  const sessionsById = new Map<string, Session>();
  activeSessions.forEach((session) => sessionsById.set(session.id, session));
  archivedSessions.forEach((session) => sessionsById.set(session.id, session));

  const cached: Extract<HydrationCandidate, { type: 'cached' }>[] = [];
  const fetch: Extract<HydrationCandidate, { type: 'fetch' }>[] = [];
  const seenKeys = new Set<string>();

  archivedSessions.forEach((session) => {
    if (!session.time?.archived) return;
    const parentSessionId = getParentSessionId(session);
    if (activityByParentSessionId[parentSessionId] !== undefined) return;

    const parentSession = sessionsById.get(parentSessionId);
    const directory = (parentSession ? getSidebarSessionDirectory(parentSession) : null)
      ?? getSidebarSessionDirectory(session);
    if (!directory) return;

    const key = `${directory}\n${parentSessionId}`;
    if (seenKeys.has(key) || resolvedKeys.has(key) || inFlightKeys.has(key)) return;
    seenKeys.add(key);

    const cachedMessages = getCachedMessages(directory, parentSessionId);
    const cachedLatest = getLastVisibleAssistantResponseAt(parentSession, cachedMessages);
    if (cachedLatest !== undefined) {
      cached.push({ type: 'cached', parentSessionId, value: cachedLatest });
      return;
    }

    if (!isActiveSidebarHydrationDirectory(directory, activeDirectory)) return;
    fetch.push({ type: 'fetch', parentSessionId, parentSession, directory, key });
  });

  return { cached, fetch };
};

async function fetchLastAssistantResponseAt(input: {
  parentSessionId: string;
  parentSession: Session | undefined;
  directory: string;
}): Promise<number | undefined> {
  const scopedClient = opencodeClient.getScopedSdkClient(input.directory);
  let before: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_SESSION; page += 1) {
    const result = await scopedClient.session.messages({ sessionID: input.parentSessionId, limit: PAGE_SIZE, before });
    const records = (result.data ?? []).filter((record: { info?: { id?: string } }) => !!record?.info?.id);
    const messages = records.map((record: { info: Message }) => stripMessageDiffSnapshots(record.info));
    const latest = getLastVisibleAssistantResponseAt(input.parentSession, messages);
    if (latest !== undefined) return latest;

    before = result.response?.headers?.get?.('x-next-cursor') ?? undefined;
    if (!before) return undefined;
  }

  return undefined;
}

export function useSidebarArchivedAssistantActivityHydration(
  activeSessions: Session[],
  archivedSessions: Session[],
  activeDirectory: string | null,
): SessionAssistantActivity {
  const childStores = useChildStoreManager();
  const [activityByParentSessionId, setActivityByParentSessionId] = React.useState<SessionAssistantActivity>({});
  const inFlightRef = React.useRef(new Set<string>());
  const resolvedRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    let cancelled = false;
    const inFlightKeys = inFlightRef.current;
    const resolvedKeys = resolvedRef.current;

    const candidates = collectHydrationCandidates({
      activeSessions,
      archivedSessions,
      activityByParentSessionId,
      getCachedMessages: (directory, parentSessionId) => childStores.getState(directory)?.message[parentSessionId],
      activeDirectory,
      resolvedKeys,
      inFlightKeys,
    });

    const cached = candidates.cached;
    if (cached.length > 0) {
      setActivityByParentSessionId((current) => {
        let next: SessionAssistantActivity | null = null;
        cached.forEach((item) => {
          if ((next ?? current)[item.parentSessionId] === item.value) return;
          next = next ? { ...next, [item.parentSessionId]: item.value } : { ...current, [item.parentSessionId]: item.value };
        });
        return next ?? current;
      });
    }

    const fetchCandidates = candidates.fetch;
    if (fetchCandidates.length === 0) return;

    const pendingKeys = new Set(fetchCandidates.map((item) => item.key));
    fetchCandidates.forEach((item) => inFlightKeys.add(item.key));
    const fetched: Array<{ parentSessionId: string; latest: number }> = [];
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      if (cancelled) return;
      const item = fetchCandidates[cursor];
      cursor += 1;
      if (!item) return;
      pendingKeys.delete(item.key);

      try {
        const latest = await fetchLastAssistantResponseAt(item);
        if (cancelled) return;
        resolvedKeys.add(item.key);
        if (latest !== undefined) {
          fetched.push({ parentSessionId: item.parentSessionId, latest });
        }
      } catch (error) {
        if (isSessionNotFoundHydrationError(error)) {
          resolvedKeys.add(item.key);
        }
        // Archived recency is non-critical; keep deterministic metadata fallback ordering.
      } finally {
        inFlightKeys.delete(item.key);
        await runNext();
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_REQUESTS, fetchCandidates.length) },
      () => runNext(),
    );

    void Promise.all(workers).then(() => {
      if (cancelled || fetched.length === 0) return;
      setActivityByParentSessionId((current) => {
        let next: SessionAssistantActivity | null = null;
        fetched.forEach(({ parentSessionId, latest }) => {
          if ((next ?? current)[parentSessionId] === latest) return;
          next = next ? { ...next, [parentSessionId]: latest } : { ...current, [parentSessionId]: latest };
        });
        return next ?? current;
      });
    });

    return () => {
      cancelled = true;
      pendingKeys.forEach((key) => inFlightKeys.delete(key));
    };
  }, [activeDirectory, activeSessions, activityByParentSessionId, archivedSessions, childStores]);

  return activityByParentSessionId;
}

export { isSessionNotFoundHydrationError };

export const __testArchivedAssistantHydration = {
  collectCandidates: collectHydrationCandidates,
};

import React from 'react';

import type { DirectoryTerminalState } from '@/stores/useTerminalStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { isPreviewLoopbackHost, parsePreviewHttpUrl } from './previewLifecycle';

export type LocalPreviewInstance = {
  id: string;
  terminalSessionId: string;
  label: string;
  url: string;
  origin: string;
  port: string;
};

export type LocalInstanceProbeStatus = 'reachable' | 'unreachable' | 'invalid';

type LocalInstanceProbeResult = {
  url: string;
  origin: string | null;
  status: LocalInstanceProbeStatus;
};

type LocalInstanceStatusResponse = {
  results?: LocalInstanceProbeResult[];
};

const LOCAL_INSTANCE_POLL_INTERVAL_MS = 3_000;
const ACTION_LABEL_PREFIX = /^Action:\s*/i;

const normalizeDirectory = (directory: string): string => {
  let normalized = directory.trim();
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

export const projectLocalPreviewInstances = (
  directoryState: DirectoryTerminalState | undefined,
  fallbackLabel: string,
): LocalPreviewInstance[] => {
  if (!directoryState) return [];

  const seenOrigins = new Set<string>();
  const instances: LocalPreviewInstance[] = [];

  for (const tab of directoryState.tabs) {
    if (tab.lifecycle !== 'running' || !tab.terminalSessionId || !tab.previewUrl) continue;

    const parsed = parsePreviewHttpUrl(tab.previewUrl);
    if (!parsed || !isPreviewLoopbackHost(parsed.hostname) || seenOrigins.has(parsed.origin)) continue;

    const label = tab.label.replace(ACTION_LABEL_PREFIX, '').trim() || fallbackLabel;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    seenOrigins.add(parsed.origin);
    instances.push({
      id: tab.id,
      terminalSessionId: tab.terminalSessionId,
      label,
      url: parsed.toString(),
      origin: parsed.origin,
      port,
    });
  }

  return instances;
};

const instanceSignature = (instances: LocalPreviewInstance[]): string => (
  instances.map((instance) => [
    instance.id,
    instance.terminalSessionId,
    instance.label,
    instance.url,
    instance.origin,
    instance.port,
  ].join('\u0000')).join('\u0001')
);

export const useLocalPreviewInstances = (
  directory: string,
  fallbackLabel: string,
): LocalPreviewInstance[] => {
  const cacheRef = React.useRef<{ signature: string; instances: LocalPreviewInstance[] }>({
    signature: '',
    instances: [],
  });

  const getSnapshot = React.useCallback(() => {
    const normalizedDirectory = normalizeDirectory(directory);
    const directoryState = normalizedDirectory
      ? useTerminalStore.getState().getDirectoryState(normalizedDirectory)
      : undefined;
    const nextInstances = projectLocalPreviewInstances(directoryState, fallbackLabel);
    const signature = instanceSignature(nextInstances);
    if (signature === cacheRef.current.signature) {
      return cacheRef.current.instances;
    }
    cacheRef.current = { signature, instances: nextInstances };
    return nextInstances;
  }, [directory, fallbackLabel]);

  return React.useSyncExternalStore(useTerminalStore.subscribe, getSnapshot, getSnapshot);
};

export const fetchReachableLocalInstanceOrigins = async (
  urls: string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> => {
  const response = await fetchImpl('/api/preview/local-instances/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    body: JSON.stringify({ urls }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Local instance status failed with HTTP ${response.status}`);
  }

  const payload = await response.json() as LocalInstanceStatusResponse;
  const reachable = new Set<string>();
  for (const result of payload.results ?? []) {
    if (result?.status === 'reachable' && typeof result.origin === 'string') {
      reachable.add(result.origin);
    }
  }
  return reachable;
};

const setsEqual = (left: Set<string>, right: Set<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

export const useReachableLocalPreviewInstances = (
  candidates: LocalPreviewInstance[],
  enabled: boolean,
): LocalPreviewInstance[] => {
  const [reachableOrigins, setReachableOrigins] = React.useState<Set<string>>(() => new Set());
  const candidateKey = React.useMemo(
    () => candidates.map((candidate) => `${candidate.origin}\u0000${candidate.url}`).join('\u0001'),
    [candidates],
  );

  React.useEffect(() => {
    const currentOrigins = new Set(candidates.map((candidate) => candidate.origin));
    setReachableOrigins((previous) => {
      const retained = new Set([...previous].filter((origin) => currentOrigins.has(origin)));
      return setsEqual(previous, retained) ? previous : retained;
    });

    if (!enabled || candidates.length === 0) {
      if (candidates.length === 0) {
        setReachableOrigins((previous) => (previous.size === 0 ? previous : new Set()));
      }
      return;
    }

    let disposed = false;
    let controller: AbortController | null = null;

    const probe = async () => {
      if (controller) return;
      controller = new AbortController();
      try {
        const reachable = await fetchReachableLocalInstanceOrigins(
          candidates.map((candidate) => candidate.url),
          controller.signal,
        );
        if (!disposed) {
          setReachableOrigins((previous) => (setsEqual(previous, reachable) ? previous : reachable));
        }
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
          // Retain the last confirmed result and retry on the next interval.
        }
      } finally {
        controller = null;
      }
    };

    void probe();
    const intervalID = window.setInterval(() => { void probe(); }, LOCAL_INSTANCE_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(intervalID);
    };
  }, [candidateKey, candidates, enabled]);

  return React.useMemo(
    () => candidates.filter((candidate) => reachableOrigins.has(candidate.origin)),
    [candidates, reachableOrigins],
  );
};

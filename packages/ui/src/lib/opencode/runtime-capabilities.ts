import React from 'react';
import { create } from 'zustand';

/**
 * OpenCode runtime capabilities the UI gates affordances on.
 *
 * The server reports them in the `/health` snapshot as
 * `openCode: { generation, capabilities }` (packages/web/server/lib/opencode/
 * core-routes.js, built by `describeOpenCodeRuntimeCapabilities` in
 * readiness-probe.js). Only OpenCode 2 is supported. Each capability requires
 * an explicit grant from its ready host integration.
 *
 * Capabilities start disabled. Disconnect/apply invalidation disables them until a fresh valid block
 * arrives; a failed or malformed replacement read cannot restore old grants.
 */

export const RUNTIME_CAPABILITY_KEYS = ['share', 'mcpOAuth', 'sessionShell', 'lsp', 'messageEdit'] as const;

export type RuntimeCapabilityKey = (typeof RUNTIME_CAPABILITY_KEYS)[number];
export type RuntimeCapabilities = Readonly<Record<RuntimeCapabilityKey, boolean>>;
export type OpenCodeRuntimeGeneration = 2;

export type RuntimeCapabilitySnapshot = Readonly<{
  /** `null` when the server did not report a valid generation. */
  generation: OpenCodeRuntimeGeneration | null;
  capabilities: RuntimeCapabilities;
  /** `default` until a `/health` body with an `openCode` block was read. */
  source: 'default' | 'health';
  runtimeIdentity?: string | null;
}>;

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  share: false,
  mcpOAuth: false,
  sessionShell: false,
  lsp: false,
  messageEdit: false,
});

export const DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT: RuntimeCapabilitySnapshot = Object.freeze({
  generation: null,
  capabilities: DEFAULT_RUNTIME_CAPABILITIES,
  source: 'default',
});

const CAPABILITY_LABELS: Readonly<Record<RuntimeCapabilityKey, string>> = Object.freeze({
  share: 'Session sharing',
  mcpOAuth: 'MCP OAuth',
  sessionShell: 'Session shell',
  lsp: 'LSP',
  messageEdit: 'Message editing',
});

export class RuntimeCapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable';
  readonly capability: RuntimeCapabilityKey;

  constructor(capability: RuntimeCapabilityKey) {
    super(`${CAPABILITY_LABELS[capability]} is not available on this OpenCode runtime.`);
    this.name = 'RuntimeCapabilityUnavailableError';
    this.capability = capability;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseGeneration = (value: unknown): OpenCodeRuntimeGeneration | null => {
  if (value === 2) return value;
  return null;
};

/**
 * Reads explicit OpenCode 2 grants. Missing, malformed and unsupported runtime
 * identities cannot enable capabilities.
 */
export const parseRuntimeCapabilitySnapshot = (health: unknown): RuntimeCapabilitySnapshot => {
  if (!isRecord(health)) return DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT;
  const block = health.openCode;
  if (!isRecord(block)) return DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT;

  const generation = parseGeneration(block.generation);
  const reported = isRecord(block.capabilities) ? block.capabilities : null;
  const capabilities = {} as Record<RuntimeCapabilityKey, boolean>;
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    const value = reported?.[key];
    capabilities[key] = generation === 2 && value === true;
  }

  return Object.freeze({
    generation,
    capabilities: Object.freeze(capabilities),
    source: 'health',
    ...(typeof block.runtimeIdentity === 'string' && block.runtimeIdentity.trim()
      ? { runtimeIdentity: block.runtimeIdentity } : {}),
  });
};

const areSnapshotsEqual = (left: RuntimeCapabilitySnapshot, right: RuntimeCapabilitySnapshot): boolean => {
  if (left.generation !== right.generation || left.source !== right.source
    || left.runtimeIdentity !== right.runtimeIdentity) return false;
  return RUNTIME_CAPABILITY_KEYS.every((key) => left.capabilities[key] === right.capabilities[key]);
};

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

type RuntimeCapabilityState = {
  snapshot: RuntimeCapabilitySnapshot;
  status: LoadStatus;
  failedAt: number;
};

export const useRuntimeCapabilityStore = create<RuntimeCapabilityState>()(() => ({
  snapshot: DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT,
  status: 'idle',
  failedAt: 0,
}));

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LoadRuntimeCapabilitiesOptions = {
  fetchImpl?: FetchLike;
  /** Re-read `/health` even when a snapshot is already loaded. */
  force?: boolean;
  timeoutMs?: number;
  now?: () => number;
};

const HEALTH_TIMEOUT_MS = 4000;
/** A failed read is retried by later callers, but not more often than this. */
export const RUNTIME_CAPABILITY_RETRY_MS = 30_000;

let inFlight: Promise<RuntimeCapabilitySnapshot> | null = null;
let readRevision = 0;

/** Fence a health read before starting it, including client readiness reads. */
export const beginRuntimeCapabilityRead = (): number => {
  inFlight = null;
  return ++readRevision;
};

export const failRuntimeCapabilityRead = (revision: number, now = Date.now): void => {
  if (revision === readRevision) useRuntimeCapabilityStore.setState({ status: 'failed', failedAt: now() });
};

/** A disconnect/apply invalidates cached permissions before a replacement can act. */
export const invalidateRuntimeCapabilities = (): void => {
  readRevision += 1;
  inFlight = null;
  const current = useRuntimeCapabilityStore.getState().snapshot;
  const unknown = DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT;
  useRuntimeCapabilityStore.setState({ snapshot: areSnapshotsEqual(current, unknown) ? current : unknown,
    status: 'idle', failedAt: 0 });
};

export const observeRuntimeCapabilityHealth = (health: unknown, revision: number): RuntimeCapabilitySnapshot => {
  if (revision !== readRevision) return useRuntimeCapabilityStore.getState().snapshot;
  const next = parseRuntimeCapabilitySnapshot(health);
  const current = useRuntimeCapabilityStore.getState().snapshot;
  if (next.generation === null) {
    const unknown = DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT;
    useRuntimeCapabilityStore.setState({ snapshot: areSnapshotsEqual(current, unknown) ? current : unknown });
    failRuntimeCapabilityRead(revision);
    return useRuntimeCapabilityStore.getState().snapshot;
  }
  const snapshot = areSnapshotsEqual(current, next) ? current : next;
  useRuntimeCapabilityStore.setState({ snapshot, status: 'loaded', failedAt: 0 });
  return snapshot;
};

export const refreshRuntimeCapabilities = (options: LoadRuntimeCapabilitiesOptions = {}): Promise<RuntimeCapabilitySnapshot> => {
  invalidateRuntimeCapabilities();
  return loadRuntimeCapabilities(options);
};

const readHealth = async (fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> => {
  const response = await fetchImpl('/health', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
};

/**
 * Loads the capability snapshot once and shares the in-flight read. A failed
 * read keeps the current snapshot (unavailable initially or after invalidation) and is
 * retried after {@link RUNTIME_CAPABILITY_RETRY_MS}.
 */
export const loadRuntimeCapabilities = (
  options: LoadRuntimeCapabilitiesOptions = {},
): Promise<RuntimeCapabilitySnapshot> => {
  const state = useRuntimeCapabilityStore.getState();
  const now = options.now ?? Date.now;
  if (inFlight) return inFlight;
  if (!options.force) {
    if (state.status === 'loaded') return Promise.resolve(state.snapshot);
    if (state.status === 'failed' && now() - state.failedAt < RUNTIME_CAPABILITY_RETRY_MS) {
      return Promise.resolve(state.snapshot);
    }
  }

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const revision = beginRuntimeCapabilityRead();
  useRuntimeCapabilityStore.setState({ status: 'loading' });

  const request = (async () => {
    try {
      return observeRuntimeCapabilityHealth(await readHealth(fetchImpl, timeoutMs), revision);
    } catch {
      failRuntimeCapabilityRead(revision, now);
      return useRuntimeCapabilityStore.getState().snapshot;
    } finally {
      if (revision === readRevision) inFlight = null;
    }
  })();
  inFlight = request;
  return request;
};

/** Current value without a network read (defaults until loaded). */
export const isRuntimeCapabilityEnabled = (key: RuntimeCapabilityKey): boolean =>
  useRuntimeCapabilityStore.getState().snapshot.capabilities[key];

/** Waits for the snapshot (one shared read), then reports the capability. */
export const resolveRuntimeCapability = async (
  key: RuntimeCapabilityKey,
  options?: LoadRuntimeCapabilitiesOptions,
): Promise<boolean> => {
  const snapshot = await loadRuntimeCapabilities(options);
  return snapshot.capabilities[key];
};

/** Core-logic guard: throws {@link RuntimeCapabilityUnavailableError} when off. */
export const assertRuntimeCapability = async (
  key: RuntimeCapabilityKey,
  options?: LoadRuntimeCapabilitiesOptions,
): Promise<void> => {
  if (await resolveRuntimeCapability(key, options)) return;
  throw new RuntimeCapabilityUnavailableError(key);
};

/**
 * Narrow subscription to one capability. Mounting triggers the shared load;
 * capabilities stay off until reported; invalidated grants stay off
 * until a valid replacement snapshot arrives.
 */
export const useRuntimeCapability = (key: RuntimeCapabilityKey): boolean => {
  const enabled = useRuntimeCapabilityStore((state) => state.snapshot.capabilities[key]);
  const status = useRuntimeCapabilityStore((state) => state.status);
  React.useEffect(() => {
    if (status === 'idle') void loadRuntimeCapabilities();
  }, [status]);
  return enabled;
};

/** Test-only reset of the module state. */
export const resetRuntimeCapabilitiesForTests = (): void => {
  readRevision += 1;
  inFlight = null;
  useRuntimeCapabilityStore.setState({
    snapshot: DEFAULT_RUNTIME_CAPABILITY_SNAPSHOT,
    status: 'idle',
    failedAt: 0,
  });
};

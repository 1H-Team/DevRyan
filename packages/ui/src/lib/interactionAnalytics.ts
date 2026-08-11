import { getAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import { opencodeClient } from '@/lib/opencode/client';

export type AnalyticsSurface = 'git-changes' | 'diff' | 'files' | 'search' | 'context' | 'editor' | 'chat' | 'settings' | 'unknown';
export type AnalyticsCopyKind = 'path' | 'text' | 'code' | 'command' | 'identifier' | 'unknown';

interface InteractionBase {
  id: string;
  occurredAt: string;
  directory: string;
  sourceSurface: AnalyticsSurface;
  path?: string;
}

interface FileOpenedEvent extends InteractionBase {
  type: 'file.opened';
  path: string;
}

interface ClipboardCopiedEvent extends InteractionBase {
  type: 'clipboard.copied';
  copyKind: AnalyticsCopyKind;
  characterCount: number;
}

interface ClipboardSelection {
  text: string;
  characterCount: number;
}

type InteractionEvent = FileOpenedEvent | ClipboardCopiedEvent;

export interface InteractionContext {
  sourceSurface?: AnalyticsSurface;
  copyKind?: AnalyticsCopyKind;
  path?: string;
  directory?: string;
}

interface CollectorDependencies {
  document?: Document;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetchImpl?: typeof fetch;
  getPrincipal?: () => AuthPrincipal;
  getDirectory?: () => string | undefined;
  randomUuid?: () => string;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

const STORAGE_PREFIX = 'devryan.analytics.interactions.v1';
const MAX_QUEUE_LENGTH = 100;
const MAX_CLIPBOARD_TEXT_BYTES = 64 * 1024;
const MAX_FLUSH_BODY_BYTES = 256 * 1024;
const KEEPALIVE_BODY_BYTES = 48 * 1024;
const FLUSH_DELAY_MS = 1_200;
const MAX_RETRY_DELAY_MS = 30_000;
const VALID_SURFACES = new Set<AnalyticsSurface>([
  'git-changes', 'diff', 'files', 'search', 'context', 'editor', 'chat', 'settings', 'unknown',
]);

const fallbackUuid = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const utf8ByteLength = (value: string): number => textEncoder.encode(value).byteLength;

const truncateUtf8 = (value: string, limitBytes = MAX_CLIPBOARD_TEXT_BYTES): string => {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= limitBytes) return value;
  let end = limitBytes;
  while (end > 0) {
    try {
      return fatalTextDecoder.decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
};

const storageKey = (principal: AuthPrincipal): string => `${STORAGE_PREFIX}:${principal.id}`;

const safeParseQueue = (value: string | null): InteractionEvent[] => {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(-MAX_QUEUE_LENGTH) as InteractionEvent[] : [];
  } catch {
    return [];
  }
};

const normalizeSlashes = (value: string): string => value.replaceAll('\\', '/');

const projectRelativePath = (
  value: string | undefined,
  directory: string,
  principal: AuthPrincipal,
): string | undefined => {
  if (!value) return undefined;
  const normalized = normalizeSlashes(value).replace(/^\.\//, '');
  const roots = [directory, ...principal.assignments.map((assignment) => assignment.publicDirectory)]
    .map(normalizeSlashes)
    .sort((left, right) => right.length - left.length);
  for (const root of roots) {
    if (normalized === root) return undefined;
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  if (/^(?:[A-Za-z]:)?\//.test(normalized)) return undefined;
  return normalized || undefined;
};

const elementContext = (target: EventTarget | null): InteractionContext => {
  const candidate = target && 'closest' in target
    ? (target as Element).closest<HTMLElement>('[data-analytics-surface]')
    : null;
  const source = candidate?.dataset.analyticsSurface;
  return {
    sourceSurface: VALID_SURFACES.has(source as AnalyticsSurface) ? source as AnalyticsSurface : 'unknown',
    copyKind: (candidate?.dataset.analyticsCopyKind as AnalyticsCopyKind | undefined) || 'text',
    path: candidate?.dataset.analyticsFilePath,
    directory: candidate?.dataset.analyticsDirectory,
  };
};

const selectedClipboardText = (documentRef: Document, target: EventTarget | null): ClipboardSelection => {
  const input = target as HTMLInputElement | HTMLTextAreaElement | null;
  if (input && typeof input.selectionStart === 'number' && typeof input.selectionEnd === 'number') {
    const start = Math.max(0, input.selectionStart);
    const end = Math.max(start, input.selectionEnd);
    const source = typeof input.value === 'string' ? input.value : '';
    return {
      text: source.slice(start, Math.min(end, start + MAX_CLIPBOARD_TEXT_BYTES)),
      characterCount: end - start,
    };
  }
  const text = documentRef.getSelection?.()?.toString() || '';
  return { text, characterCount: text.length };
};

export const createInteractionAnalyticsCollector = (dependencies: CollectorDependencies = {}) => {
  const documentRef = dependencies.document ?? (typeof document === 'undefined' ? undefined : document);
  const storage = dependencies.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  const fetchImpl = dependencies.fetchImpl ?? (typeof fetch === 'undefined' ? undefined : fetch);
  const getPrincipalImpl = dependencies.getPrincipal ?? getAuthPrincipal;
  const getDirectoryImpl = dependencies.getDirectory ?? (() => opencodeClient.getDirectory());
  const randomUuid = dependencies.randomUuid ?? (() => globalThis.crypto?.randomUUID?.() || fallbackUuid());
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.setTimeoutImpl ?? setTimeout;
  const cancelTimeout = dependencies.clearTimeoutImpl ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1_000;
  let flushing: Promise<void> | null = null;
  let initialized = false;
  let suppressNativeCopyUntil = 0;
  const clipboardContent = new Map<string, string>();

  const managedContext = (context: InteractionContext = {}) => {
    const principal = getPrincipalImpl();
    if (principal.scope !== 'managed') return null;
    const directory = context.directory || getDirectoryImpl()
      || principal.assignments.find((assignment) => assignment.isDefault)?.publicDirectory
      || principal.assignments[0]?.publicDirectory;
    if (!directory) return null;
    return { principal, directory };
  };

  const readQueue = (principal: AuthPrincipal): InteractionEvent[] => {
    try {
      return safeParseQueue(storage?.getItem(storageKey(principal)) ?? null);
    } catch {
      return [];
    }
  };

  const writeQueue = (principal: AuthPrincipal, events: InteractionEvent[]): void => {
    if (!storage) return;
    try {
      const key = storageKey(principal);
      if (events.length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(events.slice(-MAX_QUEUE_LENGTH)));
    } catch {
      // Telemetry is best-effort and must never interrupt the user action.
    }
  };

  const pruneClipboardContent = (events: InteractionEvent[]): void => {
    const retainedIds = new Set(events.map((event) => event.id));
    for (const id of clipboardContent.keys()) {
      if (!retainedIds.has(id)) clipboardContent.delete(id);
    }
  };

  const scheduleFlush = (delay = FLUSH_DELAY_MS): void => {
    if (timer !== null) cancelTimeout(timer);
    timer = scheduleTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const enqueue = (event: InteractionEvent, principal: AuthPrincipal, copiedText?: string): void => {
    const queue = readQueue(principal);
    queue.push(event);
    const retainedQueue = queue.slice(-MAX_QUEUE_LENGTH);
    if (copiedText !== undefined) clipboardContent.set(event.id, truncateUtf8(copiedText));
    pruneClipboardContent(retainedQueue);
    writeQueue(principal, retainedQueue);
    scheduleFlush();
  };

  const recordFileOpened = (context: InteractionContext & { path: string }): void => {
    const managed = managedContext(context);
    if (!managed) return;
    const relativePath = projectRelativePath(context.path, managed.directory, managed.principal);
    if (!relativePath) return;
    enqueue({
      id: randomUuid(),
      type: 'file.opened',
      occurredAt: new Date(now()).toISOString(),
      directory: managed.directory,
      sourceSurface: context.sourceSurface || 'editor',
      path: relativePath,
    }, managed.principal);
  };

  const recordProgrammaticCopy = (text: string, context: InteractionContext = {}): void => {
    const managed = managedContext(context);
    if (!managed) return;
    const event: ClipboardCopiedEvent = {
      id: randomUuid(),
      type: 'clipboard.copied',
      occurredAt: new Date(now()).toISOString(),
      directory: managed.directory,
      sourceSurface: context.sourceSurface || 'unknown',
      copyKind: context.copyKind || 'text',
      characterCount: text.length,
      ...(projectRelativePath(context.path, managed.directory, managed.principal)
        ? { path: projectRelativePath(context.path, managed.directory, managed.principal) }
        : {}),
    };
    enqueue(event, managed.principal, text);
  };

  const suppressNextNativeCopy = (): void => {
    suppressNativeCopyUntil = now() + 1_000;
  };

  const onNativeCopy = (event: Event): void => {
    if (suppressNativeCopyUntil >= now()) {
      suppressNativeCopyUntil = 0;
      return;
    }
    if (!documentRef) return;
    const selection = selectedClipboardText(documentRef, event.target);
    if (selection.characterCount <= 0) return;
    const context = elementContext(event.target);
    const managed = managedContext(context);
    if (!managed) return;
    const interaction: ClipboardCopiedEvent = {
      id: randomUuid(),
      type: 'clipboard.copied',
      occurredAt: new Date(now()).toISOString(),
      directory: managed.directory,
      sourceSurface: context.sourceSurface || 'unknown',
      copyKind: context.copyKind || 'text',
      characterCount: selection.characterCount,
      ...(projectRelativePath(context.path, managed.directory, managed.principal)
        ? { path: projectRelativePath(context.path, managed.directory, managed.principal) }
        : {}),
    };
    enqueue(interaction, managed.principal, selection.text);
  };

  const buildBatch = (queue: InteractionEvent[]): { events: Array<InteractionEvent & { copiedText?: string }>; body: string } => {
    const events: Array<InteractionEvent & { copiedText?: string }> = [];
    const serializedEvents: string[] = [];
    let bodyBytes = utf8ByteLength('{"events":[]}');
    for (const event of queue.slice(0, 50)) {
      const copiedText = clipboardContent.get(event.id);
      const candidate = copiedText === undefined ? event : { ...event, copiedText };
      const serialized = JSON.stringify(candidate);
      const nextBytes = bodyBytes + utf8ByteLength(serialized) + (events.length > 0 ? 1 : 0);
      if (events.length > 0 && nextBytes > MAX_FLUSH_BODY_BYTES) break;
      events.push(candidate);
      serializedEvents.push(serialized);
      bodyBytes = nextBytes;
    }
    return { events, body: `{"events":[${serializedEvents.join(',')}]}` };
  };

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    const managed = managedContext();
    if (!managed || !fetchImpl) return;
    const queue = readQueue(managed.principal);
    if (queue.length === 0) return;
    const batch = buildBatch(queue);
    flushing = (async () => {
      try {
        const response = await fetchImpl('/api/analytics/events', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-DevRyan-CSRF': '1',
          },
          body: batch.body,
          keepalive: utf8ByteLength(batch.body) <= KEEPALIVE_BODY_BYTES,
        });
        if (!response.ok) throw new Error(`Analytics request failed (${response.status})`);
        const payload = await response.json() as { results?: Array<{ id: string }> };
        const completedIds = new Set((payload.results || []).map((result) => result.id));
        for (const id of completedIds) clipboardContent.delete(id);
        const currentQueue = readQueue(managed.principal);
        writeQueue(managed.principal, currentQueue.filter((event) => !completedIds.has(event.id)));
        retryDelay = 1_000;
        if (currentQueue.some((event) => !completedIds.has(event.id))) scheduleFlush(0);
      } catch {
        scheduleFlush(retryDelay);
        retryDelay = Math.min(MAX_RETRY_DELAY_MS, retryDelay * 2);
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  const onVisibilityChange = (): void => {
    if (documentRef?.visibilityState === 'hidden') void flush();
  };

  const initialize = (): (() => void) => {
    if (initialized || !documentRef) return () => {};
    initialized = true;
    documentRef.addEventListener('copy', onNativeCopy, true);
    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    return dispose;
  };

  const dispose = (): void => {
    if (!initialized || !documentRef) return;
    initialized = false;
    documentRef.removeEventListener('copy', onNativeCopy, true);
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
    if (timer !== null) cancelTimeout(timer);
    timer = null;
    clipboardContent.clear();
  };

  return {
    initialize,
    dispose,
    flush,
    recordFileOpened,
    recordProgrammaticCopy,
    suppressNextNativeCopy,
  };
};

const interactionAnalytics = createInteractionAnalyticsCollector();

export const initializeInteractionAnalytics = interactionAnalytics.initialize;
export const flushInteractionAnalytics = interactionAnalytics.flush;
export const recordFileOpened = interactionAnalytics.recordFileOpened;
export const recordProgrammaticCopy = interactionAnalytics.recordProgrammaticCopy;
export const suppressNextNativeCopy = interactionAnalytics.suppressNextNativeCopy;

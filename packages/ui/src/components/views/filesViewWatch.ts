// Files view change-notification lifecycle, kept free of React so its timing
// and fallback rules are testable. FilesView owns the effects that call it.
import type { FileWatchEvent, FileWatchScope, FilesAPI } from '@/lib/api/types';
import { createReconnectBackoff } from '@/lib/reconnectBackoff';

export const FILES_DIRECTORY_POLL_MS = 8_000;
export const FILES_SELECTED_FILE_POLL_MS = 2_000;
/** Owner decision (2026-11-05): a slow refresh stays on while a watch is ready. */
export const FILES_WATCH_SAFETY_NET_MS = 30_000;
export const FILES_WATCH_SCOPE_DEBOUNCE_MS = 250;

export const filesPollIntervals = (watching: boolean): { directoryMs: number; selectedFileMs: number } => (watching
  ? { directoryMs: FILES_WATCH_SAFETY_NET_MS, selectedFileMs: FILES_WATCH_SAFETY_NET_MS }
  : { directoryMs: FILES_DIRECTORY_POLL_MS, selectedFileMs: FILES_SELECTED_FILE_POLL_MS });

export const shouldSubscribeFilesWatch = (input: {
  visible: boolean;
  documentVisible: boolean;
  hasWatch: boolean;
  hasPlan: boolean;
}): boolean => input.visible && input.documentVisible && input.hasWatch && input.hasPlan;

export type FilesWatchPlan = {
  key: string;
  root: string;
  scope: FileWatchScope;
  /** Absolute path of each `scope.expandedDirectories` entry, by slot index. */
  expandedPaths: readonly string[];
};

const comparable = (value: string): string => (/^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value);

/** Path relative to `root` (forward slashes), '' for the root, or null outside it. */
const relativeToRoot = (root: string, target: string): string | null => {
  const base = comparable(root);
  const candidate = comparable(target);
  if (candidate === base) return '';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return candidate.startsWith(prefix) ? target.slice(prefix.length) : null;
};

/**
 * Inputs are normalized absolute paths. Expanded directories outside the root
 * are left to polling; a selected file outside the root is not watched (its
 * reads use `allowOutsideWorkspace`, which the watch route never honours).
 */
export const buildFilesWatchPlan = (input: {
  root: string;
  expandedPaths: readonly string[];
  selectedPath: string | null;
}): FilesWatchPlan | null => {
  const { root } = input;
  if (!root) return null;
  const expandedPaths: string[] = [];
  const expandedDirectories: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input.expandedPaths) {
    const relative = relativeToRoot(root, candidate);
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    expandedPaths.push(candidate);
    expandedDirectories.push(relative);
  }
  const selectedRelative = input.selectedPath ? relativeToRoot(root, input.selectedPath) : null;
  const scope: FileWatchScope = {
    directory: root,
    expandedDirectories,
    ...(selectedRelative ? { selectedFile: selectedRelative } : {}),
  };
  return {
    key: JSON.stringify([root, expandedDirectories, selectedRelative ?? null]),
    root,
    scope,
    expandedPaths,
  };
};

export type FilesWatchHandlers = {
  refreshDirectory(path: string): void;
  refreshSelectedFile(): void;
  /** Authoritative refresh of the root, expanded directories and selected file. */
  refreshAll(): void;
  setWatching(watching: boolean): void;
};

type TimerApi = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

const defaultTimers: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Subscribe `plan` until the returned stop function runs. Network failures
 * retry with the shared backoff (reset after ready) and poll meanwhile; a
 * non-retryable `unavailable` keeps polling until the scope or runtime changes.
 * Stopping does not change the mode: a replacement subscription settles it.
 */
export const startFilesWatch = ({
  watch,
  plan,
  handlers,
  timers = defaultTimers,
}: {
  watch: NonNullable<FilesAPI['watch']>;
  plan: FilesWatchPlan;
  handlers: FilesWatchHandlers;
  timers?: TimerApi;
}): (() => void) => {
  const controller = new AbortController();
  const backoff = createReconnectBackoff();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    retryTimer = null;
    let epoch: number | null = null;
    let terminal = false;
    const onEvent = (event: FileWatchEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === 'ready') {
        epoch = event.epoch;
        backoff.reset();
        handlers.setWatching(true);
        handlers.refreshAll();
        return;
      }
      if (event.type === 'unavailable') {
        terminal = !event.retryable;
        handlers.setWatching(false);
        return;
      }
      if (epoch === null || event.epoch !== epoch) return;
      if (event.type === 'resync') {
        handlers.refreshAll();
        return;
      }
      const { slot } = event;
      if (slot.kind === 'root') handlers.refreshDirectory(plan.root);
      else if (slot.kind === 'selected') handlers.refreshSelectedFile();
      else {
        const target = plan.expandedPaths[slot.index];
        if (target) handlers.refreshDirectory(target);
      }
    };
    try {
      await watch(plan.scope, onEvent, controller.signal);
    } catch {
      // Network errors and timeouts retry below.
    }
    if (controller.signal.aborted) return;
    handlers.setWatching(false);
    if (terminal) return;
    retryTimer = timers.setTimeout(() => { void run(); }, backoff.next());
  };

  void run();
  return () => {
    controller.abort();
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };
};

export type FilesStatSnapshot = { path: string; size: number; mtimeMs?: number; ctimeMs?: number };

/**
 * Decide what a fresh stat of the selected file means. A dirty buffer is never
 * replaced; the change is picked up once the buffer is clean or saved.
 */
export const classifySelectedFileStat = (input: {
  previous: FilesStatSnapshot | null;
  latest: FilesStatSnapshot;
  selectedPath: string;
  isDirty: boolean;
}): 'record' | 'reload' | 'unchanged' | 'dirty' => {
  const { previous, latest } = input;
  if (!previous || previous.path !== input.selectedPath) return 'record';
  const changedByMtime = latest.mtimeMs !== undefined && previous.mtimeMs !== undefined && latest.mtimeMs !== previous.mtimeMs;
  const changedBySize = latest.size !== previous.size;
  const changedByCtime = latest.ctimeMs !== undefined && previous.ctimeMs !== undefined && latest.ctimeMs !== previous.ctimeMs;
  if (!changedByMtime && !changedBySize && !changedByCtime) return 'unchanged';
  return input.isDirty ? 'dirty' : 'reload';
};

import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import React, { lazy } from 'react';

declare const __APP_VERSION__: string | undefined;

const RELOAD_STORAGE_KEY = 'openchamber:chunk-import-reload';
const RETRY_DELAY_MS = 250;
const RELOAD_GUARD_MS = 30_000;

export class ChunkLoadTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Settings failed to load within ${timeoutMs}ms`);
    this.name = 'ChunkLoadTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

interface ChunkRecoveryOptions {
  retries?: number;
  timeoutMs?: number;
}

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Loading chunk \S+ failed/i,
  /ChunkLoadError/i,
];

function readErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}\n${error.stack ?? ''}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isDynamicImportError(error: unknown): boolean {
  const text = readErrorText(error);
  return DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function reloadMarkerSignature(error: unknown): string {
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  const identity = error instanceof Error
    ? `${error.name}\n${error.message}`
    : readErrorText(error);
  return `${appVersion || 'unknown'}:${identity.slice(0, 500)}`;
}

function scheduleReloadOnce(error: unknown): void {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const signature = reloadMarkerSignature(error);

  let marker: { signature?: unknown; timestamp?: unknown } | null = null;
  try {
    const rawMarker = getSafeSessionStorage().getItem(RELOAD_STORAGE_KEY);
    if (rawMarker) {
      try {
        marker = JSON.parse(rawMarker) as { signature?: unknown; timestamp?: unknown };
      } catch {
        marker = null;
      }
    }
  } catch {
    return;
  }

  const markerTimestamp = typeof marker?.timestamp === 'number' ? marker.timestamp : 0;
  if (marker?.signature === signature && now - markerTimestamp < RELOAD_GUARD_MS) {
    return;
  }

  try {
    getSafeSessionStorage().setItem(RELOAD_STORAGE_KEY, JSON.stringify({ signature, timestamp: now }));
  } catch {
    return;
  }

  window.setTimeout(() => {
    window.location.reload();
  }, 0);
}

function loadWithOptionalTimeout<T>(load: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return load();
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ChunkLoadTimeoutError(timeoutMs)), timeoutMs);
    load().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function importWithChunkRecovery<T>(
  load: () => Promise<T>,
  options: ChunkRecoveryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await loadWithOptionalTimeout(load, options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (error instanceof ChunkLoadTimeoutError) {
        break;
      }
      if (!isDynamicImportError(error) || attempt >= retries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  if (isDynamicImportError(lastError)) {
    scheduleReloadOnce(lastError);
  }

  throw lastError;
}

export const lazyWithChunkRecovery: typeof lazy = (load) => lazy(() => importWithChunkRecovery(load));

export function retryableLazyWithChunkRecovery<Props extends object>(
  load: () => Promise<{ default: React.ComponentType<Props> }>,
  options: ChunkRecoveryOptions = {},
): React.ComponentType<Props> {
  type LoadStatus = 'pending' | 'resolved' | 'rejected';

  let loadStatus: LoadStatus;
  let LazyComponent: React.LazyExoticComponent<React.ComponentType<Props>>;

  const createLazyComponent = () => {
    loadStatus = 'pending';
    return lazy(() => importWithChunkRecovery(load, options).then(
      (module) => {
        loadStatus = 'resolved';
        return module;
      },
      (error: unknown) => {
        loadStatus = 'rejected';
        throw error;
      },
    ));
  };

  // Keep one lazy payload stable while it is pending. Creating React.lazy in a
  // component instance or hook initializer can suspend before that component
  // commits, causing React to recreate the payload on every retry and leave the
  // UI on its loading fallback forever. A rejected payload is replaced only
  // when an error boundary renders this wrapper again after a user retry.
  LazyComponent = createLazyComponent();

  const RetryableLazyComponent: React.FC<Props> = (props) => {
    if (loadStatus === 'rejected') {
      LazyComponent = createLazyComponent();
    }

    return React.createElement(LazyComponent, props);
  };

  RetryableLazyComponent.displayName = 'RetryableLazyComponent';
  return RetryableLazyComponent;
}

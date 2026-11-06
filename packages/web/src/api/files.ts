import type {
  DirectoryListResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
  FileStatResult,
  FileReadResult,
  FileWriteOptions,
  FileWriteResult,
  FileWatchEvent,
  FileWatchScope,
  FileWatchSlot,
} from '@devryan/ui/lib/api/types';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');

type WebDirectoryEntry = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
};

type WebDirectoryListResponse = {
  directory?: string;
  path?: string;
  entries?: WebDirectoryEntry[];
};

const applyFileReadOptions = (params: URLSearchParams, options?: {
  allowOutsideWorkspace?: boolean;
  optional?: boolean;
  directory?: string;
}) => {
  if (options?.allowOutsideWorkspace) {
    params.set('allowOutsideWorkspace', 'true');
  }
  if (options?.optional) {
    params.set('optional', 'true');
  }
  if (options?.directory) {
    params.set('directory', normalizePath(options.directory));
  }
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const toDirectoryListResult = (fallbackDirectory: string, payload: WebDirectoryListResponse): DirectoryListResult => {
  const directory = normalizePath(payload?.directory || payload?.path || fallbackDirectory);
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];

  return {
    directory,
    entries: entries
      .filter((entry): entry is Required<Pick<WebDirectoryEntry, 'name' | 'path'>> & { isDirectory?: boolean } =>
        Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      )
      .map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
      })),
  };
};

// Mirrors the server's per-subscription limit; a larger scope keeps polling.
const FILE_WATCH_MAX_DIRECTORIES = 64;
const FILE_WATCH_MAX_URL_LENGTH = 8 * 1024;
// The server sends a heartbeat every 15 s.
const FILE_WATCH_TIMEOUT_MS = 45_000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseFileWatchSlot = (value: unknown): FileWatchSlot | null => {
  if (!isRecord(value)) return null;
  if (value.kind === 'root') return { kind: 'root' };
  if (value.kind === 'selected') return { kind: 'selected' };
  if (value.kind === 'expanded' && typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0) {
    return { kind: 'expanded', index: value.index };
  }
  return null;
};

export const parseFileWatchEvent = (raw: string): FileWatchEvent | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch)) return null;
  const { epoch } = value;
  switch (value.type) {
    case 'ready':
      return { type: 'ready', epoch };
    case 'resync':
      return { type: 'resync', epoch };
    case 'unavailable':
      return { type: 'unavailable', epoch, retryable: value.retryable === true };
    case 'invalidate': {
      const slot = parseFileWatchSlot(value.slot);
      return slot ? { type: 'invalidate', epoch, slot } : null;
    }
    default:
      return null;
  }
};

const parentRelativePath = (relativePath: string): string => {
  const index = relativePath.lastIndexOf('/');
  return index < 0 ? '' : relativePath.slice(0, index);
};

const buildFileWatchUrl = (scope: FileWatchScope): string | null => {
  const params = new URLSearchParams({ directory: normalizePath(scope.directory) });
  const directories = new Set<string>(['']);
  for (const entry of scope.expandedDirectories) {
    const relative = normalizePath(entry);
    params.append('expanded', relative);
    directories.add(relative);
  }
  if (scope.selectedFile) {
    const selected = normalizePath(scope.selectedFile);
    params.set('selected', selected);
    directories.add(parentRelativePath(selected));
  }
  const url = `/api/fs/watch?${params.toString()}`;
  return directories.size > FILE_WATCH_MAX_DIRECTORIES || url.length > FILE_WATCH_MAX_URL_LENGTH ? null : url;
};

// Same-origin cookie-authenticated fetch (not EventSource), so the caller's
// AbortSignal owns the stream and the server can reject a scope with a status.
const watchFiles = async (
  scope: FileWatchScope,
  onEvent: (event: FileWatchEvent) => void,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return;
  const url = buildFileWatchUrl(scope);
  if (!url) {
    onEvent({ type: 'unavailable', epoch: 0, retryable: false });
    return;
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FILE_WATCH_TIMEOUT_MS);
  };
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  resetTimer();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel().catch(() => {});
      onEvent({ type: 'unavailable', epoch: 0, retryable: false });
      return;
    }
    if (!response.ok || !response.body) {
      throw new Error(`File watch failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetTimer();
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        const event = data ? parseFileWatchEvent(data) : null;
        if (event && !signal.aborted) onEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    if (timedOut) throw new Error('File watch timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
};

export const createWebFilesAPI = (): FilesAPI => ({
  watch: watchFiles,

  async listDirectory(path: string): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams();
    if (target) {
      params.set('path', target);
    }

    const response = await fetch(`/api/fs/list${params.toString() ? `?${params.toString()}` : ''}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to list directory');
    }

    const result = (await response.json()) as WebDirectoryListResponse;
    return toDirectoryListResult(target, result);
  },

  async search(payload: FileSearchQuery): Promise<FileSearchResult[]> {
    const params = new URLSearchParams();

    const directory = normalizePath(payload.directory);
    if (directory) {
      params.set('directory', directory);
    }

    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');

    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }

    const response = await fetch(`/api/find/file?${params.toString()}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to search files');
    }

    const result = (await response.json()) as string[];
    const files = Array.isArray(result) ? result : [];

    return files.map((relativePath) => ({
      path: normalizePath(`${directory}/${relativePath}`),
      preview: [normalizePath(relativePath)],
    }));
  },

  async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await fetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to create directory');
    }

    const result = await response.json();
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizePath(result.path) : target,
    };
  },

  async statFile(path: string, options): Promise<FileStatResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    applyFileReadOptions(params, options);
    const response = await fetch(`/api/fs/stat?${params.toString()}`);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to stat file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
      exists: (result as { exists?: boolean }).exists !== false,
      isFile: Boolean((result as { isFile?: boolean }).isFile),
      size: typeof (result as { size?: number }).size === 'number' ? (result as { size: number }).size : 0,
      ctimeMs: typeof result.ctimeMs === 'number' ? result.ctimeMs : undefined,
      mtimeMs: typeof (result as { mtimeMs?: number }).mtimeMs === 'number' ? (result as { mtimeMs: number }).mtimeMs : undefined,
    };
  },

  async readFile(path: string, options): Promise<FileReadResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    applyFileReadOptions(params, options);
    const response = await fetch(`/api/fs/read?${params.toString()}`, {
      cache: options?.optional ? 'no-store' : 'default',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }

    const content = await response.text();
    return { content, path: target, version: response.headers.get('X-DevRyan-File-Version') ?? undefined,
      complete: response.headers.get('X-DevRyan-File-Complete') === '1' };
  },

  async readFileBinary(path: string, options): Promise<{ dataUrl: string; path: string }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    applyFileReadOptions(params, options);
    const response = await fetch(`/api/fs/raw?${params.toString()}`, {
      cache: options?.optional ? 'no-store' : 'default',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }

    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();
    return {
      dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
      path: target,
    };
  },

  async writeFile(path: string, content: string, options?: FileWriteOptions): Promise<FileWriteResult> {
    const target = normalizePath(path);
    const response = await fetch('/api/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, content, expectedVersion: options?.expectedVersion }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw Object.assign(new Error((error as { error?: string }).error || 'Failed to write file'),
        { code: typeof error.code === 'string' ? error.code : undefined });
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      version: typeof result.version === 'string' ? result.version : undefined,
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await fetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to delete file');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const response = await fetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPath, newPath }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to rename file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await fetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async downloadFile(path: string, options): Promise<void> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target, download: 'true' });
    applyFileReadOptions(params, options);
    const url = `/api/fs/raw?${params.toString()}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = target.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
});

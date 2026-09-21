import type {
  DirectoryListResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
  FileStatResult,
  FileReadResult,
  FileWriteOptions,
  FileWriteResult,
} from '@openchamber/ui/lib/api/types';

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

export const createWebFilesAPI = (): FilesAPI => ({
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

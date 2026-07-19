import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { createProjectIdFromPath } from '@/lib/projectId';

export interface SessionPlanFileIdentity {
  projectPath: string;
  sessionCreated: number;
  sessionSlug: string;
  sourceMessageId: string;
}

export interface SessionPlanFileStorage {
  resolveHomeDirectory(): Promise<string | null>;
  statFile(path: string): Promise<{ exists: boolean; isFile: boolean }>;
  createDirectory(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface EnsureSessionPlanFileOptions {
  identity: SessionPlanFileIdentity;
  markdown: string;
  storage?: SessionPlanFileStorage;
}

const pendingWrites = new Map<string, Promise<{ path: string; created: boolean }>>();

const normalizePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized || (value.trim().startsWith('/') ? '/' : '');
};

const joinPath = (base: string, segment: string): string => {
  const normalizedBase = normalizePath(base);
  const normalizedSegment = segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (normalizedBase === '/') return `/${normalizedSegment}`;
  return `${normalizedBase}/${normalizedSegment}`;
};

export const sanitizePlanPathSegment = (value: string): string => {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\.+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export const buildSessionPlanFilePath = (
  homeDirectory: string,
  identity: SessionPlanFileIdentity,
): string => {
  const home = normalizePath(homeDirectory);
  const projectPath = normalizePath(identity.projectPath);
  const projectId = sanitizePlanPathSegment(createProjectIdFromPath(projectPath));
  const sessionSlug = sanitizePlanPathSegment(identity.sessionSlug);
  const sourceMessageId = sanitizePlanPathSegment(identity.sourceMessageId);
  const sessionCreated = Number.isFinite(identity.sessionCreated)
    ? Math.max(0, Math.trunc(identity.sessionCreated))
    : 0;

  if (!home || !projectId || !sessionSlug || !sourceMessageId || sessionCreated === 0) {
    throw new Error('Plan file identity is incomplete');
  }

  const projectsDirectory = joinPath(joinPath(joinPath(home, '.config'), 'openchamber'), 'projects');
  const plansDirectory = joinPath(joinPath(projectsDirectory, projectId), 'plans');
  return joinPath(plansDirectory, `${sessionCreated}-${sessionSlug}-${sourceMessageId}.md`);
};

const getBaseUrl = (): string => {
  const base = import.meta.env.VITE_OPENCODE_URL || '/api';
  return base.endsWith('/') ? base.slice(0, -1) : base;
};

const getRuntimeFiles = (): FilesAPI | null => {
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs };
  return runtimeWindow.__OPENCHAMBER_RUNTIME_APIS__?.files ?? null;
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const message = typeof payload?.error === 'string' ? payload.error : response.statusText;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
};

const runtimeStorage: SessionPlanFileStorage = {
  async resolveHomeDirectory() {
    const payload = await fetchJson<{ home?: unknown }>(`${getBaseUrl()}/fs/home`, { cache: 'no-store' });
    return typeof payload.home === 'string' && payload.home.trim() ? normalizePath(payload.home) : null;
  },

  async statFile(path) {
    const files = getRuntimeFiles();
    if (files?.statFile) {
      const result = await files.statFile(path, { optional: true, allowOutsideWorkspace: true });
      return { exists: result.exists, isFile: result.isFile };
    }

    const query = new URLSearchParams({ path, optional: 'true', allowOutsideWorkspace: 'true' });
    const result = await fetchJson<{ exists?: boolean; isFile?: boolean }>(
      `${getBaseUrl()}/fs/stat?${query.toString()}`,
      { cache: 'no-store' },
    );
    return { exists: result.exists === true, isFile: result.isFile === true };
  },

  async createDirectory(path) {
    const files = getRuntimeFiles();
    if (files?.createDirectory) {
      const result = await files.createDirectory(path);
      if (!result.success) throw new Error('Failed to create plan directory');
      return;
    }

    await fetchJson(`${getBaseUrl()}/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },

  async writeFile(path, content) {
    const files = getRuntimeFiles();
    if (files?.writeFile) {
      const result = await files.writeFile(path, content);
      if (!result.success) throw new Error('Failed to save plan file');
      return;
    }

    await fetchJson(`${getBaseUrl()}/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
  },
};

export const ensureSessionPlanFile = async ({
  identity,
  markdown,
  storage = runtimeStorage,
}: EnsureSessionPlanFileOptions): Promise<{ path: string; created: boolean }> => {
  if (!markdown.trim()) {
    throw new Error('Completed plan Markdown is required');
  }

  const homeDirectory = await storage.resolveHomeDirectory();
  if (!homeDirectory) {
    throw new Error('Unable to resolve the home directory for plan storage');
  }

  const filePath = buildSessionPlanFilePath(homeDirectory, identity);
  const existing = pendingWrites.get(filePath);
  if (existing) return existing;

  const operation = (async () => {
    const stat = await storage.statFile(filePath);
    if (stat.exists) {
      if (!stat.isFile) throw new Error('The canonical plan path is not a file');
      return { path: filePath, created: false };
    }

    const plansDirectory = filePath.slice(0, filePath.lastIndexOf('/'));
    await storage.createDirectory(plansDirectory);
    await storage.writeFile(filePath, markdown);
    return { path: filePath, created: true };
  })();

  pendingWrites.set(filePath, operation);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(filePath) === operation) {
      pendingWrites.delete(filePath);
    }
  }
};

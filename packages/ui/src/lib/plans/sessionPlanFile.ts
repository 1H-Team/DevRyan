import { createProjectIdFromPath } from '@/lib/projectId';
import { resolvePlanProjectStorageId } from '../../../../shared-runtime/lib/plan-storage-id.js';

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
  storage: SessionPlanFileStorage;
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

export const buildSessionPlanFilePath = async (
  homeDirectory: string,
  identity: SessionPlanFileIdentity,
): Promise<string> => {
  const home = normalizePath(homeDirectory);
  const projectPath = normalizePath(identity.projectPath);
  const projectId = await resolvePlanProjectStorageId(sanitizePlanPathSegment(createProjectIdFromPath(projectPath)));
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

export const ensureSessionPlanFile = async ({
  identity,
  markdown,
  storage,
}: EnsureSessionPlanFileOptions): Promise<{ path: string; created: boolean }> => {
  if (!markdown.trim()) {
    throw new Error('Completed plan Markdown is required');
  }

  const homeDirectory = await storage.resolveHomeDirectory();
  if (!homeDirectory) {
    throw new Error('Unable to resolve the home directory for plan storage');
  }

  const filePath = await buildSessionPlanFilePath(homeDirectory, identity);
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

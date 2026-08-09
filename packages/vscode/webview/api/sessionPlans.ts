import type { FilesAPI, SessionPlansAPI } from '@openchamber/ui/lib/api/types';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

const normalizePath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized || (value.trim().startsWith('/') ? '/' : '');
};

const sanitizePlanPathSegment = (value: string): string => value
  .trim()
  .replace(/[\\/]+/g, '-')
  .replace(/\.+/g, '-')
  .replace(/[^A-Za-z0-9_-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const createProjectIdFromPath = (projectPath: string): string => {
  const normalized = normalizePath(projectPath);
  if (!normalized) return '';
  const data = new TextEncoder().encode(normalized);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `path_${encoded}`;
};

const buildSessionPlanFilePath = (
  homeDirectory: string,
  input: Parameters<SessionPlansAPI['readRevision']>[0],
): string => {
  const directory = normalizePath(input.directory);
  const created = Number(input.sessionCreated);
  const projectID = sanitizePlanPathSegment(createProjectIdFromPath(input.directory));
  const sessionSlug = sanitizePlanPathSegment(input.sessionSlug);
  const sessionID = input.sessionId.trim();
  const sourceMessageID = input.sourceMessageId.trim();
  const isAbsoluteDirectory = directory.startsWith('/')
    || directory.startsWith('//')
    || /^[A-Za-z]:\//.test(directory);
  if (
    !SESSION_ID_PATTERN.test(sessionID)
    || !SESSION_ID_PATTERN.test(sourceMessageID)
    || !isAbsoluteDirectory
    || !projectID
    || !sessionSlug
    || !Number.isFinite(created)
    || created <= 0
    || Math.trunc(created) !== created
  ) {
    throw new Error('Plan file identity is incomplete');
  }
  return `${normalizePath(homeDirectory)}/.config/openchamber/projects/${projectID}/plans/${created}-${sessionSlug}-${sourceMessageID}.md`;
};

const resolveHomeDirectory = async (): Promise<string> => {
  if (typeof window.__OPENCHAMBER_HOME__ === 'string' && window.__OPENCHAMBER_HOME__.trim()) {
    return window.__OPENCHAMBER_HOME__.trim();
  }
  const response = await fetch('/api/fs/home', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to resolve the home directory for plan storage');
  const payload = await response.json() as { home?: unknown };
  if (typeof payload.home !== 'string' || !payload.home.trim()) {
    throw new Error('Unable to resolve the home directory for plan storage');
  }
  return payload.home.trim();
};

export const createVSCodeSessionPlansAPI = (files: FilesAPI): SessionPlansAPI => {
  const resolvePath = async (input: Parameters<SessionPlansAPI['readRevision']>[0]) => (
    buildSessionPlanFilePath(await resolveHomeDirectory(), input)
  );

  return {
    async ensureRevision(input) {
      const filePath = await resolvePath(input);
      const stat = await files.statFile?.(filePath, { optional: true, allowOutsideWorkspace: true });
      if (stat?.exists) {
        if (!stat.isFile) throw new Error('The canonical plan path is not a file');
        return { path: filePath, created: false };
      }
      const plansDirectory = filePath.slice(0, filePath.lastIndexOf('/'));
      const created = await files.createDirectory(plansDirectory);
      if (!created.success) throw new Error('Failed to create plan directory');
      const written = await files.writeFile?.(filePath, input.markdown);
      if (!written?.success) throw new Error('Failed to save plan file');
      return { path: filePath, created: true };
    },

    async readRevision(input) {
      const filePath = await resolvePath(input);
      const result = await files.readFile?.(filePath, { allowOutsideWorkspace: true });
      if (!result) throw new Error('Plan revision could not be read');
      return { path: filePath, content: result.content };
    },

    async updateRevision(input) {
      const filePath = await resolvePath(input);
      const stat = await files.statFile?.(filePath, { optional: true, allowOutsideWorkspace: true });
      if (!stat?.exists || !stat.isFile) throw new Error('Plan revision not found');
      const result = await files.writeFile?.(filePath, input.markdown);
      if (!result?.success) throw new Error('Failed to update plan revision');
      return { path: filePath, saved: true };
    },
  };
};

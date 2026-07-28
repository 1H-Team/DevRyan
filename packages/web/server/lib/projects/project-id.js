import os from 'node:os';
import path from 'node:path';

const normalizeProjectPathForId = (value) => {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '') || value;
};

export const createProjectIdFromPath = (projectPath) => {
  const normalized = normalizeProjectPathForId(projectPath).trim();
  if (!normalized) {
    return '';
  }

  return `path_${Buffer.from(normalized, 'utf8').toString('base64url')}`;
};

export const resolveProjectPlansDirectory = (projectPath, homeDirectory = os.homedir()) => {
  const projectID = createProjectIdFromPath(projectPath);
  const normalizedHome = typeof homeDirectory === 'string' ? homeDirectory.trim() : '';
  if (!projectID || !normalizedHome) {
    return '';
  }

  return path.join(
    path.resolve(normalizedHome),
    '.config',
    'openchamber',
    'projects',
    projectID,
    'plans',
  );
};

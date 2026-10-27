import os from 'node:os';
import path from 'node:path';
import { resolvePlanProjectStorageId } from '@devryan/shared-runtime/lib/plan-storage-id.js';
import { resolveDevRyanDataRoot } from '@devryan/shared-runtime/node/data-root.js';

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

export const resolveProjectPlansDirectory = async (projectPath, homeDirectory = os.homedir()) => {
  const projectID = await resolvePlanProjectStorageId(createProjectIdFromPath(projectPath));
  const normalizedHome = typeof homeDirectory === 'string' ? homeDirectory.trim() : '';
  if (!projectID || !normalizedHome) {
    return '';
  }

  return path.join(
    resolveDevRyanDataRoot({ env: {}, home: path.resolve(normalizedHome) }),
    'projects',
    projectID,
    'plans',
  );
};

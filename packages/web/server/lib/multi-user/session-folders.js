const MAX_SESSION_FOLDERS_BYTES = 4 * 1024 * 1024;
const MAX_SCOPES = 200;
const MAX_FOLDERS_PER_SCOPE = 1_000;
const MAX_SESSIONS_PER_FOLDER = 10_000;
const MAX_COLLAPSED_FOLDERS = 10_000;

export const emptySessionFolders = () => ({
  version: 1,
  foldersMap: {},
  collapsedFolderIds: [],
  updatedAt: 0,
});

const invalidPayload = (message) => Object.assign(new Error(message), { statusCode: 400 });

const requiredString = (value, label, maxLength) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw invalidPayload(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
};

export const normalizeSessionFoldersPayload = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPayload('Session folders payload must be an object');
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FOLDERS_BYTES) {
    throw Object.assign(new Error('Session folders payload is too large'), { statusCode: 413 });
  }
  if (value.version !== 1) throw invalidPayload('Unsupported session folders version');
  if (!value.foldersMap || typeof value.foldersMap !== 'object' || Array.isArray(value.foldersMap)) {
    throw invalidPayload('foldersMap must be an object');
  }
  if (!Array.isArray(value.collapsedFolderIds)) {
    throw invalidPayload('collapsedFolderIds must be an array');
  }

  const scopeEntries = Object.entries(value.foldersMap);
  if (scopeEntries.length > MAX_SCOPES) throw invalidPayload('Too many session folder scopes');
  const foldersMap = {};
  for (const [scopeKey, folders] of scopeEntries) {
    requiredString(scopeKey, 'Session folder scope', 1_024);
    if (!Array.isArray(folders) || folders.length > MAX_FOLDERS_PER_SCOPE) {
      throw invalidPayload('Each session folder scope must contain a bounded folder array');
    }
    foldersMap[scopeKey] = folders.map((folder) => {
      if (!folder || typeof folder !== 'object' || Array.isArray(folder)) {
        throw invalidPayload('Each session folder must be an object');
      }
      if (!Array.isArray(folder.sessionIds) || folder.sessionIds.length > MAX_SESSIONS_PER_FOLDER) {
        throw invalidPayload('Each session folder must contain a bounded sessionIds array');
      }
      const createdAt = Number(folder.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < 0) {
        throw invalidPayload('Session folder createdAt must be a non-negative number');
      }
      const normalized = {
        id: requiredString(folder.id, 'Session folder id', 256),
        name: requiredString(folder.name, 'Session folder name', 512),
        sessionIds: folder.sessionIds.map((sessionId) => requiredString(sessionId, 'Session id', 512)),
        createdAt,
      };
      if (folder.parentId !== undefined && folder.parentId !== null) {
        normalized.parentId = requiredString(folder.parentId, 'Session folder parent id', 256);
      } else if (folder.parentId === null) {
        normalized.parentId = null;
      }
      return normalized;
    });
  }

  if (value.collapsedFolderIds.length > MAX_COLLAPSED_FOLDERS) {
    throw invalidPayload('Too many collapsed session folders');
  }
  const updatedAt = Number(value.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) {
    throw invalidPayload('Session folders updatedAt must be a non-negative number');
  }

  return {
    version: 1,
    foldersMap,
    collapsedFolderIds: [...new Set(value.collapsedFolderIds.map(
      (folderId) => requiredString(folderId, 'Collapsed session folder id', 256),
    ))],
    updatedAt,
  };
};

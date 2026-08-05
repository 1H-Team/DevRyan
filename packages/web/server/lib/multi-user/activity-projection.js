import path from 'node:path';

const TOOL_ACTIONS = Object.freeze({
  pending: 'tool.requested',
  running: 'tool.started',
  completed: 'tool.completed',
  error: 'tool.failed',
});

const PATH_KEYS = new Set(['path', 'file', 'filepath', 'files', 'oldpath', 'newpath']);

const isContained = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const relativeProjectPath = (assignment, value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192) return null;
  const candidate = value.trim();
  if (candidate === assignment.publicDirectory) return '.';
  if (candidate.startsWith(`${assignment.publicDirectory}/`)) {
    const relative = path.posix.normalize(candidate.slice(assignment.publicDirectory.length + 1));
    return relative === '..' || relative.startsWith('../') ? null : relative.slice(0, 1_024);
  }
  if (path.isAbsolute(candidate)) {
    if (!isContained(assignment.repositoryPath, candidate)) return null;
    return (path.relative(assignment.repositoryPath, candidate).split(path.sep).join('/') || '.').slice(0, 1_024);
  }
  const relative = path.posix.normalize(candidate.split(path.sep).join('/'));
  return relative === '..' || relative.startsWith('../') ? null : relative.slice(0, 1_024);
};

const collectPaths = (assignment, value, parentKey = '', result = new Set(), depth = 0) => {
  if (depth > 8 || result.size >= 100 || value === null || value === undefined) return result;
  if (typeof value === 'string') {
    if (PATH_KEYS.has(parentKey.toLowerCase())) {
      const relative = relativeProjectPath(assignment, value);
      if (relative) result.add(relative);
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPaths(assignment, entry, parentKey, result, depth + 1);
    return result;
  }
  if (typeof value !== 'object') return result;
  for (const [key, entry] of Object.entries(value)) {
    collectPaths(assignment, entry, key, result, depth + 1);
  }
  return result;
};

const sessionIdFromPayload = (payload) => {
  const candidates = [
    payload?.properties?.sessionID,
    payload?.properties?.sessionId,
    payload?.properties?.part?.sessionID,
    payload?.properties?.part?.sessionId,
    payload?.properties?.info?.sessionID,
    payload?.properties?.info?.sessionId,
  ];
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
};

export const projectOpenCodeActivity = ({ payload, ownership, assignment } = {}) => {
  if (!payload || !ownership || !assignment) return null;
  const sessionId = sessionIdFromPayload(payload);
  if (!sessionId || sessionId !== ownership.session_id) return null;

  if (payload.type === 'message.part.updated') {
    const part = payload.properties?.part;
    if (!part || part.type !== 'tool') return null;
    const status = typeof part.state?.status === 'string' ? part.state.status.toLowerCase() : '';
    const action = TOOL_ACTIONS[status];
    const partId = typeof part.id === 'string' ? part.id.trim() : '';
    const tool = typeof part.tool === 'string' ? part.tool.trim().slice(0, 160) : '';
    if (!action || !partId || !tool) return null;
    const paths = [...collectPaths(assignment, part.state?.input)];
    return {
      dedupeKey: `tool:${sessionId}:${partId}:${status}`,
      action,
      details: {
        targetType: 'tool',
        targetId: partId,
        projectId: ownership.project_id,
        sessionId,
        success: status !== 'error',
        metadata: {
          tool,
          status,
          branch: ownership.branch_name,
          ...(paths.length > 0 ? { paths } : {}),
        },
      },
    };
  }

  if (payload.type === 'session.diff') {
    const paths = [...collectPaths(assignment, payload.properties?.diff, 'files')].sort();
    if (paths.length === 0) return null;
    return {
      dedupeKey: `files:${sessionId}:${paths.join('\u0000')}`,
      action: 'file.change_summary',
      details: {
        targetType: 'session', targetId: sessionId, projectId: ownership.project_id, sessionId,
        metadata: { branch: ownership.branch_name, paths },
      },
    };
  }

  if (['file.edited', 'file.changed', 'file.watcher.updated'].includes(payload.type)) {
    const paths = [...collectPaths(assignment, payload.properties, 'files')].sort();
    if (paths.length === 0) return null;
    return {
      dedupeKey: `file-event:${payload.type}:${sessionId}:${paths.join('\u0000')}`,
      action: 'file.changed',
      details: {
        targetType: 'session', targetId: sessionId, projectId: ownership.project_id, sessionId,
        metadata: { branch: ownership.branch_name, paths },
      },
    };
  }

  return null;
};

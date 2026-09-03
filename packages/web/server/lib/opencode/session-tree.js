// Session tree discovery for OpenCode sessions.
//
// A prompt's "session tree" is the root session plus every descendant
// sub-agent session (OpenCode `GET /session/:id/children`, recursively).
// Scoped revert, redo and the change summary all operate over that tree.

export const SESSION_TREE_MAX_DEPTH = 8;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Session tree lookup was aborted');
};

const encodeDirectoryQuery = (directory) => {
  const params = new URLSearchParams();
  params.set('directory', directory);
  return params.toString();
};

const requestJson = async ({ url, fetchImpl, getOpenCodeAuthHeaders, signal }) => {
  throwIfAborted(signal);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(getOpenCodeAuthHeaders?.() ?? {}) },
    signal,
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
};

const toSessionEntry = (session, { fallbackID, parentID, depth }) => ({
  id: typeof session?.id === 'string' && session.id.length > 0 ? session.id : fallbackID,
  parentID: typeof session?.parentID === 'string' && session.parentID.length > 0 ? session.parentID : (parentID ?? null),
  title: typeof session?.title === 'string' ? session.title : '',
  time: isObject(session?.time) ? session.time : null,
  projectID: typeof session?.projectID === 'string' ? session.projectID : null,
  revert: isObject(session?.revert) ? session.revert : null,
  depth,
});

/**
 * Lists the session tree rooted at `sessionID`: `[root, ...descendants]` in
 * breadth-first order. Every entry is `{ id, parentID, title, time, projectID,
 * revert, depth }`.
 *
 * - Descendants are discovered with `GET /session/:id/children`, at most
 *   `maxDepth` levels deep (default 8).
 * - A 404 on the root keeps a synthesized root entry (older OpenCode builds and
 *   test stubs may not expose `GET /session/:id`); a 404 on a children lookup
 *   skips that branch. Any other failure is surfaced because a partial tree
 *   would silently violate the tree-scoped revert rule.
 * - A cycle guard ignores sessions that were already visited.
 */
export const listSessionTree = async ({
  sessionID,
  directory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  signal,
  maxDepth = SESSION_TREE_MAX_DEPTH,
}) => {
  if (typeof sessionID !== 'string' || sessionID.length === 0) {
    throw new Error('sessionID is required to list a session tree');
  }
  const query = encodeDirectoryQuery(directory);
  const rootResult = await requestJson({
    url: buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}?${query}`, ''),
    fetchImpl,
    getOpenCodeAuthHeaders,
    signal,
  });
  if (!rootResult.ok && rootResult.status !== 404) {
    throw new Error(`Cannot load session ${sessionID} (status ${rootResult.status})`);
  }

  const root = toSessionEntry(rootResult.ok ? rootResult.payload : null, {
    fallbackID: sessionID,
    parentID: null,
    depth: 0,
  });
  const entries = [root];
  const visited = new Set([root.id]);
  const depthLimit = Math.max(0, Number.isFinite(maxDepth) ? Math.floor(maxDepth) : SESSION_TREE_MAX_DEPTH);
  let frontier = [root];

  while (frontier.length > 0 && frontier[0].depth < depthLimit) {
    throwIfAborted(signal);
    const childLists = await Promise.all(frontier.map(async (parent) => {
      const result = await requestJson({
        url: buildOpenCodeUrl(`/session/${encodeURIComponent(parent.id)}/children?${query}`, ''),
        fetchImpl,
        getOpenCodeAuthHeaders,
        signal,
      });
      if (result.status === 404) return [];
      if (!result.ok) {
        throw new Error(`Cannot list children of session ${parent.id} (status ${result.status})`);
      }
      return Array.isArray(result.payload) ? result.payload : [];
    }));

    const next = [];
    for (let index = 0; index < frontier.length; index += 1) {
      const parent = frontier[index];
      for (const child of childLists[index]) {
        const childID = typeof child?.id === 'string' ? child.id : '';
        if (!childID || visited.has(childID)) continue;
        visited.add(childID);
        const entry = toSessionEntry(child, { fallbackID: childID, parentID: parent.id, depth: parent.depth + 1 });
        entries.push(entry);
        next.push(entry);
      }
    }
    frontier = next;
  }

  return entries;
};

/**
 * Returns the OpenCode session status map for a directory:
 * `{ [sessionID]: { type: 'idle' | 'busy' | 'retry', ... } }`.
 * A 404 (endpoint unavailable) yields an empty map.
 */
export const listSessionStatuses = async ({
  directory,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  signal,
}) => {
  const result = await requestJson({
    url: buildOpenCodeUrl(`/session/status?${encodeDirectoryQuery(directory)}`, ''),
    fetchImpl,
    getOpenCodeAuthHeaders,
    signal,
  });
  if (result.status === 404) return {};
  if (!result.ok) {
    throw new Error(`Cannot read session status (status ${result.status})`);
  }
  if (!isObject(result.payload)) return {};
  const statuses = {};
  for (const [id, status] of Object.entries(result.payload)) {
    if (isObject(status) && typeof status.type === 'string') statuses[id] = status;
  }
  return statuses;
};

export const isActiveSessionStatus = (status) => status?.type === 'busy' || status?.type === 'retry';

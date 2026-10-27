// Session tree discovery for OpenCode sessions.
//
// A prompt's "session tree" is the root session plus every descendant
// sub-agent session (OpenCode `GET /session/:id/children`, recursively).
// Scoped revert, redo and the change summary all operate over that tree.
//
// With an `openCodeClient` on generation 2 the reads go through the client
// (`sessions.get`, `sessions.children`, `sessions.status`), which projects the
// 2.0.20 answers into the application records. Native identity is required.

import { isOpenCodeNotFoundError } from './opencode-client/index.js';
import { resolveOpenCodeGeneration } from './opencode-generation.js';

export const SESSION_TREE_MAX_DEPTH = 8;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Session tree lookup was aborted');
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

const clientStatus = (error) => (Number.isInteger(error?.statusCode) ? error.statusCode : 502);

const createV2TreeReaders = ({ openCodeClient, directory, signal }) => ({
  root: async (sessionID) => {
    throwIfAborted(signal);
    try {
      return await openCodeClient.sessions.get(sessionID, { directory, signal, allowNotFound: true });
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(`Cannot load session ${sessionID} (status ${clientStatus(error)})`, { cause: error });
    }
  },
  children: async (parentID) => {
    throwIfAborted(signal);
    try {
      const children = await openCodeClient.sessions.children(parentID, { directory, signal, allowNotFound: true });
      return Array.isArray(children) ? children : [];
    } catch (error) {
      throwIfAborted(signal);
      throw new Error(`Cannot list children of session ${parentID} (status ${clientStatus(error)})`, { cause: error });
    }
  },
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
 * - With `openCodeClient` on generation 2 the same reads go through the client;
 *   a client failure keeps the messages above, with the client's status.
 */
export const listSessionTree = async ({
  sessionID,
  directory,
  openCodeClient,
  signal,
  maxDepth = SESSION_TREE_MAX_DEPTH,
}) => {
  if (typeof sessionID !== 'string' || sessionID.length === 0) {
    throw new Error('sessionID is required to list a session tree');
  }
  resolveOpenCodeGeneration(openCodeClient);
  const readers = createV2TreeReaders({ openCodeClient, directory, signal });
  const rootPayload = await readers.root(sessionID);

  const root = toSessionEntry(rootPayload, {
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
    const childLists = await Promise.all(frontier.map((parent) => readers.children(parent.id)));

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

const normalizeStatuses = (payload) => {
  if (!isObject(payload)) return {};
  const statuses = {};
  for (const [id, status] of Object.entries(payload)) {
    if (isObject(status) && typeof status.type === 'string') statuses[id] = status;
  }
  return statuses;
};

/**
 * Returns the OpenCode session status map for a directory:
 * `{ [sessionID]: { type: 'idle' | 'busy' | 'retry', ... } }`.
 * A 404 (endpoint unavailable) yields an empty map. On generation 2 (with
 * `openCodeClient`) the map lists only busy and retrying sessions: an absent
 * entry is idle.
 */
export const listSessionStatuses = async ({
  directory,
  openCodeClient,
  signal,
}) => {
  resolveOpenCodeGeneration(openCodeClient);
  {
    throwIfAborted(signal);
    let payload;
    try {
      payload = await openCodeClient.sessions.status({ directory }, { signal });
    } catch (error) {
      throwIfAborted(signal);
      if (isOpenCodeNotFoundError(error)) return {};
      throw new Error(`Cannot read session status (status ${clientStatus(error)})`, { cause: error });
    }
    return normalizeStatuses(payload);
  }

};

export const isActiveSessionStatus = (status) => status?.type === 'busy' || status?.type === 'retry';

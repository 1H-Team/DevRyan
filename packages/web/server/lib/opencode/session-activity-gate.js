import crypto from 'node:crypto';

const conflict = (code) => Object.assign(new Error(code), { code, status: 409, retryable: true });

/** Process-local admission, separate from the durable mutation ledger. An
 * accepted activity owns its reservation until settlement, not HTTP response. */
export function createSessionActivityGate() {
  const active = new Map(), held = new Set(), clients = new Map(), connections = new Map();
  const assert = (ids) => { if (ids.some((id) => held.has(id))) throw conflict('session_retention_in_progress'); };
  const enter = (ids) => {
    ids = [...new Set(ids.filter(Boolean))]; assert(ids);
    for (const id of ids) active.set(id, (active.get(id) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      for (const id of ids) { const count = active.get(id) - 1; if (count) active.set(id, count); else active.delete(id); }
    };
  };
  return {
    enter, assert,
    async run(ids, action) { const leave = enter(ids); try { return await action(); } finally { leave(); } },
    hold(ids) {
      assert(ids);
      if (ids.some((id) => active.has(id))) throw conflict('session_active');
      for (const id of ids) held.add(id);
      let released = false;
      return () => { if (released) return; released = true; for (const id of ids) held.delete(id); };
    },
    select(clientID, sessionID, revision = 0, committed = false) {
      if (typeof clientID !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(clientID)) throw conflict('invalid_retention_client');
      const previous = clients.get(clientID);
      if (!Number.isSafeInteger(revision) || revision < 0 || previous && revision < previous.revision) throw conflict('selection_superseded');
      assert(sessionID ? [sessionID] : []);
      const ids = committed ? new Set() : new Set(previous?.ids);
      if (sessionID) ids.add(sessionID);
      clients.set(clientID, { revision, ids });
    },
    connect(req) {
      const url = new URL(req.originalUrl ?? req.url, 'http://localhost');
      const id = req.headers?.['x-devryan-client-id'] ?? url.searchParams.get('clientID');
      const connection = crypto.randomUUID(); connections.set(connection, typeof id === 'string' ? id : null);
      return () => connections.delete(connection);
    },
    selections() {
      const ids = new Set();
      for (const id of connections.values()) {
        if (!id || !clients.has(id)) throw conflict('client_selection_unknown');
        for (const sessionID of clients.get(id).ids) ids.add(sessionID);
      }
      // Keep acknowledged selections through reconnects. Stale entries are
      // conservative protection; no heartbeat timeout can erase a selection.
      for (const client of clients.values()) for (const id of client.ids) ids.add(id);
      return ids;
    },
  };
}

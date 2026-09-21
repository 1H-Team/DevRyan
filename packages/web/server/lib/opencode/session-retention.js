import express from 'express';
import path from 'node:path';

const DAY = 86_400_000;
const failure = (code) => Object.assign(new Error(code), { code, status: 409 });
const stamp = (session, archivedOnly) => archivedOnly ? session.time?.archived : session.time?.updated ?? session.time?.created;

export function retentionTrees(snapshot, { days, archivedOnly = false, protectedIDs = [], now = Date.now() }) {
  if (snapshot?.protocol !== 1 || snapshot.complete !== true || !Array.isArray(snapshot.sessions)) throw failure('session_tree_incomplete');
  const sessions = snapshot.sessions, byID = new Map();
  for (const session of sessions) {
    if (!session?.id || byID.has(session.id) || !path.isAbsolute(session.directory ?? '') || !Number.isFinite(session.time?.updated)) {
      throw failure('session_state_unknown');
    }
    byID.set(session.id, session);
  }
  const roots = new Map();
  for (const session of sessions) {
    const seen = new Set(); let root = session;
    while (root.parentID) {
      if (seen.has(root.id) || !byID.has(root.parentID)) throw failure('session_tree_incomplete');
      seen.add(root.id); root = byID.get(root.parentID);
    }
    const tree = roots.get(root.id) ?? []; tree.push(session); roots.set(root.id, tree);
  }
  const protectedSet = new Set(protectedIDs);
  for (const session of [...sessions].sort((a, b) => b.time.updated - a.time.updated).slice(0, 5)) protectedSet.add(session.id);
  const cutoff = now - days * DAY;
  return [...roots].map(([rootID, tree]) => {
    let reason;
    for (const session of tree) {
      if (protectedSet.has(session.id)) reason = 'protected_session';
      else if (session.share) reason = 'shared_session';
      // Unknown metadata may describe a managed owner. Fail conservatively.
      else if (session.metadata && Object.keys(session.metadata).length) reason = 'managed_session';
      else if (archivedOnly ? !session.time.archived : Boolean(session.time.archived)) reason = 'archive_policy';
      else if (!Number.isFinite(stamp(session, archivedOnly)) || stamp(session, archivedOnly) >= cutoff) reason = 'recent_session';
      if (reason) break;
    }
    return { rootID, tree, reason };
  });
}

/** Only a paired, exclusive runtime can prove admission and tree completeness.
 * The native hold outlives an HTTP response and fences durable session writes.
 * Every action is rechecked under both native and host activity holds. */
export function createSessionRetention(options) {
  let running = false;
  const request = async (directory, pathname, body) => {
    const url = new URL(options.buildOpenCodeUrl(pathname, '')); url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...options.getOpenCodeAuthHeaders(), ...(body === undefined ? {} : {
        'content-type': 'application/json', 'x-devryan-retention-token': await options.getControlToken(),
      }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw failure(response.status === 404 ? 'retention_unsupported' : 'retention_state_unavailable');
    const value = await response.json(); if (value?.error) throw failure(value.error); return value;
  };
  const control = (directory, body) => request(directory, '/session/retention-control', body);
  const run = async () => {
    const result = { action: 'archive', completed: [], skipped: [], failed: [] };
    const skip = (reason, id = null) => result.skipped.push({ id, reason });
    if (running) { skip('running'); return result; }
    running = true;
    try {
      let settings = await options.readSettings();
      if (!settings.autoDeleteEnabled) { skip('disabled'); return result; }
      result.action = settings.sessionRetentionAction === 'delete' ? 'delete' : 'archive';
      if (!options.isExclusive()) { skip('runtime_uncoordinated'); return result; }
      const directory = options.getDirectory();
      if (!path.isAbsolute(directory ?? '')) { skip('directory_unknown'); return result; }
      const capability = await request(directory, '/session/revert-capabilities');
      if (capability?.sessionRetention !== 1) { skip('retention_unsupported'); return result; }
      const snapshot = await control(directory, { action: 'snapshot' });
      const protectedIDs = [...options.gate.selections(), ...await options.protectedSessions()];
      const policy = { days: Math.max(1, Math.min(365, Number(settings.autoDeleteAfterDays) || 30)),
        archivedOnly: result.action === 'delete' && settings.sessionRetentionArchivedOnly === true, protectedIDs };
      const candidates = retentionTrees(snapshot, policy);
      for (const candidate of candidates) {
        if (candidate.reason) { skip(candidate.reason, candidate.rootID); continue; }
        settings = await options.readSettings();
        if (!settings.autoDeleteEnabled) { skip('disabled'); break; }
        // Policy changes stop the batch; an already accepted mutation drains.
        if ((settings.sessionRetentionAction ?? 'archive') !== result.action
          || (result.action === 'delete' && settings.sessionRetentionArchivedOnly === true) !== policy.archivedOnly
          || (Number(settings.autoDeleteAfterDays) || 30) !== policy.days) { skip('policy_changed'); break; }
        const ids = candidate.tree.map((session) => session.id);
        let release, token, mutationStarted = false;
        try {
          release = options.gate.hold(ids);
          ({ token } = await control(directory, { action: 'hold', instanceID: snapshot.instanceID, ids }));
          if (typeof token !== 'string') throw failure('session_active');
          const current = await control(directory, { action: 'snapshot' });
          if (current.instanceID !== snapshot.instanceID) throw failure('runtime_restarted');
          const refreshed = retentionTrees(current, { ...policy,
            protectedIDs: [...options.gate.selections(), ...await options.protectedSessions()] })
            .find((entry) => entry.rootID === candidate.rootID);
          if (!refreshed || refreshed.reason || refreshed.tree.length !== ids.length
            || refreshed.tree.some((session) => !ids.includes(session.id))) throw failure(refreshed?.reason ?? 'session_tree_changed');
          for (const scope of new Set(refreshed.tree.map((session) => session.directory))) {
            const statuses = await request(scope, '/session/status');
            if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) throw failure('session_status_unknown');
            for (const session of refreshed.tree) {
              if (session.directory !== scope) continue;
              // The paired capability defines omitted status as idle. This is
              // never inferred for external runtimes or a missing endpoint.
              if (statuses[session.id] && statuses[session.id].type !== 'idle') throw failure('session_active');
            }
            for (const endpoint of ['/permission', '/question']) {
              const blockers = await request(scope, endpoint);
              if (!Array.isArray(blockers)) throw failure('session_blockers_unknown');
              if (blockers.some((blocker) => !blocker?.sessionID || ids.includes(blocker.sessionID))) throw failure('session_blocked');
            }
            await options.checkLedger({ directory: scope, sessions: ids });
          }
          if (!(await options.readSettings()).autoDeleteEnabled) throw failure('disabled');
          // Children first: native deletion is recursive. This also makes any
          // partial outcome explicit instead of counting descendants twice.
          const ordered = [...refreshed.tree].sort((a, b) => {
            const depth = (row) => { let n = 0; while (row.parentID) { n++; row = refreshed.tree.find((r) => r.id === row.parentID); } return n; };
            return depth(b) - depth(a);
          }).map((session) => session.id);
          mutationStarted = true;
          const done = await control(directory, { action: result.action, token, instanceID: snapshot.instanceID, ids: ordered });
          if (!Array.isArray(done.completed) || !Array.isArray(done.failed)) throw failure('mutation_unconfirmed');
          result.completed.push(...done.completed); result.failed.push(...done.failed);
        } catch (cause) {
          if (mutationStarted) result.failed.push({ id: candidate.rootID, reason: 'mutation_unconfirmed' });
          else skip(cause.code ?? 'retention_state_unavailable', candidate.rootID);
        }
        finally {
          if (token) {
            // A response timeout does not prove native settlement. Preserve the
            // host hold until the companion confirms it no longer owns a commit.
            const drain = async () => {
              for (;;) {
                try {
                  const state = await control(directory, { action: 'release', token, instanceID: snapshot.instanceID });
                  if (state.released === true) { release?.(); return; }
                } catch (cause) {
                  if (cause.code === 'runtime_restarted') { release?.(); return; }
                }
                await new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref?.(); });
              }
            };
            // Keep this batch single-flight until every accepted action drains.
            await drain();
          } else release?.();
        }
      }
    } catch (cause) { skip(cause.code ?? 'retention_state_unavailable'); }
    finally { running = false; }
    return result;
  };
  return { run };
}

export function registerSessionRetentionRoutes(app, { retention, gate }) {
  // Authentication/CSRF and principal middleware precede this registration.
  app.all('/api/session/retention-control', (_req, res) => res.sendStatus(404));
  app.post('/api/openchamber/session-retention/run', express.json({ limit: '4kb' }), async (_req, res) => res.json(await retention.run()));
  app.post('/api/openchamber/session-retention/selection', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const { clientID, sessionID, revision, committed } = req.body ?? {};
      if (sessionID !== null && (typeof sessionID !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(sessionID))) throw failure('invalid_session');
      gate.select(clientID, sessionID, revision, committed === true); res.json({ selected: true });
    } catch (cause) { res.status(cause.status ?? 400).json({ code: cause.code, retryable: true }); }
  });
  app.use(['/api/global/event', '/api/event'], (req, res, next) => {
    const disconnect = gate.connect(req); res.once('close', disconnect); next();
  });
}

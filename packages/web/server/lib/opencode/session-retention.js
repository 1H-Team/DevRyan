import { markSelectionTiming } from './selection-timing.js';
import { resolveOpenCodeGeneration } from './opencode-generation.js';
import express from 'express';
import path from 'node:path';

const DAY = 86_400_000;
const failure = (code) => Object.assign(new Error(code), { code, status: 409 });
const stamp = (session, archivedOnly) => archivedOnly ? session.time?.archived : session.time?.updated ?? session.time?.created;

const archiveMetadataOnly=session=>{
  const metadata=session.metadata,devryan=metadata?.devryan,archive=devryan?.archive;
  return Object.keys(metadata??{}).length===1&&Object.keys(devryan??{}).length===1&&archive?.sessionID===session.id
    &&Object.keys(archive).every(key=>['sessionID','at'].includes(key))&&(archive.at===null||Number.isSafeInteger(archive.at)&&archive.at>0);
};
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
      else if (session.metadata && Object.keys(session.metadata).length && !archiveMetadataOnly(session)) reason = 'managed_session';
      else if (archivedOnly ? !session.time.archived : Boolean(session.time.archived)) reason = 'archive_policy';
      else if (!Number.isFinite(stamp(session, archivedOnly)) || stamp(session, archivedOnly) >= cutoff) reason = 'recent_session';
      if (reason) break;
    }
    return { rootID, tree, reason };
  });
}

/** Only a paired, exclusive runtime can prove admission and tree completeness.
 * The native hold outlives an HTTP response and fences durable session writes.
 * Every action is rechecked under both native and host activity holds.
 * Automatic decisions never cancel work: the native owner atomically proves a
 * quiet subtree before archive or durable removal. */
export function createSessionRetention(options) {
  let running = false;
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
      resolveOpenCodeGeneration(options.openCodeClient);
      const native=options.getNativeRuntime?.();
      if(typeof native?.readRetentionSnapshot!=='function'||typeof native?.retainSessions!=='function'){skip('capability_absent');return result;}
      const initial=await native.readRetentionSnapshot(),now=Date.now();
      const policy=async()=>{
        settings=await options.readSettings();
        if(!settings.autoDeleteEnabled||!options.isExclusive()||options.getNativeRuntime()!==native||options.getDirectory()!==directory
          ||(settings.sessionRetentionAction==='delete'?'delete':'archive')!==result.action)throw failure('retention_policy_changed');
        const days=settings.autoDeleteAfterDays;
        if(!Number.isFinite(days)||days<1)throw failure('retention_policy_invalid');
        return {days,now,archivedOnly:settings.sessionRetentionArchivedOnly===true,protectedIDs:[...options.gate.selections(),...await options.protectedSessions()]};
      };
      for(const choice of retentionTrees(initial,await policy())){
        if(choice.reason){skip(choice.reason,choice.rootID);continue;}
        if(choice.tree.some(row=>row.directory!==directory)){skip('directory_unknown',choice.rootID);continue;}
        let release;
        try{
          release=options.gate.hold(choice.tree.map(row=>row.id));
          const authorize=async members=>{
            const freshPolicy=await policy();
            const fresh={...initial,sessions:initial.sessions.map(row=>members.find(member=>member.id===row.id)??row)};
            const current=retentionTrees(fresh,freshPolicy).find(row=>row.rootID===choice.rootID);
            if(!current||current.reason||JSON.stringify(current.tree.map(row=>row.id).sort())!==JSON.stringify(choice.tree.map(row=>row.id).sort()))throw failure(current?.reason??'session_tree_changed');
            await options.checkLedger({directory,sessions:members.map(row=>row.id)});
          };
          await authorize(choice.tree);
          await native.retainSessions({directory,sessionID:choice.rootID,action:result.action,at:now,members:choice.tree,authorize});
          result.completed.push(...choice.tree.map(row=>row.id));
        }catch(cause){skip(cause.code??'retention_state_unavailable',choice.rootID);}
        finally{release?.();}
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
  app.post('/api/openchamber/session-retention/selection', (req, _res, next) => {
    markSelectionTiming(req, 'middlewareMs'); next();
  }, express.json({ limit: '4kb' }), (req, res) => {
    try {
      const { clientID, sessionID, revision, committed } = req.body ?? {};
      if (sessionID !== null && (typeof sessionID !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(sessionID))) throw failure('invalid_session');
      markSelectionTiming(req, 'gateStartMs');
      try { gate.select(clientID, sessionID, revision, committed === true); }
      finally { markSelectionTiming(req, 'gateEndMs'); }
      res.json({ selected: true });
    } catch (cause) { res.status(cause.status ?? 400).json({ code: cause.code, retryable: true }); }
  });
  app.use(['/api/global/event', '/api/event'], (req, res, next) => {
    const disconnect = gate.connect(req); res.once('close', disconnect); next();
  });
}

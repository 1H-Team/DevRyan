import fs from 'node:fs/promises';
import path from 'node:path';
import { planError, readPlanRevision, resolveSessionPlanRevision } from './revisions.js';

const canonicalDirectory = async (directory) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw planError(409, 'plan_project_mismatch');
  // Canonical session metadata remains usable when a historical local directory
  // is absent; existing symlinks still resolve before identities are compared.
  return fs.realpath(directory).catch((error) => { if (error.code === 'ENOENT') return path.resolve(directory); throw error; });
};

// OpenCode's global ID covers unrelated non-Git directories. Their actual
// session paths must remain inside the chosen project root on every surface.
export const assertGlobalPlanProjectScope = async (projectID, directory, sessionDirectories) => {
  if (projectID !== 'global') return;
  const root = await canonicalDirectory(directory);
  for (const sessionDirectory of sessionDirectories) {
    const relative = path.relative(root, await canonicalDirectory(sessionDirectory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw planError(403, 'plan_project_mismatch');
  }
};

/** One selected revision identity for both compaction and root-agent updates. */
export const resolveSelectedPlanRevision = async ({ plan, context, readSession, readProject, options }) => {
  const current = context.session;
  let ownerKey;
  let ownedCurrent;
  if (options.isManaged?.()) {
    ownedCurrent = await options.resolveOwnedPlanContext?.({ sessionID: current.id, directory: current.directory });
    if (!ownedCurrent?.directory || !ownedCurrent.ownerKey) throw planError(403, 'plan_owner_unavailable');
    ownerKey = ownedCurrent.ownerKey;
  } else {
    ownerKey = await options.sessionOwnerKey?.(current.id);
    if (!ownerKey && plan.sourceSessionId !== current.id) throw planError(403, 'plan_owner_unavailable');
    ownerKey ??= 'local';
  }
  let source = current;
  let ownedSource = ownedCurrent;
  if (plan.sourceSessionId !== current.id) {
    const sourceOwner = options.isManaged?.()
      ? await options.resolveOwnedPlanContext?.({ sessionID: plan.sourceSessionId })
      : { ownerKey: await options.sessionOwnerKey?.(plan.sourceSessionId) };
    if (sourceOwner?.ownerKey !== ownerKey) throw planError(403, 'plan_owner_mismatch');
    ownedSource = options.isManaged?.() ? sourceOwner : undefined;
    source = await readSession(plan.sourceSessionId, current.directory);
    if (options.isManaged?.()) {
      ownedSource = await options.resolveOwnedPlanContext?.({ sessionID: source.id, directory: source.directory });
      if (ownedSource?.ownerKey !== ownerKey || ownedSource?.directory !== sourceOwner.directory) throw planError(403, 'plan_owner_mismatch');
    }
  }
  if (source?.id !== plan.sourceSessionId || source.time?.archived || !source.projectID || source.projectID !== current.projectID
    || !Number.isSafeInteger(source.time?.created) || typeof source.slug !== 'string') throw planError(409, 'plan_source_mismatch');
  let candidates;
  if (ownedSource) {
    const owned = await canonicalDirectory(ownedSource.directory);
    if (ownedCurrent && await canonicalDirectory(ownedCurrent.directory) !== owned) throw planError(403, 'plan_project_mismatch');
    if (plan.projectDirectory !== undefined && await canonicalDirectory(plan.projectDirectory) !== owned) throw planError(403, 'plan_project_mismatch');
    if ((await readProject(ownedSource.directory))?.id !== current.projectID) throw planError(403, 'plan_project_mismatch');
    candidates = [ownedSource.directory];
  } else if (plan.projectDirectory !== undefined) {
    const selected = await canonicalDirectory(plan.projectDirectory);
    const registered = await Promise.all((await options.getRegisteredProjects?.() ?? []).map((project) => canonicalDirectory(project.path)));
    if (!registered.includes(selected) || (await readProject(selected))?.id !== current.projectID) throw planError(403, 'plan_project_mismatch');
    candidates = [plan.projectDirectory];
  } else {
    const groups = new Map();
    for (const directory of [context.projectDirectory, source.directory]) {
      const canonical = await canonicalDirectory(directory), identities = groups.get(canonical) ?? new Set([canonical]);
      identities.add(directory); groups.set(canonical, identities);
    }
    candidates = [...groups.values()].flatMap((identities) => [...identities]);
  }
  const found = [], checked = new Set();
  for (const directory of candidates) {
    try { await assertGlobalPlanProjectScope(current.projectID, directory, [current.directory, source.directory]); }
    catch (error) {
      if (error.code === 'plan_project_mismatch' && plan.projectDirectory === undefined && !ownedSource) continue;
      throw error;
    }
    const revision = await resolveSessionPlanRevision({ dataDirectory: options.dataDirectory, directory,
      sessionCreated: source.time.created, sessionSlug: source.slug, sourceMessageID: plan.sourceMessageId });
    if (checked.has(revision.path)) continue;
    checked.add(revision.path);
    try { await readPlanRevision(revision, { fsApi: options.fsApi }); found.push({ revision, projectDirectory: directory }); }
    catch (error) {
      if (error.code !== 'plan_revision_missing' || plan.projectDirectory !== undefined || ownedSource) throw error;
    }
  }
  if (found.length !== 1) throw planError(409, 'plan_selection_required', 'Reselect the saved plan to identify its project');
  return { ...found[0], source, ownerKey, sourceMessageID: plan.sourceMessageId };
};

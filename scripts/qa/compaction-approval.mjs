import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureFixtureManifest } from '../agent-evals/fixture.mjs';
import { gradeQaProject } from './acceptance-graders.mjs';
import { assertQaSubmittedPlanMode, findQaSubmittedUser, findQaTurnAssistants } from './submitted-turn.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalizePlan = text => text.replace(/\r\n/g, '\n').replace(/^\s*<!--\s*plan\s*-->\s*/, '').trim();
const approvalPrompt = planPath => 'Present the complete current contents of the existing saved plan at ' + JSON.stringify(planPath) + ' as a fresh Plan card for explicit approval. Use native read to read that saved file and reproduce the full plan after the <!--plan--> marker without summarizing or changing its contents. This request adds no requirements and does not authorize implementation. Do not rewrite the file, change any project file, reread completed source investigations, rerun failed tests, or start or repeat delegated investigations. Preserve all current decisions and completed work, then wait for approval.';

export async function captureQaCompactionProjectPlan(projectFixture) {
  const projectRoot = await realpath(projectFixture.fixtureRoot);
  const relativePath = '.opencode/plans/qa-current.md';
  const requestedPath = path.join(projectRoot, relativePath);
  assert.ok((await lstat(requestedPath)).isFile(), 'The current project plan must be a regular file');
  const realPath = await realpath(requestedPath);
  assert.ok(realPath.startsWith(projectRoot + path.sep), 'The current project plan escaped the owned fixture');
  const content = await readFile(realPath);
  assert.ok(content.toString('utf8').trim(), 'The current project plan is empty');
  return { relativePath, realPath, sha256: digest(content), bytes: content.length };
}

export async function assertQaCompactionProjectPlanUnchanged(projectFixture, expectedProjectPlan) {
  assert.ok(expectedProjectPlan?.relativePath === '.opencode/plans/qa-current.md'
    && typeof expectedProjectPlan.realPath === 'string' && /^[a-f0-9]{64}$/.test(expectedProjectPlan.sha256),
  'The revision-2 project plan baseline is required');
  const current = await captureQaCompactionProjectPlan(projectFixture);
  assert.deepEqual(current, expectedProjectPlan, 'The revision-2 project plan changed while implementation was paused');
  return current;
}

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const assertRevisionIdentity = identity => {
  assert.ok(identity && validId(identity.sessionId) && validId(identity.sourceMessageId)
    && typeof identity.directory === 'string' && path.isAbsolute(identity.directory)
    && Number.isSafeInteger(identity.sessionCreated) && identity.sessionCreated > 0
    && typeof identity.sessionSlug === 'string' && identity.sessionSlug.trim(),
  'The exact saved Plan revision identity is required');
};

const assertOwnedPlanFile = async (canonicalPath, ownedPlansRoot) => {
  assert.ok(canonicalPath.startsWith(ownedPlansRoot + path.sep), 'The saved Plan escaped the prepared runtime plans directory');
  assert.equal(path.resolve(canonicalPath), canonicalPath, 'The saved Plan path is not canonical');
  assert.ok((await lstat(ownedPlansRoot)).isDirectory(), 'The prepared runtime plans root must be an ordinary directory');
  assert.equal(await realpath(ownedPlansRoot), ownedPlansRoot, 'The prepared runtime plans root was redirected');
  assert.ok((await lstat(canonicalPath)).isFile(), 'The saved Plan must be an ordinary file');
  assert.equal(await realpath(canonicalPath), canonicalPath, 'The saved Plan path was redirected');
};

export async function readQaSavedPlanRevision(api, identity, ownedPlansRoot) {
  assertRevisionIdentity(identity);
  assert.ok(typeof ownedPlansRoot === 'string' && path.isAbsolute(ownedPlansRoot)
    && path.resolve(ownedPlansRoot) === ownedPlansRoot, 'The prepared runtime plans directory is required');
  const query = new URLSearchParams({ directory: identity.directory,
    sessionCreated: String(identity.sessionCreated), sessionSlug: identity.sessionSlug });
  const result = await api(`/api/session/${encodeURIComponent(identity.sessionId)}/plan-revisions/${encodeURIComponent(identity.sourceMessageId)}?${query}`, { cache: 'no-store' });
  assert.ok(typeof result?.path === 'string' && path.isAbsolute(result.path)
    && typeof result.content === 'string' && result.content.trim(), 'The exact saved Plan revision has no path or contents');
  await assertOwnedPlanFile(result.path, ownedPlansRoot);
  const contents = await readFile(result.path);
  assert.ok(contents.equals(Buffer.from(result.content, 'utf8')), 'The saved Plan API contents differ from the owned file');
  await assertOwnedPlanFile(result.path, ownedPlansRoot);
  return { identity: structuredClone(identity), canonicalPath: result.path, content: result.content };
}

export function requireQaCompactionPlanSource(rows, { sessionID, userMessageID, content }) {
  const user = rows.find(row => row.info?.id === userMessageID);
  assert.ok(user?.info.role === 'user' && user.info.sessionID === sessionID, 'The saved Plan requires its exact canonical user request');
  assertQaSubmittedPlanMode(user, true);
  const source = rows.toReversed().find(row => row.info?.role === 'assistant' && row.info.sessionID === sessionID
    && row.info.parentID === userMessageID && row.info.summary !== true && !row.info.error
    && Number.isFinite(row.info.time?.created) && Number.isFinite(row.info.time?.completed)
    && row.info.time.completed >= row.info.time.created && typeof row.info.finish === 'string'
    && row.info.finish && row.info.finish !== 'tool-calls');
  assert.ok(source, 'The exact canonical request has no completed Plan source');
  const body = canonicalPlanBody(source);
  if (content !== undefined) assert.equal(body, normalizePlan(content), 'The saved revision differs from its exact canonical Plan source');
  return source;
}

const canonicalPlanBody = source => {
  const text = source.parts.filter(part => part.type === 'text' && part.synthetic !== true).map(part => part.text ?? '').join('\n');
  const markers = [...text.matchAll(/<!--\s*plan\s*-->/g)];
  assert.equal(markers.length, 1, 'The canonical Plan source must contain exactly one Plan marker');
  const body = text.slice(markers[0].index + markers[0][0].length).trim();
  assert.ok(body, 'The canonical Plan source is empty');
  return normalizePlan(body);
};

export async function captureQaCompactionPlanReference({ planMode, projectFixture, savedPlan, readSavedRevision }) {
  if (!planMode) return { kind: 'project-file', ...await captureQaCompactionProjectPlan(projectFixture) };
  assertRevisionIdentity(savedPlan?.revision);
  assert.equal(savedPlan.revision.sourceMessageId, savedPlan.sourceMessageID, 'The saved Plan source identity changed');
  assert.ok(validId(savedPlan.userMessageID), 'The saved Plan requires its original user request identity');
  assert.equal(typeof readSavedRevision, 'function', 'Exact saved-revision reads are required in Plan mode');
  const observed = await readSavedRevision(structuredClone(savedPlan.revision));
  assert.deepEqual(observed.identity, savedPlan.revision, 'The saved Plan revision identity changed');
  assert.ok(typeof observed.canonicalPath === 'string' && path.isAbsolute(observed.canonicalPath)
    && typeof observed.content === 'string' && observed.content.trim(), 'The exact saved Plan revision has no path or contents');
  assert.equal(observed.canonicalPath, savedPlan.canonicalPath, 'The saved Plan canonical path changed before baseline');
  assert.equal(digest(observed.content), savedPlan.sha256, 'The saved Plan contents changed before baseline');
  assert.equal(digest(await readFile(savedPlan.path)), savedPlan.sha256, 'The archived Plan does not match its saved revision');
  return { kind: 'session-revision', identity: structuredClone(savedPlan.revision), userMessageID: savedPlan.userMessageID,
    canonicalPath: observed.canonicalPath, sha256: digest(observed.content), bytes: Buffer.byteLength(observed.content, 'utf8') };
}

export async function assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan, readSavedRevision }) {
  if (expectedPlan?.kind === 'project-file') {
    const { kind, ...projectPlan } = expectedPlan;
    return { kind, ...await assertQaCompactionProjectPlanUnchanged(projectFixture, projectPlan) };
  }
  assert.ok(expectedPlan?.kind === 'session-revision', 'The revision-2 saved Plan baseline is required');
  assertRevisionIdentity(expectedPlan.identity);
  assert.ok(validId(expectedPlan.userMessageID) && typeof expectedPlan.canonicalPath === 'string' && path.isAbsolute(expectedPlan.canonicalPath)
    && /^[a-f0-9]{64}$/.test(expectedPlan.sha256) && Number.isSafeInteger(expectedPlan.bytes) && expectedPlan.bytes > 0,
  'The revision-2 saved Plan baseline is required');
  assert.equal(typeof readSavedRevision, 'function', 'Exact saved-revision reads are required in Plan mode');
  const observed = await readSavedRevision(structuredClone(expectedPlan.identity));
  assert.deepEqual(observed.identity, expectedPlan.identity, 'The revision-2 saved Plan identity changed');
  assert.equal(observed.canonicalPath, expectedPlan.canonicalPath, 'The revision-2 saved Plan path changed');
  assert.ok(typeof observed.content === 'string', 'The revision-2 saved Plan contents are unavailable');
  assert.equal(digest(observed.content), expectedPlan.sha256, 'The revision-2 saved Plan contents changed');
  assert.equal(Buffer.byteLength(observed.content, 'utf8'), expectedPlan.bytes, 'The revision-2 saved Plan byte count changed');
  return { kind: 'session-revision', identity: structuredClone(observed.identity), userMessageID: expectedPlan.userMessageID,
    canonicalPath: observed.canonicalPath, sha256: digest(observed.content), bytes: Buffer.byteLength(observed.content, 'utf8') };
}

const requireNativePlanRead = (rows, previousIds, requestedUserMessageID, source, planPath, sessionID) => {
  const matches = rows.filter(row => row.info?.role === 'assistant' && !previousIds.has(row.info.id)
    && row.info.sessionID === sessionID && row.info.parentID === requestedUserMessageID && !row.info.error && row.info.summary !== true)
    .flatMap(row => row.parts.filter(part => part.type === 'tool' && ['read', 'oc_read'].includes(part.tool)
      && part.messageID === row.info.id && part.sessionID === sessionID && validId(part.callID) && validId(part.id)
      && part.state?.status === 'completed' && typeof part.state.output === 'string' && part.state.output.trim()
      && part.state.input?.filePath === planPath
      && ['filePath', 'path', 'file_path', 'filename', 'file'].filter(key => part.state.input[key] !== undefined).length === 1
      && Number.isFinite(part.state.time?.start) && part.state.time.start >= 0
      && Number.isFinite(part.state.time?.end) && part.state.time.start <= part.state.time.end
      && part.state.time.end <= source.info.time.created)
      .map(part => ({ callID: part.callID, partID: part.id, messageID: row.info.id,
        startedAt: part.state.time.start, completedAt: part.state.time.end, path: planPath, outputSha256: digest(part.state.output) })));
  assert.ok(matches.length > 0, 'Fresh Plan approval requires a successful native read of the exact saved plan before the final source');
  return matches;
};

// A later human Plan-mode request supersedes older cards. Read the pinned
// revision through its original API identity; never switch to the latest card.
export async function prepareQaCompactionApproval({ projectFixture, priorSavedPlan, expectedPlan, messages,
  sendTurn, captureSavedPlan, readSavedRevision, evidenceName }) {
  await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan, readSavedRevision });
  assert.ok(gradeQaProject({ fixture: projectFixture, phase: 'plan', savedPlan: priorSavedPlan }).passed,
    'Approval preparation requires an intact paused project');
  const planPath = expectedPlan.kind === 'session-revision' ? expectedPlan.canonicalPath : expectedPlan.realPath;
  const original = expectedPlan.kind === 'session-revision'
    ? (await readSavedRevision(structuredClone(expectedPlan.identity))).content : await readFile(planPath, 'utf8');
  assert.equal(digest(original), expectedPlan.sha256, 'The revision-2 saved Plan contents changed');
  const normalized = normalizePlan(original);
  const mentions = normalized.replace(/[`*_]/g, '').replace(/\s+/g, ' ');
  assert.match(mentions, /\b(?:creation|insertion)[ -]order\b/i, 'The current plan lost the revised task creation order');
  assert.match(mentions, /\bpriority\b.{0,120}\bfilter\b|\bfilter\b.{0,120}\bpriority\b/i,
    'The current plan lost the revised priority filter');
  const before = captureFixtureManifest(projectFixture.fixtureRoot);
  const previousIds = new Set((await messages()).map(row => row.info.id));
  const prompt = approvalPrompt(planPath);
  const rows = await sendTurn(prompt);
  const submitted = findQaSubmittedUser(rows, previousIds, prompt);
  assert.ok(submitted, 'Approval preparation has no exact canonical human request');
  assertQaSubmittedPlanMode(submitted, true);
  const savedPlan = await captureSavedPlan(evidenceName, { userMessageID: submitted.info.id });
  const source = findQaTurnAssistants(rows, previousIds, submitted.info.id)
    .find(row => row.info.id === savedPlan.sourceMessageID);
  assert.ok(source?.info.time?.completed && !source.info.error,
    'Approval preparation fell back to a prior source instead of a new completed Plan response');
  assert.equal(source.info.parentID, submitted.info.id,
    'The fresh Plan source must belong to the exact canonical approval-preparation request');
  const sessionID = expectedPlan.kind === 'session-revision' ? expectedPlan.identity.sessionId : submitted.info.sessionID;
  assert.equal(source.info.sessionID, sessionID, 'The fresh Plan source changed session');
  assert.equal(submitted.info.sessionID, sessionID, 'The approval-preparation request changed session');
  assert.ok(Number.isFinite(source.info.time.created) && Number.isFinite(source.info.time.completed)
    && source.info.time.created >= 0 && source.info.time.completed >= source.info.time.created
    && typeof source.info.finish === 'string' && source.info.finish && source.info.finish !== 'tool-calls',
  'The fresh Plan source has no completed final interval');
  assert.notEqual(savedPlan.sourceMessageID, priorSavedPlan.sourceMessageID,
    'Approval preparation must create a fresh canonical UI source');
  assert.equal(canonicalPlanBody(source), normalized, 'The fresh canonical Plan source must contain the full unchanged current plan');
  const nativeReads = requireNativePlanRead(rows, previousIds, submitted.info.id, source, planPath, sessionID);
  const current = await readFile(savedPlan.path, 'utf8');
  assert.equal(normalizePlan(current), normalized, 'The fresh Plan card must contain the full unchanged current plan');
  if (expectedPlan.kind === 'session-revision') {
    const fresh = await captureQaCompactionPlanReference({ planMode: true, projectFixture, savedPlan, readSavedRevision });
    assert.deepEqual(fresh.identity, { ...expectedPlan.identity, sourceMessageId: savedPlan.sourceMessageID }, 'The fresh saved Plan changed session storage identity');
    assert.equal(fresh.userMessageID, submitted.info.id, 'The fresh saved Plan changed request identity');
    assert.equal(normalizePlan((await readSavedRevision(fresh.identity)).content), normalized, 'The fresh saved revision lost the full plan');
  }
  await assertQaCompactionPlanUnchanged({ projectFixture, expectedPlan, readSavedRevision });
  assert.deepEqual(captureFixtureManifest(projectFixture.fixtureRoot), before, 'Approval preparation changed the paused project');
  assert.ok(gradeQaProject({ fixture: projectFixture, phase: 'plan', savedPlan }).passed,
    'The fresh approval source failed paused project grading');
  return { savedPlan, evidence: {
    reason: 'human-plan-request-supersession', requestedUserMessageID: submitted.info.id,
    previousUISourceMessageID: priorSavedPlan.sourceMessageID, previousUIPlanSha256: priorSavedPlan.sha256,
    freshUISourceMessageID: savedPlan.sourceMessageID, freshUIPlanSha256: savedPlan.sha256,
    planReference: { ...expectedPlan, unchanged: true }, nativeReads,
    completeCurrentPlan: true, revisedCreationOrderPresent: true, revisedPriorityFilterPresent: true,
    projectUnchanged: true, freshSourceAfterRequest: true, freshSourceParentID: source.info.parentID,
  } };
}

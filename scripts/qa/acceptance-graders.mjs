import { readFileSync, readdirSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { captureFixtureManifest } from '../agent-evals/fixture.mjs';
import { gradeManagedTaskOutcome, gradeToolRequirements } from '../agent-evals/graders.mjs';
import { assertQaProjectFixtureOwned, QA_PROJECT_PLAN_PREFIXES, QA_PROJECT_PROTECTED_PATHS } from './project-fixture.mjs';

const check = (id, passed) => ({ id, passed: passed === true });
const summarize = (checks, extra = {}) => ({ passed: checks.length > 0 && checks.every((item) => item.passed), checks, ...extra });
const sameEntry = (a, b) => !!a && !!b && a.type === b.type && a.mode === b.mode && a.size === b.size && a.sha256 === b.sha256;
const entries = (manifest) => new Map([...manifest.tracked, ...manifest.untracked].map((entry) => [entry.path, entry]));

const assertNoSymlinks = (root) => {
  for (const name of readdirSync(root)) {
    if (name === '.git') continue;
    const file = path.join(root, name);
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) throw new Error('QA project contains a symlink');
    if (stats.isDirectory()) assertNoSymlinks(file);
  }
};

// The probe executes outside the agent-editable repository, using real exported
// domain/store/server behavior. Editing or deleting the fixture tests cannot make it pass.
const PROJECT_PROBE = String.raw`
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, scratch] = process.argv.slice(1);
const results = [];
const probe = async (id, run) => { try { await run(); results.push({ id, passed: true }); } catch { results.push({ id, passed: false }); } };
const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);
await probe('project.summary', async () => {
  const { summarizeTasks } = await load('tasks.mjs');
  assert.deepEqual(summarizeTasks([{done:true,archived:false},{done:false,archived:false},{done:true,archived:true}]), {total:2,completed:1,percent:50});
  assert.deepEqual(summarizeTasks([{done:true,archived:true}]), {total:0,completed:0,percent:0});
  assert.deepEqual(summarizeTasks([]), {total:0,completed:0,percent:0});
});
await probe('project.monotonic-events', async () => {
  const { applyTaskEvent } = await load('tasks.mjs');
  const current = [{id:'one',title:'Current',revision:5,priority:'high',done:false,archived:false},{id:'two',title:'Other',revision:1,priority:'normal',done:false,archived:false}];
  for (const revision of [1,4,5]) assert.deepEqual(applyTaskEvent(structuredClone(current), {id:'one',revision,patch:{title:'Stale',done:true}}), current);
  const updated = applyTaskEvent(structuredClone(current), {id:'one',revision:6,patch:{title:'New'}});
  assert.equal(updated[0].title, 'New'); assert.equal(updated[0].priority, 'high'); assert.equal(updated[0].revision, 6);
  assert.deepEqual(updated[1], current[1]);
});
await probe('project.priority-domain', async () => {
  const { createTask } = await load('tasks.mjs');
  assert.equal(createTask({title:'Default'}, 'default').priority, 'normal');
  for (const priority of ['low','normal','high']) assert.equal(createTask({title:'Selected',priority}, priority).priority, priority);
  for (const priority of ['urgent','',null,12]) assert.throws(() => createTask({title:'Invalid',priority}, 'bad'));
});
await probe('project.persistence', async () => {
  const { createTaskStore } = await load('store.mjs');
  const file = path.join(scratch, 'store.json');
  await writeFile(file, JSON.stringify([{id:'legacy',title:'Legacy',done:false,archived:false,revision:1}]));
  let store = await createTaskStore(file);
  assert.equal(store.list()[0].priority, 'normal');
  const created = await store.add({title:'Persist me',priority:'high'});
  await store.apply({id:created.id,revision:2,patch:{title:'Edited'}});
  store = await createTaskStore(file);
  const reloaded = store.list().find(task => task.id === created.id);
  assert.equal(reloaded.title, 'Edited'); assert.equal(reloaded.priority, 'high');
  await store.apply({id:created.id,revision:1,patch:{title:'Stale'}});
  assert.equal((await createTaskStore(file)).list().find(task => task.id === created.id).title, 'Edited');
});
await probe('project.http-and-restart', async () => {
  const { startTaskServer } = await load('server.mjs');
  const file = path.join(scratch, 'http.json');
  let app;
  const send = async (route, method='GET', body) => {
    const response = await fetch(app.origin + route, {method, signal:AbortSignal.timeout(3000), ...(body === undefined ? {} : {headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  try {
    app = await startTaskServer({port:0,dataFile:file});
    const first = await send('/api/tasks','POST',{title:'First low',priority:'low'});
    assert.equal(first.status,201); assert.equal(first.body.priority,'low');
    const second = await send('/api/tasks','POST',{title:'Second high',priority:'high'});
    assert.equal(second.status,201);
    const third = await send('/api/tasks','POST',{title:'Third default'});
    assert.equal(third.body.priority,'normal');
    assert.equal((await send('/api/tasks','POST',{title:'Invalid',priority:'urgent'})).status,400);
    assert.equal((await send('/api/tasks/' + first.body.id,'PATCH',{priority:'urgent'})).status,400);
    assert.equal((await send('/api/tasks/' + first.body.id,'PATCH',{title:'First edited'})).body.priority,'low');
    await send('/api/tasks/' + second.body.id,'PATCH',{done:true});
    await send('/api/tasks/' + third.body.id,'PATCH',{done:true,archived:true});
    assert.deepEqual((await send('/api/summary')).body,{total:2,completed:1,percent:50});
    const tasks = (await send('/api/tasks')).body;
    assert.deepEqual(tasks.map(task=>task.id),[first.body.id,second.body.id,third.body.id]);
    const current = tasks[0];
    for (const revision of [1,current.revision]) await send('/api/events','POST',{id:current.id,revision,patch:{title:'Stale',priority:'high'}});
    assert.equal((await send('/api/tasks')).body[0].title,'First edited');
    await app.close(); app = await startTaskServer({port:0,dataFile:file});
    const restored = (await send('/api/tasks')).body;
    assert.equal(restored[0].title,'First edited'); assert.equal(restored[0].priority,'low');
    assert.equal(restored[1].priority,'high');
    assert.equal((await fetch(app.origin + '/')).status,200);
  } finally { if (app) await app.close(); }
});
process.stdout.write(JSON.stringify({checks:results}));
`;

const verifiedExternalPlan = (fixture, savedPlan) => {
  if (!savedPlan || typeof savedPlan.path !== 'string' || !/^[a-f0-9]{64}$/.test(savedPlan.sha256 ?? '')) return false;
  try {
    const target = realpathSync(savedPlan.path);
    const relative = path.relative(realpathSync(fixture.evidenceDirectory),target);
    const projectRelative = path.relative(fixture.fixtureRoot,target);
    const withinEvidence = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const withinProject = projectRelative === '' || (projectRelative !== '..' && !projectRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(projectRelative));
    if (!withinEvidence || withinProject || lstatSync(savedPlan.path).isSymbolicLink() || !lstatSync(target).isFile()) return false;
    const content = readFileSync(target);
    return content.toString('utf8').trim().length > 0 && createHash('sha256').update(content).digest('hex') === savedPlan.sha256;
  } catch { return false; }
};

export const gradeQaProject = ({ fixture, phase, savedPlan, timeoutMs = 30_000 } = {}) => {
  if (!['plan', 'implemented', 'baseline'].includes(phase)) throw new Error('Invalid QA project grading phase');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('Invalid QA project grading timeout');
  assertQaProjectFixtureOwned(fixture);
  assertNoSymlinks(fixture.fixtureRoot);
  const after = captureFixtureManifest(fixture.fixtureRoot);
  const beforeEntries = entries(fixture.seed.manifest);
  const afterEntries = entries(after);
  const changedPaths = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])]
    .filter((key) => !sameEntry(beforeEntries.get(key), afterEntries.get(key))).sort();
  const checks = [check('project.user-edit-and-requirements', QA_PROJECT_PROTECTED_PATHS.every((key) => sameEntry(beforeEntries.get(key), afterEntries.get(key))))];
  const packageJson = JSON.parse(readFileSync(path.join(fixture.fixtureRoot, 'package.json'), 'utf8'));
  checks.push(check('project.no-added-dependencies', ['dependencies','devDependencies','optionalDependencies','peerDependencies']
    .every((key) => packageJson[key] === undefined || (packageJson[key] && Object.keys(packageJson[key]).length === 0))));
  checks.push(check('project.original-tests-retained', fixture.seed.manifest.tracked.filter((entry) => entry.path.startsWith('test/'))
    .every((entry) => sameEntry(entry, afterEntries.get(entry.path)))));
  const git = spawnSync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], {cwd:fixture.fixtureRoot,encoding:'utf8',timeout:5_000});
  checks.push(check('project.branch-and-history', git.status === 0 && git.stdout.trim() === `${fixture.seed.revision}\n${fixture.seed.branch}`));
  if (phase === 'plan') {
    checks.push(check('project.plan-only', changedPaths.every((key) => QA_PROJECT_PLAN_PREFIXES.some((prefix) => key.startsWith(prefix)))));
    checks.push(check('project.saved-plan', savedPlan === undefined ? [...afterEntries.values()].some((entry) => entry.type === 'file' && entry.size > 0
      && QA_PROJECT_PLAN_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) : verifiedExternalPlan(fixture,savedPlan)));
    return summarize(checks, { phase, changedPaths, manifestAfter: after });
  }
  const scratch = mkdtempSync(path.join(fixture.evidenceDirectory, 'grading-'));
  try {
    const execution = spawnSync(process.execPath, ['--input-type=module', '-e', PROJECT_PROBE, fixture.fixtureRoot, scratch], {
      cwd: scratch, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1_048_576, killSignal: 'SIGKILL',
    });
    let observed;
    try { observed = JSON.parse(execution.stdout); } catch { observed = null; }
    const expectedIds = ['project.summary','project.monotonic-events','project.priority-domain','project.persistence','project.http-and-restart'];
    const validOutput = !execution.error && execution.status === 0 && execution.signal === null
      && Array.isArray(observed?.checks) && observed.checks.length === expectedIds.length
      && observed.checks.every((item,index) => item?.id === expectedIds[index] && typeof item.passed === 'boolean');
    checks.push(check('project.independent-probe-completed', validOutput));
    if (validOutput) checks.push(...observed.checks);
    return summarize(checks, { phase, changedPaths, manifestAfter: after,
      verification: { exitCode: execution.status, signal: execution.signal, timedOut: execution.error?.code === 'ETIMEDOUT',
        probeSha256: createHash('sha256').update(PROJECT_PROBE).digest('hex') } });
  } finally { rmSync(scratch, {recursive:true,force:true}); }
};

// Tool events must come from the existing evaluator's private timing-evidence
// handoff. Self-reported model prose cannot prove a RED -> edit -> GREEN chain.
export const gradeQaRepairToolEvidence = (toolEvents) => gradeToolRequirements('repair-and-test', toolEvents);
export const gradeQaManagedRepairToolEvidence = (toolEvents) => gradeToolRequirements('managed-repair-and-test', toolEvents);

export const gradeManagedTaskAcceptance = (input = {}) => {
  const checks = [gradeManagedTaskOutcome(input)];
  checks.push(check('managed.barriers-cleared', Array.isArray(input.activeBarriers) && input.activeBarriers.length === 0));
  const executions = input.dispatches;
  const tasks = (Array.isArray(input.snapshot?.tasks) ? input.snapshot.tasks : []).filter((task) => task.rootSessionId === input.rootSessionId);
  checks.push(check('managed.no-duplicate-dispatch', Array.isArray(executions) && executions.length > 0
    && executions.length === tasks.length
    && executions.every((item) => typeof item?.taskId === 'string' && item.taskId && typeof item?.childSessionId === 'string' && item.childSessionId)
    && new Set(executions.map((item) => item.taskId)).size === executions.length
    && new Set(executions.map((item) => item.childSessionId)).size === executions.length
    && executions.every((item) => tasks.some((task) => task.taskId === item.taskId && task.childSessionId === item.childSessionId))));
  return summarize(checks);
};

const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const uniqueIds = (value) => Array.isArray(value) && value.every(validId) && new Set(value).size === value.length;
const sameMembers = (left, right) => uniqueIds(left) && uniqueIds(right) && left.length === right.length && left.every((id) => right.includes(id));
const nonemptyHashMap = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  && Object.values(value).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));

// expected/observed revisions and task state must be captured from authoritative
// saved plans, Git/files, and managed ledgers. They are not assistant recaps.
export const gradeCompactionRetention = ({ mode, source = 'opencode', boundaries, expected, observed } = {}) => {
  if (!['manual', 'natural'].includes(mode)) throw new Error('Invalid compaction grading mode');
  if (!['opencode', 'provider-adapter'].includes(source)) throw new Error('Invalid compaction source');
  const expectedTrigger = mode === 'natural' ? 'threshold' : 'manual';
  const validBoundaries = Array.isArray(boundaries) && boundaries.length >= 2 && boundaries.every((boundary, index) => (
    boundary?.source === source
    && validId(boundary.eventId) && validId(boundary.summaryMessageId)
    && boundary.trigger === expectedTrigger
    && boundary.requestKind === (mode === 'natural' ? 'none' : 'manual')
    && Number.isFinite(boundary.observedAt) && boundary.observedAt > 0
    && (index === 0 || boundary.observedAt > boundaries[index - 1].observedAt)
    && (mode !== 'natural' || (Number.isFinite(boundary.contextBefore) && Number.isFinite(boundary.thresholdTokens)
      && boundary.thresholdTokens > 0 && boundary.contextBefore >= boundary.thresholdTokens))
  )) && new Set(boundaries.map((item) => item.eventId)).size === boundaries.length
    && new Set(boundaries.map((item) => item.summaryMessageId)).size === boundaries.length;
  const checks = [check('compaction.observed-boundaries', validBoundaries)];
  const e = expected ?? {}; const o = observed ?? {};
  checks.push(check('compaction.current-plan-and-phase', validId(e.objectiveRevision) && validId(e.planRevision)
    && ['plan','implementation'].includes(e.phase) && o.objectiveRevision === e.objectiveRevision
    && o.planRevision === e.planRevision && o.phase === e.phase));
  checks.push(check('compaction.repository-and-user-edit', typeof e.repositoryHead === 'string' && /^[a-f0-9]{40,64}$/.test(e.repositoryHead)
    && o.repositoryHead === e.repositoryHead && nonemptyHashMap(e.preservedFileHashes) && nonemptyHashMap(o.preservedFileHashes)
    && Object.entries(e.preservedFileHashes).every(([file,hash]) => o.preservedFileHashes[file] === hash)));
  checks.push(check('compaction.unfinished-obligations', sameMembers(e.remainingTaskIds, o.remainingTaskIds)));
  checks.push(check('compaction.completed-work-not-repeated', uniqueIds(e.completedActionIds) && uniqueIds(o.performedActionIds)
    && e.completedActionIds.every((id) => !o.performedActionIds.includes(id))));
  checks.push(check('compaction.rejected-approaches-absent', uniqueIds(e.rejectedActionIds) && e.rejectedActionIds.length > 0
    && uniqueIds(o.performedActionIds) && e.rejectedActionIds.every((id) => !o.performedActionIds.includes(id))));
  // These checks carry external behavioral grade IDs and their observed artifacts.
  // Requiring them prevents a perfect state recap from passing failed implementation.
  checks.push(check('compaction.behavioral-continuation', uniqueIds(e.requiredBehaviorCheckIds) && e.requiredBehaviorCheckIds.length > 0
    && Array.isArray(o.behaviorChecks) && sameMembers(e.requiredBehaviorCheckIds, o.behaviorChecks.map((item) => item?.id))
    && o.behaviorChecks.every((item) => item.passed === true && validId(item.evidenceId))));
  return summarize(checks);
};

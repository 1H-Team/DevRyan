import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { captureQaTaskEvidence, cleanupQaSessionTree, projectQaPlanChildPolicy } from './live-task-evidence.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';

const tool = (name, index, input = {}, metadata = {}) => ({ id: `prt_${index}`, callID: `call_${index}`, type: 'tool', tool: name,
  state: { status: 'completed', input, metadata, output: 'A secret raw tool output must never be persisted.', time: { start: index * 10, end: index * 10 + 5 } } });
const chain = command => [tool('read', 1, { filePath: 'src/tasks.mjs' }), tool('bash', 2, { command }, { exit: 1 }),
  tool('edit', 3, { filePath: 'src/tasks.mjs' }), tool('bash', 4, { command }, { exit: 0 })];
const row = (id, parts = []) => ({ info: { id, role: 'assistant' }, parts });
const withProject = async run => {
  const project = createQaProjectFixture({ runId: 'live-task-evidence' });
  try { await run(project); } finally { removeQaProjectFixture(project); await rm(project.evidenceDirectory, { recursive: true, force: true }); }
};
const reader = ({ parts = chain('npm test'), children = {}, childRows = {}, snapshot, handoff, calls = [] } = {}) => async (route, options = {}) => {
  calls.push({ route, options });
  const url = new URL(route, 'http://qa.invalid');
  if (url.pathname === '/api/orchestration/snapshot') return structuredClone(snapshot);
  if (url.pathname === '/api/orchestration/handoff') {
    assert.deepEqual(JSON.parse(options.body), { rootSessionId: 'ses_root', fromMode: 'orchestrator', toMode: 'builder', confirm: false });
    return structuredClone(handoff);
  }
  const [, sessionID, suffix] = /^\/api\/session\/([^/]+)\/([^/]+)$/.exec(url.pathname) ?? [];
  if (suffix === 'children') return (children[sessionID] ?? []).map(id => ({ id }));
  if (suffix === 'message') return sessionID === 'ses_root' ? [row('msg_root', parts)] : childRows[sessionID] ?? [row('msg_child')];
  if (suffix === 'abort') { assert.equal(options.method, 'POST'); return true; }
  throw new Error('Unexpected API route');
};
const capture = (project, api, extra = {}) => captureQaTaskEvidence({ api, rootSessionID: 'ses_root', directory: project.fixtureRoot, agent: 'builder', ...extra });

test('QA npm suite evidence proves a causal chain without persisting prompts, command text or output', () => withProject(async project => {
  for (const command of ['npm test', 'npm run test', `cd '${project.fixtureRoot}' && npm test`, 'node --test test/tasks.test.mjs']) {
    const calls = [];
    const evidence = await capture(project, reader({ parts: chain(command), calls }));
    assert.equal(evidence.passed, true, command);
    assert.equal(evidence.repair.suite.passed, true);
    assert.deepEqual(evidence.repair.suiteTools.map(event => event.ordinal), [1, 2, 3, 4]);
    assert.doesNotMatch(JSON.stringify(evidence), /secret raw|command"|output"|state"|time"/);
    assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'));
  }
}));

test('suite evidence rejects prose, ambiguous exits, wrappers, altered cwd and overlapping intervals', () => withProject(async project => {
  const mutations = [
    parts => { parts[1].state.metadata = {}; parts[1].state.output = 'exit code: 1'; },
    parts => { parts[1].state.metadata.exit = '1'; },
    parts => { parts[1].state.metadata.exitCode = 0; },
    parts => { parts[1].state.status = 'error'; },
    parts => { parts[1].state.input.command = 'npm test || true'; },
    parts => { parts[1].state.input.command = 'echo test && npm test'; },
    parts => { parts[1].state.input.command = 'npm test; echo 1'; },
    parts => { parts[1].state.input.command = 'CI=1 npm test'; },
    parts => { parts[1].state.input.command = 'npm test -- --test-name-pattern=irrelevant'; },
    parts => { parts[1].state.input.cwd = '/tmp'; },
    parts => { parts[1].state.input.command = 'cd /tmp && npm test'; },
    parts => { parts[1].state.input.command = 'node --check src/tasks.mjs && npm test'; },
    parts => { parts[1].state.time.start = 14; },
    parts => { parts[2].state.time.start = 24; },
    parts => { parts[3].state.time.end = parts[2].state.time.end; },
    parts => { parts[0].state.status = 'error'; },
  ];
  for (const mutation of mutations) {
    const parts = chain('npm test'); mutation(parts);
    assert.equal((await capture(project, reader({ parts }))).passed, false, mutation.toString());
  }
  const green = chain('npm test');
  green[3].state.input.command = 'node --check src/tasks.mjs && node --check public/app.js && npm test';
  green[3].state.metadata = { exit: 0, exitCode: 0 };
  assert.equal((await capture(project, reader({ parts: green }))).passed, true);
}));

test('npm suite evidence fails when the test script or original tests were changed', () => withProject(async project => {
  await writeFile(path.join(project.fixtureRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
  const script = await capture(project, reader());
  assert.equal(script.passed, false); assert.equal(script.repair.provenance.testScriptUnchanged, false);
  await writeFile(path.join(project.fixtureRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs', pretest: 'exit 1' } }));
  assert.equal((await capture(project, reader())).passed, false);
  await writeFile(path.join(project.fixtureRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/*.test.mjs' } }));
  await writeFile(path.join(project.fixtureRoot, '.npmrc'), 'script-shell=/bin/false\n');
  assert.equal((await capture(project, reader())).passed, false);
  await rm(path.join(project.fixtureRoot, '.npmrc'));
  await writeFile(path.join(project.fixtureRoot, 'test/tasks.test.mjs'), '// all tests removed\n');
  const tests = await capture(project, reader());
  assert.equal(tests.passed, false); assert.equal(tests.repair.provenance.originalTestsRetained, false);
}));

test('strict QA acceptance cannot be bypassed by quoted argv or weaker legacy evidence', () => withProject(async project => {
  const quoted = chain('npm test'); quoted[1].state.input.command = '"npm test"';
  assert.equal((await capture(project, reader({ parts: quoted }))).passed, false);
  for (const mutate of [
    parts => { parts[0].state.status = 'error'; },
    parts => { parts[1].state.metadata.exit = 0; },
  ]) {
    const parts = chain('node --test test/tasks.test.mjs');
    parts[1].state.metadata = { exitCode: 1 }; parts[3].state.metadata = { exitCode: 0 };
    mutate(parts);
    const evidence = await capture(project, reader({ parts }));
    assert.equal(evidence.repair.canonical.passed, true, 'Legacy evidence is retained as a diagnostic');
    assert.equal(evidence.repair.suite.passed, false);
    assert.equal(evidence.passed, false);
  }
}));

test('canonical collection traverses paginated messages and descendants; child repairs cannot count as Builder work', () => withProject(async project => {
  const firstPage = Array.from({ length: 200 }, (_, index) => row(`msg_${String(index + 5).padStart(4, '0')}`));
  const calls = [];
  const base = reader({ parts: [], children: { ses_root: ['ses_child'], ses_child: ['ses_grandchild'] }, childRows: { ses_child: [row('msg_repair', chain('npm test'))] }, calls });
  const api = async (route, options) => {
    if (route.startsWith('/api/session/ses_root/message')) {
      calls.push({ route, options });
      return route.includes('&before=msg_0005') ? [row('msg_0001')] : firstPage;
    }
    return base(route, options);
  };
  const evidence = await capture(project, api);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.collection.complete, true);
  assert.deepEqual(evidence.sessionIDs, ['ses_root', 'ses_child', 'ses_grandchild']);
  assert.equal(evidence.sessions[0].messageCount, 201);
  assert.ok(calls.some(call => call.route.includes('&before=msg_0005')));
}));

const managed = () => {
  const task = { taskId: 'dvr_task_one', rootSessionId: 'ses_root', childSessionId: 'ses_child', dispatchCallId: 'call_1', mode: 'orchestrator', dispatchGrouped: true, status: 'completed', prompt: 'Never export this raw prompt.' };
  const envelope = { envelopeId: 'envelope_one', taskId: task.taskId, rootSessionId: 'ses_root', status: 'completed', action: 'continue', result: 'Never export this raw result.' };
  const start = tool('devryan_task', 1, { action: 'start', prompt: 'Never export delegated prompts.' });
  start.state.output = JSON.stringify({ task });
  const disposition = tool('devryan_task', 2, { action: 'continue', task_id: task.taskId });
  disposition.state.output = JSON.stringify({ task, resultEnvelope: envelope });
  return { parts: [start, disposition], children: { ses_root: ['ses_child'] },
    snapshot: { available: true, bridgeReady: true, recoveryWarning: null, tasks: [task], resultEnvelopes: [envelope] },
    handoff: { rootSessionId: 'ses_root', fromMode: 'orchestrator', toMode: 'builder', state: 'clear', tasks: [], failures: [] } };
};

const managedRepair = () => {
  const data = managed();
  data.parts.splice(1, 0, tool('read', 10, { filePath: 'src/tasks.mjs' }), tool('bash', 40, { command: 'node --test test/tasks.test.mjs' }, { exit: 0 }));
  data.childRows = { ses_child: [row('msg_child_repair', [
    tool('bash', 20, { command: 'node --test test/tasks.test.mjs' }, { exit: 1 }), tool('edit', 30, { filePath: 'src/tasks.mjs' }),
  ])] };
  return data;
};

test('Orchestrator reconciliation links dispatch, canonical child, disposition and actual readonly scheduler clearance', () => withProject(async project => {
  const calls = [];
  const evidence = await capture(project, reader({ ...managed(), calls }), { agent: 'orchestrator', requireProjectWork: false });
  assert.equal(evidence.passed, true);
  assert.equal(evidence.managed.barrier.state, 'clear');
  assert.equal(evidence.managed.grade.passed, true);
  assert.doesNotMatch(JSON.stringify(evidence), /Never export|prompt|result"/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
}));

test('Orchestrator project acceptance additionally requires native failing verification before a repair and passing verification', () => withProject(async project => {
  const missing = await capture(project, reader(managed()), { agent: 'orchestrator' });
  assert.equal(missing.managed.grade.passed, true);
  assert.equal(missing.passed, false);
  assert.equal(missing.checks.find(item => item.id === 'qa.orchestrator-causal-repair').passed, false);
  const evidence = await capture(project, reader(managedRepair()), { agent: 'orchestrator' });
  assert.equal(evidence.passed, true);
  assert.equal(evidence.repair.suite.passed, true);
  assert.ok(evidence.repair.suiteTools.filter(event => event.ordinal).every(event => event.callID && event.sessionID));
  assert.deepEqual(evidence.repair.suiteTools.filter(event => event.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal).map(event => [event.sessionScope, event.ownedTestOutcome ?? event.tool]),
  [['root', 'read'], ['child', 'failed'], ['child', 'edit'], ['root', 'passed']]);
  assert.doesNotMatch(JSON.stringify(evidence.repair), /secret raw|command"|output"|state"|time"/);
  for (const mutate of [
    data => { data.childRows.ses_child[0].parts[0].state.metadata = {}; },
    data => { data.childRows.ses_child[0].parts[0].state.metadata.exit = 0; },
    data => { data.childRows.ses_child[0].parts[0].state.input.cwd = '/tmp'; },
    data => { data.childRows.ses_child[0].parts[0].state.input.command += ' || true'; },
    data => { data.childRows.ses_child[0].parts[1].state.time.start = 204; },
    data => { data.parts.find(part => part.callID === 'call_40').state.metadata.exit = 1; },
    data => { data.children.ses_root.push('ses_unmanaged'); },
    data => { data.snapshot.resultEnvelopes[0].action = null; },
  ]) {
    const data = managedRepair(); mutate(data);
    assert.equal((await capture(project, reader(data), { agent: 'orchestrator' })).passed, false, mutate.toString());
  }
  await writeFile(path.join(project.fixtureRoot, 'test/tasks.test.mjs'), '// removed original tests\n');
  const rewritten = await capture(project, reader(managedRepair()), { agent: 'orchestrator' });
  assert.equal(rewritten.repair.provenance.originalTestsRetained, false);
  assert.equal(rewritten.passed, false);
}));

test('only successful owned source reads and mutations can supply either role’s causal repair', () => withProject(async project => {
  for (const agent of ['builder', 'orchestrator']) {
    const run = async parts => {
      const data = agent === 'orchestrator' ? managed() : {};
      data.parts = [...(data.parts ?? []), ...parts];
      return capture(project, reader(data), { agent });
    };
    for (const change of [
      parts => { parts[0].state.input.filePath = 'README.md'; },
      parts => { parts[2].state.input.filePath = 'README.md'; },
      parts => { parts[0].state.input.path = 'src/store.mjs'; },
      parts => { parts[2].state.input.filePath = '../outside.mjs'; },
      parts => { parts[2].state.input.filePath = 'src/missing.mjs'; },
    ]) {
      const parts = chain('npm test'); change(parts);
      assert.equal((await run(parts)).passed, false, `${agent}: ${change.toString()}`);
    }
    const overlap = chain('npm test');
    overlap[2].state.time.start = 21;
    overlap.push(tool('edit', 36, { filePath: 'README.md' }));
    overlap[3].state.time = { start: 400, end: 405 };
    assert.equal((await run(overlap)).passed, false,
      'A later unrelated edit cannot replace the owned source repair that overlapped RED');
    const patch = chain('npm test');
    patch[2].tool = 'apply_patch';
    patch[2].state.input = { patchText: '*** Begin Patch\n*** Update File: src/tasks.mjs\n@@\n-old\n+new\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch' };
    const evidence = await run(patch);
    assert.equal(evidence.passed, true);
    assert.deepEqual(evidence.repair.suiteTools.find(event => event.ordinal === 3).ownedSource,
      { kind: 'mutation', relativePaths: ['src/tasks.mjs'] });
  }
  await symlink('tasks.mjs', path.join(project.fixtureRoot, 'src/alias.mjs'));
  const aliased = chain('npm test'); aliased[0].state.input.filePath = 'src/alias.mjs';
  assert.equal((await capture(project, reader({ parts: aliased }))).passed, false);
}));

test('Plan child policy requires canonical wildcard denial and safe enabled tools, scoped to actual plan dispatch turns', () => {
  const plan = { info: { id: 'msg_plan', role: 'user' }, parts: [{ type: 'text', synthetic: true, text: 'User has requested to enter plan mode' }] };
  const start = row('msg_start', [tool('devryan_task', 1, { action: 'start' })]); start.info.parentID = plan.info.id;
  const child = { info: { id: 'msg_child_user', role: 'user', tools: { '*': false, read: true, oc_read: true, ctx_index: true, task: false } }, parts: [] };
  const tree = [{ sessionId: 'ses_root', messages: [plan, start] }, { sessionId: 'ses_child', messages: [child] }];
  const tasks = [{ taskId: 'task_one', childSessionId: 'ses_child', dispatchCallId: 'call_1' }];
  assert.equal(projectQaPlanChildPolicy(tree, 'ses_root', tasks).passed, true);
  for (const mutation of [
    value => { delete value[1].messages[0].info.tools; },
    value => { value[1].messages[0].info.tools['*'] = true; },
    value => { value[1].messages[0].info.tools.bash = true; },
    value => { value[1].messages[0].info.tools.custom_writer = true; },
    value => { value[0].messages[0].parts[0].synthetic = false; },
    value => { value[0].messages[1].info.parentID = 'unrelated'; },
  ]) { const value = structuredClone(tree); mutation(value); assert.equal(projectQaPlanChildPolicy(value, 'ses_root', tasks).passed, false); }
  const implementation = row('msg_implementation', [tool('devryan_task', 3, { action: 'start' })]); implementation.info.parentID = 'msg_approved';
  tree[0].messages.push({ info: { id: 'msg_approved', role: 'user' }, parts: [] }, implementation);
  tree.push({ sessionId: 'ses_writable', messages: [{ info: { id: 'msg_build', role: 'user', tools: { edit: true } }, parts: [] }] });
  tasks.push({ taskId: 'task_build', childSessionId: 'ses_writable', dispatchCallId: 'call_3' });
  const result = projectQaPlanChildPolicy(tree, 'ses_root', tasks);
  assert.equal(result.passed, true); assert.equal(result.children.length, 1);
});

test('managed acceptance fails closed on unresolved barriers, missing dispositions, duplicate starts and wrong child/call identities', () => withProject(async project => {
  for (const mutation of [
    data => { data.handoff.state = 'confirmation_required'; },
    data => { delete data.handoff.tasks; },
    data => { data.handoff.rootSessionId = 'ses_other'; },
    data => { data.snapshot.tasks[0].mode = 'builder'; },
    data => { data.snapshot.bridgeReady = false; },
    data => { data.snapshot.resultEnvelopes[0].action = null; },
    data => { data.snapshot.resultEnvelopes.push({ ...data.snapshot.resultEnvelopes[0], taskId: 'orphan' }); },
    data => { data.parts.pop(); },
    data => { data.parts.push(structuredClone(data.parts[0])); },
    data => { data.parts[0].callID = 'call_wrong'; },
    data => { data.parts[0].state.output = JSON.stringify({ task: { ...data.snapshot.tasks[0], childSessionId: 'ses_wrong' } }); },
    data => { data.children.ses_root.push('ses_extra'); },
  ]) {
    const data = managedRepair(); mutation(data);
    const evidence = await capture(project, reader(data), { agent: 'orchestrator' });
    assert.equal(evidence.passed, false, mutation.toString());
  }
}));

test('capture failures are bounded and sanitized while discovered children remain available to cleanup', () => withProject(async project => {
  const data = managed();
  const base = reader(data);
  const evidence = await capture(project, async (route, options) => {
    if (route.startsWith('/api/session/ses_child/message')) throw new Error('Private output and secret details');
    return base(route, options);
  }, { agent: 'orchestrator' });
  assert.equal(evidence.passed, false); assert.equal(evidence.collection.complete, false);
  assert.deepEqual(evidence.sessionIDs, ['ses_root', 'ses_child']);
  assert.doesNotMatch(JSON.stringify(evidence), /Private|secret/);
  const started = Date.now();
  const timedOut = await capture(project, async () => new Promise(() => {}), { timeoutMs: 25 });
  assert.equal(timedOut.collection.reason, 'qa_evidence_deadline');
  assert.ok(Date.now() - started < 1_000);
}));

test('cleanup reuses bounded recursive abort, includes known children and rejects non-owned directories before APIs', () => withProject(async project => {
  const calls = [];
  const api = reader({ children: { ses_root: ['ses_child'], ses_child: ['ses_grandchild'] }, calls });
  const result = await cleanupQaSessionTree({ api, rootSessionID: 'ses_root', directory: project.fixtureRoot, knownSessionIds: ['ses_known'] });
  assert.equal(result.complete, true);
  const aborted = calls.filter(call => call.route.includes('/abort?')).map(call => call.route.split('/')[3]);
  assert.ok(aborted.indexOf('ses_grandchild') < aborted.indexOf('ses_child'));
  assert.ok(aborted.indexOf('ses_child') < aborted.indexOf('ses_root'));
  assert.ok(aborted.includes('ses_known'));
  await assert.rejects(cleanupQaSessionTree({ api: () => assert.fail('must not call API'), rootSessionID: 'ses_root', directory: rootPath() }), /owned project/);
}));

const rootPath = () => path.resolve('.');

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertQaCompactionPlanUnchanged, assertQaCompactionProjectPlanUnchanged,
  captureQaCompactionPlanReference, captureQaCompactionProjectPlan, prepareQaCompactionApproval,
  readQaSavedPlanRevision,
} from './compaction-approval.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';

const plan = '# Current Task Board plan\n\n## Context\n\nKeep task creation order — aperçu.\n\n## Implementation\n\nAdd a labeled Priority filter, preserve the user note, and verify persistent low/normal/high values.\n';
const digest = text => createHash('sha256').update(text).digest('hex');
const identity = directory => ({ sessionId: 'ses_root', sourceMessageId: 'msg_revision2', directory,
  sessionCreated: 1_750_000_000_000, sessionSlug: 'task-board' });

async function withFixture(runId, action) {
  const fixture = createQaProjectFixture({ runId });
  try { return await action(fixture); }
  finally {
    removeQaProjectFixture(fixture);
    await rm(fixture.evidenceDirectory, { recursive: true, force: true });
  }
}

async function savedRevision(fixture) {
  const revision = identity(fixture.fixtureRoot);
  const originalIdentity = structuredClone(revision);
  const ownedPlansRoot = path.join(fixture.evidenceDirectory, 'app-data', 'plans');
  const canonicalPath = path.join(ownedPlansRoot, 'revision-2.md');
  const evidencePath = path.join(fixture.evidenceDirectory, 'revision-2.md');
  await mkdir(ownedPlansRoot, { recursive: true });
  await writeFile(canonicalPath, plan);
  await writeFile(evidencePath, plan);
  const savedPlan = { path: evidencePath, sha256: digest(plan), sourceMessageID: revision.sourceMessageId,
    userMessageID: 'msg_revision2_request', revision, canonicalPath };
  const remote = { identity: structuredClone(revision), canonicalPath, content: plan };
  const readCalls = [];
  const readSavedRevision = async requested => {
    readCalls.push(structuredClone(requested));
    const observed = await readQaSavedPlanRevision(async () => ({ path: remote.canonicalPath, content: remote.content }),
      requested, ownedPlansRoot);
    if (Object.keys(originalIdentity).some(key => remote.identity[key] !== originalIdentity[key])) {
      observed.identity = structuredClone(remote.identity);
    }
    return observed;
  };
  return { savedPlan, remote, readCalls, readSavedRevision, ownedPlansRoot };
}

test('revision reads use the complete exact identity and bypass cached API responses', async () => withFixture('compaction-revision-api', async fixture => {
  const data = await savedRevision(fixture);
  const revision = identity(path.join(fixture.fixtureRoot, 'directory with spaces'));
  const original = structuredClone(revision);
  const canonicalPath = data.savedPlan.canonicalPath;
  let calls = 0;
  const result = await readQaSavedPlanRevision(async (route, options) => {
    calls++;
    const url = new URL(route, 'http://qa.invalid');
    assert.equal(url.pathname, '/api/session/ses_root/plan-revisions/msg_revision2');
    assert.deepEqual(Object.fromEntries(url.searchParams), { directory: original.directory,
      sessionCreated: String(original.sessionCreated), sessionSlug: original.sessionSlug });
    assert.equal(options?.cache, 'no-store');
    assert.ok(options?.method === undefined || options.method === 'GET');
    return { path: canonicalPath, content: plan };
  }, revision, data.ownedPlansRoot);
  assert.equal(calls, 1);
  assert.deepEqual(result, { identity: original, canonicalPath, content: plan });
}));

test('revision reads reject invalid identity before making an API request', async () => {
  const valid = identity('/owned/project');
  const invalid = [null, {}, ...Object.keys(valid).map(key => ({ ...valid, [key]: undefined })),
    ...['sessionId', 'sourceMessageId', 'directory', 'sessionSlug'].map(key => ({ ...valid, [key]: '' })),
    { ...valid, directory: 'relative/project' },
    ...[null, '1750000000000', NaN, Infinity, -1, 1.5].map(sessionCreated => ({ ...valid, sessionCreated }))];
  for (const revision of invalid) {
    let calls = 0;
    await assert.rejects(readQaSavedPlanRevision(async () => { calls++; return { path: '/owned/plan.md', content: plan }; }, revision),
      /exact saved Plan revision identity/);
    assert.equal(calls, 0, JSON.stringify(revision));
  }
});

test('revision reads reject unavailable, missing, relative, sanitized, and empty canonical files', async () => withFixture('compaction-invalid-api-file', async fixture => {
  const data = await savedRevision(fixture);
  const revision = data.savedPlan.revision;
  const canonicalPath = data.savedPlan.canonicalPath;
  await assert.rejects(readQaSavedPlanRevision(async () => { throw new Error('HTTP 404: unavailable'); }, revision, data.ownedPlansRoot), /404/);
  for (const response of [null, {}, { path: '', content: plan }, { path: 'relative/plan.md', content: plan },
    { path: '<WORKTREE_1>/plan.md', content: plan }, { path: canonicalPath },
    { path: canonicalPath, content: '' }, { path: canonicalPath, content: ' \n' }]) {
    await assert.rejects(readQaSavedPlanRevision(async () => response, revision, data.ownedPlansRoot));
  }
}));

test('revision reads require a separately supplied existing ordinary owned plans root', async () => withFixture('compaction-owned-plan-root', async fixture => {
  const data = await savedRevision(fixture);
  const api = async () => ({ path: data.savedPlan.canonicalPath, content: plan });
  const missingRoot = path.join(fixture.evidenceDirectory, 'not-created-plans');
  for (const ownedPlansRoot of [undefined, null, '', 'relative/plans', missingRoot, data.savedPlan.canonicalPath]) {
    await assert.rejects(readQaSavedPlanRevision(api, data.savedPlan.revision, ownedPlansRoot));
  }
  await assert.rejects(lstat(missingRoot), { code: 'ENOENT' }, 'The reader must not create its authority directory');
  assert.equal(await readFile(data.savedPlan.canonicalPath, 'utf8'), plan);
}));

test('API path and revision directory cannot authorize a file outside the pinned plans root', async () => withFixture('compaction-plan-root-escape', async fixture => {
  const data = await savedRevision(fixture);
  const escapedPaths = [path.join(fixture.evidenceDirectory, 'sibling-project', 'plan.md'),
    path.join(data.ownedPlansRoot + '-sibling', 'plan.md'),
    path.join(fixture.fixtureRoot, '.opencode', 'plans', 'qa-current.md')];
  for (const escapedPath of escapedPaths) {
    await mkdir(path.dirname(escapedPath), { recursive: true });
    await writeFile(escapedPath, plan);
    const changedDirectory = { ...data.savedPlan.revision, directory: path.dirname(escapedPath) };
    await assert.rejects(readQaSavedPlanRevision(async () => ({ path: escapedPath, content: plan }),
      changedDirectory, data.ownedPlansRoot));
    assert.equal(await readFile(escapedPath, 'utf8'), plan);
  }
  await assert.rejects(readQaSavedPlanRevision(async () => ({ path: data.ownedPlansRoot, content: plan }),
    data.savedPlan.revision, data.ownedPlansRoot));
  await assert.rejects(readQaSavedPlanRevision(async () => ({ path: data.ownedPlansRoot + '/./revision-2.md', content: plan }),
    data.savedPlan.revision, data.ownedPlansRoot));
}));

test('revision reads reject a symlink leaf even when its target stays inside the owned root', async () => withFixture('compaction-plan-leaf-symlink', async fixture => {
  const data = await savedRevision(fixture);
  const target = path.join(data.ownedPlansRoot, 'actual-plan.md');
  await rename(data.savedPlan.canonicalPath, target);
  await symlink(target, data.savedPlan.canonicalPath);
  await assert.rejects(data.readSavedRevision(data.savedPlan.revision));
  assert.equal((await lstat(data.savedPlan.canonicalPath)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), plan);
}));

test('revision reads reject an aliased parent both inside and outside the owned root', async () => withFixture('compaction-plan-parent-alias', async fixture => {
  const data = await savedRevision(fixture);
  const targets = [path.join(data.ownedPlansRoot, 'actual'), path.join(fixture.evidenceDirectory, 'outside-plans')];
  for (const [index, target] of targets.entries()) {
    await mkdir(target);
    await writeFile(path.join(target, 'plan.md'), plan);
    const alias = path.join(data.ownedPlansRoot, `alias-${index}`);
    await symlink(target, alias);
    await assert.rejects(readQaSavedPlanRevision(async () => ({ path: path.join(alias, 'plan.md'), content: plan }),
      data.savedPlan.revision, data.ownedPlansRoot));
  }
}));

test('revision reads reject symlinks at the owned root and its ancestors', async () => {
  for (const redirected of ['root', 'ancestor']) await withFixture('compaction-plan-root-alias', async fixture => {
    const data = await savedRevision(fixture);
    const original = redirected === 'root' ? data.ownedPlansRoot : path.dirname(data.ownedPlansRoot);
    const target = original + '-actual';
    await rename(original, target);
    await symlink(target, original);
    await assert.rejects(data.readSavedRevision(data.savedPlan.revision));
  });
});

test('revision reads recheck a root redirected while the API response is pending', async () => withFixture('compaction-plan-api-redirect', async fixture => {
  const data = await savedRevision(fixture);
  await assert.rejects(readQaSavedPlanRevision(async () => {
    const target = data.ownedPlansRoot + '-redirected';
    await rename(data.ownedPlansRoot, target);
    await symlink(target, data.ownedPlansRoot);
    return { path: data.savedPlan.canonicalPath, content: plan };
  }, data.savedPlan.revision, data.ownedPlansRoot));
}));

test('revision reads reject disk versus API disagreement without repairing or recreating files', async () => withFixture('compaction-plan-disk-bytes', async fixture => {
  const data = await savedRevision(fixture);
  const changed = plan.replace('normal', 'formal');
  await writeFile(data.savedPlan.canonicalPath, changed);
  await assert.rejects(data.readSavedRevision(data.savedPlan.revision));
  assert.equal(await readFile(data.savedPlan.canonicalPath, 'utf8'), changed);
  await writeFile(data.savedPlan.canonicalPath, plan);
  data.remote.content = changed;
  await assert.rejects(data.readSavedRevision(data.savedPlan.revision));
  assert.equal(await readFile(data.savedPlan.canonicalPath, 'utf8'), plan);
  data.remote.content = plan;
  await rm(data.savedPlan.canonicalPath);
  await assert.rejects(data.readSavedRevision(data.savedPlan.revision), { code: 'ENOENT' });
  await assert.rejects(lstat(data.savedPlan.canonicalPath), { code: 'ENOENT' });
}));

test('PlanON pins the saved API revision and UTF-8 bytes without a project plan file', async () => withFixture('compaction-revision-pin', async fixture => {
  const data = await savedRevision(fixture);
  const expected = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
  assert.deepEqual(expected, { kind: 'session-revision', identity: data.savedPlan.revision,
    userMessageID: data.savedPlan.userMessageID, canonicalPath: data.savedPlan.canonicalPath,
    sha256: digest(plan), bytes: Buffer.byteLength(plan, 'utf8') });
  assert.ok(expected.bytes > plan.length);
  await assert.rejects(lstat(path.join(fixture.fixtureRoot, '.opencode/plans/qa-current.md')), { code: 'ENOENT' });
  assert.deepEqual(await assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan: expected,
    readSavedRevision: data.readSavedRevision }), expected);
}));

test('PlanON captures only a matching revision, source, path, hash, and originating user', async () => withFixture('compaction-invalid-pin', async fixture => {
  for (const mutate of [
    value => { delete value.savedPlan.revision; },
    value => { delete value.savedPlan.userMessageID; },
    value => { value.savedPlan.sourceMessageID = 'msg_latest'; },
    value => { value.savedPlan.canonicalPath += '.other'; },
    value => { value.savedPlan.sha256 = digest('different'); },
    value => { value.remote.identity.sourceMessageId = 'msg_latest'; },
    value => { value.remote.canonicalPath += '.other'; },
    value => { value.remote.content = ''; },
  ]) {
    const data = await savedRevision(fixture);
    mutate(data);
    await assert.rejects(captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data }), mutate.toString());
  }
}));

test('paused boundaries retain the original full identity when later UI and session pointers change', async () => withFixture('compaction-pinned-identity', async fixture => {
  const data = await savedRevision(fixture);
  const original = structuredClone(data.savedPlan.revision);
  const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
  Object.assign(data.savedPlan.revision, { sessionId: 'ses_other', sourceMessageId: 'msg_latest', directory: '/owned/later-worktree',
    sessionCreated: original.sessionCreated + 1, sessionSlug: 'later-slug' });
  data.savedPlan.sourceMessageID = 'msg_latest';
  data.savedPlan.canonicalPath = '/owned/app-data/plans/latest.md';
  for (let boundary = 0; boundary < 2; boundary++) {
    assert.deepEqual(await assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
      readSavedRevision: data.readSavedRevision }), expectedPlan);
  }
  assert.deepEqual(expectedPlan.identity, original, 'The pin must own its identity snapshot');
  assert.ok(data.readCalls.length >= 3);
  for (const requested of data.readCalls) assert.deepEqual(requested, original);
}));

test('paused boundaries reject identity, path, and byte changes with the evidence copy intact', async () => withFixture('compaction-revision-changes', async fixture => {
  const changes = [
    ...['sessionId', 'sourceMessageId', 'directory', 'sessionSlug'].map(key => value => { value.remote.identity[key] += '-changed'; }),
    value => { value.remote.identity.sessionCreated++; },
    value => { value.remote.canonicalPath += '.new'; },
    value => { value.remote.content = plan.replace('normal', 'formal'); },
    value => { value.remote.content = plan + '\n'; },
    value => { value.remote.content = ''; },
  ];
  for (const mutate of changes) {
    const data = await savedRevision(fixture);
    const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
    mutate(data);
    assert.equal(data.savedPlan.sha256, digest(plan));
    await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
      readSavedRevision: data.readSavedRevision }), mutate.toString());
  }
  const data = await savedRevision(fixture);
  const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
  await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
    readSavedRevision: async () => { throw new Error('HTTP 404: missing original revision'); } }), /404/);
}));

test('paused checks reject a real replacement path or changed canonical bytes even when the API agrees', async () => withFixture('compaction-plan-authoritative-change', async fixture => {
  for (const change of ['path', 'bytes']) {
    const data = await savedRevision(fixture);
    const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
    if (change === 'path') {
      data.remote.canonicalPath = path.join(data.ownedPlansRoot, 'other-revision.md');
      await writeFile(data.remote.canonicalPath, plan);
    } else {
      data.remote.content = plan.replace('normal', 'formal');
      await writeFile(data.savedPlan.canonicalPath, data.remote.content);
    }
    await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
      readSavedRevision: data.readSavedRevision }), change);
    assert.equal(await readFile(data.savedPlan.path, 'utf8'), plan, 'The retained evidence copy remains unchanged');
  }
}));

test('paused checks revalidate the original canonical file after filesystem redirects', async () => {
  for (const change of ['leaf', 'root', 'disk']) await withFixture('compaction-plan-paused-redirect', async fixture => {
    const data = await savedRevision(fixture);
    const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
    if (change === 'leaf') {
      const target = path.join(data.ownedPlansRoot, 'redirected.md');
      await rename(data.savedPlan.canonicalPath, target);
      await symlink(target, data.savedPlan.canonicalPath);
    } else if (change === 'root') {
      const target = data.ownedPlansRoot + '-redirected';
      await rename(data.ownedPlansRoot, target);
      await symlink(target, data.ownedPlansRoot);
    } else await writeFile(data.savedPlan.canonicalPath, plan.replace('normal', 'formal'));
    await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
      readSavedRevision: data.readSavedRevision }), change);
    assert.equal(data.remote.content, plan, 'The API copy remains unchanged');
    assert.equal(await readFile(data.savedPlan.path, 'utf8'), plan, 'The retained evidence copy remains unchanged');
  });
});

test('paused checks require the complete original baseline and never silently recapture it', async () => withFixture('compaction-required-pin', async fixture => {
  const data = await savedRevision(fixture);
  const valid = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
  for (const key of ['kind', 'identity', 'userMessageID', 'canonicalPath', 'sha256', 'bytes']) {
    const expectedPlan = structuredClone(valid);
    delete expectedPlan[key];
    await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan,
      readSavedRevision: data.readSavedRevision }), key);
  }
}));

async function runApproval(mutation, afterBaseline) {
  return withFixture('compaction-approval', async fixture => {
    const data = await savedRevision(fixture);
    const expectedPlan = await captureQaCompactionPlanReference({ planMode: true, projectFixture: fixture, ...data });
    const newPath = path.join(fixture.evidenceDirectory, 'fresh-ui-plan.md');
    await writeFile(newPath, plan);
    const savedPlan = { path: newPath, sha256: digest(plan), sourceMessageID: 'msg_fresh', userMessageID: 'msg_request',
      revision: { ...identity(fixture.fixtureRoot), sourceMessageId: 'msg_fresh' },
      canonicalPath: path.join(data.ownedPlansRoot, 'fresh-ui-plan.md') };
    await writeFile(savedPlan.canonicalPath, plan);
    const previousRows = [{ info: { id: 'msg_revision2', sessionID: 'ses_root', role: 'assistant' }, parts: [] }];
    await afterBaseline?.({ fixture, ...data, expectedPlan, savedPlan, previousRows });
    let sent = 0;
    const prepared = await prepareQaCompactionApproval({
      projectFixture: fixture, priorSavedPlan: data.savedPlan, expectedPlan, evidenceName: 'fresh-ui-plan',
      readSavedRevision: async requested => {
        if (requested.sourceMessageId === 'msg_fresh') return readQaSavedPlanRevision(async () => ({
          path: savedPlan.canonicalPath, content: plan }), requested, data.ownedPlansRoot);
        return data.readSavedRevision(requested);
      },
      messages: async () => previousRows,
      sendTurn: async text => {
        sent++;
        assert.ok(text.includes(expectedPlan.canonicalPath), 'Approval must name the pinned raw canonical path');
        assert.doesNotMatch(text, /creation.order|priority.filter|aperçu/i, 'Approval cannot refeed forgotten requirements');
        assert.doesNotMatch(text, /qa-current\.md/, 'PlanON must not substitute the project plan contract');
        const user = { info: { id: 'msg_request', sessionID: 'ses_root', role: 'user', time: { created: 1 } }, parts: [
          { type: 'text', text }, { type: 'text', text: 'User has requested to enter plan mode.', synthetic: true },
        ] };
        const read = { type: 'tool', id: 'prt_read', callID: 'call_read', messageID: 'msg_read', sessionID: 'ses_root', tool: 'read',
          state: { status: 'completed', input: { filePath: expectedPlan.canonicalPath }, output: plan,
            time: { start: 20, end: 30 } } };
        const readSource = { info: { id: 'msg_read', sessionID: 'ses_root', parentID: 'msg_request', role: 'assistant',
          finish: 'tool-calls', time: { created: 10, completed: 35 } }, parts: [read] };
        const source = { info: { id: 'msg_fresh', sessionID: 'ses_root', parentID: 'msg_request', role: 'assistant',
          finish: 'stop', time: { created: 40, completed: 100 } }, parts: [{ type: 'text', text: '<!--plan-->\n' + plan }] };
        const rows = [...previousRows, user, readSource, source];
        await mutation?.({ fixture, ...data, expectedPlan, user, read, readSource, source, savedPlan, rows, previousRows });
        return rows;
      },
      captureSavedPlan: async (name, options) => {
        assert.equal(name, 'fresh-ui-plan');
        assert.equal(options?.userMessageID, 'msg_request');
        return savedPlan;
      },
    });
    assert.equal(sent, 1);
    return prepared;
  });
}

test('PlanON approval reads the original pinned path then presents a fresh full canonical Plan source', async () => {
  const { savedPlan, evidence } = await runApproval();
  assert.equal(savedPlan.sourceMessageID, 'msg_fresh');
  assert.equal(evidence.reason, 'human-plan-request-supersession');
  assert.equal(evidence.previousUISourceMessageID, 'msg_revision2');
  assert.equal(evidence.freshUISourceMessageID, 'msg_fresh');
  assert.equal(evidence.freshSourceParentID, evidence.requestedUserMessageID);
  assert.equal(evidence.completeCurrentPlan, true);
  assert.equal(evidence.projectUnchanged, true);
  await runApproval(({ read }) => { read.tool = 'oc_read'; });
});

test('approval rejects stale, partial, superseded, or unproven canonical Plan sources', async () => {
  const mutations = [
    ({ savedPlan }) => { savedPlan.sourceMessageID = 'msg_revision2'; },
    ({ savedPlan }) => { savedPlan.userMessageID = 'msg_other_request'; },
    ({ savedPlan }) => { savedPlan.revision.sourceMessageId = 'msg_latest'; },
    ({ source }) => { source.info.summary = true; },
    ({ source }) => { source.info.sessionID = 'ses_other'; },
    ({ source }) => { source.info.error = { name: 'UnknownError' }; },
    ({ source }) => { source.info.finish = 'tool-calls'; },
    ({ source }) => { source.info.time.created = undefined; },
    ({ source }) => { source.info.time.completed = undefined; },
    ({ source }) => { source.info.time.completed = 39; },
    ({ source }) => { source.info.time.completed = '100'; },
    ({ source }) => { source.parts[0].text = '<!--plan-->\n# Partial plan'; },
    ({ source }) => { source.parts[0].text = plan; },
    ({ source }) => { source.parts[0].text += '\n<!--plan-->\n' + plan; },
    ({ user }) => { user.parts = user.parts.slice(0, 1); },
    async ({ savedPlan }) => { await writeFile(savedPlan.path, '# Partial plan\n'); },
    async ({ fixture }) => { await writeFile(path.join(fixture.fixtureRoot, 'src/tasks.mjs'), '// changed\n'); },
  ];
  for (const mutation of mutations) await assert.rejects(runApproval(mutation), mutation.toString());
  for (const parentID of ['unrelated-previous-user', 'unproven-native-continuation', undefined]) {
    await assert.rejects(runApproval(({ source }) => { source.info.parentID = parentID; }));
  }
});

test('approval requires a fresh successful native read of the exact canonical path', async () => {
  const mutations = [
    ({ rows }) => { rows.splice(2, 1); },
    ({ readSource }) => { readSource.parts = [{ type: 'text', text: 'I successfully read the saved plan.' }]; },
    ({ read }) => { read.state.status = 'running'; },
    ({ read }) => { read.state.status = 'error'; read.state.error = 'Permission denied'; },
    ({ read }) => { read.state.output = ''; },
    ({ read }) => { read.state.output = ' \n'; },
    ({ read }) => { read.tool = 'file_read'; },
    ({ read }) => { read.tool = 'context_mode_execute'; },
    ({ read }) => { read.tool = 'bash'; read.state.input = { command: 'cat ' + read.state.input.filePath }; },
    ({ read }) => { read.state.input.filePath += '.other'; },
    ({ read }) => { read.state.input.filePath = '.opencode/plans/qa-current.md'; },
    ({ read }) => { read.state.input.filePath = '<WORKTREE_1>/plans/revision-2.md'; },
    ({ read }) => { read.state.input.path = read.state.input.filePath; },
    ({ read }) => { delete read.callID; },
    ({ read }) => { read.messageID = 'msg_other'; },
    ({ read }) => { read.sessionID = 'ses_other'; },
    ({ readSource }) => { readSource.info.sessionID = 'ses_child'; },
    ({ readSource }) => { readSource.info.parentID = 'msg_other_request'; },
    ({ readSource }) => { readSource.info.summary = true; },
    ({ readSource }) => { readSource.info.role = 'user'; },
  ];
  for (const mutation of mutations) await assert.rejects(runApproval(mutation), mutation.toString());
  await assert.rejects(runApproval(undefined, ({ previousRows }) => {
    previousRows.push({ info: { id: 'msg_read', sessionID: 'ses_root', role: 'assistant' }, parts: [] });
  }));
});

test('native read completion must have valid numeric timing before the final Plan source begins', async () => {
  for (const time of [{}, { start: 20 }, { end: 30 }, { start: '20', end: 30 }, { start: 20, end: '30' },
    { start: NaN, end: 30 }, { start: 20, end: Infinity }, { start: -1, end: 30 },
    { start: 30, end: 20 }, { start: 20, end: 41 }]) {
    await assert.rejects(runApproval(({ read }) => { read.state.time = time; }), JSON.stringify(time));
  }
  await runApproval(({ read }) => { read.state.time.end = 40; });
});

test('approval rejects changes to the pinned API revision before or during preparation', async () => {
  await assert.rejects(runApproval(undefined, ({ remote }) => { remote.content += '\nChanged before approval.\n'; }));
  await assert.rejects(runApproval(({ remote }) => { remote.content += '\nChanged during approval.\n'; }));
  await assert.rejects(runApproval(({ remote }) => { remote.canonicalPath += '.replacement'; }));
  await assert.rejects(runApproval(undefined, ({ expectedPlan }) => { delete expectedPlan.sha256; }));
});

test('approval checks real canonical files for the pinned revision and the fresh Plan card', async () => {
  await assert.rejects(runApproval(undefined, async ({ remote }) => {
    await writeFile(remote.canonicalPath, plan.replace('normal', 'formal'));
  }));
  await assert.rejects(runApproval(async ({ remote }) => {
    const target = remote.canonicalPath + '.actual';
    await rename(remote.canonicalPath, target);
    await symlink(target, remote.canonicalPath);
  }));
  await assert.rejects(runApproval(async ({ savedPlan }) => {
    await writeFile(savedPlan.canonicalPath, '# Partial physical Plan card\n');
  }));
  await assert.rejects(runApproval(async ({ savedPlan }) => {
    await rm(savedPlan.canonicalPath);
  }));
});

test('PlanOFF retains the owned project-file contract without reading a session revision', async () => withFixture('compaction-project-reference', async fixture => {
  const projectPlanPath = path.join(fixture.fixtureRoot, '.opencode/plans/qa-current.md');
  await mkdir(path.dirname(projectPlanPath), { recursive: true });
  await writeFile(projectPlanPath, plan);
  const readSavedRevision = async () => { throw new Error('PlanOFF cannot read an app plan revision'); };
  const expectedPlan = await captureQaCompactionPlanReference({ planMode: false, projectFixture: fixture, readSavedRevision });
  assert.deepEqual(expectedPlan, { kind: 'project-file', ...await captureQaCompactionProjectPlan(fixture) });
  assert.deepEqual(await assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan, readSavedRevision }), expectedPlan);
  await writeFile(projectPlanPath, plan + '\n');
  await assert.rejects(assertQaCompactionPlanUnchanged({ projectFixture: fixture, expectedPlan, readSavedRevision }));
  await rm(projectPlanPath);
  await assert.rejects(captureQaCompactionPlanReference({ planMode: false, projectFixture: fixture, readSavedRevision }), { code: 'ENOENT' });
}));

test('paused project-plan checks preserve exact bytes and reject a redirected leaf path', async () => withFixture('compaction-project-plan', async fixture => {
  const projectPlanPath = path.join(fixture.fixtureRoot, '.opencode/plans/qa-current.md');
  await mkdir(path.dirname(projectPlanPath), { recursive: true });
  await writeFile(projectPlanPath, plan);
  const expected = await captureQaCompactionProjectPlan(fixture);
  assert.deepEqual(await assertQaCompactionProjectPlanUnchanged(fixture, expected), expected);
  await writeFile(projectPlanPath, plan + '\n');
  await assert.rejects(assertQaCompactionProjectPlanUnchanged(fixture, expected), /revision-2 project plan changed/);
  await writeFile(projectPlanPath, plan);
  const replacement = path.join(path.dirname(projectPlanPath), 'replacement.md');
  await rename(projectPlanPath, replacement);
  await symlink(replacement, projectPlanPath);
  await assert.rejects(assertQaCompactionProjectPlanUnchanged(fixture, expected), /regular file/);
}));

test('project plan capture rejects a parent-directory symlink escaping the owned fixture', async () => withFixture('compaction-plan-parent-symlink', async fixture => {
  const outside = path.join(fixture.evidenceDirectory, 'outside-plans');
  await mkdir(outside);
  await writeFile(path.join(outside, 'qa-current.md'), plan);
  await mkdir(path.join(fixture.fixtureRoot, '.opencode'));
  await symlink(outside, path.join(fixture.fixtureRoot, '.opencode/plans'));
  await assert.rejects(captureQaCompactionProjectPlan(fixture), /escaped the owned fixture/);
  await assert.rejects(captureQaCompactionPlanReference({ planMode: false, projectFixture: fixture }));
}));

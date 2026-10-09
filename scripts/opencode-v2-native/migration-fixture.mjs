import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Effect, Schema } from 'effect';
import initialMigration from '@opencode/core/database/migration/20260127222353_familiar_lady_ursula';
import * as SessionV1 from '@opencode/schema/v1/session';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { repositoryPath } from './artifacts.mjs';

const execute = promisify(execFile);
export const fixtureSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const time = 1_790_812_800_000;
const model = { providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'default' };
const tokens = { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } };

/** Real legacy DDL and rows; this helper never creates a quiescence receipt or runs migration. */
export async function createMigrationFixture({ root, conversations = true }) {
  root = await repositoryPath(root);
  const sourceRoot = path.join(root, conversations ? 'legacy' : 'empty-source');
  const configRoot = path.join(sourceRoot, 'config');
  const globals = Object.fromEntries(['home', 'config', 'data', 'state', 'cache', 'bin', 'log', 'repos', 'tmp']
    .map(name => [name, name === 'config' ? path.join(configRoot, 'opencode') : path.join(sourceRoot, 'global', name)]));
  const webConfigDirectory = path.join(configRoot, 'openchamber');
  const webDataDirectory = path.join(sourceRoot, 'web-data');
  for (const directory of [...Object.values(globals), webConfigDirectory, webDataDirectory]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(globals.tmp, 'package.json'), '{"type":"commonjs"}\n');
  const gitConfig = path.join(sourceRoot, 'git-config'); await fs.writeFile(gitConfig, '');
  const template = path.join(sourceRoot, 'git-template'); await fs.mkdir(template);
  const environment = createQaHostLaunchEnvironment({ HOME: globals.home, XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state, XDG_CACHE_HOME: globals.cache,
    TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp, GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = async (directory, args) => (await execute('/usr/bin/git', args, { cwd: directory, env: environment,
    timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const projects = [], projectMap = [];
  for (const [index, name] of ['alpha', 'beta'].entries()) {
    const directory = path.join(sourceRoot, 'projects', name);
    const targetDirectory = path.join(root, 'relocated', name);
    await fs.mkdir(directory, { recursive: true });
    await git(directory, ['init', '--quiet', '--initial-branch=main', `--template=${template}`]);
    await fs.writeFile(path.join(directory, 'seed.txt'), `legacy ${name} project\n`);
    await fs.writeFile(path.join(directory, 'attachment.txt'), `attachment ${name} exact bytes\r\n`);
    await git(directory, ['add', '--', 'seed.txt', 'attachment.txt']);
    await git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'owned synthetic baseline']);
    await git(directory, ['update-ref', 'refs/devryan/fixture-checkpoint', 'HEAD']);
    const refs = (await git(directory, ['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n');
    await fs.mkdir(path.dirname(targetDirectory), { recursive: true });
    await fs.cp(directory, targetDirectory, { recursive: true, errorOnExist: true, force: false });
    projects.push({ id: `prj_migration_${index + 1}`, directory, targetDirectory, refs });
    projectMap.push({ sourceDirectory: directory, targetDirectory, mode: 'synthetic-copy' });
  }
  const sentinels = [
    [path.join(webConfigDirectory, 'settings.json'), '{"theme":"fixture-web-only","projects":[]}\n'],
    [path.join(globals.config, 'opencode.json'), '{"agent":{"fixture-profile":{"description":"fixture-native-only"}}}\n'],
  ];
  for (const [file, bytes] of sentinels) await fs.writeFile(file, bytes);
  const databasePath = path.join(sourceRoot, 'opencode-devryan.db'); await fs.writeFile(databasePath, '');
  const db = resolveSqliteDriver().open(databasePath);
  const sessions = [], messages = [], parts = [], attachments = [], inlineAttachments = [];
  const addMessage = (sessionID, id, parentID, directory, summary = false) => {
    const info = parentID ? { id, sessionID, role: 'assistant', parentID, time: { created: time + messages.length, completed: time + messages.length + 1 },
      agent: 'build', mode: 'build', modelID: model.modelID, providerID: model.providerID, variant: model.variant,
      path: { cwd: directory, root: directory }, cost: 0, tokens, finish: 'stop', ...(summary ? { summary: true } : {}) }
      : { id, sessionID, role: 'user', time: { created: time + messages.length }, agent: 'build', model };
    Schema.decodeUnknownSync(SessionV1.Info)(info); messages.push(info); return info;
  };
  const addPart = (message, content) => {
    const part = { id: `prt_migration_${parts.length + 1}`, sessionID: message.sessionID, messageID: message.id, ...content };
    Schema.decodeUnknownSync(SessionV1.Part)(part); parts.push(part); return part;
  };
  const rules = [{ permission: '*', pattern: '*', action: 'ask' }, { permission: 'read', pattern: '*', action: 'allow' },
    { permission: 'edit', pattern: 'blocked.txt', action: 'deny' }, { permission: 'edit', pattern: 'allowed.txt', action: 'allow' }];
  try {
    // The actual public migration executes every statement against SQLite.
    // The old journal records only the migration genuinely applied here.
    await Effect.runPromise(initialMigration.up({ run: sql => Effect.sync(() => db.exec(sql)) }));
    db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL, name TEXT NOT NULL)');
    db.prepare('INSERT INTO __drizzle_migrations VALUES (1, ?, ?, ?)').run('fixture-executed-public-ddl',
      Date.UTC(2026, 0, 27, 22, 23, 53), initialMigration.id);
    for (const project of projects) db.prepare('INSERT INTO project (id,worktree,vcs,name,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?,?,?)')
      .run(project.id, project.directory, 'git', project.id, time, time, '[]');
    for (const [index, project] of projects.entries()) {
      const rootID = `ses_migration_root_${index + 1}`;
      for (const [suffix, parentID, archived] of (conversations ? [['root', null, false], ['child', rootID, false], ['archive', null, true]] : [])) {
        const id = `ses_migration_${suffix}_${index + 1}`;
        sessions.push({ id, projectID: project.id, parentID, directory: project.directory, archived, permissions: rules });
        db.prepare('INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,permission,time_created,time_updated,time_archived) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, project.id, parentID, id, project.directory, `Owned ${suffix}`, 'legacy-fixture', JSON.stringify(rules), time, time + 100, archived ? time + 100 : null);
        const user = addMessage(id, `msg_${id}_user`, null, project.directory);
        addPart(user, { type: 'text', text: `objective ${id}` });
        const assistant = addMessage(id, `msg_${id}_assistant`, user.id, project.directory);
        addPart(assistant, { type: 'tool', callID: `call_${id}_read`, tool: 'read', state: { status: 'completed', input: { filePath: 'seed.txt' },
          output: `legacy ${index + 1}`, title: 'Owned read', metadata: {}, time: { start: time + 1, end: time + 2 } } });
        addPart(assistant, { type: 'text', text: `result ${id}` });
        if (suffix === 'root') {
          const file = path.join(project.directory, 'attachment.txt'); const bytes = await fs.readFile(file);
          const filePart = addPart(user, { type: 'file', mime: 'text/plain', filename: 'attachment.txt', url: pathToFileURL(file).href });
          attachments.push({ partID: filePart.id, sessionID: id, originalURI: filePart.url, sha256: fixtureSha256(bytes), size: bytes.length });
          const inline = addPart(user, { type: 'file', mime: 'text/plain', filename: 'inline.txt', url: 'data:text/plain;base64,aW5saW5lIGF0dGFjaG1lbnQ=' });
          inlineAttachments.push({ partID: inline.id, sessionID: id, messageID: user.id, sha256: fixtureSha256('inline attachment'), size: 17 });
          const compact = addMessage(id, `msg_${id}_compact`, null, project.directory);
          addPart(compact, { type: 'compaction', auto: true, tail_start_id: user.id });
          const summary = addMessage(id, `msg_${id}_summary`, compact.id, project.directory, true);
          addPart(summary, { type: 'text', text: `preserved compact summary ${index + 1}` });
        }
      }
      db.prepare('INSERT INTO permission (project_id,time_created,time_updated,data) VALUES (?,?,?,?)')
        .run(project.id, time, time, JSON.stringify([{ permission: 'read', pattern: '*', action: 'allow' }]));
    }
    for (const info of messages) db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(info.id, info.sessionID, info.time.created, info.time.completed ?? info.time.created, JSON.stringify(info));
    for (const part of parts) db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(part.id, part.messageID, part.sessionID, time, time + 1, JSON.stringify(part));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
  return { root, environment, sourceLaunch: { opencodeDatabasePath: databasePath, webDataDirectory, webConfigDirectory,
    opencodeConfigDirectory: globals.config, global: globals }, projectMap,
    expected: { sessions, messageIDs: messages.map(row => row.id), toolCallIDs: parts.filter(row => row.type === 'tool').map(row => row.callID),
      compactions: (conversations ? projects : []).map((_, index) => ({ id: `msg_ses_migration_root_${index + 1}_compact`, foldedSummaryID: `msg_ses_migration_root_${index + 1}_summary`, summary: `preserved compact summary ${index + 1}` })),
      attachments, inlineAttachments, projects, configurations: sentinels.map(([file, bytes]) => ({ file, sha256: fixtureSha256(bytes) })),
      databaseSha256: fixtureSha256(await fs.readFile(databasePath)), appliedMigrations: [initialMigration.id] } };
}

/** Private empty initialization seed: setup/workspaces only, no conversations or old journal.
 * Its database still carries the legacy DDL and __drizzle_migrations table. */
export const createEmptyRuntimeFixture = ({ root }) => createMigrationFixture({ root, conversations: false });

/** The POSIX source every 2.x install provisions (native-default-bundle.js): a
 * zero-byte empty.db with no legacy journal, private source directories and an
 * identity workspace map. The workspace is a Git repository so project
 * discovery stops inside the fixture root. */
export async function createFreshInstallSource({ root }) {
  root = await repositoryPath(root);
  const sourceRoot = path.join(root, 'fresh-native-source');
  const sourceLaunch = { opencodeDatabasePath: path.join(sourceRoot, 'empty.db'), webDataDirectory: path.join(sourceRoot, 'web-data'),
    webConfigDirectory: path.join(sourceRoot, 'web-config'), opencodeConfigDirectory: path.join(sourceRoot, 'opencode-config'),
    global: { home: path.join(sourceRoot, 'home') } };
  for (const directory of [sourceLaunch.webDataDirectory, sourceLaunch.webConfigDirectory, sourceLaunch.opencodeConfigDirectory, sourceLaunch.global.home]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(sourceLaunch.opencodeDatabasePath, '', { flag: 'wx' });
  resolveSqliteDriver().open(sourceLaunch.opencodeDatabasePath).close();
  await fs.chmod(sourceLaunch.opencodeDatabasePath, 0o600);
  const gitConfig = path.join(root, 'git-config'); await fs.writeFile(gitConfig, '');
  const template = path.join(root, 'git-template'); await fs.mkdir(template);
  const environment = createQaHostLaunchEnvironment({ HOME: sourceLaunch.global.home, GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const directory = path.join(root, 'workspace'); await fs.mkdir(directory);
  const git = args => execute('/usr/bin/git', args, { cwd: directory, env: environment, timeout: 10_000, maxBuffer: 1024 * 1024 });
  await git(['init', '--quiet', '--initial-branch=main', `--template=${template}`]);
  await fs.writeFile(path.join(directory, 'seed.txt'), 'fresh install workspace\n');
  await git(['add', '--', 'seed.txt']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '-m', 'owned synthetic baseline']);
  return { root, environment, sourceLaunch, projectMap: [{ sourceDirectory: directory, targetDirectory: directory, mode: 'identity' }],
    expected: { databaseSha256: fixtureSha256(await fs.readFile(sourceLaunch.opencodeDatabasePath)) } };
}

/** Independent raw-store assertions after the actual compiled importer. */
export async function assertMigratedFixture({ fixture, descriptor }) {
  const { expected, sourceLaunch } = fixture;
  assert.equal(descriptor.generation, 2);
  const launch = descriptor.launch;
  assert.notEqual(launch.opencodeDatabasePath, sourceLaunch.opencodeDatabasePath);
  assert.notEqual(launch.webConfigDirectory, launch.opencodeConfigDirectory);
  assert.equal(launch.global.config, launch.opencodeConfigDirectory);
  const db = resolveSqliteDriver().open(launch.opencodeDatabasePath, { readonly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM kv WHERE key='migration.v1-v2'").get().value).phase, 'completed');
    const sessions = db.prepare('SELECT id,project_id,parent_id,directory,time_archived,permission FROM session_v2 ORDER BY id').all();
    assert.deepEqual(sessions.map(row => row.id), expected.sessions.map(row => row.id).sort());
    for (const source of expected.sessions) {
      const native = sessions.find(row => row.id === source.id);
      const mapping = fixture.projectMap.find(row => row.sourceDirectory === source.directory);
      assert.equal(native.project_id, source.projectID); assert.equal(native.parent_id, source.parentID);
      assert.equal(native.directory, mapping.targetDirectory);
      assert.equal(native.time_archived, source.archived ? time + 100 : null);
      assert.deepEqual(JSON.parse(native.permission), source.permissions.map(rule => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })));
    }
    const messages = db.prepare('SELECT id,session_id,type,seq,data FROM session_message ORDER BY session_id,seq').all();
    const byID = new Map(messages.map(row => [row.id, { ...row, data: JSON.parse(row.data) }]));
    const folded = new Set(expected.compactions.map(row => row.foldedSummaryID));
    for (const id of expected.messageIDs) assert.equal(byID.has(id), !folded.has(id), `Source message disposition changed: ${id}`);
    for (const compaction of expected.compactions) {
      const native = byID.get(compaction.id); assert.equal(native.type, 'compaction');
      assert.equal(native.data.status, 'completed'); assert.equal(native.data.summary, compaction.summary);
    }
    const toolIDs = messages.flatMap(row => JSON.parse(row.data).content ?? []).filter(row => row.type === 'tool').map(row => row.id);
    assert.deepEqual(toolIDs.sort(), [...expected.toolCallIDs].sort());
    for (const attachment of [...expected.attachments, ...expected.inlineAttachments]) {
      const user = byID.get(attachment.messageID ?? `msg_${attachment.sessionID}_user`);
      const name = Object.hasOwn(attachment, 'originalURI') ? 'attachment.txt' : 'inline.txt';
      const files = user.data.files.filter(row => row.name === name);
      assert.equal(files.length, 1); assert.equal(files[0].mime, 'text/plain');
      const bytes = Buffer.from(files[0].data, 'base64');
      assert.equal(fixtureSha256(bytes), attachment.sha256); assert.equal(bytes.length, attachment.size);
    }
    for (const project of expected.projects) {
      assert.equal(db.prepare('SELECT worktree FROM project WHERE id=?').get(project.id).worktree, project.targetDirectory);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM permission WHERE project_id=? AND action='read' AND resource='*'").get(project.id).n, 1);
    }
  } finally { db.close(); }
  assert.equal(fixtureSha256(await fs.readFile(sourceLaunch.opencodeDatabasePath)), expected.databaseSha256, 'Native import mutated its original source');
  for (const [index, config] of expected.configurations.entries()) {
    assert.equal(fixtureSha256(await fs.readFile(config.file)), config.sha256);
    const target = path.join(index === 0 ? launch.webConfigDirectory : launch.opencodeConfigDirectory, path.basename(config.file));
    assert.equal(fixtureSha256(await fs.readFile(target)), config.sha256);
  }
  for (const project of expected.projects) {
    for (const directory of [project.directory, project.targetDirectory]) {
      const refs = (await execute('/usr/bin/git', ['for-each-ref', '--format=%(refname) %(objectname)'],
        { cwd: directory, env: fixture.environment, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim().split('\n');
      assert.deepEqual(refs, project.refs, 'Migration changed Git reference identities');
    }
  }
  return { sessionIDs: expected.sessions.map(row => row.id), toolCallIDs: expected.toolCallIDs,
    compactions: expected.compactions, attachments: expected.attachments, sourceUnchanged: true, projectRefsUnchanged: true };
}

/** Negative inputs are independent closed copies, never mutations of the source baseline. */
export async function createMigrationRefusalCopy(fixture, kind) {
  assert.ok(['pending-revert', 'remembered-deny', 'unknown-marker'].includes(kind), 'Unknown migration refusal fixture');
  const root = path.join(fixture.root, 'negative', kind); await fs.mkdir(root, { recursive: true });
  const databasePath = path.join(root, 'opencode-devryan.db');
  await fs.copyFile(fixture.sourceLaunch.opencodeDatabasePath, databasePath, fs.constants.COPYFILE_EXCL);
  const db = resolveSqliteDriver().open(databasePath);
  try {
    if (kind === 'pending-revert') db.prepare('UPDATE session SET revert=? WHERE id=?')
      .run(JSON.stringify({ messageID: 'msg_ses_migration_root_1_user' }), 'ses_migration_root_1');
    else if (kind === 'remembered-deny') db.prepare('UPDATE permission SET data=? WHERE project_id=?')
      .run(JSON.stringify([{ permission: 'read', pattern: '*', action: 'deny' }]), 'prj_migration_1');
    else {
      db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      db.prepare('INSERT INTO kv VALUES (?,?)').run('migration.v1-v2', '{"phase":"unrecognized-fixture-marker"}');
    }
  } finally { db.close(); }
  return { databasePath, expectedCode: { 'pending-revert': 'migration_revert_pending', 'remembered-deny': 'migration_permissions_unsupported',
    'unknown-marker': 'migration_marker_invalid' }[kind] };
}

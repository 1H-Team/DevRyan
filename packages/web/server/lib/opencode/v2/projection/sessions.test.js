import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  V1_SESSION_VERSION,
  isV1SessionArchived,
  readArchiveOverride,
  readOwnedDevryanEntry,
  readSessionTodo,
  sessionDirectory,
  sessionMessageContext,
  stripDevryanMetadata,
  toV1PermissionRuleset,
  toV1Fork,
  toV1Revert,
  toV1Session,
  toV1SessionFromCreated,
  toV1SessionList,
  toV1SessionTodos,
} from './sessions.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');
const loadVector = (file) => JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));
const rest = (file, label) => {
  const entry = loadVector(file).rest.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ${file} ${label}`);
  return entry.body;
};
const frameData = (file, type) => loadVector(file).frames
  .filter((frame) => frame.startsWith('data: '))
  .map((frame) => JSON.parse(frame.slice('data: '.length)))
  .filter((event) => event.type === type);

const PARENT = 'ses_fffffffffff3normalized0000';
const DIR = '<home>/workspace';
const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

describe('toV1Session (vector 09)', () => {
  it('projects a session with an owned archive override', () => {
    const session = toV1Session(rest('09-rename-metadata.json', 'after.a.session.get').data);
    expect(session).toEqual({
      id: PARENT,
      // LOSS(session-slug): no cached slug, so the id stands in.
      slug: PARENT,
      projectID: 'global',
      directory: DIR,
      title: 'Renamed by user',
      version: V1_SESSION_VERSION,
      // Native lifecycle facts are copied exactly; `time.updated` is native's own.
      time: { created: 1767225635000, updated: 1767225648000, archived: 1767225601000, idle: 1767225646000 },
      outcome: 'succeeded',
      cost: 0,
      tokens: zeroTokens,
      metadata: { a: 1 },
    });
    expect(isV1SessionArchived(session)).toBe(true);
  });

  it('uses the cached slug and reads an owned todo list', () => {
    const info = rest('09-rename-metadata.json', 'after.b.session.get').data;
    const session = toV1Session(info, { slug: 'brave-otter' });
    expect(session.slug).toBe('brave-otter');
    expect(session.metadata).toEqual({ b: 2 });
    expect(isV1SessionArchived(session)).toBe(false);
    expect(readSessionTodo(info.metadata, info.id)).toEqual({ items: [{ content: 'x', status: 'pending' }], rev: 1 });
    expect(toV1SessionTodos(info)).toEqual([{ content: 'x', status: 'pending' }]);
  });

  it('keeps forks as roots and maps the permission ruleset to the v1 rule shape', () => {
    const fork = toV1Session(rest('09-rename-metadata.json', 'fork.session.get').data);
    expect(fork.parentID).toBeUndefined();
    // Native forks have no parentID; the origin is display lineage only.
    expect(fork.fork).toEqual({
      sessionID: PARENT,
      boundary: { type: 'before', messageID: 'msg_000000000004normalized0000' },
    });
    expect(fork.permission).toEqual([{ permission: 'edit', pattern: '*', action: 'ask' }]);
    expect(fork.metadata).toEqual({ a: null });
    expect(fork.title).toBe('Renamed by user (fork #1)');
  });

  it('projects a list body, keeping forks unparented', () => {
    const body = rest('09-rename-metadata.json', 'session.list.directory');
    const slugs = new Map([[PARENT, 'slug-parent']]);
    const sessions = toV1SessionList(body, { slugOf: (id) => slugs.get(id) });
    expect(sessions).toHaveLength(body.data.length);
    expect(sessions.every((session) => session.parentID === undefined)).toBe(true);
    expect(sessions.find((session) => session.id === PARENT).slug).toBe('slug-parent');
    expect(sessions.find((session) => session.id === 'ses_fffffffffff1normalized0000').fork).toEqual({
      sessionID: PARENT,
      boundary: { type: 'through', messageID: 'msg_000000000007normalized0000' },
    });
    expect(sessions.find((session) => session.id === 'ses_fffffffffffanormalized0000')).toMatchObject({
      outcome: 'failed', time: { idle: 1767225616000 },
    });
    expect(toV1SessionList([{ id: PARENT, time: { created: 1, updated: 2 } }, { title: 'no id' }, null]))
      .toHaveLength(1);
    expect(toV1SessionList(undefined)).toEqual([]);
  });

  it('defaults a missing title, time and location', () => {
    expect(toV1Session({ id: 'ses_x' })).toEqual({
      id: 'ses_x', slug: 'ses_x', projectID: '', directory: '', title: '', version: '2', time: { created: 0, updated: 0 },
    });
    expect(toV1Session({ title: 'no id' })).toBeUndefined();
    expect(toV1Session(null)).toBeUndefined();
  });

  it('carries path, agent, model, the read-only archived time and the lifecycle times', () => {
    const session = toV1Session({
      id: 'ses_x',
      projectID: 'p',
      location: { directory: '/repo' },
      subpath: 'pkg',
      agent: 'build',
      model: { id: 'm', providerID: 'p', variant: 'high' },
      time: { created: 1, updated: 2, idle: 3, viewed: 4, archived: 5 },
    });
    expect(session).toMatchObject({
      directory: '/repo', path: 'pkg', agent: 'build', model: { id: 'm', providerID: 'p', variant: 'high' },
    });
    expect(session.time).toEqual({ created: 1, updated: 2, idle: 3, viewed: 4, archived: 5 });
  });
});

describe('native lifecycle and fork facts (2.2.5 Session.Info)', () => {
  const base = { id: 'ses_x', time: { created: 1, updated: 2 } };

  it('copies busy, idle, viewed, outcome and fork exactly', () => {
    const session = toV1Session({
      ...base,
      time: { created: 1, updated: 2, busy: 1767225700000, idle: 1767225699001, viewed: 0 },
      outcome: 'interrupted',
      fork: { sessionID: 'ses_origin', boundary: { type: 'through', messageID: 'msg_7' } },
    });
    expect(session.time).toEqual({ created: 1, updated: 2, busy: 1767225700000, idle: 1767225699001, viewed: 0 });
    expect(session.outcome).toBe('interrupted');
    expect(session.fork).toEqual({ sessionID: 'ses_origin', boundary: { type: 'through', messageID: 'msg_7' } });
    expect(session.parentID).toBeUndefined();
    for (const outcome of ['succeeded', 'failed', 'interrupted']) {
      expect(toV1Session({ ...base, outcome }).outcome).toBe(outcome);
    }
  });

  it('omits invalid lifecycle values and leaves time.updated unchanged', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, {}]) {
      const session = toV1Session({ ...base, time: { created: 1, updated: 2, busy: bad, idle: bad, viewed: bad } });
      expect(session.time).toEqual({ created: 1, updated: 2 });
    }
    for (const outcome of ['aborted', 'SUCCEEDED', '', 1, null]) {
      expect(toV1Session({ ...base, outcome })).not.toHaveProperty('outcome');
    }
    expect(toV1Session(base)).not.toHaveProperty('outcome');
    expect(toV1Session(base)).not.toHaveProperty('fork');
  });

  it('omits a fork unless every member is valid', () => {
    const valid = { sessionID: 'ses_origin', boundary: { type: 'before', messageID: 'msg_1' } };
    expect(toV1Fork(valid)).toEqual(valid);
    expect(toV1Fork({ ...valid, extra: 1, boundary: { ...valid.boundary, extra: 2 } })).toEqual(valid);
    for (const bad of [
      undefined, null, 'ses_origin', [],
      { boundary: valid.boundary },
      { sessionID: '', boundary: valid.boundary },
      { sessionID: 'ses_origin' },
      { sessionID: 'ses_origin', boundary: { type: 'after', messageID: 'msg_1' } },
      { sessionID: 'ses_origin', boundary: { type: 'before' } },
      { sessionID: 'ses_origin', boundary: { type: 'before', messageID: '' } },
    ]) {
      expect(toV1Fork(bad)).toBeUndefined();
      expect(toV1Session({ ...base, fork: bad })).not.toHaveProperty('fork');
    }
  });
});

describe('owner guard (vector 10, F4 inheritance)', () => {
  it('ignores a todo list inherited from another session', () => {
    const child = rest('10-child.json', 'child.session.get').data;
    expect(child.metadata.devryan.todo.sessionID).toBe('owner-check');
    expect(readSessionTodo(child.metadata, child.id)).toBeNull();
    expect(toV1SessionTodos(child)).toEqual([]);
    const projected = toV1Session(child);
    expect(projected.parentID).toBe('ses_fffffffffffenormalized0000');
    expect(projected.agent).toBe('general');
    expect(projected.metadata).toEqual({ inherit: 'yes' });
  });

  it('ignores an inherited archive override and honours an owned unarchive', () => {
    const inherited = { devryan: { archive: { sessionID: 'ses_parent', at: 10 } } };
    expect(readArchiveOverride(inherited, 'ses_child')).toBeUndefined();
    expect(toV1Session({ id: 'ses_child', metadata: inherited, time: { created: 1, updated: 1 } }).time)
      .toEqual({ created: 1, updated: 1 });
    const unarchived = { devryan: { archive: { sessionID: 'ses_x', at: null } } };
    expect(readArchiveOverride(unarchived, 'ses_x')).toEqual({ at: null });
    expect(toV1Session({ id: 'ses_x', metadata: unarchived, time: { created: 1, updated: 1, archived: 9 } }).time)
      .toEqual({ created: 1, updated: 1 });
    expect(readArchiveOverride({ devryan: { archive: { sessionID: 'ses_x', at: 'soon' } } }, 'ses_x')).toBeUndefined();
    expect(readOwnedDevryanEntry({ devryan: { todo: { sessionID: 'ses_x' } } }, 'todo', '')).toBeUndefined();
  });

  it('skips malformed todo items', () => {
    const metadata = { devryan: { todo: { sessionID: 'ses_x', items: [{ content: 'ok', status: 'pending', priority: 'high' }, { content: 1 }, 'x'] } } };
    expect(readSessionTodo(metadata, 'ses_x')).toEqual({ items: [{ content: 'ok', status: 'pending', priority: 'high' }], rev: 0 });
    expect(readSessionTodo({ devryan: { todo: { sessionID: 'ses_x', items: 'nope' } } }, 'ses_x')).toBeNull();
  });
});

describe('field projections', () => {
  it('strips DevRyan internals from metadata', () => {
    expect(stripDevryanMetadata({ devryan: { todo: {} } })).toBeUndefined();
    expect(stripDevryanMetadata({ devryan: {}, keep: 1 })).toEqual({ keep: 1 });
    const plain = { keep: 1 };
    expect(stripDevryanMetadata(plain)).toBe(plain);
    expect(stripDevryanMetadata({})).toBeUndefined();
    expect(stripDevryanMetadata(undefined)).toBeUndefined();
  });

  it('projects revert without patch bodies (vector 08)', () => {
    const staged = rest('08-revert.json', 'staged.session.get').data;
    expect(toV1Session(staged).revert).toEqual({ messageID: 'msg_000000000004normalized0000', files: [] });
    expect(toV1Revert({
      messageID: 'msg_1', partID: 'prt_1', snapshot: 'snap', files: [{ file: 'a', patch: 'BIG', additions: 1, deletions: 2, status: 'modified' }],
    })).toEqual({ messageID: 'msg_1', partID: 'prt_1', snapshot: 'snap', files: [{ file: 'a', additions: 1, deletions: 2, status: 'modified' }] });
    expect(toV1Revert({ files: [] })).toBeUndefined();
  });

  it('maps permission rules and skips malformed ones', () => {
    expect(toV1PermissionRuleset([
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'edit', resource: '*' },
    ])).toEqual([{ permission: 'bash', pattern: 'git *', action: 'allow' }]);
    expect(toV1PermissionRuleset(undefined)).toBeUndefined();
  });

  it('reads the location directory and builds the message page context', () => {
    expect(sessionDirectory({ location: { directory: '/repo' } })).toBe('/repo');
    expect(sessionDirectory({})).toBeUndefined();
    expect(sessionMessageContext({
      id: 'ses_x', location: { directory: '/repo/pkg' }, subpath: 'pkg', agent: 'build', model: { id: 'm', providerID: 'p' },
    })).toEqual({ sessionID: 'ses_x', directory: '/repo', cwd: path.join('/repo', 'pkg'), agent: 'build', model: { id: 'm', providerID: 'p' } });
    expect(sessionMessageContext({ title: 'x' })).toBeUndefined();
  });
});

describe('toV1SessionFromCreated (vector 10 frames)', () => {
  it('builds the v1 session from session.created data and the envelope time', () => {
    const [parentCreated, childCreated] = frameData('10-child.json', 'session.created');
    const parent = toV1SessionFromCreated(parentCreated.data, parentCreated.created);
    expect(parent).toEqual({
      id: 'ses_fffffffffffenormalized0000',
      slug: 'slug-1',
      projectID: 'global',
      directory: DIR,
      title: 'Parent',
      version: '2',
      time: { created: 1767225601000, updated: 1767225601000 },
      metadata: { inherit: 'yes' },
    });
    const child = toV1SessionFromCreated(childCreated.data, childCreated.created);
    expect(child).toMatchObject({ id: 'ses_fffffffffffdnormalized0000', slug: 'slug-2', parentID: 'ses_fffffffffffenormalized0000', agent: 'general' });
    expect(toV1SessionFromCreated({ slug: 'x' }, 1)).toBeUndefined();
  });
});

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
      time: { created: 1767225635000, updated: 1767225648000, archived: 1767225601000 },
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
    expect(fork).not.toHaveProperty('fork');
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

  it('carries path, agent, model and the read-only archived time', () => {
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
      time: { created: 1, updated: 2, archived: 5 },
    });
    expect(session.time).not.toHaveProperty('idle');
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

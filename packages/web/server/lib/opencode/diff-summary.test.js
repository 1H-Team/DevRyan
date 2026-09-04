import { describe, expect, it } from 'vitest';

import {
  stripEventDiffContent,
  stripMessageDiffContent,
  stripSessionDiffContent,
} from './diff-summary.js';

const diffEntry = (overrides = {}) => ({
  file: 'src/index.ts',
  status: 'modified',
  additions: 3,
  deletions: 1,
  patch: '@@ -1,3 +1,5 @@\n-old\n+new',
  before: 'old',
  after: 'new',
  from: 'old',
  to: 'new',
  ...overrides,
});

describe('stripEventDiffContent', () => {
  it('drops patch bodies from message.updated while keeping the counts', () => {
    const payload = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          role: 'user',
          sessionID: 'ses_1',
          summary: { additions: 3, deletions: 1, files: 1, diffs: [diffEntry()] },
        },
      },
    };

    const stripped = stripEventDiffContent(payload);

    expect(stripped).not.toBe(payload);
    expect(stripped.type).toBe('message.updated');
    expect(stripped.properties.info.id).toBe('msg_1');
    expect(stripped.properties.info.summary).toEqual({
      additions: 3,
      deletions: 1,
      files: 1,
      diffs: [{ file: 'src/index.ts', status: 'modified', additions: 3, deletions: 1 }],
    });
    // The input is never mutated.
    expect(payload.properties.info.summary.diffs[0].patch).toContain('@@');
  });

  it('drops patch bodies from session.updated', () => {
    const payload = {
      type: 'session.updated',
      properties: {
        info: {
          id: 'ses_1',
          title: 'Work',
          summary: { additions: 1, deletions: 0, files: 1, diffs: [diffEntry({ deletions: 0 })] },
        },
      },
    };

    const stripped = stripEventDiffContent(payload);

    expect(stripped).not.toBe(payload);
    expect(stripped.properties.info.title).toBe('Work');
    expect(stripped.properties.info.summary.diffs).toEqual([
      { file: 'src/index.ts', status: 'modified', additions: 3, deletions: 0 },
    ]);
  });

  it('returns the identical reference when nothing had a patch body', () => {
    const message = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_1',
          summary: { additions: 0, deletions: 0, files: 0, diffs: [{ file: 'a', additions: 0, deletions: 0 }] },
        },
      },
    };
    const session = { type: 'session.updated', properties: { info: { id: 'ses_1', title: 'no summary' } } };

    expect(stripEventDiffContent(message)).toBe(message);
    expect(stripEventDiffContent(session)).toBe(session);
  });

  it('is the identity for every other event type and for malformed payloads', () => {
    const partUpdated = {
      type: 'message.part.updated',
      properties: { part: { type: 'text', text: 'contains "diffs" and a patch: "x"' } },
    };
    const sessionDiff = {
      type: 'session.diff',
      properties: { sessionID: 'ses_1', diff: [{ file: 'a', before: 'x', after: 'y' }] },
    };
    const heartbeat = { type: 'server.heartbeat', properties: {} };

    expect(stripEventDiffContent(partUpdated)).toBe(partUpdated);
    expect(stripEventDiffContent(sessionDiff)).toBe(sessionDiff);
    expect(stripEventDiffContent(heartbeat)).toBe(heartbeat);
    expect(stripEventDiffContent(null)).toBe(null);
    expect(stripEventDiffContent('data')).toBe('data');
    expect(stripEventDiffContent({ type: 'message.updated' })).toEqual({ type: 'message.updated' });
    const noInfo = { type: 'message.updated', properties: {} };
    expect(stripEventDiffContent(noInfo)).toBe(noInfo);
  });

  it('matches the HTTP list-response trims field for field', () => {
    const info = { id: 'msg_1', summary: { additions: 1, deletions: 1, files: 1, diffs: [diffEntry()] } };
    const viaEvent = stripEventDiffContent({ type: 'message.updated', properties: { info } });
    const viaList = stripMessageDiffContent({ info });
    expect(viaEvent.properties.info).toEqual(viaList.info);

    const session = { id: 'ses_1', summary: { additions: 1, deletions: 1, files: 1, diffs: [diffEntry()] } };
    const viaSessionEvent = stripEventDiffContent({ type: 'session.updated', properties: { info: session } });
    expect(viaSessionEvent.properties.info).toEqual(stripSessionDiffContent(session));
  });
});

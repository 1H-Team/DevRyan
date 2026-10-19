import { describe, expect, test } from 'bun:test';

import { parseDevRyanEventEnvelope } from './devryanEvents';

describe('DevRyan event parsing', () => {
  test('projects a reconnect signal and scoped project metadata invalidation', () => {
    expect(parseDevRyanEventEnvelope({
      type: 'devryan:event-stream-ready',
      properties: { connectedAt: 1 },
    })).toEqual({ type: 'stream-ready' });
    expect(parseDevRyanEventEnvelope({
      type: 'devryan:project-metadata-changed',
      properties: { projectId: ' project-1 ', ignored: 'secret' },
    })).toEqual({ type: 'project-metadata-changed', projectId: 'project-1' });
  });

  test('accepts the openchamber:* names an older host sends', () => {
    expect(parseDevRyanEventEnvelope({ type: 'openchamber:event-stream-ready', properties: {} })).toEqual({ type: 'stream-ready' });
    expect(parseDevRyanEventEnvelope({
      type: 'openchamber:project-metadata-changed',
      properties: { projectId: 'project-1' },
    })).toEqual({ type: 'project-metadata-changed', projectId: 'project-1' });
  });

  test('rejects metadata events without a project id', () => {
    expect(parseDevRyanEventEnvelope({
      type: 'devryan:project-metadata-changed',
      properties: { projectId: '' },
    })).toBeNull();
  });

  test('projects content-free browser lease invalidations', () => {
    expect(parseDevRyanEventEnvelope({
      type: 'devryan:browser-agent-leases-changed',
      properties: { revision: 7, leaseId: 'must-not-project' },
    })).toEqual({ type: 'browser-agent-leases-changed', revision: 7 });
    expect(parseDevRyanEventEnvelope({
      type: 'devryan:browser-agent-leases-changed',
      properties: { revision: -1 },
    })).toBeNull();
  });
});

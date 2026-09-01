import { describe, expect, test } from 'bun:test';

import { parseOpenChamberEventEnvelope } from './openchamberEvents';

describe('OpenChamber event parsing', () => {
  test('projects a reconnect signal and scoped project metadata invalidation', () => {
    expect(parseOpenChamberEventEnvelope({
      type: 'openchamber:event-stream-ready',
      properties: { connectedAt: 1 },
    })).toEqual({ type: 'stream-ready' });
    expect(parseOpenChamberEventEnvelope({
      type: 'openchamber:project-metadata-changed',
      properties: { projectId: ' project-1 ', ignored: 'secret' },
    })).toEqual({ type: 'project-metadata-changed', projectId: 'project-1' });
  });

  test('rejects metadata events without a project id', () => {
    expect(parseOpenChamberEventEnvelope({
      type: 'openchamber:project-metadata-changed',
      properties: { projectId: '' },
    })).toBeNull();
  });

  test('projects content-free browser lease invalidations', () => {
    expect(parseOpenChamberEventEnvelope({
      type: 'openchamber:browser-agent-leases-changed',
      properties: { revision: 7, leaseId: 'must-not-project' },
    })).toEqual({ type: 'browser-agent-leases-changed', revision: 7 });
    expect(parseOpenChamberEventEnvelope({
      type: 'openchamber:browser-agent-leases-changed',
      properties: { revision: -1 },
    })).toBeNull();
  });
});

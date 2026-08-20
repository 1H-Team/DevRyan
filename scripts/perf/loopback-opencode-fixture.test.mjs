import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createLoopbackOpenCodeFixture,
  PERF_CHILD_SESSION_IDS,
  PERF_PARENT_SESSION_ID,
} from './loopback-opencode-fixture.mjs';

describe('loopback OpenCode performance fixture', () => {
  it('serves one parent, three children, and deterministic concurrent deltas', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devryan-perf-fixture-'));
    const fixture = await createLoopbackOpenCodeFixture({ directory });
    try {
      const sessions = await fetch(`${fixture.origin}/session`).then((response) => response.json());
      assert.equal(sessions.length, 4);
      assert.equal(sessions[0].id, PERF_PARENT_SESSION_ID);
      assert.deepEqual(
        sessions.filter((session) => session.parentID === PERF_PARENT_SESSION_ID).map((session) => session.id),
        PERF_CHILD_SESSION_IDS,
      );

      fixture.startScenario('four-stream');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const state = fixture.getState();
      for (const sessionID of [PERF_PARENT_SESSION_ID, ...PERF_CHILD_SESSION_IDS]) {
        assert.ok(state.textLengths[sessionID] > 0);
      }
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

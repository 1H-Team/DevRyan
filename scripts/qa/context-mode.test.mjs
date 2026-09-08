import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextModeScene } from './context-mode.mjs';

test('context-mode visual scene has exact session, message and call correlation', () => {
  const scene = createContextModeScene('/fixture', 1700000000000);
  assert.equal(scene.tool.tool, 'ctx_index');
  assert.equal(scene.tool.state.status, 'running');
  assert.equal(scene.assistant.info.parentID, scene.userID);
  for (const row of scene.rows) {
    assert.equal(row.info.sessionID, scene.sessionID);
    for (const part of row.parts) {
      assert.equal(part.sessionID, scene.sessionID);
      assert.equal(part.messageID, row.info.id);
    }
  }
  assert.ok(scene.tool.callID);
});

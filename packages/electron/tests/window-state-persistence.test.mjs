import assert from 'node:assert/strict';
import test from 'node:test';
import { persistWindowState } from '../window-state-persistence.mjs';

test('captures BrowserWindow state before an asynchronous settings mutation runs', async () => {
  let destroyed = false;
  const root = {};
  const browserWindow = {
    id: 7,
    isDestroyed: () => false,
    getBounds: () => {
      assert.equal(destroyed, false);
      return { x: 10, y: 20, width: 640, height: 500 };
    },
    isMaximized: () => {
      assert.equal(destroyed, false);
      return true;
    },
    isFullScreen: () => {
      assert.equal(destroyed, false);
      return false;
    },
  };

  const persisted = await persistWindowState({
    browserWindow,
    mainWindowID: 7,
    minWidth: 800,
    minHeight: 600,
    mutateSettingsRoot: (mutator) => Promise.resolve().then(() => {
      destroyed = true;
      return mutator(root);
    }),
  });

  assert.equal(persisted, true);
  assert.deepEqual(root.desktopWindowState, {
    x: 10,
    y: 20,
    width: 800,
    height: 600,
    maximized: true,
    fullscreen: false,
  });
});

test('does not persist destroyed or non-primary windows', async () => {
  let mutationCount = 0;
  const mutateSettingsRoot = async () => {
    mutationCount += 1;
  };

  assert.equal(await persistWindowState({
    browserWindow: { id: 1, isDestroyed: () => true },
    mainWindowID: 1,
    minWidth: 800,
    minHeight: 600,
    mutateSettingsRoot,
  }), false);
  assert.equal(await persistWindowState({
    browserWindow: { id: 2, isDestroyed: () => false },
    mainWindowID: 1,
    minWidth: 800,
    minHeight: 600,
    mutateSettingsRoot,
  }), false);
  assert.equal(mutationCount, 0);
});

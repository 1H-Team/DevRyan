import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopMenu } from '../desktop-menu.mjs';

test('session sidebar keeps its dispatch while avoiding the bare Command-L accelerator', () => {
  const actions = [];
  const window = { isDestroyed: () => false, webContents: { executeJavaScript: async () => {} } };
  const menu = createDesktopMenu({ app: { name: 'DevRyan' }, Menu: { buildFromTemplate: (value) => value },
    BrowserWindow: { getFocusedWindow: () => window, getAllWindows: () => [window] },
    emitToWindow: (_window, _event, action) => actions.push(action),
  }).buildMacMenu();
  const items = menu.flatMap((section) => section.submenu || []);
  const toggle = items.find((item) => item.label === 'Toggle Session Sidebar');
  assert.equal(toggle.accelerator, 'Cmd+Alt+L');
  toggle.click();
  assert.deepEqual(actions, ['toggle-sidebar']);
  assert.equal(items.some((item) => item.accelerator === 'Cmd+L'), false);
});

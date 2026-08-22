import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

test('session sidebar keeps its dispatch while avoiding the bare Command-L accelerator', () => {
  assert.match(
    mainSource,
    /label: 'Toggle Session Sidebar', accelerator: 'Cmd\+Alt\+L', click: \(\) => dispatchAction\('toggle-sidebar'\)/,
  );
  assert.doesNotMatch(mainSource, /accelerator:\s*['"]Cmd\+L['"]/);
});

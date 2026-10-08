import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const { build } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeCopy = (resources) => resources.find((resource) => resource.from === '../web/runtime');

test('the native runtime ships once, as the revert-runtime resource', () => {
  // The packaged server resolves executables from Resources/revert-runtime only
  // (packages/web/server/lib/opencode/execution-artifacts.js). A second copy inside
  // app.asar.unpacked added ~470 MB installed and ~165 MB to the DMG.
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.ok(build.files.includes(`!node_modules/@openchamber/web/runtime/${platform}-*{,/**}`), platform);
  }
  assert.ok(build.files.includes('!node_modules/@openchamber/web/runtime/reviewed-inputs/claude-*/assets{,/**}'));
  assert.equal(runtimeCopy(build.mac.extraResources)?.to, 'revert-runtime');
  assert.equal(runtimeCopy(build.win.extraResources)?.to, 'revert-runtime');
});

test('the web package stays unpacked without the runtime forcing it', () => {
  assert.ok(build.asarUnpack.includes('node_modules/@openchamber/web/**'));
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('rebuilds the Cursor SDK sqlite3 binding for Electron', async () => {
  const source = await readFile(new URL('./rebuild-native.mjs', import.meta.url), 'utf8');

  assert.match(source, /realpathSync\([^)]*cursor-sdk-runtime[^)]*@cursor[^)]*sdk[^)]*package\.json/s);
  assert.match(
    source,
    /rebuild\(\{[^}]*buildPath:\s*cursorSqliteDir[^}]*onlyModules:\s*\[['"]sqlite3['"]\]/s,
  );
});

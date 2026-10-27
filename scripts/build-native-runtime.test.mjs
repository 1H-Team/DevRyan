import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const builder = await fs.readFile(new URL('./build-native-runtime.mjs', import.meta.url), 'utf8');
const sourceList = builder.match(/const buildSources=await Promise\.all\((\[[\s\S]*?\])\.map\(async file=>/)?.[1];
assert.ok(sourceList, 'Native build source inventory must remain inspectable without executing the builder');
// Evaluate only the repository-owned inventory literal, never the native builder.
const sourcesFor = new Function('windowsCandidate', `"use strict";return (${sourceList});`);

for (const windowsCandidate of [false, true]) {
  test(`native ${windowsCandidate ? 'Windows candidate' : 'Darwin'} identity binds every local C include`, async () => {
    const sources = new Set(sourcesFor(windowsCandidate));
    assert.equal(sources.has('packages/harness-runtime/native/session-execution-windows.c'), windowsCandidate);
    const visited = new Set();
    const inspect = async file => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = await fs.readFile(path.join(repository, file), 'utf8');
      for (const include of source.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) {
        const absolute = path.resolve(repository, path.dirname(file), include[1]);
        assert.ok(absolute.startsWith(repository), 'Compiled local include must remain inside the repository');
        const included = path.relative(repository, absolute).split(path.sep).join('/');
        assert.ok(sources.has(included), `Native build identity omits ${included}, included by ${file}`);
        await inspect(included);
      }
    };
    for (const file of sources) if (file.endsWith('.c')) await inspect(file);
    assert.ok(visited.has('packages/harness-runtime/native/session-execution.c'));
    assert.ok(visited.has('packages/harness-runtime/native/session-spawn-darwin.c'));
    assert.ok(visited.has('packages/harness-runtime/native/session-group-darwin.h'));
  });
}

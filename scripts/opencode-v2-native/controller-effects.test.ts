import { test, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('private native Effects preserve JSON-lines stdout and send native logs to stderr', async () => {
  const helper = fileURLToPath(new URL('../../packages/web/server/lib/opencode/runtime-host/controller-effects.ts', import.meta.url));
  const child = Bun.spawn([process.execPath, '--eval', `import {Effect} from 'effect';import {runControllerEffect} from ${JSON.stringify(helper)};
    await runControllerEffect(Effect.logInfo('owned-fixture-log'));process.stdout.write(JSON.stringify({protocol:1,ok:true})+'\\n');`],
  { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(0);
  expect(stdout).toBe('{"protocol":1,"ok":true}\n');
  expect(stderr).toContain('owned-fixture-log');
});

import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('custom Cursor model names, prices and variant overlays survive the native catalog graph', async () => {
  const repository = path.resolve(import.meta.dirname, '../..');
  const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/cursor-catalog-'));
  const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const sourcePath = path.join(repository, 'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
    let source = await fs.readFile(sourcePath, 'utf8');
    const replace = (before: string, after: string) => {
      if (source.split(before).length !== 2) throw new Error('Owned fixture shape changed');
      source = source.replace(before, after);
    };
    source = `import {nativeProviderConfigurations} from ${JSON.stringify(pathToFileURL(path.join(repository, 'packages/web/server/lib/opencode/runtime-host/native-configuration-data.js')).href)};\n` + source;
    replace('providers: { openai:', `providers: {...nativeProviderConfigurations({'cursor-acp': {
      npm:'@ai-sdk/openai-compatible', env:[], options:{baseURL:'https://fixture.invalid',apiKey:'isolated-synthetic-key'},
      models:{'names-only':{name:'Names only'},'gpt-5.5-fast':{name:'Fast',cost:{input:5,output:30,cache_read:0.5,cache_write:5,
        context_over_200k:{input:5,output:30,cache_read:0.5,cache_write:5}},options:{cursorModel:'gpt-5.5-fast'},
        variants:{medium:{cursorModel:'gpt-5.5-medium',cost:{input:5,output:30,cache_read:0.5,cache_write:5}}}},
      'cursor-model-row':{name:'Cursor model',cursorModel:'gpt-5.5',options:{cursorModel:'gpt-5.5'},variants:{high:{cursorModel:'gpt-5.5-high'}}}}
    }}), openai:`);
    replace("  assert.equal(catalog.asserted, true);", `  assert.equal(catalog.asserted, true);
    const cursorResponse=await handler(new Request('http://native/api/model',{headers:{'x-opencode-directory':encodeURIComponent(directories[0])}}),httpContext);
    assert.equal(cursorResponse.status,200);const cursorRows=(await cursorResponse.json()).data.filter(model=>model.providerID==='cursor-acp');
    for(const id of ['names-only','gpt-5.5-fast','cursor-model-row'])assert.ok(cursorRows.some(model=>model.id===id),'Missing reviewed custom row '+id);`);
    source = source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g, (_all, _quote, relative: string) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href));
    source = source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g, (_all, _quote, relative: string) => 'new URL(' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath), relative)).href) + ')');
    const entry = path.join(root, 'fixture.mjs');
    await fs.writeFile(entry, source);
    child = Bun.spawn([process.execPath, entry], { cwd: repository,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
        XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), GIT_CEILING_DIRECTORIES: root, DEVRYAN_INTEGRATION_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe' });
    if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw new Error('Owned child pipes required');
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout).providerCompatibility).toBe(true);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);

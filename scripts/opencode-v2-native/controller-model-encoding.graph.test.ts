import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '../..');
test('real native graph classifies HTTP model encoding failure and isolates the invalid row', async () => {
  for (const guarded of [false, true]) {
    const root = await fs.mkdtemp(path.join(repository, '.cache/v2-validation/model-encoding-'));
    const home = path.join(root, 'home'), tmp = path.join(home, 'tmp');
    await fs.mkdir(tmp, { recursive: true }); await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const original = path.join(repository, 'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
      let source = await fs.readFile(original, 'utf8');
      source = "import {createNativeCatalogDiagnostics} from " + JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-catalog-diagnostics.ts')).href) + ";\nconst graphDiagnostics=createNativeCatalogDiagnostics();\n" + source;
      source = source.replaceAll('new Set([reportCause])', 'new Set([reportCause,...Context.get(graphDiagnostics.context,ErrorReporter.CurrentErrorReporters)])');
      const start = source.indexOf('  const catalog = await assertNativeCatalog('), end = source.indexOf('} catch (error) { primaryFailure');
      expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
      const setupStart=source.indexOf('  server = Bun.serve('),setupEnd=source.indexOf("  assert.equal((await call(directories[0], '/api/integration/openai')).connections");
      expect(setupStart).toBeGreaterThan(start);expect(setupEnd).toBeGreaterThan(setupStart);
      source = source.slice(0, source.indexOf('  const savedSelections =')) + source.slice(setupStart,setupEnd) + `
  const at=(directory,effect)=>Effect.runPromise(effect.pipe(Scope.provide(scope),Effect.provide(map.get({directory})),Effect.provideService(LocationServiceMap.Service,map),Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
  await handler(new Request('http://native/api/agent',{headers:{'x-opencode-directory':encodeURIComponent(directories[0])}}),httpContext);
  await at(directories[0],Effect.gen(function*(){const models=yield* Model.Service;yield* models.transform(editor=>editor.update('openai','synthetic-invalid',model=>{model.time.released=NaN;}));}));
  const requirements={agents:[],plugins:[],tools:[],models:[]};
  const inspect=()=>assertNativeCatalog({directories:[directories[0]],requirements,handler,tools:gates.controls.catalogTools});
  if(${guarded}){
    assert.equal((await inspect()).asserted,true);
    const response=await handler(new Request('http://native/api/model',{headers:{'x-opencode-directory':encodeURIComponent(directories[0])}}),httpContext);
    assert.equal(response.status,200);const body=await response.json();
    assert.ok(body.data.some(model=>model.id==='gpt-5.5'));
    assert.ok(!body.data.some(model=>model.id==='synthetic-invalid'));
    result={status:200,invalidRemoved:true};
  }else{
    await assert.rejects(inspect,/^Error: native_catalog_read_failed_model_http_400_response_schema_invalid$/);
    result={status:400,cause:'response_schema_invalid'};
  }
` + source.slice(end);
      if (!guarded) source = source.replace('...factory.overrides,...compatibility.overrides,', '...factory.overrides,');
      source = source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g, (_all, _quote, relative: string) => 'from ' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(original), relative)).href));
      source = source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g, (_all, _quote, relative: string) => 'new URL(' + JSON.stringify(pathToFileURL(path.resolve(path.dirname(original), relative)).href) + ')');
      const entry = path.join(root, 'fixture.mjs'); await fs.writeFile(entry, source);
      child = Bun.spawn([process.execPath, entry], { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp,
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
        XDG_CACHE_HOME: path.join(home, 'cache'), GIT_CEILING_DIRECTORIES: root, DEVRYAN_INTEGRATION_FIXTURE_ROOT: root }, stdout: 'pipe', stderr: 'pipe' });
      if (!child.stdout || typeof child.stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw Error('Owned pipes required');
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors: stderr.split('\n').filter(line => line && !/^level=(?:error|warn) msg=(?:response_schema_invalid|model_response_schema_invalid) name=(?:HttpApiSchemaError|SchemaError) schemaPath=/.test(line)) }).toEqual({ code: 0, errors: [] });
      expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual(guarded ? { status: 200, invalidRemoved: true } : { status: 400, cause: 'response_schema_invalid' });
    } finally {
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);

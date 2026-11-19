// The second self-test file of the backend conformance harness (run by the full
// suite and CI only: `<name>.full.test.mjs`, skipped by fast validate): the parts that
// need the real server (the product route census, the pilot group host, an
// edge host per planted variant, the server's composition files). The first
// file (conformance.test.mjs) proves the detectors on synthetic input and is
// kept well under 20 s; this one takes longer.
//
// Every assertion here about the server's own files is relative: a planted
// change must add a problem that names it, whatever the baseline reports. So
// an edit to the server's composition never fails this file either (decision
// 2 of the fix round): the real files are judged by every harness run and by
// the explicit composition-drift command, which make a drifted run
// inconclusive. What the baseline reports is printed as a diagnostic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from './outcomes.mjs';
import { createBackendRun } from './run-scratch.mjs';
import { SERVER_ROOT } from './edge.mjs';
import { runCensus } from './census.mjs';
import { layerStackProblems, reachProblems } from './reach.mjs';
import { EDGE_PROBES, edgeProbeProblems } from './edge-probes.mjs';
import { APPLICATION_TABLE, GROUP_TABLES, compositionTextDrift } from './composition-drift.mjs';
import { readTapRecords, startGroupHost, stopAllHosts } from './host-launch.mjs';
import { onceFinished } from './child-finish.mjs';
import { GROUPS } from './groups.mjs';
import { GROUPS as TOY_GROUPS, TOY_VARIANTS } from './toy/toy-groups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '../..');
const TOY_TABLE = path.join(HERE, 'toy/toy-groups.mjs');
const DEADLINE = { timeout: 300_000 };
const PILOT = GROUPS['magic-prompts'];
const decode = (base64) => Buffer.from(base64 ?? '', 'base64').toString('utf8');

const runFor = (t) => {
  const run = createBackendRun({ owner: 'backend-conformance-composition-test' });
  let status = 'failed';
  t.after(() => { try { run.finish(status); } catch { /* cleaned by the test */ } });
  return { run, pass: () => { status = 'passed'; } };
};
const runChild = (args, { env = process.env, timeoutMs = 240_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: REPOSITORY_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { stderr += `\n(killed after ${timeoutMs} ms)`; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  onceFinished(child, (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
});
const newProblems = (planted, baseline) => planted.filter((problem) => !baseline.includes(problem));

// The census is shared by the tests that need it (one child process, about 5 s).
let censusPromise = null;
const census = (run) => { censusPromise ??= runCensus({ dataDirectory: run.makeDirectory('census') }); return censusPromise; };

describe('backend conformance with the real server', { concurrency: true, ...DEADLINE }, () => {
// Whatever a failed test left running is stopped, so the file always ends.
after(() => stopAllHosts());
test('the drift detector names every planted change of the server\'s own composition files, in memory', DEADLINE, (t) => {
  const APP = path.join(SERVER_ROOT, APPLICATION_TABLE.file);
  const FEATURE = path.join(SERVER_ROOT, GROUP_TABLES['magic-prompts'].file);
  const app = fs.readFileSync(APP, 'utf8');
  const feature = fs.readFileSync(FEATURE, 'utf8');
  const drift = (appText, featureText) => compositionTextDrift({ group: 'magic-prompts', readFile: (file) => (file === APP ? appText : file === FEATURE ? featureText : fs.readFileSync(file, 'utf8')) });
  const baseline = drift(app, feature);
  if (baseline.length) t.diagnostic(`the server's composition drifted from the table (a harness run would be inconclusive):\n${baseline.join('\n')}`);
  // Plants anchored on the span itself, not on its current text: before the group's call, and after the start.
  const groupCall = app.indexOf('featureRoutesRuntime.registerRoutes(app');
  const lineStart = app.lastIndexOf('\n', groupCall) + 1;
  const before = (line) => `${app.slice(0, lineStart)}${line}\n${app.slice(lineStart)}`;
  const start = app.indexOf('const app = express();');
  const afterStart = (line) => `${app.slice(0, app.indexOf('\n', start) + 1)}${line}\n${app.slice(app.indexOf('\n', start) + 1)}`;
  const groupLine = feature.indexOf('registerMagicPromptRoutes(app');
  const featureLineStart = feature.lastIndexOf('\n', groupLine) + 1;
  const beforeGroup = (line) => `${feature.slice(0, featureLineStart)}${line}\n${feature.slice(featureLineStart)}`;
  // After the statement that holds the group's call (its closing line), in each file.
  const groupEnd = app.indexOf('\n    });\n', groupCall) + '\n    });\n'.length;
  const afterGroup = (line, text = app) => { const at = groupEnd + (text.length - app.length); return `${text.slice(0, at)}${line}\n${text.slice(at)}`; };
  const featureGroupEnd = feature.indexOf(';\n', groupLine) + 2;
  const afterGroupCall = (line) => `${feature.slice(0, featureGroupEnd)}${line}\n${feature.slice(featureGroupEnd)}`;
  const plants = [
    ['app.use(extra) before the group', before('    app.use(extraLayer);'), feature, /app\.use\(extraLayer\)/],
    ['expressApp.use(extra)', before('    expressApp.use(extraLayer);'), feature, /expressApp\.use\(extraLayer\)/],
    ['app.param', before("    app.param('id', (req, res, next) => next());"), feature, /app\.param\('id'/],
    ['app.options', before("    app.options('/api/magic-prompts', (req, res) => res.sendStatus(204));"), feature, /app\.options\(/],
    ['app.head', before("    app.head('/api/magic-prompts', (req, res) => res.end());"), feature, /app\.head\(/],
    ['app.route', before("    app.route('/api/magic-prompts').get((req, res) => res.json({}));"), feature, /app\.route\(/],
    ['app.disable', before("    app.disable('x-powered-by');"), feature, /app\.disable\(/],
    ['app.enable', before("    app.enable('case sensitive routing');"), feature, /app\.enable\(/],
    ['app.set', before("    app.set('json spaces', 2);"), feature, /app\.set\('json spaces'/],
    ['registerExtra(server, app)', before('    registerExtra(server, app);'), feature, /registerExtra\(server, app\)/],
    ["app['use']", before("    app['use'](extraLayer);"), feature, /app\['use'\]/],
    ['app.router.stack', before('    app.router.stack.unshift(extraLayer);'), feature, /app\.router\.stack/],
    ["server.on('request')", before("    server.on('request', () => {});"), feature, /server\.on\('request'/],
    ['server limits', before('    server.maxHeadersCount = 5;'), feature, /server\.maxHeadersCount/],
    ['a layer right after the start', afterStart('    app.use(firstLayer);'), feature, /app\.use\(firstLayer\)/],
    ['a middleware before the group inside the feature routes', app, beforeGroup('    app.use(extraLayer);'), /feature-routes-runtime\.js:\d+ app\.use\(extraLayer\)/],
    ['the app wrapped for the group', app, feature.replace('registerMagicPromptRoutes(app', 'registerMagicPromptRoutes(withAudit(app)'), /withAudit\(app\)/],
    ['a comment holding a call (not drift)', before('    // app.use(fake)'), feature, null],
    // The second review's A1-A18 that are not above, relative to the span (BH01-review-2.md, B1).
    ['A1 a function declared after the span registers a layer; called inside', afterGroup('    function installExtraLayers() { app.use(extraLayer); }', before('    installExtraLayers();')), feature, /installExtraLayers\(\); — it calls installExtraLayers/],
    ['A2 a closure declared before the start registers a layer; called inside', `${app.slice(0, app.lastIndexOf('\n', start) + 1)}    const installEarly = () => app.use(extraLayer);\n${before('    installEarly();').slice(app.lastIndexOf('\n', start) + 1)}`, feature, /installEarly\(\); — it calls installEarly/],
    ['A3 a root read as a property', before('    openCodeLifecycleState.expressApp.use(extraLayer);'), feature, /expressApp\.use\(extraLayer\); — it reads expressApp as a property/],
    ['A4 express.response.json patched', before('    express.response.json = function patchedJson(body) { return this.send(body); };'), feature, /express\.response\.json = .* — it mutates express/],
    ['A5 ServerResponse.prototype.setHeader patched', before('    { const original = http.ServerResponse.prototype.setHeader; http.ServerResponse.prototype.setHeader = function (n, v) { return original.call(this, n, v); }; }'), feature, /it mutates http/],
    ['A6 compression.filter mutated', before('    compression.filter = () => true;'), feature, /compression\.filter = .* — it mutates compression/],
    ['A7 a conditional registration', before("    if (process.env.DEVRYAN_AUDIT === '1') app.use(auditLayer);"), feature, /app\.use\(auditLayer\)/],
    ['A10 a second app mounted into the first', before('    const auditApp = express(); auditApp.use(auditLayer); app.use(auditApp);'), feature, /app\.use\(auditApp\)/],
    ['A11 app.use monkey-patched', before('    const originalUse = app.use.bind(app); app.use = (...args) => originalUse(auditLayer, ...args);'), feature, /const originalUse = app\.use\.bind\(app\)/],
    ['A13 feature routes: the dependency object mutated', app, beforeGroup('    routeDependencies.fsPromises = auditedFsPromises;'), /routeDependencies\.fsPromises = auditedFsPromises; — it mutates routeDependencies/],
    ['A14 a pinned dependency object mutated', before('    fsPromises.writeFile = auditedWriteFile;'), feature, /fsPromises\.writeFile = auditedWriteFile; — it mutates fsPromises/],
    ['A15 a registration in an async continuation', before('    setImmediate(() => expressApp.use(lateLayer));'), feature, /setImmediate\(\(\) => expressApp\.use\(lateLayer\)\)/],
    ['A16 a globalThis holder', before('    globalThis.__devryanApp = app;\n    globalThis.__devryanApp.use(extraLayer);'), feature, /globalThis\.__devryanApp = app;/],
    ['A17 json spaces after the group\'s call', afterGroup("    app.set('json spaces', 2);"), feature, /app\.set\('json spaces', 2\); — after the group's call/],
    ['A18 etag disabled after the group\'s call', afterGroup("    app.disable('etag');"), feature, /app\.disable\('etag'\); — after the group's call/],
    ['a layer after the group inside the feature routes', app, afterGroupCall('    app.set(\'json spaces\', 2);'), /feature-routes-runtime\.js:\d+ app\.set\('json spaces', 2\); — after the group's call/],
    // The second review's harmless edits that can be planted relative to the span (the rest are in the self-test).
    ['N1 a comment line', before('    // the feature routes register the groups'), feature, null],
    ['N5 an unrelated const', before("    const startupNote = 'feature routes';"), feature, null],
    ['N6 an unrelated console.log', before("    console.log('[startup] registering feature routes');"), feature, null],
    ['N11 an unrelated statement in the feature routes', app, beforeGroup('    const groupCount = 1;'), null],
  ];
  // A9: the import of a not-applicable entry's registrar moved to another module (found through the table, so it follows the server's text).
  const registrar = APPLICATION_TABLE.entries.find((entry) => entry.class === 'not-applicable' && entry.reads.length)?.reads[0];
  const importLine = registrar && new RegExp(`^import \\{[^}]*\\b${registrar}\\b[^}]*\\} from '([^']+)';$`, 'm').exec(app);
  if (importLine) plants.push(['A9 a not-applicable registrar imported from another module', app.replace(importLine[0], importLine[0].replace(`'${importLine[1]}'`, `'${importLine[1].replace(/\.js$/, '-v2.js')}'`)), feature, new RegExp(`changed: application\\.js: the definition of ${registrar}`)]);
  else t.diagnostic(`A9 not planted: no import of ${registrar} found`);
  for (const [name, appText, featureText, named] of plants) {
    const added = newProblems(drift(appText, featureText), baseline);
    if (named === null) assert.deepEqual(added, [], name);
    else assert.ok(added.some((problem) => named.test(problem)), `${name}: ${named} in ${JSON.stringify(added)}`);
  }
});

test('the explicit drift command passes or names the drift of a copy, and names each of three planted changes', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const copy = (name, transform = (text) => text) => {
    const root = run.makeDirectory(`${name}/server`);
    for (const relative of [APPLICATION_TABLE.file, GROUP_TABLES['magic-prompts'].file]) {
      const parts = relative.split('/');
      for (let index = 1; index < parts.length; index += 1) { const directory = path.join(root, ...parts.slice(0, index)); if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 }); }
      fs.writeFileSync(path.join(root, relative), transform(fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8'), relative), { mode: 0o600 });
    }
    return root;
  };
  const plantThree = (text, relative) => {
    if (relative !== APPLICATION_TABLE.file) return text.replace('registerMagicPromptRoutes(app', 'registerMagicPromptRoutes(withAudit(app)');
    const at = text.lastIndexOf('\n', text.indexOf('featureRoutesRuntime.registerRoutes(app')) + 1;
    return `${text.slice(0, at)}    app.param('id', (req, res, next) => next());\n    server.maxHeadersCount = 5;\n${text.slice(at)}`;
  };
  const command = (root) => runChild([path.join(HERE, 'composition-drift.mjs'), '--group=magic-prompts', '--text-only', `--server-root=${root}`]);
  const [baseline, planted] = await Promise.all([command(copy('baseline')), command(copy('planted', plantThree))]);
  assert.ok([EXIT.passed, EXIT.incomplete].includes(baseline.code), baseline.stdout + baseline.stderr);
  if (baseline.code !== 0) t.diagnostic(`the server's composition drifted from the table:\n${baseline.stdout}`);
  assert.equal(planted.code, 2, planted.stdout + planted.stderr);
  const added = newProblems(planted.stdout.split('\n'), baseline.stdout.split('\n'));
  for (const named of [/^DRIFT composition: unclassified: application\.js:\d+ app\.param\('id'/, /^DRIFT composition: unclassified: application\.js:\d+ server\.maxHeadersCount = 5/, /^DRIFT composition: unclassified: lib\/opencode\/feature-routes-runtime\.js:\d+ registerMagicPromptRoutes\(withAudit\(app\)/]) {
    assert.ok(added.some((line) => named.test(line)), `${named} in ${added.join('\n')}`);
  }
  assert.match(planted.stdout, /composition drift \(magic-prompts, text\): DRIFT, \d+ problems exit 2/);
  pass();
});

test('the reach check on the real census catches every layer the review injected', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const real = await census(run);
  const values = PILOT.parameterValues;
  const baseline = await reachProblems({ group: PILOT, census: real, values });
  if (baseline.length) t.diagnostic(`reach on the real census:\n${baseline.join('\n')}`);
  const file = 'lib/diagnostics/routes.js';
  const cases = [
    ['GET /api/:name', [{ method: 'GET', path: '/api/:name', order: 1, file, line: 1 }], []],
    ['PUT /api/magic-prompts/*splat', [{ method: 'PUT', path: '/api/magic-prompts/*splat', order: 1, file, line: 2 }], []],
    ['a regex route', [{ method: 'GET', path: 'regex:magic', order: 1, file, line: 3 }], []],
    ['a mount /api/:x', [], [{ method: 'USE', path: '/api/:x', order: 1, file, line: 4 }]],
    ['an array mount', [], [{ method: 'USE', path: ['/a', '/api'], order: 1, file, line: 5 }]],
    ['a mount on a concrete id', [], [{ method: 'USE', path: '/api/magic-prompts/foo', order: 1, file, line: 6 }]],
    ['a mount in upper case', [], [{ method: 'USE', path: '/API', order: 1, file, line: 7 }]],
  ];
  for (const [name, routes, mounts] of cases) {
    const injected = { routes: [...real.routes, ...routes.map((route) => ({ ...route, viaRouter: false }))], mounts: [...real.mounts, ...mounts.map((mount) => ({ ...mount, viaRouter: false }))] };
    const added = newProblems(await reachProblems({ group: PILOT, census: injected, values }), baseline);
    assert.ok(added.some((problem) => problem.includes(`${file}:${(routes[0] ?? mounts[0]).line} runs for`)), `${name}: ${JSON.stringify(added)}`);
  }
  pass();
});

test('the pilot is served behind the real edge, its layer stack is the census\'s, and the tap records it', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const [real, host] = await Promise.all([census(run), startGroupHost({ run, name: 'magic-prompts', group: PILOT, label: 'pilot' })]);
  t.after(() => host.stop());
  const send = async (method, route, body) => { const response = await fetch(host.url(route), { method, body, headers: body === undefined ? {} : { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) }); return { status: response.status, text: await response.text() }; };
  assert.equal((await send('GET', '/api/magic-prompts')).text, '{"version":1,"overrides":{}}');
  assert.equal((await send('PUT', '/api/magic-prompts/git.pr.generate.visible', '{"text":"\\ud800 lone"}')).text, '{"version":1,"overrides":{"git.pr.generate.visible":"\\ud800 lone"}}');
  assert.deepEqual(Object.values(await send('PUT', '/api/magic-prompts/Not%20Valid', '{"text":"x"}')), [400, '{"error":"Invalid prompt id"}']);
  assert.equal((await send('PUT', '/api/magic-prompts/x', '{"text":')).status, 400);
  assert.equal((await send('DELETE', '/api/magic-prompts')).text, '{"version":1,"overrides":{}}');
  assert.equal((await send('PATCH', '/api/magic-prompts')).status, 599, 'what the server\'s tail would answer is the stand-in\'s');
  for (let index = 1; index <= 6; index += 1) assert.equal((await host.quiescent(index)).body.quiescent, true, `exchange ${index}`);
  assert.equal(fs.readFileSync(path.join(host.dataRoot, 'magic-prompts.json'), 'utf8'), JSON.stringify({ version: 1, overrides: {} }, null, 2));
  const { body } = await host.control('/registrations');
  const stack = await layerStackProblems({ group: PILOT, census: real, hostRegistrations: body.registrations, values: PILOT.parameterValues });
  if (stack.length) t.diagnostic(`layer stack against the census:\n${stack.join('\n')}`);
  assert.equal((await host.stop()).code, 0);
  const records = readTapRecords(host.tapFile);
  const exchanges = records.filter((entry) => entry.type === 'exchange');
  assert.deepEqual(exchanges.map((entry) => [entry.kind, entry.answeredBy?.owner, entry.response.status]), [['group', 'group', 200], ['group', 'group', 200], ['group', 'group', 400], ['edge', 'edge', 400], ['group', 'group', 200], ['tail', 'tail', 599]]);
  assert.deepEqual(records.filter((entry) => entry.type === 'registration' && entry.group).map((entry) => `${entry.method} ${entry.path}`),
    ['GET /api/magic-prompts', 'PUT /api/magic-prompts/:id', 'DELETE /api/magic-prompts/:id', 'DELETE /api/magic-prompts']);
  assert.equal(decode(exchanges[1].request.body), '{"text":"\\ud800 lone"}');
  assert.equal(exchanges[1].entry.bodyParsedByEdge, true, 'the shared parser reads the pilot\'s body');
  assert.equal(exchanges[2].entry.url, '/api/magic-prompts/Not%20Valid');
  assert.deepEqual(exchanges[0].response.headers.filter((entry) => entry.owner?.owner === 'group').map((entry) => entry.name), ['Content-Type', 'Content-Length', 'ETag']);
  assert.deepEqual(records.filter((entry) => ['unattributed', 'late', 'blind', 'problem'].includes(entry.type)), []);
  assert.ok(exchanges.every((entry) => entry.blind.length === 0 && entry.crossed.length === 0));
  pass();
});

test('each planted re-statement of the edge is caught by its probe, and a missing layer by the layer stack', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const [real, host] = await Promise.all([census(run), startGroupHost({ run, name: 'toy', group: TOY_GROUPS.toy, label: 'variants', table: TOY_TABLE, variants: Object.keys(TOY_VARIANTS) })]);
  t.after(() => host.stop());
  // Each variant is caught by its probe and only by it, except a UI password, which locks every /api answer:
  // it must be caught by the auth probes (and is, incidentally, by every probe that needs an /api answer).
  const expected = {
    // The threshold variant composes compression with the package's own filter, so it lacks the server's skip policy too.
    'compression-threshold-8192': ['compression-threshold', 'compression-skip'], 'compression-skip-ignored': ['compression-skip'], 'trust-proxy-off': ['trust-proxy'], 'no-store-skipped': ['no-store'], 'indexing-skipped': ['indexing-policy'],
    'legacy-path-skipped': ['legacy-path'], 'admission-skipped': ['bundle-admission'], 'parser-limit-50mb': ['body-parser-limit'], 'readiness-unavailable': ['execution-readiness'],
    'tunnel-boundary-skipped': ['tunnel-boundary'], 'local-owner-skipped': ['local-owner-bootstrap'],
  };
  const atLeast = { 'ui-password-planted': ['ui-auth', 'principal'] };
  assert.deepEqual([...Object.keys(expected), ...Object.keys(atLeast)].sort(), Object.keys(TOY_VARIANTS).sort(), 'every variant has its probe');
  assert.deepEqual([...new Set([...Object.values(expected), ...Object.values(atLeast)].flat())].sort(), EDGE_PROBES.map((probe) => probe.id).filter((id) => id !== 'tail').sort(), 'every probe has a variant it must catch');
  const baseline = await edgeProbeProblems({ port: host.ready.listen });
  assert.deepEqual(baseline.problems, []);
  for (const [variant, probes] of Object.entries({ ...expected, ...atLeast })) {
    const result = await edgeProbeProblems({ port: host.ready.variants[variant] });
    const failing = result.probes.filter((entry) => entry.problems.length).map((entry) => entry.id);
    if (Object.hasOwn(expected, variant)) assert.deepEqual(failing, probes, `${variant}: caught by ${probes} and only by it (${JSON.stringify(result.problems)})`);
    else for (const probe of probes) assert.ok(failing.includes(probe), `${variant}: caught by ${probe} (${JSON.stringify(failing)})`);
  }
  // The layer stack of each composition, split where its group registrar's window closes.
  const { body } = await host.control('/registrations');
  const compositions = [];
  let current = [];
  for (const [index, entry] of body.registrations.entries()) {
    current.push(entry);
    if (entry.inWindow && !body.registrations[index + 1]?.inWindow) { compositions.push(current); current = []; }
  }
  assert.equal(compositions.length, 1 + Object.keys(TOY_VARIANTS).length);
  const stackOf = (index) => layerStackProblems({ group: PILOT, census: real, hostRegistrations: compositions[index], values: PILOT.parameterValues });
  const base = await stackOf(0);
  if (base.length) t.diagnostic(`layer stack of the toy host against the census:\n${base.join('\n')}`);
  const skipped = await stackOf(1 + Object.keys(TOY_VARIANTS).indexOf('indexing-skipped'));
  assert.ok(newProblems(skipped, base).some((problem) => /layer stack: .*lib\/indexing-policy\.js/.test(problem)), JSON.stringify(skipped));
  pass();
});

test('the command line refuses outside the guard and, on the real tree, judges nothing yet', DEADLINE, async (t) => {
  const { run, pass } = runFor(t);
  const env = { ...process.env, TMPDIR: run.makeDirectory('foreign-tmp') };
  delete env.DEVRYAN_TEST_ISOLATION_ROOT;
  const [refused, real] = await Promise.all([
    runChild([path.join(HERE, 'conformance.mjs'), '--group=magic-prompts'], { env }),
    runChild([path.join(HERE, 'conformance.mjs'), '--group=magic-prompts']),
  ]);
  assert.equal(refused.code, EXIT.refused, refused.stderr);
  assert.deepEqual(fs.readdirSync(env.TMPDIR), []);
  assert.equal(real.code, EXIT.incomplete, real.stdout + real.stderr);
  assert.match(real.stdout, /backend conformance: (NOTHING RECORDED|COMPOSITION DRIFT) \(0 rows/);
  if (/COMPOSITION DRIFT/.test(real.stdout)) t.diagnostic(real.stdout);
  pass();
});
});

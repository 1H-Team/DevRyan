import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateWindowsJobBoundary } from './verify-windows-host-boundary.mjs';
import { supervisorStartupVariants } from './diagnose-windows-supervisor-startup.mjs';

test('empty-job diagnostic requires every OS-supported UI restriction and exact readback', () => {
  const probe = { protocol: 'devryan.windows-job-probe/2', osBuild: 26100, sdkUIFlags: 0x3ff, inJob: true, hostLimitFlags: 0x2000,
    breakawayAllowed: false, silentBreakawayAllowed: false, requestedUIFlags: 0x3ff,
    uiSet: false, uiError: 87, uiReadBack: 0 };
  assert.equal(validateWindowsJobBoundary(probe, true), probe);
  assert.equal(validateWindowsJobBoundary({ ...probe, uiSet: true, uiError: 0, uiReadBack: 0x3ff }, true).uiSet, true);
  for (const [osBuild, mask] of [[10240,0xff],[20348,0xff],[22620,0xff],[22621,0x1ff],[26099,0x1ff],[26100,0x3ff]]) {
    assert.equal(validateWindowsJobBoundary({ ...probe, osBuild, requestedUIFlags: mask, uiSet: true, uiError: 0, uiReadBack: mask }, true).uiSet, true);
  }
  for (const change of [{ requestedUIFlags: 0xff }, { uiError: 0 }, { uiReadBack: 0xff },
    { osBuild: 10239 }, { osBuild: 20348 }, { sdkUIFlags: 0xff },
    { breakawayAllowed: true }, { inJob: false }, { extra: 'unreviewed' }]) {
    assert.throws(() => validateWindowsJobBoundary({ ...probe, ...change }, true));
  }
});

test('Windows qualification builds and executes independent pinned native architectures with no publication authority', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs.native;
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.include, [{ runner: 'windows-2022', arch: 'x64' }, { runner: 'windows-11-arm', arch: 'arm64' }]);
  assert.equal(job.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@')).with['bun-version'], '1.3.14');
  assert.deepEqual(workflow.on.push.branches, ['release/2.0.2', 'implementation/windows-port']);
  assert.deepEqual(workflow.on.push.paths, workflow.on.pull_request.paths);
  for (const input of ['.gitattributes', 'scripts/native-compaction-observation-transform.mjs']) assert.ok(workflow.on.push.paths.includes(input));
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with.architecture, '${{ matrix.arch }}');
  assert.equal(job.env.GIT_CEILING_DIRECTORIES, '${{ github.workspace }}/.cache/test-fixtures');
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /process\.arch!==process\.env\.EXPECTED_ARCH/);
  assert.match(commands, /--frozen-lockfile --ignore-scripts/);
  assert.match(commands, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.ARM64/);
  assert.match(commands, /build-session-execution\.mjs.*--verify/);
  assert.match(commands, /bun scripts\/build-native-runtime\.mjs --windows-candidate/);
  assert.match(commands, /node scripts\/verify-opencode-v2-package\.mjs/);
  assert.doesNotMatch(commands, /npm publish|supabase|gh release|git (?:push|tag)|docker (?:push|login)|checkpoint-export/);
  assert.ok(!job.steps.some(step => /action-gh-release|login-action/.test(step.uses ?? '')));
  const byID = Object.fromEntries(job.steps.filter(step => step.id).map(step => [step.id, step]));
  const startup = job.steps.find(step => step.run?.includes('diagnose-windows-supervisor-startup.mjs'));
  assert.equal(startup.if, "${{ always() && steps.supervisor.outcome == 'success' }}");
  assert.equal(startup['continue-on-error'], true);
  assert.equal(startup.id, undefined, 'Startup diagnostics cannot supply a required acceptance outcome');
  assert.ok(!byID.runtime.if.includes('supervisor'), 'Supervisor refusal must not hide an independent controller/writer build failure');
  assert.ok(byID.runtime_acceptance.if.includes("steps.supervisor_acceptance.outcome == 'success'"));
  const required = job.steps.find(step => step.env?.SUPERVISOR_ACCEPTANCE);
  assert.equal(required.if, '${{ always() }}');
  assert.equal(required['continue-on-error'], undefined);
  assert.deepEqual(Object.keys(required.env).sort(), ['FEATURE_CAPABILITIES', 'FILESYSTEM_BOUNDARY', 'HOST_BOUNDARY', 'REVIEWED_EXECUTABLES', 'REVIEWED_LIBSQL', 'RUNTIME', 'RUNTIME_ACCEPTANCE', 'SUPERVISOR', 'SUPERVISOR_ACCEPTANCE']);
  assert.equal(required.env.REVIEWED_EXECUTABLES, '${{ steps.reviewed_executables.outcome }}');
  assert.equal(byID.reviewed_executables.if, '${{ always() }}');
  assert.match(byID.reviewed_executables.run, /node scripts\/build-windows-reviewed-executables\.mjs/);
  assert.equal(required.env.FEATURE_CAPABILITIES, '${{ steps.feature_capabilities.outcome }}');
  assert.equal(byID.feature_capabilities.if, "${{ always() && steps.dependencies.outcome == 'success' }}");
  assert.match(byID.feature_capabilities.run, /TerminalView\.mounted\.test\.tsx/);
  assert.match(byID.feature_capabilities.run, /node scripts\/test-ui\.mjs src\/lib\/terminalApi\.test\.ts/);
  assert.match(byID.feature_capabilities.run, /cursor-sdk-runtime\/platform-capabilities\.test\.js/);
  assert.match(byID.feature_capabilities.run, /provider-routes\.test\.js -t Windows/);
  assert.match(byID.feature_capabilities.run, /ProvidersPage\.authenticationSummary\.test\.tsx/);
  assert.match(byID.feature_capabilities.run, /bot-runtime-manager-platform\.test\.mjs.*speech-manager\.test\.mjs -t Windows/);
  assert.match(byID.feature_capabilities.run, /node --test --test-name-pattern=Windows.*runtime-service-startup\.test\.mjs/);
  assert.match(byID.feature_capabilities.run, /runtime\.test\.js.* -t Windows/);
  const libsql = job.steps.find(step => step.with?.repository === 'tursodatabase/libsql-js');
  assert.deepEqual(libsql.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });
  assert.equal(libsql.with.ref, '55bee86d1c284f1ddf2b9e280e870d2b6cef884a');
  assert.equal(libsql.with['persist-credentials'], false);
  assert.match(byID.reviewed_libsql.run, /1\.85\.1-\$target/);
  assert.equal(required.env.REVIEWED_LIBSQL, '${{ steps.reviewed_libsql.outcome }}');
  for (const [name, id] of [['HOST_BOUNDARY', 'host_boundary'], ['FILESYSTEM_BOUNDARY', 'filesystem_boundary']]) {
    assert.equal(required.env[name], '${{ steps.' + id + '.outcome }}');
    assert.ok(byID[id].run.includes(`verify-windows-${id === 'host_boundary' ? 'host' : 'filesystem'}-boundary.mjs`));
    assert.equal(byID[id].if, "${{ always() && steps.supervisor.outcome == 'success' }}");
  }
  assert.match(required.run, /\$outcome -ne 'success'/);
  assert.match(required.run, /if \(\$failed\).*throw/);
  const processSource = fs.readFileSync(new URL('../packages/web/server/lib/opencode/runtime-host/native-process.js', import.meta.url), 'utf8');
  assert.match(processSource, /process\.platform !== 'darwin'.*native_controller_supervisor_unavailable/);
});

test('startup diagnostics retain the original helper and core fences in every disposable variant', () => {
  const source = fs.readFileSync(new URL('../packages/harness-runtime/native/session-execution-windows.c', import.meta.url), 'utf8');
  const variants = supervisorStartupVariants(source);
  assert.deepEqual(variants.map(row => row.id), ['original', 'no-ui-job', 'private-station', 'private-station-no-ui-job', 'low-integrity']);
  assert.equal(variants[0].source, source);
  for (const row of variants) {
    for (const fence of ['DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED | LUA_TOKEN', 'S-1-16-0',
      'PROC_THREAD_ATTRIBUTE_HANDLE_LIST', 'PROC_THREAD_ATTRIBUTE_JOB_LIST', 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
      'TerminateJobObject(job', 'FlushFileBuffers(receipt)', 'original owner identity']) assert.ok(row.source.includes(fence), row.id);
    assert.ok(row.source.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST') < row.source.indexOf('checked(CreateProcessAsUserW('));
    assert.equal(row.source.includes('uiMask = 0;'), row.id.includes('no-ui-job'));
    assert.equal(row.source.match(/ConvertStringSidToSidW\(L"(S-1-16-[0-9]+)", &integrity\)/)?.[1],
      row.id === 'low-integrity' ? 'S-1-16-4096' : 'S-1-16-0');
    if (row.id.startsWith('private-station')) {
      assert.ok(row.source.includes('CreateWindowStationW(NULL, CWF_CREATE_ONLY, GENERIC_ALL, &desktopSecurity)'));
      assert.ok(row.source.includes(String.raw`L"%ls\\%ls"`));
      assert.ok(row.source.includes('SetProcessWindowStation(inheritedStation)'));
      assert.ok(row.source.includes('CloseWindowStation(station)'));
    }
  }
  assert.throws(() => supervisorStartupVariants(source.replace('DWORD uiMask = maximum_ui_limits(os_build());', '')), /anchor changed/);
  const refused = spawnSync(process.execPath, [fileURLToPath(new URL('./diagnose-windows-supervisor-startup.mjs', import.meta.url)),
    'unused-output', 'extra-argument'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Pass only the owned diagnostic output directory/);
});

test('the Windows supervisor requires kernel job assignment before creating a child', () => {
  const source = fs.readFileSync(new URL('../packages/harness-runtime/native/session-execution-windows.c', import.meta.url), 'utf8');
  const attributes = source.indexOf('PROC_THREAD_ATTRIBUTE_JOB_LIST');
  const create = source.indexOf('checked(CreateProcessAsUserW(');
  assert.ok(attributes > 0 && attributes < create);
  assert.match(source, /&job, sizeof\(job\), NULL, NULL\), "atomic command ownership"/);
  assert.doesNotMatch(source, /if\s*\(!AssignProcessToJobObject/);
  assert.match(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(source, /maximum_ui_limits\(os_build\(\)\)/);
  assert.match(source, /observedUI\.UIRestrictionsClass != uiMask/);
  const readOnlyJobFlags = source.replace(/host\.BasicLimitInformation\.LimitFlags & JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK \? "true" : "false"/g, '');
  assert.doesNotMatch(readOnlyJobFlags, /JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK/);
  assert.doesNotMatch(source, /CREATE_BREAKAWAY_FROM_JOB/);
});

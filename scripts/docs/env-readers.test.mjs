import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ENVIRONMENT_REFERENCE, NOT_ENVIRONMENT_LITERALS, compareUndocumented, describeUndocumented, isProductionSource, likelyHome, listPackageFiles,
  productionEnvReads, pruneUndocumentedBaseline, readUndocumentedBaseline, readsInSource, staleLiteralAllowlist, undocumentedEnvReads,
} from './env-readers.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

function fixture(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-docs-env-reverse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

// One planted variable per read syntax. OPENCODE_ names are used where the
// syntax itself must be recognized: the shape rule never covers that prefix.
const SYNTAX_CASES = [
  ['member', 'process.env.OPENCODE_SYN_DOT;', 'OPENCODE_SYN_DOT'],
  ['quoted key', "process.env['OPENCODE_SYN_BRACKET'];", 'OPENCODE_SYN_BRACKET'],
  ['optional member', 'env?.OPENCODE_SYN_OPTIONAL;', 'OPENCODE_SYN_OPTIONAL'],
  ['optional quoted key', "env?.['OPENCODE_SYN_OPTIONAL_KEY'];", 'OPENCODE_SYN_OPTIONAL_KEY'],
  ['template key', 'process.env[`OPENCODE_SYN_TEMPLATE`];', 'OPENCODE_SYN_TEMPLATE'],
  ['spaced key', "process.env[ 'OPENCODE_SYN_SPACED' ];", 'OPENCODE_SYN_SPACED'],
  ['split across lines', 'process.env\n  .OPENCODE_SYN_SPLIT;', 'OPENCODE_SYN_SPLIT'],
  ['other environment objects', 'Bun.env.OPENCODE_SYN_BUN; import.meta.env.OPENCODE_SYN_META; childEnv.OPENCODE_SYN_CHILD;',
    'OPENCODE_SYN_BUN', 'OPENCODE_SYN_META', 'OPENCODE_SYN_CHILD'],
  ['destructuring', "const { OPENCODE_SYN_DESTRUCTURE, OPENCODE_SYN_RENAMED: renamed = '1' } = process.env;",
    'OPENCODE_SYN_DESTRUCTURE', 'OPENCODE_SYN_RENAMED'],
  ['aliased environment object', 'const vars = process.env;\nvars.OPENCODE_SYN_ALIAS;\nconst { OPENCODE_SYN_ALIAS_DESTRUCTURE } = vars;',
    'OPENCODE_SYN_ALIAS', 'OPENCODE_SYN_ALIAS_DESTRUCTURE'],
  ['spread copy', 'const copy = { ...process.env };\ncopy.OPENCODE_SYN_SPREAD;', 'OPENCODE_SYN_SPREAD'],
  ['presence checks', "'OPENCODE_SYN_IN' in process.env; Object.hasOwn(process.env, 'OPENCODE_SYN_HASOWN'); env.get('OPENCODE_SYN_GET');",
    'OPENCODE_SYN_IN', 'OPENCODE_SYN_HASOWN', 'OPENCODE_SYN_GET'],
  ['same-file constant', "const NAME = 'OPENCODE_SYN_CONSTANT';\nconst TYPED: string = 'OPENCODE_SYN_TYPED';\nprocess.env[NAME]; env?.[TYPED];",
    'OPENCODE_SYN_CONSTANT', 'OPENCODE_SYN_TYPED'],
  ['list of names', "for (const name of ['OPENCODE_SYN_LIST_A', 'OPENCODE_SYN_LIST_B']) if (env[name]) break;",
    'OPENCODE_SYN_LIST_A', 'OPENCODE_SYN_LIST_B'],
  ['map of names', "const POLICY = { key: 'OPENCODE_SYN_MAP' };\nexport const on = (environment) => environment[POLICY.key] === '1';", 'OPENCODE_SYN_MAP'],
  ['helpers', "readDevRyanEnv(env, 'DEVRYAN_SYN_HELPER'); readDevRyanEnv(env, 'SYN_SUFFIX'); readDevRyanEnv(pick(env), 'OPENCHAMBER_SYN_NESTED'); setDevRyanEnv(env, 'DEVRYAN_SYN_SET', '1');",
    'DEVRYAN_SYN_HELPER', 'DEVRYAN_SYN_SUFFIX', 'DEVRYAN_SYN_NESTED', 'DEVRYAN_SYN_SET'],
  ['embedded shell', 'const script = `if [ -n "$OPENCODE_SYN_SHELL" ]; then printf %s "\\${OPENCODE_SYN_SHELL_BRACED}"; fi`;\nconst ps = \'$env:OPENCODE_SYN_PWSH\', cmd = "%OPENCODE_SYN_CMD%";',
    'OPENCODE_SYN_SHELL', 'OPENCODE_SYN_SHELL_BRACED', 'OPENCODE_SYN_PWSH', 'OPENCODE_SYN_CMD'],
  ['product-name literal', "const marker = 'DEVRYAN_SYN_SHAPE'; const legacy = \"OPENCHAMBER_SYN_SHAPE_ALIAS\";",
    'DEVRYAN_SYN_SHAPE', 'DEVRYAN_SYN_SHAPE_ALIAS'],
  ['after a regular expression literal', "const quote = /[\"']/.test(input);\nprocess.env.OPENCODE_SYN_AFTER_REGEX;", 'OPENCODE_SYN_AFTER_REGEX'],
];

test('recognizes every read syntax, one planted variable each', () => {
  for (const [label, source, ...names] of SYNTAX_CASES) assert.deepEqual(readsInSource(source, 'packages/x/a.ts'), names, label);
});

test('recognizes native reads in C, Rust and shell sources', () => {
  assert.deepEqual(readsInSource([
    'const char *a = getenv("OPENCODE_SYN_C"); wchar_t *b = _wgetenv(L"OPENCODE_SYN_C_WIDE");',
    'GetEnvironmentVariableW(L"OPENCODE_SYN_C_WIN", buffer, 9);',
    '#define CACHE_NAME L"OPENCODE_SYN_C_DEFINE"',
    'GetEnvironmentVariableW(CACHE_NAME, buffer, 9);',
  ].join('\n'), 'packages/x/native/a.c'), ['OPENCODE_SYN_C', 'OPENCODE_SYN_C_WIDE', 'OPENCODE_SYN_C_WIN', 'OPENCODE_SYN_C_DEFINE']);
  assert.deepEqual(readsInSource('const wchar_t *names[]={L"OPENCODE_SYN_C_ARRAY",L"HOME"};\nfor(int i=0;i<2;i++)GetEnvironmentVariableW(names[i],b,9);',
    'packages/x/native/b.c'), ['OPENCODE_SYN_C_ARRAY']);
  assert.deepEqual(readsInSource([
    "fn f<'a>(x: &'a str) { let _ = std::env::var(\"OPENCODE_SYN_RS\"); }",
    'const NAME: &str = "OPENCODE_SYN_RS_CONST";',
    'fn g() { std::env::var_os(NAME); option_env!("OPENCODE_SYN_RS_OPTION"); let raw = r#"process.env.OPENCODE_SYN_RS_RAW"#; }',
  ].join('\n'), 'packages/x/src/lib.rs'), ['OPENCODE_SYN_RS', 'OPENCODE_SYN_RS_CONST', 'OPENCODE_SYN_RS_OPTION']);
  assert.deepEqual(readsInSource('#!/bin/sh\necho "$OPENCODE_SYN_SH_FILE" # $OPENCODE_SYN_SH_COMMENT\n', 'packages/x/run.sh'), ['OPENCODE_SYN_SH_FILE']);
});

test('does not report comments, prose, other-prefix literals or allowlisted non-variable literals', () => {
  const [allowlisted] = NOT_ENVIRONMENT_LITERALS.keys();
  assert.ok(allowlisted, 'NOT_ENVIRONMENT_LITERALS has an entry to test with');
  assert.deepEqual(readsInSource([
    '// process.env.DEVRYAN_SYN_LINE_COMMENT',
    '/* env.OPENCODE_SYN_BLOCK_COMMENT and \'DEVRYAN_SYN_BLOCK_LITERAL\' */',
    "const message = 'set DEVRYAN_SYN_PROSE=1 to enable';",
    "const other = 'OPENCODE_SYN_PLAIN_LITERAL';",
    `const code = '${allowlisted}';`,
    "const prefix = 'DEVRYAN_';",
  ].join('\n'), 'packages/x/a.js'), []);
  assert.deepEqual(readsInSource(`const codes = ['${allowlisted}']; for (const key of keys) env[key];`, 'packages/x/b.js'), []);
});

test('production sources exclude tests, fixtures, QA, build tooling, declarations, legacy desktop, docs site and reviewed inputs', () => {
  for (const file of ['packages/web/server/a.js', 'packages/x/native/b.c', 'packages/x/native/b.h', 'packages/x/src/c.ts', 'packages/x/src/d.tsx',
    'packages/x/e.cjs', 'packages/x/f.mts', 'packages/electron/main.mjs', 'packages/x/src/lib.rs', 'packages/x/run.sh', 'packages/x/run.ps1']) {
    assert.ok(isProductionSource(file), file);
  }
  for (const file of ['packages/web/server/a.test.js', 'packages/x/a.spec.ts', 'packages/x/a.bench.js', 'packages/x/tests/run.mjs',
    'packages/x/test/a.js', 'packages/x/src/__tests__/a.js', 'packages/x/fixtures/a.js', 'packages/x/a.d.ts', 'packages/desktop/a.js',
    'packages/docs/a.ts', 'packages/web/scripts/dev.mjs', 'packages/electron/tests/qa/smoke.mjs', 'packages/web/vite.config.ts',
    'packages/web/vitest.config.ts', 'packages/native/crates/front/build.rs', 'packages/web/runtime/reviewed-inputs/x/a.ts',
    'scripts/dev.mjs', 'scripts/qa/run.mjs', 'packages/x/a.graph.test.ts', 'packages/x/README.md']) {
    assert.equal(isProductionSource(file), false, file);
  }
});

// Every production file kind, in different packages, each with one planted read.
const PLANTED = {
  'packages/web/server/lib/demo/reader.js': 'export const limit = Number(process.env.DEVRYAN_FIXTURE_JS ?? 5);\n',
  'packages/web/server/lib/demo/DOCUMENTATION.md': '# Demo\n',
  'packages/electron/main.mjs': '\n\nconst { DEVRYAN_FIXTURE_MJS } = process.env;\n',
  'packages/web/bin/cli.cjs': "const N = 'OPENCODE_FIXTURE_CJS';\nmodule.exports = process.env[N];\n",
  'packages/ui/src/App.tsx': 'export const x = import.meta.env.OPENCODE_FIXTURE_TSX;\n',
  'packages/runtime/src/a.ts': "const names = ['OPENCODE_FIXTURE_TS'];\nexport const on = names.some((n) => process.env[n]);\n",
  'packages/runtime/src/b.mts': "export const marker = 'DEVRYAN_FIXTURE_MTS';\n",
  'packages/harness/native/launch.c': 'int main(void) { return getenv("DEVRYAN_FIXTURE_C") != 0; }\n',
  'packages/harness/native/launch.h': 'static const char *probe(void) { return getenv("OPENCODE_FIXTURE_H"); }\n',
  'packages/crate/src/lib.rs': 'pub fn f() { let _ = std::env::var("OPENCODE_FIXTURE_RS"); }\n',
  'packages/electron/askpass.mjs': 'export const script = () => `#!/bin/sh\nprintf %s "$DEVRYAN_FIXTURE_SHELL"\n`;\n',
  'packages/tools/run.sh': '#!/bin/sh\necho "$OPENCODE_FIXTURE_SH"\n',
  'packages/web/server/lib/demo/reader.test.js': 'process.env.DEVRYAN_FIXTURE_TEST_ONLY = "1";\n',
  'packages/web/server/lib/demo/fixtures/f.js': 'process.env.DEVRYAN_FIXTURE_FIXTURE_ONLY;\n',
  'packages/web/scripts/build.mjs': 'process.env.DEVRYAN_FIXTURE_BUILD_ONLY;\n',
  'packages/web/runtime/reviewed-inputs/up/a.js': 'process.env.DEVRYAN_FIXTURE_VENDORED_ONLY;\n',
  'packages/web/runtime/reviewed-inputs/up/README.md': '`DEVRYAN_FIXTURE_JS` (an upstream README documents nothing)\n',
  'packages/web/server/lib/demo/comment.js': '// process.env.DEVRYAN_FIXTURE_COMMENT_ONLY\n',
  'packages/family/index.js': 'process.env.DEVRYAN_FIXTURE_FAMILY_ONE;\n',
  'docs/a.md': 'The `DEVRYAN_FIXTURE_FAMILY_*` switches and `DEVRYAN_` alone document nothing.\n',
};
const EXPECTED = [
  ['DEVRYAN_FIXTURE_C', 'packages/harness/native/launch.c', 1, ENVIRONMENT_REFERENCE],
  ['DEVRYAN_FIXTURE_FAMILY_ONE', 'packages/family/index.js', 1, ENVIRONMENT_REFERENCE],
  ['DEVRYAN_FIXTURE_JS', 'packages/web/server/lib/demo/reader.js', 1, 'packages/web/server/lib/demo/DOCUMENTATION.md'],
  ['DEVRYAN_FIXTURE_MJS', 'packages/electron/main.mjs', 3, ENVIRONMENT_REFERENCE],
  ['DEVRYAN_FIXTURE_MTS', 'packages/runtime/src/b.mts', 1, ENVIRONMENT_REFERENCE],
  ['DEVRYAN_FIXTURE_SHELL', 'packages/electron/askpass.mjs', 2, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_CJS', 'packages/web/bin/cli.cjs', 2, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_H', 'packages/harness/native/launch.h', 1, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_RS', 'packages/crate/src/lib.rs', 1, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_SH', 'packages/tools/run.sh', 2, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_TS', 'packages/runtime/src/a.ts', 1, ENVIRONMENT_REFERENCE],
  ['OPENCODE_FIXTURE_TSX', 'packages/ui/src/App.tsx', 1, ENVIRONMENT_REFERENCE],
].map(([name, file, line, home]) => ({ name, file, line, home }));

test('reports each planted undocumented read with its file, line and a suggested document, in every file kind, and passes once named', t => {
  const root = fixture(t, PLANTED);
  const docs = ['packages/web/server/lib/demo/DOCUMENTATION.md', 'docs/a.md', 'packages/web/runtime/reviewed-inputs/up/README.md'];
  const missing = undocumentedEnvReads(root, docs);
  assert.deepEqual(missing, EXPECTED);
  assert.equal(describeUndocumented(missing[2]), 'DEVRYAN_FIXTURE_JS is read at packages/web/server/lib/demo/reader.js:1 but named in no repository document: '
    + 'describe it in docs/ENVIRONMENT.md (or the package document that owns it; suggested: packages/web/server/lib/demo/DOCUMENTATION.md)');
  writeFileSync(path.join(root, 'docs/b.md'), EXPECTED.map((entry) => `\`${entry.name.replace(/^DEVRYAN_FIXTURE_MJS$/, 'OPENCHAMBER_FIXTURE_MJS')}\``).join('\n'));
  assert.deepEqual(undocumentedEnvReads(root, [...docs, 'docs/b.md']), []);
});

test('the scan reads every production source it is given, so no file kind or folder is dropped', t => {
  const root = fixture(t, PLANTED);
  const reads = productionEnvReads(root);
  assert.deepEqual(reads.scanned, Object.keys(PLANTED).filter(isProductionSource).sort());
  assert.deepEqual([...reads.keys()].sort(), EXPECTED.map((entry) => entry.name).sort());
});

test('the baseline only shrinks: unlisted reads are new, entries that no longer apply are stale and pruned', t => {
  const root = fixture(t, { 'scripts/docs/known-undocumented-env.json': '[\n  {"name":"DEVRYAN_FIXTURE_GONE","reason":"fixture"},\n  {"name":"DEVRYAN_FIXTURE_KEPT","reason":"fixture"}\n]\n' });
  const file = path.join(root, 'scripts/docs/known-undocumented-env.json');
  const baseline = readUndocumentedBaseline(file);
  const result = compareUndocumented([{ name: 'DEVRYAN_FIXTURE_KEPT', file: 'a', line: 1, home: 'b' }, { name: 'DEVRYAN_FIXTURE_NEW', file: 'a', line: 1, home: 'b' }], baseline);
  assert.deepEqual(result.added.map((entry) => entry.name), ['DEVRYAN_FIXTURE_NEW']);
  assert.deepEqual(result.known.map((entry) => entry.name), ['DEVRYAN_FIXTURE_KEPT']);
  assert.deepEqual(result.stale.map((entry) => entry.name), ['DEVRYAN_FIXTURE_GONE']);
  pruneUndocumentedBaseline(file, baseline, result.stale);
  assert.equal(readFileSync(file, 'utf8'), '[\n  {"name":"DEVRYAN_FIXTURE_KEPT","reason":"fixture"}\n]\n');
  writeFileSync(file, '[{"name":"DEVRYAN_FIXTURE_X","reason":" "}]');
  assert.throws(() => readUndocumentedBaseline(file), /nonempty reason/);
});

test('an allowlisted literal that no production source contains any more is stale', t => {
  const [kept, ...rest] = NOT_ENVIRONMENT_LITERALS.keys();
  const root = fixture(t, { 'packages/a/codes.js': `export const code = '${kept}';\n` });
  assert.deepEqual(staleLiteralAllowlist(productionEnvReads(root)), rest);
});

test('likely home walks up to the nearest package DOCUMENTATION.md', t => {
  const root = fixture(t, { 'packages/a/DOCUMENTATION.md': '# A\n', 'packages/a/b/c/d.js': '' });
  assert.equal(likelyHome(root, 'packages/a/b/c/d.js'), 'packages/a/DOCUMENTATION.md');
  assert.equal(likelyHome(root, 'packages/z/e.js'), ENVIRONMENT_REFERENCE);
});

test('docs:validate runs the check: a planted read fails it with the instruction, and naming the variable passes it', t => {
  const codes = [...NOT_ENVIRONMENT_LITERALS.keys()].map((literal) => `'${literal}'`).join(', ');
  const root = fixture(t, {
    'packages/docs/content/docs/index.mdx': '---\ntitle: Fixture\ndescription: Fixture site\n---\n',
    'packages/docs/sidebar.config.json': '{"sections":[{"items":[{"link":"/"}]}]}\n',
    'packages/demo/reader.js': 'export const on = process.env.DEVRYAN_FIXTURE_UNHOOKED === "1";\n',
    'packages/demo/codes.js': `export const codes = [${codes}];\n`,
  });
  const docsDirectory = path.join(root, 'scripts', 'docs');
  mkdirSync(docsDirectory, { recursive: true });
  for (const file of readdirSync(import.meta.dirname).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    copyFileSync(path.join(import.meta.dirname, file), path.join(docsDirectory, file));
  }
  writeFileSync(path.join(docsDirectory, 'known-drift.json'), '[]\n');
  writeFileSync(path.join(docsDirectory, 'known-undocumented-env.json'), '[]\n');
  const validate = () => spawnSync(process.execPath, [path.join(docsDirectory, 'validate-docs.mjs')], { cwd: root, encoding: 'utf8' });
  const failed = validate();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /\[env-reverse\] DEVRYAN_FIXTURE_UNHOOKED is read at packages\/demo\/reader\.js:1 but named in no repository document: describe it in docs\/ENVIRONMENT\.md \(or the package document that owns it/);
  writeFileSync(path.join(root, 'docs.md'), '`DEVRYAN_FIXTURE_UNHOOKED` turns the demo on.\n');
  const passed = validate();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /Docs drift env-reverse: 0 new, 0 known \(0 in baseline\); 1 variables read by 2 production sources/);
});

// Known production reads, one per file kind and owner: a scan that silently
// drops a folder or an extension loses one of these.
const SENTINELS = [
  ['DEVRYAN_EXECUTION_CWD', 'packages/harness-runtime/native/session-execution.c'],
  ['DEVRYAN_NATIVE_IMPORT_ENVIRONMENT_ROOT', 'packages/harness-runtime/native/session-execution-windows.c'],
  ['DEVRYAN_WORKER_GROUP_SIGNALS', 'packages/harness-runtime/native/session-group-darwin.h'],
  ['DEVRYAN_SSH_ASKPASS_VALUE', 'packages/electron/ssh-manager.mjs'],
  ['DEVRYAN_TOOL_ATTACHMENT_OMIT', 'packages/web/server/lib/opencode/tool-attachment-summary.js'],
  ['DEVRYAN_AGENTS_PRESET', 'packages/web/server/lib/opencode/slim-config.js'],
  ['DEVRYAN_MANAGED_READ_OVERLAP', 'packages/orchestration-runtime/harness-policies.js'],
  ['DEVRYAN_NATIVE_SHELL_TICKET', 'packages/web/server/lib/opencode/runtime-host/execution-routing.ts'],
  ['DEVRYAN_DAEMON_READY_TIMEOUT_MS', 'packages/web/bin/cli.js'],
  ['DEVRYAN_CURSOR_SETTING_SOURCES', 'packages/cursor-sdk-runtime/index.js'],
  ['OPENCODE_TUI_CONFIG', 'packages/agents-core/src/cli/paths.ts'],
];

// The repository itself is checked by docs:validate (the test above proves it
// runs the check); this keeps the scan honest about what it reads.
test('the scan reads every production source in the repository and finds known reads of every kind', () => {
  const reads = productionEnvReads(repositoryRoot);
  const expected = listPackageFiles(repositoryRoot).filter((file) => isProductionSource(file) && existsSync(path.join(repositoryRoot, file))).sort();
  assert.deepEqual(reads.scanned, expected);
  for (const [name, file] of SENTINELS) assert.ok(reads.get(name)?.some((site) => site.file === file), `${name} read by ${file}`);
  assert.deepEqual(staleLiteralAllowlist(reads), []);
  assert.deepEqual(readUndocumentedBaseline(path.join(import.meta.dirname, 'known-undocumented-env.json')), []);
});

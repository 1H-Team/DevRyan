import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { VERSION_FILES } from './release.mjs';
import { DRY_RUN_GATES } from './release-candidate.mjs';
import { createFakeGitHub } from './release-github-fake.mjs';
import { isCanonicalRemote, releaseTag } from './release-tag.mjs';

const version = '9.8.7', tag = `v${version}`;
const source = 'a'.repeat(40), other = 'b'.repeat(40);
const repository = '1H-Team/DevRyan';
const quiet = () => {};

async function checkout(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-release-tag-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of VERSION_FILES) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify({ version }));
  }
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.toml'), `[package]\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'packages/desktop/src-tauri/Cargo.lock'), `name = "devryan-desktop"\nversion = "${version}"\n`);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-10-24\n\n- Fixed things.\n`);
  return root;
}

const ciRun = (fields = {}) => ({ id: 7, path: '.github/workflows/ci.yml', head_sha: source, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: repository }, ...fields });
const dryRun = ({ jobs = DRY_RUN_GATES.map(name => ({ name, conclusion: 'success' })), ...fields } = {}) => ({ id: 31, path: '.github/workflows/release.yml', head_sha: source, event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', repository: { full_name: repository }, jobs,
  artifacts: ['DevRyan-macos-arm64-release', 'DevRyan-macos-arm64-candidate-identity'].map(name => ({ name, expired: false, workflow_run: { id: 31, head_sha: source } })), ...fields });

// Scripted git: every call is recorded, nothing touches a real repository.
function scriptedGit({ status = '', origin = 'https://github.com/1H-Team/DevRyan.git', localTag = '' } = {}) {
  const calls = [];
  const run = async (command, args) => {
    assert.equal(command, 'git', `only git runs (${command})`);
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${source}\n` };
    if (args[0] === 'status') return { stdout: status };
    if (args[0] === 'remote') return { stdout: `${origin}\n` };
    if (args[0] === 'rev-parse' && args[1] === '-q') {
      if (!localTag) throw Object.assign(new Error('not a tag'), { code: 1 });
      return { stdout: `${localTag}\n` };
    }
    if (args[0] === 'tag' || args[0] === 'push') return { stdout: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { calls, run, pushes: () => calls.filter(call => call.startsWith('push') || call.startsWith('tag ')) };
}

async function attempt(t, { github = {}, git = {}, preflightStatus = 0, check = false, move = false } = {}) {
  const repositoryRoot = await checkout(t);
  const fake = createFakeGitHub({ ciRuns: [ciRun()], releaseRuns: [dryRun()], ...github });
  const scripted = scriptedGit(git);
  const preflights = [];
  const lines = [];
  const result = await releaseTag({ repositoryRoot, environment: { GITHUB_TOKEN: 'fixture-token' }, fetchImpl: fake.fetchImpl, run: scripted.run, log: line => lines.push(line),
    check, move, cleanPreflight: async options => { preflights.push(options); return preflightStatus; } }).catch(error => error);
  assert.ok(fake.requests.every(request => request.method === 'GET'), 'release:tag only reads GitHub');
  return { result, fake, git: scripted, preflights, lines };
}

test('with clean preflight, green main CI and a green dry run at the commit, release:tag pushes only the tag', async t => {
  const { result, git, preflights, lines } = await attempt(t);
  assert.equal(result.pushed, true, result.message);
  assert.equal(result.dryRunId, '31');
  assert.deepEqual(git.pushes(), [`tag ${tag} ${source}`, `push origin refs/tags/${tag}`], 'the tag alone: main is already pushed');
  assert.equal(git.calls.at(-1), `push origin refs/tags/${tag}`, 'the push is the last step, after every check');
  assert.deepEqual(preflights.map(options => [options.args, options.environment.GITHUB_SHA]), [[['--local-only'], source]]);
  assert.ok(lines.some(line => /Dry run 31 at a{40} passed simulation and visual gates; the tag run adopts its DMG/.test(line)), lines.join('\n'));
});

test('--check runs every check and prints the push command without pushing', async t => {
  const { result, git } = await attempt(t, { check: true });
  assert.equal(result.pushed, false);
  assert.equal(result.command, `git tag ${tag} ${source} && git push origin refs/tags/${tag}`);
  assert.deepEqual(git.pushes(), []);
});

test('release:tag refuses, and pushes nothing, unless every gate holds', async t => {
  const refusals = {
    'uncommitted changes': [{ git: { status: ' M scripts/release.mjs' } }, /uncommitted changes.*Commit or remove them first/s],
    'a fork as origin': [{ git: { origin: 'git@github.com:someone/DevRyan.git' } }, /origin is git@github\.com:someone\/DevRyan\.git, not github\.com\/1H-Team\/DevRyan/],
    'a stale local tag': [{ git: { localTag: other } }, /A local v9\.8\.7 points at b{40}/],
    'red main CI': [{ github: { ciRuns: [ciRun({ conclusion: 'failure' })] } }, /Trusted CI for a{40} is completed\/failure/],
    'main CI still running': [{ github: { ciRuns: [ciRun({ status: 'in_progress', conclusion: null })] } }, /Trusted CI for a{40} is in_progress\/pending/],
    'CI of a pull request': [{ github: { ciRuns: [ciRun({ event: 'pull_request' })] } }, /Trusted CI for a{40} is missing/],
    'no dry run': [{ github: { releaseRuns: [] } }, /No green dry run at a{40}: run `gh workflow run release\.yml --ref main`/],
    'simulate-release failed': [{ github: { releaseRuns: [dryRun({ jobs: DRY_RUN_GATES.map(name => ({ name, conclusion: name === 'simulate-release' ? 'failure' : 'success' })) })] } }, /No green dry run/],
    'a dry run of another commit': [{ github: { releaseRuns: [dryRun({ head_sha: other })] } }, /No green dry run/],
    'the dry run DMG expired': [{ github: { releaseRuns: [dryRun({ artifacts: [] })] } }, /No green dry run/],
    'failing preflight': [{ preflightStatus: 1 }, /Release preflight failed at a{40}; fix it before tagging v9\.8\.7/],
    'the tag at another commit': [{ github: { tags: { [tag]: other } } }, /v9\.8\.7 already points at b{40}\. Move it .* --move/],
  };
  for (const [label, [options, pattern]] of Object.entries(refusals)) {
    const { result, git } = await attempt(t, options);
    assert.ok(result instanceof Error, `${label}: refused`);
    assert.match(result.message, pattern, label);
    assert.deepEqual(git.pushes(), [], `${label}: nothing pushed`);
  }
});

test('a published version or a newer latest is refused before any push', async t => {
  const published = (tagName, fields = {}) => ({ state: { repository, nextId: 1000, tick: 0, latestId: 1, refs: { [`tags/${tagName}`]: { type: 'commit', sha: source } }, tagObjects: {},
    ciRuns: [ciRun()], releaseRuns: [dryRun()], violations: [], effects: [],
    releases: [{ id: 1, tag_name: tagName, target_commitish: source, name: tagName, body: '- notes', draft: false, prerelease: false, created_at: 'x', updated_at: 'x', published_at: 'x', assets: [], ...fields }] } });
  const same = await attempt(t, { github: published(tag) });
  assert.match(same.result.message, /v9\.8\.7 is already published; a published version is final, so bump the patch version/);
  const newer = await attempt(t, { github: published('v10.0.0') });
  assert.match(newer.result.message, /v10\.0\.0 is already latest; release a higher version/);
  for (const { git } of [same, newer]) assert.deepEqual(git.pushes(), []);
});

test('a tag already at the commit pushes nothing; --move re-points an unpublished version with a forced tag ref only', async t => {
  const already = await attempt(t, { github: { tags: { [tag]: source } } });
  assert.equal(already.result.pushed, false);
  assert.deepEqual(already.git.pushes(), []);
  assert.ok(already.lines.some(line => line.includes('already points at')));
  const moved = await attempt(t, { github: { tags: { [tag]: other } }, git: { localTag: other }, move: true });
  assert.equal(moved.result.pushed, true, moved.result.message);
  assert.deepEqual(moved.git.pushes(), [`tag -f ${tag} ${source}`, `push origin +refs/tags/${tag}`]);
});

test('only the canonical repository is an accepted origin', () => {
  for (const url of ['https://github.com/1H-Team/DevRyan.git', 'https://github.com/1H-Team/DevRyan', 'git@github.com:1H-Team/DevRyan.git', 'ssh://git@github.com/1H-Team/DevRyan.git']) assert.ok(isCanonicalRemote(url), url);
  for (const url of ['https://github.com/1H-Team/DevRyan-fork.git', 'https://github.com/someone/DevRyan.git', 'https://example.com/1H-Team/DevRyan.git', '/tmp/DevRyan']) assert.ok(!isCanonicalRemote(url), url);
});

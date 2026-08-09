import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  EVALUATION_CASE_IDS,
  loadEvaluationConfig,
  parseEvaluationArgs,
  validateEvaluationConfig,
} from './config.mjs';
import { discoverScriptTestFiles } from '../test-scripts.mjs';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

const makeWorkspace = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-config-'));
  const fixtureRoot = path.join(root, 'fixture');
  const reportDirectory = path.join(root, 'reports');
  mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  return { fixtureRoot, reportDirectory, root };
};

const validConfig = ({ fixtureRoot, reportDirectory }) => ({
  schemaVersion: 1,
  fixtureRoot,
  devRyanBaseUrl: 'http://127.0.0.1:4310',
  providerId: 'provider-pinned',
  modelId: 'model-pinned',
  agent: 'builder',
  variant: 'high',
  caseIds: ['inspect', 'repair-and-test', 'managed-change'],
  repetitions: 2,
  timeoutMs: 120_000,
  reportDirectory,
});

describe('agent evaluation CLI configuration', () => {
  test('accepts exactly one --config path and resolves it from the repository root', () => {
    assert.deepEqual(parseEvaluationArgs(['--config', 'tmp/eval.json'], { repoRoot }), {
      configPath: path.join(repoRoot, 'tmp/eval.json'),
    });
    assert.deepEqual(parseEvaluationArgs(['--config', '/tmp/eval.json'], { repoRoot }), {
      configPath: '/tmp/eval.json',
    });
  });

  test('rejects missing, duplicate, inline, and additional CLI arguments', () => {
    for (const argv of [
      [],
      ['--config'],
      ['--config=config.json'],
      ['--config', 'one.json', '--config', 'two.json'],
      ['--config', 'config.json', '--quiet'],
      ['config.json'],
    ]) {
      assert.throws(
        () => parseEvaluationArgs(argv, { repoRoot }),
        /Usage: .*--config <path>/,
        JSON.stringify(argv),
      );
    }
  });

  test('normalizes a complete schema-v1 config without reading credentials', () => {
    const workspace = makeWorkspace();
    const input = validConfig(workspace);
    const config = validateEvaluationConfig(input, { repoRoot: workspace.root });

    assert.equal(config.schemaVersion, 1);
    assert.equal(config.fixtureRoot, workspace.fixtureRoot);
    assert.equal(config.reportDirectory, workspace.reportDirectory);
    assert.equal(config.devRyanBaseUrl, 'http://127.0.0.1:4310');
    assert.deepEqual(config.caseIds, input.caseIds);
    assert.equal('headers' in config, false);
    assert.equal('credentials' in config, false);
  });

  test('loads repo-relative fixture and report paths from JSON', () => {
    const workspace = makeWorkspace();
    const configPath = path.join(workspace.root, 'eval.json');
    writeFileSync(configPath, `${JSON.stringify({
      ...validConfig(workspace),
      fixtureRoot: 'fixture',
      reportDirectory: 'reports',
    })}\n`);

    const loaded = loadEvaluationConfig(configPath, { repoRoot: workspace.root });
    assert.equal(loaded.fixtureRoot, workspace.fixtureRoot);
    assert.equal(loaded.reportDirectory, workspace.reportDirectory);
  });

  test('rejects every missing required field and all unknown top-level fields', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);
    for (const key of Object.keys(config)) {
      const candidate = { ...config };
      delete candidate[key];
      assert.throws(
        () => validateEvaluationConfig(candidate, { repoRoot: workspace.root }),
        new RegExp(`Missing required config field: ${key}`),
      );
    }

    assert.throws(
      () => validateEvaluationConfig({ ...config, authorization: 'Bearer secret' }, { repoRoot: workspace.root }),
      /Unknown config field: authorization/,
    );
  });

  test('requires unique known cases, bounded integers, and explicit pinned selectors', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);

    for (const patch of [
      { schemaVersion: 2 },
      { providerId: '' },
      { modelId: '  ' },
      { agent: null },
      { variant: undefined },
      { caseIds: [] },
      { caseIds: ['inspect', 'inspect'] },
      { caseIds: ['unknown'] },
      { repetitions: 0 },
      { repetitions: 1.5 },
      { timeoutMs: 999 },
    ]) {
      assert.throws(
        () => validateEvaluationConfig({ ...config, ...patch }, { repoRoot: workspace.root }),
        /config/i,
        JSON.stringify(patch),
      );
    }

    assert.equal(
      validateEvaluationConfig({ ...config, variant: null }, { repoRoot: workspace.root }).variant,
      null,
    );
    assert.deepEqual(EVALUATION_CASE_IDS, [
      'inspect',
      'repair-and-test',
      'managed-change',
      'oracle-review-focused',
      'oracle-review-deep',
    ]);
    assert.deepEqual(
      validateEvaluationConfig({
        ...config,
        agent: 'oracle',
        caseIds: ['oracle-review-focused', 'oracle-review-deep'],
      }, { repoRoot: workspace.root }).caseIds,
      ['oracle-review-focused', 'oracle-review-deep'],
    );
  });

  test('rejects credential-, URL-, error-, home-, and absolute-path-shaped pinned selectors', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);
    for (const [field, value] of [
      ['providerId', 'Bearer SECRET_PROVIDER'],
      ['providerId', 'token-provider'],
      ['modelId', 'http://127.0.0.1/private'],
      ['modelId', '/Users/private/model'],
      ['agent', '~/private-agent'],
      ['agent', 'Error: SECRET_AGENT'],
      ['variant', '../private-variant'],
    ]) {
      assert.throws(
        () => validateEvaluationConfig({ ...config, [field]: value }, { repoRoot: workspace.root }),
        new RegExp(field),
        `${field}: ${value}`,
      );
    }
  });

  test('accepts only credential-free HTTP loopback base URLs', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);
    for (const devRyanBaseUrl of [
      'https://devryan.example.test',
      'http://192.168.1.10:4310',
      'ftp://127.0.0.1:4310',
      'http://user:password@127.0.0.1:4310',
      'http://127.0.0.1:4310/path',
      'http://127.0.0.1:4310/?token=secret',
    ]) {
      assert.throws(
        () => validateEvaluationConfig({ ...config, devRyanBaseUrl }, { repoRoot: workspace.root }),
        /loopback|base URL|credentials/i,
        devRyanBaseUrl,
      );
    }

    for (const devRyanBaseUrl of [
      'http://localhost:4310/',
      'http://[::1]:4310',
      'https://127.0.0.1:4310/api',
    ]) {
      assert.doesNotThrow(() => validateEvaluationConfig(
        { ...config, devRyanBaseUrl },
        { repoRoot: workspace.root },
      ));
    }
  });

  test('validates the optional prescribed process-sampling profile strictly', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);
    const processSampling = {
      electronPid: 4242,
      caseId: 'inspect',
      intervalMs: 1_000,
      idleSeconds: 60,
      cycles: 5,
      settlementSeconds: 30,
      runs: 2,
    };
    assert.deepEqual(
      validateEvaluationConfig({ ...config, processSampling }, { repoRoot: workspace.root }).processSampling,
      processSampling,
    );

    for (const patch of [
      { token: 'secret' },
      { electronPid: 0 },
      { caseId: 'unknown' },
      { intervalMs: 500 },
      { idleSeconds: 59 },
      { cycles: 4 },
      { settlementSeconds: 29 },
      { runs: 1 },
    ]) {
      assert.throws(
        () => validateEvaluationConfig({
          ...config,
          processSampling: { ...processSampling, ...patch },
        }, { repoRoot: workspace.root }),
        /processSampling/,
        JSON.stringify(patch),
      );
    }
  });

  test('keeps the report directory outside the fixture and wires the root script', () => {
    const workspace = makeWorkspace();
    const config = validConfig(workspace);
    assert.throws(
      () => validateEvaluationConfig({
        ...config,
        reportDirectory: path.join(workspace.fixtureRoot, 'reports'),
      }, { repoRoot: workspace.root }),
      /reportDirectory.*fixtureRoot/,
    );

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts['agent:eval'], 'node ./scripts/agent-evals/main.mjs');
    assert.equal(packageJson.scripts['test:scripts'], 'node scripts/test-scripts.mjs');
    assert.ok(discoverScriptTestFiles(repoRoot).includes('scripts/agent-evals/config.test.mjs'));
  });

  test('rejects a report directory that enters the fixture through a symlink', () => {
    const workspace = makeWorkspace();
    const reportLink = path.join(workspace.root, 'report-link');
    symlinkSync(workspace.fixtureRoot, reportLink, 'dir');

    assert.throws(
      () => validateEvaluationConfig({
        ...validConfig(workspace),
        reportDirectory: path.join(reportLink, 'reports'),
      }, { repoRoot: workspace.root }),
      /reportDirectory.*fixtureRoot/,
    );
  });
});

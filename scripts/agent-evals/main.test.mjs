import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runEvaluationCli } from './main.mjs';

const config = {
  schemaVersion: 1,
  fixtureRoot: '/fixture',
  devRyanBaseUrl: 'http://127.0.0.1:4310',
};

describe('non-interactive evaluation CLI', () => {
  test('loads only the requested config and reports a successful aggregate deterministically', async () => {
    const stdout = [];
    const stderr = [];
    const loadedPaths = [];
    const exitCode = await runEvaluationCli({
      argv: ['--config', 'eval.json'],
      repoRoot: '/repo',
      loadConfig: (configPath) => {
        loadedPaths.push(configPath);
        return config;
      },
      runEvaluation: async (received) => {
        assert.equal(received, config);
        return {
          reportPath: '/reports/result.json',
          report: { aggregates: { status: 'passed' } },
        };
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(loadedPaths, ['/repo/eval.json']);
    assert.deepEqual(stdout, ['[agent:eval] passed; schema-v1 report written\n']);
    assert.deepEqual(stderr, []);
  });

  test('returns nonzero when deterministic graders fail', async () => {
    const stdout = [];
    const exitCode = await runEvaluationCli({
      argv: ['--config', '/tmp/eval.json'],
      repoRoot: '/repo',
      loadConfig: () => config,
      runEvaluation: async () => ({
        reportPath: '/reports/result.json',
        report: { aggregates: { status: 'failed' } },
      }),
      stdout: (line) => stdout.push(line),
      stderr: () => {},
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(stdout, ['[agent:eval] failed; schema-v1 report written\n']);
  });

  test('prints only a stable error code and never an exception message, URL, or credential', async () => {
    const stderr = [];
    const exitCode = await runEvaluationCli({
      argv: ['--config', '/tmp/eval.json'],
      repoRoot: '/repo',
      loadConfig: () => config,
      runEvaluation: async () => {
        const error = new Error('Bearer SECRET at http://127.0.0.1:4310/api?token=SECRET');
        error.code = 'evaluation_http_error';
        error.reportPath = '/private/report.json';
        throw error;
      },
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(stderr, ['[agent:eval] evaluation_http_error; schema-v1 report written\n']);
    assert.equal(stderr.join('').includes('SECRET'), false);
    assert.equal(stderr.join('').includes('http://'), false);
    assert.equal(stderr.join('').includes('/private'), false);
  });
});

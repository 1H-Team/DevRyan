import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  assertSchemaV1ReportSafe,
  buildSchemaV1Report,
  redactHeaders,
  redactUrl,
  writeSchemaV1Report,
} from './report.mjs';

describe('evaluation report safety', () => {
  test('redacts URL credentials, ports, queries, and fragments from diagnostics', () => {
    assert.equal(
      redactUrl('http://user:secret@127.0.0.1:4310/api/session/ses_1?directory=/private/path&token=abc#secret'),
      '<loopback>/api/session/ses_1',
    );
    assert.equal(redactUrl('https://example.test/private?secret=x'), '<remote>/private');
    assert.equal(redactUrl('not a url token=secret'), '<invalid-url>');
  });

  test('redacts sensitive request headers and never returns cookies or credentials', () => {
    assert.deepEqual(redactHeaders({
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
      'Set-Cookie': 'session=secret',
      'X-Api-Key': 'secret',
      Accept: 'application/json',
    }), {
      accept: 'application/json',
      authorization: '[redacted]',
      cookie: '[redacted]',
      'set-cookie': '[redacted]',
      'x-api-key': '[redacted]',
    });
  });

  test('builds a whitelist-only schema-v1 report from secret-bearing internal results', () => {
    const report = buildSchemaV1Report({
      runId: 'eval_001',
      selection: {
        providerId: 'provider-pinned',
        modelId: 'model-pinned',
        agent: 'orchestrator',
        variant: null,
      },
      caseIds: ['managed-change'],
      repetitions: 1,
      timeoutMs: 30_000,
      sessionIds: ['ses_parent', 'ses_child'],
      caseResults: [{
        caseId: 'managed-change',
        repetition: 1,
        durationMs: 1_234,
        status: 'passed',
        tools: [
          { tool: 'devryan_task', status: 'completed', final: true, input: 'SECRET INPUT' },
          { tool: 'apply_patch', status: 'completed', final: true, output: 'SECRET OUTPUT' },
        ],
        graders: [
          { id: 'managed.task-disposition', passed: true, detail: 'SECRET RESPONSE' },
        ],
        turnTiming: {
          records: [
            { durationsMs: { send_to_idle: 55, first_tool: 12 }, marks: { secret: 'SECRET MARK' } },
            { durationsMs: { send_to_idle: 45 } },
          ],
        },
        managedSnapshot: {
          tasks: [{ taskId: 'dvr_task_1', status: 'completed' }],
          resultEnvelopes: [{ taskId: 'dvr_task_1', status: 'completed', action: 'continue' }],
          prompt: 'SECRET MANAGED PROMPT',
        },
        prompt: 'SECRET PROMPT',
        messages: [{ text: 'SECRET MESSAGE TEXT' }],
        requestHeaders: { authorization: 'Bearer SECRET_TOKEN' },
        url: 'http://127.0.0.1:4310/api?token=SECRET_TOKEN',
      }],
      cleanup: {
        restored: true,
        deletedOwnedFileCount: 2,
        manifestMatch: true,
        sessionComplete: false,
        sessionDiscoveryComplete: false,
        sessionAbortFailureCount: 2,
        error: new Error('SECRET CLEANUP ERROR'),
      },
      resources: {
        processSampling: {
          classification: 'not-reproduced',
          runs: [{ baselineBytes: 10, finalBytes: 11, samples: [{ command: 'SECRET COMMAND' }] }],
        },
      },
    });

    assert.deepEqual(Object.keys(report), [
      'schemaVersion',
      'runId',
      'selection',
      'plan',
      'execution',
      'sessionIds',
      'aggregates',
      'resources',
      'graders',
      'cleanup',
    ]);
    assert.doesNotThrow(() => assertSchemaV1ReportSafe(report));
    const serialized = JSON.stringify(report);
    for (const secret of [
      'SECRET INPUT',
      'SECRET OUTPUT',
      'SECRET RESPONSE',
      'SECRET PROMPT',
      'SECRET MESSAGE TEXT',
      'SECRET_TOKEN',
      'SECRET CLEANUP ERROR',
      'SECRET COMMAND',
      'authorization',
      'requestHeaders',
      'messages',
      'prompt',
      'input',
      'output',
      'http://',
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.deepEqual(report.aggregates.tools.byName, {
      apply_patch: 1,
      devryan_task: 1,
    });
    assert.deepEqual(report.graders.byId, {
      'managed.task-disposition': { passed: 1, failed: 0 },
    });
    assert.deepEqual(report.aggregates.turnTimingMs.byMetric.send_to_idle, {
      count: 2,
      total: 100,
      minimum: 45,
      maximum: 55,
      mean: 50,
    });
    assert.deepEqual(report.aggregates.managed, {
      tasks: 1,
      byStatus: { completed: 1 },
      dispositions: { continue: 1 },
    });
    assert.deepEqual(report.cleanup, {
      restored: true,
      deletedOwnedFileCount: 2,
      manifestMatch: true,
      deletionFailureCount: 0,
      sessionComplete: false,
      sessionDiscoveryComplete: false,
      sessionAbortFailureCount: 2,
    });
  });

  test('rejects forbidden report keys and URL- or credential-shaped strings', () => {
    for (const report of [
      { schemaVersion: 1, prompt: 'do the work' },
      { schemaVersion: 1, nested: { toolInput: 'secret' } },
      { schemaVersion: 1, value: 'Bearer secret-token' },
      { schemaVersion: 1, value: 'http://127.0.0.1:4310/api' },
    ]) {
      assert.throws(() => assertSchemaV1ReportSafe(report), /unsafe evaluation report/i);
    }
  });

  test('keeps hostile run identifiers inside the configured report directory', () => {
    const reportDirectory = mkdtempSync(path.join(os.tmpdir(), 'devryan-agent-eval-report-'));
    const report = buildSchemaV1Report({
      runId: '../../../escape',
      selection: { providerId: 'provider', modelId: 'model', agent: 'builder', variant: null },
      caseIds: ['inspect'],
      repetitions: 1,
      timeoutMs: 30_000,
      caseResults: [],
      cleanup: { restored: true, manifestMatch: true },
    });

    const reportPath = writeSchemaV1Report(reportDirectory, report);
    assert.equal(path.dirname(reportPath), reportDirectory);
    assert.equal(report.runId.includes('/'), false);
    assert.equal(path.basename(reportPath).includes('..'), false);
  });

  test('replaces unsafe strings in every whitelisted identifier source without leaking substrings', () => {
    const report = buildSchemaV1Report({
      runId: 'Bearer_SECRET_RUN',
      selection: {
        providerId: 'Bearer SECRET_PROVIDER',
        modelId: 'http://127.0.0.1/private-model',
        agent: '/Users/private/agent',
        variant: 'Error: SECRET_VARIANT',
      },
      caseIds: ['inspect'],
      repetitions: 1,
      timeoutMs: 30_000,
      sessionIds: [
        '/Users/private/fixture',
        'Bearer_SECRET_SESSION',
        'http://127.0.0.1/session',
      ],
      caseResults: [{
        caseId: 'inspect',
        status: 'failed',
        durationMs: 1,
        tools: [
          { tool: '/Users/private/tool', status: 'Bearer_SECRET_STATUS' },
          { tool: 'http://private/tool', status: 'Error: SECRET_STATUS' },
        ],
        turnTiming: {
          records: [{ durationsMs: {
            '/Users/private/metric': 1,
            'Bearer_SECRET_METRIC': 2,
            'Error: SECRET_METRIC': 3,
          } }],
        },
        managedSnapshot: {
          tasks: [{ status: 'Bearer_SECRET_TASK' }],
          resultEnvelopes: [{ action: 'Error: SECRET_ACTION' }],
        },
        graders: [{ id: 'Bearer_SECRET_GRADER', passed: false }],
      }],
      cleanup: { restored: true, manifestMatch: true },
    });

    const serialized = JSON.stringify(report);
    for (const fragment of [
      'SECRET',
      'Bearer',
      'Users',
      'private',
      'http',
      'Error:',
    ]) {
      assert.equal(serialized.includes(fragment), false, fragment);
    }
    assert.equal(report.sessionIds.every((id) => /^session-[a-f0-9]{16}$/.test(id)), true);
  });
});

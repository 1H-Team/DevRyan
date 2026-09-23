import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import {
  classifyCredential,
  getConfigCredentialSources,
  scanConfigCredentialSources,
} from './config-credential-scan.js';
import { createHarnessPreflight, registerHarnessPreflightRoute } from './harness-preflight.js';

// Credential-shaped fixtures are assembled at runtime so no token-like
// literal is committed to the repository.
const fake = (...parts) => parts.join('');
const ANTHROPIC_KEY = fake('sk-', 'ant-', 'api03-', 'Q'.repeat(32));
const OPENAI_KEY = fake('sk-', 'proj-', 'R'.repeat(40));
const GITHUB_TOKEN = fake('gh', 'p_', 'S'.repeat(36));
const GITHUB_PAT = fake('github', '_pat_', 'T'.repeat(30));
const SLACK_TOKEN = fake('xo', 'xb-', '1234567890-', 'U'.repeat(12));
const AWS_KEY_ID = fake('AK', 'IA', 'V'.repeat(16));
const BEARER = fake('Bearer ', 'W'.repeat(40));
const ALL_SECRETS = [ANTHROPIC_KEY, OPENAI_KEY, GITHUB_TOKEN, GITHUB_PAT, SLACK_TOKEN, AWS_KEY_ID, BEARER];

const notFound = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const readerFor = (files) => (filePath) => {
  if (!(filePath in files)) throw notFound();
  const content = files[filePath];
  if (content instanceof Error) throw content;
  return content;
};
const expectNoSecrets = (value) => {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of ALL_SECRETS) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('W'.repeat(20));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyCredential', () => {
  it('recognizes precise credential shapes', () => {
    expect(classifyCredential(ANTHROPIC_KEY)).toBe('anthropic-api-key');
    expect(classifyCredential(OPENAI_KEY)).toBe('api-key');
    expect(classifyCredential(GITHUB_TOKEN)).toBe('github-token');
    expect(classifyCredential(GITHUB_PAT)).toBe('github-token');
    expect(classifyCredential(SLACK_TOKEN)).toBe('slack-token');
    expect(classifyCredential(AWS_KEY_ID)).toBe('aws-access-key-id');
    expect(classifyCredential(BEARER)).toBe('bearer-token');
    expect(classifyCredential(fake('token ', GITHUB_TOKEN))).toBe('github-token');
  });

  it('accepts references, placeholders, and non-credential strings', () => {
    for (const value of [
      '{env:ANTHROPIC_API_KEY}',
      'Bearer {env:MCP_TOKEN}',
      '{file:~/.secrets/openai}',
      'sk-test',
      'task-runner-with-a-very-long-descriptive-name',
      'https://example.test/v1',
      '',
      42,
      null,
      undefined,
      { apiKey: OPENAI_KEY },
    ]) {
      expect(classifyCredential(value)).toBeNull();
    }
  });
});

describe('scanConfigCredentialSources', () => {
  it('reports only key paths and kinds for literal credentials in covered fields', () => {
    const config = {
      mcp: {
        github: { type: 'remote', headers: { Authorization: fake('Bearer ', GITHUB_TOKEN), 'X-Trace': 'on' } },
        slack: { type: 'local', environment: { SLACK_BOT_TOKEN: SLACK_TOKEN, SAFE: '{env:SLACK_BOT_TOKEN}' } },
        uncovered: { type: 'local', command: ['server', '--token', OPENAI_KEY] },
      },
      provider: {
        anthropic: { options: { apiKey: ANTHROPIC_KEY } },
        openai: { options: { apiKey: '{env:OPENAI_API_KEY}', headers: { 'X-Key': AWS_KEY_ID } } },
      },
    };
    const scan = scanConfigCredentialSources(
      [{ origin: 'project', path: '/repo/opencode.jsonc' }],
      { readFile: readerFor({ '/repo/opencode.jsonc': `// comment\n${JSON.stringify(config)}` }) },
    );

    expect(scan.availability).toBe('complete');
    expect(scan.sources).toEqual([{ origin: 'project', path: '/repo/opencode.jsonc', availability: 'scanned' }]);
    expect(scan.findings.map(({ keyPath, kind }) => [keyPath, kind]).sort()).toEqual([
      ['mcp.github.headers.Authorization', 'github-token'],
      ['mcp.slack.environment.SLACK_BOT_TOKEN', 'slack-token'],
      ['provider.anthropic.options.apiKey', 'anthropic-api-key'],
      ['provider.openai.options.headers.X-Key', 'aws-access-key-id'],
    ]);
    expectNoSecrets(scan);
  });

  it('distinguishes absent and unreadable layers from a clean scan without leaking content', () => {
    const errorSpies = ['error', 'warn', 'log', 'info'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const denied = Object.assign(new Error(`EACCES ${OPENAI_KEY}`), { code: 'EACCES' });
    const scan = scanConfigCredentialSources([
      { origin: 'user', path: '/home/a/.config/opencode/opencode.json' },
      { origin: 'project', path: '/repo/opencode.json' },
      { origin: 'project-legacy', path: '/repo/.opencode/opencode.json' },
      { origin: 'custom', path: '/custom/opencode.json' },
    ], {
      readFile: readerFor({
        '/repo/opencode.json': `{ "provider": { "openai": { "options": { "apiKey": "${OPENAI_KEY}" `,
        '/repo/.opencode/opencode.json': denied,
        '/custom/opencode.json': '{}',
      }),
    });

    expect(scan.availability).toBe('partial');
    expect(scan.sources).toEqual([
      { origin: 'user', path: '/home/a/.config/opencode/opencode.json', availability: 'absent' },
      { origin: 'project', path: '/repo/opencode.json', availability: 'unavailable', reason: 'invalidJsonc' },
      { origin: 'project-legacy', path: '/repo/.opencode/opencode.json', availability: 'unavailable', reason: 'readFailed' },
      { origin: 'custom', path: '/custom/opencode.json', availability: 'scanned' },
    ]);
    expect(scan.findings).toEqual([]);
    expectNoSecrets(scan);
    for (const spy of errorSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('reports complete coverage when every layer is absent', () => {
    const scan = scanConfigCredentialSources([{ origin: 'user', path: '/none.json' }], { readFile: readerFor({}) });
    expect(scan).toEqual({
      availability: 'complete',
      sources: [{ origin: 'user', path: '/none.json', availability: 'absent' }],
      findings: [],
    });
  });

  it('enumerates raw user and project layers once', () => {
    const sources = getConfigCredentialSources({ directory: '/repo' });
    const paths = sources.map((source) => source.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(expect.arrayContaining([
      path.join('/repo', 'opencode.json'),
      path.join('/repo', 'opencode.jsonc'),
      path.join('/repo', '.opencode', 'opencode.json'),
      path.join('/repo', '.opencode', 'opencode.jsonc'),
    ]));
    expect(sources.some((source) => source.origin === 'user')).toBe(true);
    expect(getConfigCredentialSources({}).every((source) => !source.origin.startsWith('project'))).toBe(true);
  });
});

describe('harness preflight credential scan', () => {
  const baseDependencies = {
    getAgents: () => [],
    getSkills: () => [],
    getHiddenSkills: () => [],
    getStaleOverrides: () => [],
    getLatestWarmup: () => null,
    getToolManifest: () => ({ tools: [], aliases: {}, sourceRuntime: 'web', directory: '/repo' }),
    getPackagedAgents: () => [],
  };
  const fixtureScan = () => scanConfigCredentialSources([
    { origin: 'project', path: '/repo/opencode.json' },
    { origin: 'project-legacy', path: '/repo/.opencode/opencode.json' },
  ], {
    readFile: readerFor({
      '/repo/opencode.json': JSON.stringify({ mcp: { docs: { headers: { Authorization: BEARER } } } }),
      '/repo/.opencode/opencode.json': `{ "mcp": { "x": { "environment": { "K": "${SLACK_TOKEN}" `,
    }),
  });

  const serve = (dependencies) => {
    const app = express();
    app.use(express.json());
    registerHarnessPreflightRoute(app, createHarnessPreflight(dependencies));
    return app;
  };

  it('adds redacted findings and coverage to the serialized preflight response', async () => {
    const response = await request(serve({ ...baseDependencies, getConfigCredentialScan: fixtureScan }))
      .get('/api/diagnostics/harness/preflight')
      .query({ directory: '/repo' });

    expect(response.status).toBe(200);
    const credentialFindings = response.body.findings.filter((finding) => finding.ruleId === 'literal-credential-in-config');
    expect(credentialFindings).toEqual([expect.objectContaining({
      severity: 'warning',
      artifact: { type: 'config', name: 'mcp.docs.headers.Authorization', path: '/repo/opencode.json', origin: 'project' },
    })]);
    expect(response.body.findings.filter((finding) => finding.ruleId === 'config-credential-scan-unavailable'))
      .toEqual([expect.objectContaining({ artifact: expect.objectContaining({ path: '/repo/.opencode/opencode.json' }) })]);
    expect(response.body.configCredentialScan).toEqual({
      availability: 'partial',
      sources: [
        { origin: 'project', path: '/repo/opencode.json', availability: 'scanned' },
        { origin: 'project-legacy', path: '/repo/.opencode/opencode.json', availability: 'unavailable', reason: 'invalidJsonc' },
      ],
      findingCount: 1,
    });
    expectNoSecrets(response.text);
  });

  it('reduces a failing scan to a kind without exposing its message', async () => {
    const failing = () => { throw new Error(`boom ${ANTHROPIC_KEY}`); };
    const rejecting = async () => { throw new Error(`boom ${ANTHROPIC_KEY}`); };
    for (const getConfigCredentialScan of [failing, rejecting]) {
      const response = await request(serve({ ...baseDependencies, getConfigCredentialScan }))
        .get('/api/diagnostics/harness/preflight');
      expect(response.status).toBe(200);
      expect(response.body.configCredentialScan).toEqual({
        availability: 'unavailable', reason: 'scanFailed', sources: [], findingCount: 0,
      });
      expectNoSecrets(response.text);
    }
  });

  it('marks the scan unavailable rather than clean when no source is wired', () => {
    const result = createHarnessPreflight(baseDependencies).run({ directory: '/repo' });
    expect(result.configCredentialScan).toEqual({
      availability: 'unavailable', reason: 'sourceUnavailable', sources: [], findingCount: 0,
    });
    expect(result.findings.some((finding) => finding.ruleId === 'literal-credential-in-config')).toBe(false);
  });
});

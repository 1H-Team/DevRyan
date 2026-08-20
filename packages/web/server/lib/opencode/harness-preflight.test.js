import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';

import {
  auditPackagedPromptContext,
  createHarnessAnthropicUsageReader,
  createHarnessPreflight,
  extractAnthropicUsageFromMessages,
  lintAgentHarness,
  registerHarnessPreflightRoute,
} from './harness-preflight.js';
import {
  deduplicateExactToolDefinitions,
  findExactDuplicateDefinitions,
} from './harness-context-budget.js';

describe('harness preflight', () => {
  it('warns that external runtimes cannot guarantee skill-policy enforcement', () => {
    const findings = lintAgentHarness({
      agents: [],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {},
      runtimeMode: 'external',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'external-skill-policy-unenforced',
        severity: 'warning',
        summary: expect.stringContaining('cannot guarantee'),
      }),
    ]);
  });

  it('reports read-only findings for unavailable delegated agents and invalid permission keys', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'orchestrator',
          path: '/agents/orchestrator.md',
          frontmatter: {
            permission: {
              task: { explorer: 'allow', missing: 'allow' },
              edit: 'allow',
              unknown_tool: 'allow',
            },
          },
        },
        {
          name: 'explorer',
          path: '/agents/explorer.md',
          frontmatter: { permission: { read: 'allow' } },
        },
      ],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {
        aliases: {
          edit: ['edit', 'write', 'patch'],
          read: ['read'],
          task: ['task'],
          skill: ['skill'],
        },
      },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        summary: expect.stringContaining('missing'),
        artifact: expect.objectContaining({ path: '/agents/orchestrator.md' }),
        stopCondition: expect.stringContaining('missing'),
      }),
      expect.objectContaining({
        severity: 'warning',
        summary: expect.stringContaining('unknown_tool'),
        artifact: expect.objectContaining({ path: '/agents/orchestrator.md' }),
      }),
    ]));
  });

  it('accepts DevRyan tool aliases and MCP wildcard permission keys', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'librarian',
          path: '/agents/librarian.md',
          frontmatter: {
            permission: {
              webfetch: 'allow',
              apply_patch: 'deny',
              'supabase_*': 'deny',
            },
          },
        },
      ],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {
        aliases: {
          edit: ['edit', 'write', 'patch', 'apply_patch'],
          webfetch: ['webfetch'],
        },
      },
    });

    expect(findings).toEqual([]);
  });

  it('warns when the live runtime tool catalog crosses the context review threshold', () => {
    const toolIds = Array.from({ length: 201 }, (_, index) => `tool_${index}`);
    const findings = lintAgentHarness({
      agents: [],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {
        toolIds,
        tools: toolIds.map((id) => ({ id })),
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'large-runtime-tool-surface',
        severity: 'warning',
        summary: expect.stringContaining('201 tools'),
        artifact: expect.objectContaining({
          toolCount: 201,
          warningThreshold: 200,
        }),
        stopCondition: expect.stringContaining('Do not remove tools solely by count'),
      }),
    ]);
  });

  it('accepts Explorer read and search permission keys', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'explorer',
          path: '/agents/explorer.md',
          frontmatter: {
            permission: {
              '*': 'deny',
              read: { '*': 'allow', '*.env': 'ask' },
              grep: 'allow',
              glob: 'allow',
              ast_grep_search: 'allow',
              bash: 'deny',
              task: { '*': 'deny' },
            },
          },
        },
      ],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {},
    });

    expect(findings).toEqual([]);
  });

  it('reports forbidden live runtime tool and MCP surface entries', () => {
    const findings = lintAgentHarness({
      agents: [],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: {
        tools: [
          { id: 'read' },
          { id: 'grep_app_searchGitHub' },
          { id: 'invalid' },
        ],
        mcp: {
          'gh-grep': {},
        },
      },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'forbidden-runtime-tool-surface',
        severity: 'error',
        summary: expect.stringContaining('grep_app_searchGitHub'),
      }),
      expect.objectContaining({
        ruleId: 'forbidden-runtime-tool-surface',
        severity: 'error',
        summary: expect.stringContaining('invalid'),
      }),
      expect.objectContaining({
        ruleId: 'forbidden-runtime-mcp-surface',
        severity: 'error',
        summary: expect.stringContaining('gh-grep'),
      }),
    ]));
  });

  it('does not report forbidden tools that the selected prompt policy disables', () => {
    const findings = lintAgentHarness({
      agents: [],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      promptTools: {
        invalid: false,
        'mcp__*': false,
      },
      toolManifest: {
        tools: [
          { id: 'invalid' },
          { id: 'mcp__docs__query-docs' },
          { id: 'grep_app_searchGitHub' },
        ],
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      ruleId: 'forbidden-runtime-tool-surface',
      summary: expect.stringContaining('grep_app_searchGitHub'),
    }));
  });

  it('reports hidden allowed skills, stale overrides, duplicate skill names, malformed skills, and warmup state', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'builder',
          path: '/agents/builder.md',
          frontmatter: { permission: { skill: { hidden: 'allow' } } },
        },
      ],
      skills: [
        { name: 'hidden', path: '/skills/hidden/SKILL.md', parseOk: true },
        { name: 'duplicate', path: '/skills/a/SKILL.md', parseOk: true },
        { name: 'duplicate', path: '/skills/b/SKILL.md', parseOk: true },
        { name: '', path: '/skills/bad/SKILL.md', parseOk: false, error: 'frontmatter parse failed' },
      ],
      hiddenSkills: [{ name: 'hidden', path: '/skills/hidden/SKILL.md' }],
      staleOverrides: ['removed-agent'],
      latestWarmup: {
        timestamp: 1,
        directory: '/repo',
        timedOut: true,
        errors: [{ name: 'mcp', status: 'timeout', error: 'Timed out' }],
      },
      slimRuntime: {
        expectedMode: 'devryan-wrapper',
        rawPluginEnabled: true,
        wrapperPluginEnabled: false,
      },
      toolManifest: { aliases: { skill: ['skill'] } },
    });

    expect(findings.map((finding) => finding.ruleId)).toEqual(expect.arrayContaining([
      'hidden-skill-allowed',
      'stale-model-override',
      'duplicate-skill-name',
      'malformed-skill-frontmatter',
      'warmup-timeout',
      'slim-raw-mode-active',
    ]));
  });

  it('reports skill names that are invalid or do not match their directory', () => {
    const findings = lintAgentHarness({
      agents: [],
      skills: [
        {
          name: 'Frontend Design',
          path: '/skills/frontend-design/SKILL.md',
          parseOk: true,
        },
        {
          name: 'valid-name',
          path: '/skills/valid-name/SKILL.md',
          parseOk: true,
        },
      ],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: { aliases: { skill: ['skill'] } },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'skill-name-path-mismatch',
        severity: 'error',
        summary: expect.stringContaining('Frontend Design'),
        artifact: expect.objectContaining({
          path: '/skills/frontend-design/SKILL.md',
          expectedName: 'frontend-design',
        }),
      }),
    ]));
    expect(findings.filter((finding) => finding.ruleId === 'skill-name-path-mismatch')).toHaveLength(1);
  });

  it('reports skill-capable agents without the platform skill-announcement policy', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'orchestrator',
          path: '/agents/orchestrator.md',
          content: 'Use skills when relevant.',
          frontmatter: {
            permission: {
              skill: { '*': 'deny', 'Writing Plans': 'allow' },
            },
          },
        },
      ],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: { aliases: { skill: ['skill'] } },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'skill-announcement-policy-missing',
        severity: 'warning',
        summary: expect.stringContaining('skill-announcement policy'),
        artifact: expect.objectContaining({ path: '/agents/orchestrator.md' }),
      }),
    ]));
  });

  it('accepts skill-capable agents with the platform skill-announcement policy', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'orchestrator',
          path: '/agents/orchestrator.md',
          content: 'Skill announcements are tool activity only; do not write assistant text to announce skill use.',
          frontmatter: {
            permission: {
              skill: { '*': 'deny', 'Writing Plans': 'allow' },
            },
          },
        },
      ],
      skills: [],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: { aliases: { skill: ['skill'] } },
    });

    expect(findings.map((finding) => finding.ruleId)).not.toContain('skill-announcement-policy-missing');
  });

  it('reports prompt conflicts when announcement-requiring skills are visible to a silent skill agent', () => {
    const findings = lintAgentHarness({
      agents: [
        {
          name: 'orchestrator',
          path: '/agents/orchestrator.md',
          content: 'Do not write assistant prose announcing that you are loading a skill, using a skill, or about to invoke a specialist.',
          frontmatter: {
            permission: {
              skill: { '*': 'deny', 'Writing Plans': 'allow' },
            },
          },
        },
      ],
      skills: [
        {
          name: 'Writing Plans',
          path: '/skills/writing-plans/SKILL.md',
          content: '**Announce at start:** "I am using the writing-plans skill to create the implementation plan."',
          parseOk: true,
        },
      ],
      hiddenSkills: [],
      staleOverrides: [],
      toolManifest: { aliases: { skill: ['skill'] } },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'skill-announcement-conflict',
        severity: 'warning',
        summary: expect.stringContaining('conflicts with announcement-requiring skill'),
        artifact: expect.objectContaining({ path: '/agents/orchestrator.md' }),
      }),
    ]));
  });

  it('audits packaged prompt context budget without changing content', () => {
    const content = [
      'Use only tools that the runtime exposes.',
      'Use only tools that the runtime exposes.',
      'Route unknown codebase discovery to explorer.',
    ].join('\n');
    const agents = [{ name: 'builder', path: '/agents/builder.md', content }];

    const report = auditPackagedPromptContext({ agents });

    expect(agents[0].content).toBe(content);
    expect(report).toEqual([
      expect.objectContaining({
        agent: 'builder',
        path: '/agents/builder.md',
        byteCount: Buffer.byteLength(content, 'utf8'),
        repeatedRoutingRules: expect.any(Number),
        duplicatedToolSafetyText: expect.any(Number),
        candidates: expect.arrayContaining([
          expect.objectContaining({ classification: 'needs-human-review' }),
        ]),
      }),
    ]);
  });

  it('combines diagnostics, manifest, findings, and read-only audit in a preflight result', () => {
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getLatestWarmup: () => null,
      getToolManifest: () => ({ tools: [], aliases: {}, sourceRuntime: 'web', directory: '/repo' }),
      getPackagedAgents: () => [{ name: 'builder', path: '/agents/builder.md', content: 'short prompt' }],
    });

    const result = preflight.run({ directory: '/repo' });

    expect(result.ok).toBe(true);
    expect(result.directory).toBe('/repo');
    expect(result.findings).toEqual([]);
    expect(result.toolManifest).toEqual(expect.objectContaining({ sourceRuntime: 'web' }));
    expect(result.promptAudit[0]).toEqual(expect.objectContaining({
      agent: 'builder',
      classification: expect.any(String),
    }));
    expect(result.harness).toEqual(expect.objectContaining({
      status: 'success',
      summary: 'Harness preflight completed with 0 findings',
    }));
  });

  it('returns a harness error envelope when preflight dependencies fail', async () => {
    const app = express();
    app.use(express.json());
    registerHarnessPreflightRoute(app, {
      run: async () => {
        throw new Error('skill metadata failed');
      },
    });

    const response = await request(app)
      .get('/api/diagnostics/harness/preflight')
      .query({ directory: '/repo' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      directory: '/repo',
      error: {
        kind: 'preflightFailed',
        message: 'skill metadata failed',
      },
      harness: expect.objectContaining({
        status: 'error',
        summary: 'Harness preflight failed',
      }),
    }));
  });

  it('rejects incomplete model selectors before running preflight diagnostics', async () => {
    const app = express();
    app.use(express.json());
    let runCount = 0;
    registerHarnessPreflightRoute(app, {
      run: async () => {
        runCount += 1;
        return { ok: true };
      },
    });

    const getResponse = await request(app)
      .get('/api/diagnostics/harness/preflight')
      .query({ directory: '/repo', providerID: 'openai' });
    const postResponse = await request(app)
      .post('/api/diagnostics/harness/preflight')
      .send({ directory: '/repo', modelID: 'gpt-5.6' });

    expect(getResponse.status).toBe(400);
    expect(postResponse.status).toBe(400);
    expect(getResponse.body.error).toEqual(expect.objectContaining({
      kind: 'invalidModelSelector',
    }));
    expect(postResponse.body.error).toEqual(expect.objectContaining({
      kind: 'invalidModelSelector',
    }));
    expect(runCount).toBe(0);
  });

  it('passes complete GET and POST model selectors to preflight diagnostics', async () => {
    const app = express();
    app.use(express.json());
    const contexts = [];
    registerHarnessPreflightRoute(app, {
      run: async (context) => {
        contexts.push(context);
        return { ok: true, context };
      },
    });

    await request(app)
      .get('/api/diagnostics/harness/preflight')
      .query({
        directory: '/get-repo',
        providerID: 'openai',
        modelID: 'gpt-5.6',
        agent: 'orchestrator',
      })
      .expect(200);
    await request(app)
      .post('/api/diagnostics/harness/preflight')
      .send({ directory: '/post-repo', providerID: 'anthropic', modelID: 'claude-opus-4-6' })
      .expect(200);

    expect(contexts).toEqual([
      {
        directory: '/get-repo',
        providerID: 'openai',
        modelID: 'gpt-5.6',
        agent: 'orchestrator',
      },
      {
        directory: '/post-repo',
        providerID: 'anthropic',
        modelID: 'claude-opus-4-6',
        agent: undefined,
      },
    ]);
  });

  it('loads IDs-only runtime diagnostics lazily and preserves duplicate tool IDs', async () => {
    const urls = [];
    const toolIds = ['read', 'read', 'é_tool'];
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify(toolIds), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(urls).toEqual([]);

    const result = await preflight.run({ directory: '/repo' });

    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).pathname).toBe('/experimental/tool/ids');
    expect(new URL(urls[0]).searchParams.get('directory')).toBe('/repo');
    expect(result.toolManifest.toolIds).toEqual(toolIds);
    expect(result.toolManifest.tools.map((tool) => tool.id)).toEqual(toolIds);
    expect(result.contextBudget.tools).toEqual(expect.objectContaining({
      label: 'runtimeCatalogUpperBound',
      mode: 'idsOnly',
      duplicatesRetained: true,
      ids: expect.objectContaining({
        availability: 'available',
        itemCount: 3,
        byteCount: Buffer.byteLength(toolIds.join(''), 'utf8'),
        duplicateIds: [{ id: 'read', occurrences: 2 }],
      }),
      descriptions: expect.objectContaining({ availability: 'notRequested', byteCount: null }),
      parameters: expect.objectContaining({ availability: 'notRequested', byteCount: null }),
    }));
  });

  it('loads the selected model catalog and reports exact description, parameter, and duplicate measurements', async () => {
    const urls = [];
    const toolIds = ['é_tool', 'write', 'write'];
    const sharedSchema = { type: 'object', properties: { value: { type: 'string' } } };
    const catalog = [
      { id: 'é_tool', description: 'café', parameters: sharedSchema },
      { id: 'write', description: '写入', parameters: sharedSchema },
      { id: 'write', description: 'other', parameters: { type: 'object', properties: {} } },
    ];
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      fetchImpl: async (url) => {
        urls.push(String(url));
        const pathname = new URL(url).pathname;
        const payload = pathname.endsWith('/ids') ? toolIds : catalog;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await preflight.run({
      directory: '/repo',
      providerID: 'openai',
      modelID: 'gpt-5.6',
    });

    expect(urls).toHaveLength(2);
    const catalogUrl = new URL(urls.find((url) => new URL(url).pathname === '/experimental/tool'));
    expect(Object.fromEntries(catalogUrl.searchParams)).toEqual({
      directory: '/repo',
      provider: 'openai',
      model: 'gpt-5.6',
    });
    expect(result.toolManifest.tools.map((tool) => tool.id)).toEqual(['é_tool', 'write', 'write']);
    expect(result.contextBudget.tools).toEqual(expect.objectContaining({
      label: 'runtimeCatalogUpperBound',
      mode: 'providerModel',
      rawItemCount: 3,
      uniqueItemCount: 2,
      duplicateOccurrenceByteCount: Buffer.byteLength('writeother', 'utf8')
        + Buffer.byteLength(JSON.stringify(catalog[2].parameters), 'utf8'),
      exactDuplicateDefinitionByteCount: 0,
      descriptions: {
        availability: 'available',
        itemCount: 3,
        byteCount: Buffer.byteLength(catalog.map((tool) => tool.description).join(''), 'utf8'),
      },
      parameters: {
        availability: 'available',
        itemCount: 3,
        byteCount: catalog.reduce(
          (total, tool) => total + Buffer.byteLength(JSON.stringify(tool.parameters), 'utf8'),
          0,
        ),
      },
      duplicateCatalogIds: [{ id: 'write', occurrences: 2 }],
      duplicateSchemas: [expect.objectContaining({
        occurrences: 2,
        toolIds: ['é_tool', 'write'],
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
      exactDuplicateDefinitions: [],
    }));
  });

  it('identifies and removes only byte-identical tool definitions', () => {
    const shared = {
      id: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const conflicting = {
      ...shared,
      description: 'Read a file with a plugin override',
    };
    const external = {
      id: 'mcp__buffer__list',
      description: 'List Buffer entries',
      parameters: { type: 'object', properties: {} },
    };
    const tools = [shared, { ...shared }, conflicting, external];

    expect(findExactDuplicateDefinitions(tools)).toEqual([
      expect.objectContaining({
        id: 'read',
        occurrences: 2,
        duplicateByteCount: expect.any(Number),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(deduplicateExactToolDefinitions(tools)).toEqual([shared, conflicting, external]);
    expect(new Set(deduplicateExactToolDefinitions(tools).map((tool) => tool.id)))
      .toEqual(new Set(tools.map((tool) => tool.id)));
  });

  it('reports an unavailable IDs measurement instead of zero bytes when OpenCode rejects the request', async () => {
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    const result = await preflight.run({ directory: '/repo' });

    expect(result.ok).toBe(true);
    expect(result.toolManifest.availability.ids).toEqual({
      availability: 'unavailable',
      error: { kind: 'httpError', httpStatus: 503 },
    });
    expect(result.contextBudget.tools.ids).toEqual({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      duplicateIds: null,
      error: { kind: 'httpError', httpStatus: 503 },
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'runtime-tool-ids-unavailable' }),
    ]));
    expect(result.harness.status).toBe('warning');
  });

  it('preserves available IDs while marking a rejected model catalog unavailable', async () => {
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      fetchImpl: async (url) => (
        new URL(url).pathname.endsWith('/ids')
          ? new Response(JSON.stringify(['read']), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(null, { status: 502 })
      ),
    });

    const result = await preflight.run({
      directory: '/repo',
      providerID: 'openai',
      modelID: 'gpt-5.6',
    });

    expect(result.contextBudget.tools.ids).toEqual(expect.objectContaining({
      availability: 'available',
      itemCount: 1,
      byteCount: 4,
    }));
    expect(result.contextBudget.tools.descriptions).toEqual({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      error: { kind: 'httpError', httpStatus: 502 },
    });
    expect(result.contextBudget.tools.parameters).toEqual({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      error: { kind: 'httpError', httpStatus: 502 },
    });
    expect(result.contextBudget.tools.duplicateCatalogIds).toBe(null);
    expect(result.contextBudget.tools.duplicateSchemas).toBe(null);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'runtime-tool-catalog-unavailable' }),
    ]));
  });

  it('reports a missing live tool reader as unavailable instead of an empty successful catalog', async () => {
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
    });

    const result = await preflight.run({ directory: '/repo' });

    expect(result.toolManifest.availability).toEqual({
      ids: {
        availability: 'unavailable',
        error: { kind: 'sourceUnavailable' },
      },
      catalog: { availability: 'notRequested' },
    });
    expect(result.contextBudget.tools.ids).toEqual({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      duplicateIds: null,
      error: { kind: 'sourceUnavailable' },
    });
    expect(result.contextBudget.tools.duplicateCatalogIds).toBe(null);
    expect(result.contextBudget.tools.duplicateSchemas).toBe(null);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'runtime-tool-ids-unavailable' }),
    ]));
  });

  it('bounds a never-settling IDs request and returns a redacted timeout measurement', async () => {
    const deadline = Symbol('deadline');
    let requestSignal = null;
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer secret-timeout-token' }),
      toolRequestTimeoutMs: 5,
      fetchImpl: async (_url, options = {}) => {
        requestSignal = options.signal || null;
        return new Promise((resolve, reject) => {
          if (!options.signal) return;
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });

    const result = await Promise.race([
      preflight.run({ directory: '/repo' }),
      new Promise((resolve) => setTimeout(() => resolve(deadline), 100)),
    ]);

    expect(result).not.toBe(deadline);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal.aborted).toBe(true);
    expect(result.toolManifest.availability.ids).toEqual({
      availability: 'unavailable',
      error: { kind: 'timeout' },
    });
    expect(result.contextBudget.tools.ids).toEqual(expect.objectContaining({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      duplicateIds: null,
      error: { kind: 'timeout' },
    }));
    expect(JSON.stringify(result)).not.toContain('secret-timeout-token');
    expect(JSON.stringify(result)).not.toContain('opencode.test');
  });

  it('times out only the never-settling full catalog endpoint while preserving IDs', async () => {
    const deadline = Symbol('deadline');
    const signals = new Map();
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      toolRequestTimeoutMs: 5,
      fetchImpl: async (url, options = {}) => {
        const pathname = new URL(url).pathname;
        signals.set(pathname, options.signal || null);
        if (pathname.endsWith('/ids')) {
          return new Response(JSON.stringify(['read']), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Promise((resolve, reject) => {
          if (!options.signal) return;
          options.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    });

    const result = await Promise.race([
      preflight.run({
        directory: '/repo',
        providerID: 'openai',
        modelID: 'gpt-5.6',
      }),
      new Promise((resolve) => setTimeout(() => resolve(deadline), 100)),
    ]);

    expect(result).not.toBe(deadline);
    expect(signals.get('/experimental/tool/ids')).toBeInstanceOf(AbortSignal);
    expect(signals.get('/experimental/tool/ids').aborted).toBe(false);
    expect(signals.get('/experimental/tool')).toBeInstanceOf(AbortSignal);
    expect(signals.get('/experimental/tool').aborted).toBe(true);
    expect(result.contextBudget.tools.ids).toEqual(expect.objectContaining({
      availability: 'available',
      itemCount: 1,
      byteCount: 4,
      duplicateIds: [],
    }));
    expect(result.toolManifest.availability.catalog).toEqual({
      availability: 'unavailable',
      error: { kind: 'timeout' },
    });
    expect(result.contextBudget.tools.descriptions).toEqual(expect.objectContaining({
      availability: 'unavailable',
      itemCount: null,
      byteCount: null,
      error: { kind: 'timeout' },
    }));
    expect(result.contextBudget.tools.duplicateCatalogIds).toBe(null);
    expect(result.contextBudget.tools.duplicateSchemas).toBe(null);
  });

  it('counts packaged prompts and visible skill metadata and bodies without returning their content', async () => {
    const prompt = 'private prompt é';
    const visibleBody = 'private skill body 步骤';
    const readSkills = [];
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [
        {
          name: 'visible-é',
          description: 'résumé helper',
          path: '/skills/visible/SKILL.md',
          parseOk: true,
        },
        {
          name: 'hidden',
          description: 'must stay hidden',
          path: '/skills/hidden/SKILL.md',
          parseOk: true,
        },
      ],
      getHiddenSkills: () => [{ name: 'hidden', path: '/skills/hidden/SKILL.md' }],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [{ name: 'builder', path: '/agents/builder.md', content: prompt }],
      getToolManifest: () => ({
        tools: [],
        toolIds: [],
        aliases: {},
        sourceRuntime: 'server',
        selector: { mode: 'idsOnly', providerID: null, modelID: null },
        availability: {
          ids: { availability: 'available' },
          catalog: { availability: 'notRequested' },
        },
      }),
      readSkillBody: async (skill) => {
        readSkills.push(skill.name);
        return visibleBody;
      },
    });

    const result = await preflight.run({ directory: '/repo' });

    expect(readSkills).toEqual(['visible-é']);
    expect(result.contextBudget.packagedAgentPrompts).toEqual({
      availability: 'available',
      itemCount: 1,
      byteCount: Buffer.byteLength(prompt, 'utf8'),
      items: [{
        name: 'builder',
        path: '/agents/builder.md',
        byteCount: Buffer.byteLength(prompt, 'utf8'),
        source: 'contentFallback',
      }],
    });
    expect(result.contextBudget.visibleSkillCatalogMetadata).toEqual({
      availability: 'available',
      itemCount: 1,
      byteCount: Buffer.byteLength('visible-érésumé helper', 'utf8'),
      items: [{
        name: 'visible-é',
        path: '/skills/visible/SKILL.md',
        byteCount: Buffer.byteLength('visible-érésumé helper', 'utf8'),
      }],
    });
    expect(result.contextBudget.visibleOnDemandSkillBodies).toEqual({
      availability: 'available',
      itemCount: 1,
      byteCount: Buffer.byteLength(visibleBody, 'utf8'),
      items: [{
        name: 'visible-é',
        path: '/skills/visible/SKILL.md',
        availability: 'available',
        byteCount: Buffer.byteLength(visibleBody, 'utf8'),
      }],
    });
    expect(JSON.stringify(result)).not.toContain(prompt);
    expect(JSON.stringify(result)).not.toContain(visibleBody);
    expect(JSON.stringify(result)).not.toContain('must stay hidden');
  });

  it('measures the parsed packaged prompt body instead of production full-file content', async () => {
    const prompt = 'authoritative prompt é';
    const content = `---\ndescription: private frontmatter\n---\n${prompt}`;
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [{
        name: 'builder',
        path: '/agents/builder.md',
        content,
        prompt,
      }],
      getToolManifest: () => ({
        tools: [],
        toolIds: [],
        aliases: {},
        sourceRuntime: 'server',
        selector: { mode: 'idsOnly', providerID: null, modelID: null },
        availability: {
          ids: { availability: 'available' },
          catalog: { availability: 'notRequested' },
        },
      }),
    });

    const result = await preflight.run({ directory: '/repo' });

    expect(result.contextBudget.packagedAgentPrompts).toEqual({
      availability: 'available',
      itemCount: 1,
      byteCount: Buffer.byteLength(prompt, 'utf8'),
      items: [{
        name: 'builder',
        path: '/agents/builder.md',
        byteCount: Buffer.byteLength(prompt, 'utf8'),
        source: 'prompt',
      }],
    });
    expect(JSON.stringify(result)).not.toContain(prompt);
    expect(JSON.stringify(result)).not.toContain('private frontmatter');
  });

  it('keeps a same-name skill visible when only a different path is hidden', async () => {
    const visiblePath = '/skills/visible/SKILL.md';
    const hiddenPath = '/skills/hidden/SKILL.md';
    const readPaths = [];
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [
        { name: 'duplicate', description: 'visible copy', path: visiblePath, parseOk: true },
        { name: 'duplicate', description: 'hidden copy', path: hiddenPath, parseOk: true },
      ],
      getHiddenSkills: () => [{ name: 'duplicate', path: hiddenPath }],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      getToolManifest: () => ({
        tools: [],
        toolIds: [],
        aliases: {},
        sourceRuntime: 'server',
        selector: { mode: 'idsOnly', providerID: null, modelID: null },
        availability: {
          ids: { availability: 'available' },
          catalog: { availability: 'notRequested' },
        },
      }),
      readSkillBody: async (skill) => {
        readPaths.push(skill.path);
        return `body:${skill.path}`;
      },
    });

    const result = await preflight.run({ directory: '/repo' });

    expect(readPaths).toEqual([visiblePath]);
    expect(result.contextBudget.visibleSkillCatalogMetadata.items).toEqual([
      expect.objectContaining({ name: 'duplicate', path: visiblePath }),
    ]);
    expect(result.contextBudget.visibleOnDemandSkillBodies.items).toEqual([
      expect.objectContaining({ name: 'duplicate', path: visiblePath, availability: 'available' }),
    ]);
  });

  it('uses canonical paths so a hidden symlink suppresses its real skill target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-context-skill-'));
    const hiddenRealDir = path.join(root, 'real', 'hidden-skill');
    const hiddenLinkDir = path.join(root, 'linked', 'hidden-skill');
    const visibleDir = path.join(root, 'real', 'visible-skill');
    fs.mkdirSync(hiddenRealDir, { recursive: true });
    fs.mkdirSync(visibleDir, { recursive: true });
    fs.mkdirSync(path.dirname(hiddenLinkDir), { recursive: true });
    fs.writeFileSync(path.join(hiddenRealDir, 'SKILL.md'), 'hidden body', 'utf8');
    fs.writeFileSync(path.join(visibleDir, 'SKILL.md'), 'visible body', 'utf8');
    fs.symlinkSync(hiddenRealDir, hiddenLinkDir, 'dir');

    const hiddenRealPath = path.join(hiddenRealDir, 'SKILL.md');
    const hiddenLinkPath = path.join(hiddenLinkDir, 'SKILL.md');
    const visiblePath = path.join(visibleDir, 'SKILL.md');
    const readPaths = [];

    try {
      const preflight = createHarnessPreflight({
        getAgents: () => [],
        getSkills: () => [
          { name: 'hidden-target', description: 'hidden', path: hiddenRealPath, parseOk: true },
          { name: 'visible-target', description: 'visible', path: visiblePath, parseOk: true },
        ],
        getHiddenSkills: () => [{ name: 'different-name', path: hiddenLinkPath }],
        getStaleOverrides: () => [],
        getPackagedAgents: () => [],
        getToolManifest: () => ({
          tools: [],
          toolIds: [],
          aliases: {},
          sourceRuntime: 'server',
          selector: { mode: 'idsOnly', providerID: null, modelID: null },
          availability: {
            ids: { availability: 'available' },
            catalog: { availability: 'notRequested' },
          },
        }),
        readSkillBody: async (skill) => {
          readPaths.push(skill.path);
          return fs.promises.readFile(skill.path, 'utf8');
        },
      });

      const result = await preflight.run({ directory: root });

      expect(readPaths).toEqual([visiblePath]);
      expect(result.contextBudget.visibleSkillCatalogMetadata.items.map((item) => item.path)).toEqual([
        visiblePath,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Anthropic context budget projection', () => {
  it('extracts provider-reported first and latest turn usage without message content', () => {
    const usage = extractAnthropicUsageFromMessages([
      {
        info: {
          role: 'assistant',
          providerID: 'anthropic',
          tokens: {
            input: 6,
            output: 14,
            reasoning: 0,
            total: 58_055,
            cache: {
              read: 0,
              write: 58_035,
              creation: { ephemeral_1h_input_tokens: 58_035 },
            },
          },
        },
        parts: [{ type: 'text', text: 'private assistant output' }],
      },
      {
        info: {
          role: 'assistant',
          providerID: 'anthropic',
          tokens: {
            input: 20,
            output: 10,
            total: 58_065,
            cache: { read: 58_035, write: 0 },
          },
        },
      },
    ]);

    expect(usage).toEqual({
      fixedPrefixTokens: 58_041,
      requestCount: 2,
      activeContextTokens: 58_065,
      cumulativeProcessedInputTokens: 116_096,
      firstTurnProviderUsage: {
        uncachedInputTokens: 6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 58_035,
        outputTokens: 14,
        reasoningTokens: 0,
        totalTokens: 58_055,
        cacheCreation: { fiveMinuteTokens: null, oneHourTokens: 58_035 },
      },
      providerUsage: {
        uncachedInputTokens: 20,
        cacheReadInputTokens: 58_035,
        cacheCreationInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        totalTokens: 58_065,
        cacheCreation: { fiveMinuteTokens: null, oneHourTokens: null },
      },
    });
    expect(JSON.stringify(usage)).not.toContain('private assistant output');
  });

  it('joins Meridian telemetry by recovered session without exposing raw telemetry', async () => {
    const calls = [];
    const fetchImpl = async (input) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/session/session-a/message') {
        return {
          ok: true,
          json: async () => [{
            info: {
              role: 'assistant',
              providerID: 'anthropic',
              tokens: { input: 6, output: 14, cache: { read: 0, write: 58_035 } },
            },
          }],
        };
      }
      if (url.pathname === '/config/providers') {
        return {
          ok: true,
          json: async () => ({
            providers: [{
              id: 'anthropic',
              options: { baseURL: 'http://127.0.0.1:3456', apiKey: 'private' },
            }],
          }),
        };
      }
      if (url.pathname === '/v1/sessions/session-a/recover') {
        return { ok: true, json: async () => ({ claudeSessionId: 'sdk-private-id' }) };
      }
      if (url.pathname === '/telemetry/requests') {
        return {
          ok: true,
          json: async () => [{
            sdkSessionId: 'sdk-private-id',
            toolCount: 80,
            deferredToolCount: 74,
            rawPrompt: 'must not escape',
          }],
        };
      }
      return { ok: false, json: async () => ({}) };
    };
    const reader = createHarnessAnthropicUsageReader({
      fetchImpl,
      buildOpenCodeUrl: (pathname) => new URL(pathname, 'http://127.0.0.1:4096'),
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic private' }),
    });

    const usage = await reader({ sessionID: 'session-a', directory: '/repo' });

    expect(usage).toMatchObject({
      firstTurnProviderUsage: {
        cacheCreationInputTokens: 58_035,
      },
      tooling: {
        rawToolCount: 80,
        eagerToolCount: 6,
        deferredToolCount: 74,
      },
    });
    expect(calls).toEqual(expect.arrayContaining([
      '/session/session-a/message',
      '/config/providers',
      '/v1/sessions/session-a/recover',
      '/telemetry/requests',
    ]));
    expect(JSON.stringify(usage)).not.toContain('private');
    expect(JSON.stringify(usage)).not.toContain('must not escape');
  });

  it('separates fixed prefix, request count, active context, and cumulative input', async () => {
    const journalRecords = [];
    const preflight = createHarnessPreflight({
      getAgents: () => [],
      getSkills: () => [{
        name: 'alpha',
        description: `A workflow ${'with repeated detail '.repeat(30)}`,
        path: '/skills/alpha/SKILL.md',
        body: 'full body remains on demand',
      }],
      getHiddenSkills: () => [],
      getStaleOverrides: () => [],
      getPackagedAgents: () => [],
      getClaudeRuntime: () => ({
        source: 'managed',
        channel: 'candidate',
        compatibilityStatus: 'upstream_blocked',
        runtimeStatus: 'ready',
        installed: {
          opencodeWithClaude: '1.8.0',
          meridian: '1.62.6',
          agentSdk: '0.2.141',
          claudeCode: '2.1.98',
        },
        managementSources: {
          opencodeWithClaude: 'managed',
          meridian: 'managed',
          agentSdk: 'managed',
          claudeCode: 'managed',
        },
        privatePath: '/Users/private/node_modules',
      }),
      recordDiagnostic: (record) => journalRecords.push(record),
    });

    const result = await preflight.run({
      anthropicUsage: {
        fixedPrefixTokens: 2_000,
        requestCount: 40,
        activeContextTokens: 127_040,
        cumulativeProcessedInputTokens: 4_010_214,
        providerUsage: {
          uncachedInputTokens: 10,
          cacheReadInputTokens: 1_990,
          cacheCreationInputTokens: 0,
          cacheCreation: { oneHourTokens: 0 },
        },
        tooling: { rawToolCount: 80, eagerToolCount: 6, deferredToolCount: 74 },
      },
    });

    expect(result.contextBudget.anthropic).toMatchObject({
      fixedPrefix: {
        descriptionLimit: 240,
        superpowersBootstrapBytes: 0,
        tokens: 2_000,
      },
      requestCount: 40,
      activeContextTokens: 127_040,
      cumulativeProcessedInputTokens: 4_010_214,
      runtime: {
        source: 'managed',
        channel: 'candidate',
        compatibilityStatus: 'upstream_blocked',
        runtimeStatus: 'ready',
        versions: {
          opencodeWithClaude: '1.8.0',
          meridian: '1.62.6',
          agentSdk: '0.2.141',
          claudeCode: '2.1.98',
        },
        managementSources: {
          opencodeWithClaude: 'managed',
          meridian: 'managed',
          agentSdk: 'managed',
          claudeCode: 'managed',
        },
      },
      tooling: { rawToolCount: 80, eagerToolCount: 6, deferredToolCount: 74 },
    });
    expect(result.contextBudget.anthropic.fixedPrefix.transformedBytes)
      .toBeLessThan(result.contextBudget.anthropic.fixedPrefix.originalBytes);
    expect(journalRecords).toHaveLength(1);
    expect(journalRecords[0]).toMatchObject({
      type: 'log',
      event: 'anthropic_context_preflight',
      payload: {
        runtime: result.contextBudget.anthropic.runtime,
        usage: {
          fixedPrefixTokens: 2_000,
          providerUsage: expect.objectContaining({ cacheReadInputTokens: 1_990 }),
        },
      },
    });
    expect(JSON.stringify(journalRecords[0])).not.toContain('/Users/private');
  });
});

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';

import {
  auditPackagedPromptContext,
  createHarnessPreflight,
  lintAgentHarness,
  registerHarnessPreflightRoute,
} from './harness-preflight.js';

describe('harness preflight', () => {
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
          { id: 'context7_query_docs' },
          { id: 'grep_app_searchGitHub' },
          { id: 'invalid' },
        ],
        mcp: {
          context7: {},
          'gh-grep': {},
        },
      },
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'forbidden-runtime-tool-surface',
        severity: 'error',
        summary: expect.stringContaining('context7_query_docs'),
      }),
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
        summary: expect.stringContaining('context7'),
      }),
    ]));
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
});

import { describe, expect, it } from 'vitest';

import {
  bindBotActionPolicyDecision,
  classifyBotActionPolicy,
  effectiveBotBrowserNetworkPolicy,
  validateBotActionPolicy,
  validateBotBrowserPolicy,
} from './policy-engine.js';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const action = (overrides = {}) => ({
  botId: 'bot-1',
  revisionId: 'revision-1',
  runId: 'run-1',
  channelId: 'channel-1',
  initiatorUserId: 'user-1',
  tool: 'browser',
  action: 'click',
  target: {
    origin: 'https://example.com',
    goal: 'Open account settings',
    ref: 'button-1',
  },
  credentialScopeKey: null,
  computerScopeKey: 'bot:bot-1',
  args: { ref: 'button-1' },
  limits: {},
  ...overrides,
});

describe('Bot action policy engine', () => {
  it('keeps the legacy matcher projection byte-compatible when v2 is absent', () => {
    expect(validateBotActionPolicy({
      defaultEffect: 'allow',
      defaultRisk: 'low',
      rules: [],
    })).toEqual({
      defaultEffect: 'allow',
      defaultRisk: 'low',
      rules: [],
    });
    expect(classifyBotActionPolicy({
      action: action({ action: 'snapshot', args: {} }),
      actionPolicy: { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
    })).not.toHaveProperty('matcherVersion');
  });

  it('ANDs structured dimensions and exposes every matching hard quota', () => {
    const classification = classifyBotActionPolicy({
      action: action({
        tool: 'connector:github',
        action: 'publish',
        target: { operationKind: 'write' },
        args: { repository: '1H-Team/DevRyan', files: ['/workspace/docs/a.md'] },
      }),
      facts: {
        actorRole: 'manager',
        authoritativeUrl: 'https://example.com/releases/v1',
        filePaths: ['/workspace/docs/a.md'],
        connectorSchemaValidated: true,
      },
      actionPolicy: {
        matcherVersion: 2,
        defaultEffect: 'deny',
        defaultRisk: 'critical',
        rules: [{
          id: 'publish-docs',
          effect: 'prompt',
          risk: 'sensitive',
          match: {
            tool: 'connector:github',
            actions: ['publish'],
            actorRoles: ['manager'],
            urlPathGlobs: ['/releases/**'],
            filePaths: { quantifier: 'all', globs: ['/workspace/docs/**'] },
            argumentPredicates: [
              { pointer: '/repository', op: 'eq', value: '1H-Team/DevRyan' },
              { pointer: '/files', op: 'arrayContains', value: '/workspace/docs/a.md' },
            ],
          },
          quota: { scope: 'actor', limit: 3, windowSeconds: 300 },
        }],
      },
    });

    expect(classification).toMatchObject({
      matcherVersion: 2,
      effect: 'prompt',
      risk: 'sensitive',
      quotaRules: [{
        ruleId: 'publish-docs',
        scope: 'actor',
        limit: 3,
        windowSeconds: 300,
      }],
    });
    expect(classification.policyFactsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not run connector argument predicates before schema validation', () => {
    const request = {
      action: action({
        tool: 'connector:github',
        action: 'publish',
        target: { operationKind: 'write' },
        args: { repository: '1H-Team/DevRyan' },
      }),
      actionPolicy: {
        matcherVersion: 2,
        defaultEffect: 'deny',
        defaultRisk: 'critical',
        rules: [{
          id: 'schema-gated',
          effect: 'allow',
          risk: 'low',
          match: {
            tool: 'connector:github',
            argumentPredicates: [{
              pointer: '/repository', op: 'eq', value: '1H-Team/DevRyan',
            }],
          },
        }],
      },
      facts: { actorRole: 'manager' },
    };
    expect(classifyBotActionPolicy(request)).toMatchObject({ effect: 'deny' });
    expect(classifyBotActionPolicy({
      ...request,
      facts: { actorRole: 'manager', connectorSchemaValidated: true },
    })).toMatchObject({ effect: 'allow' });
  });

  it('rejects URL ambiguity, host paths, and expression-like glob tokens', () => {
    const policy = {
      matcherVersion: 2,
      rules: [{
        id: 'safe-path',
        effect: 'allow',
        risk: 'low',
        match: { urlPathGlobs: ['/safe/**'] },
      }],
    };
    expect(() => classifyBotActionPolicy({
      action: action({ action: 'snapshot', args: {} }),
      actionPolicy: policy,
      facts: { actorRole: 'member', authoritativeUrl: 'https://example.com/safe/%2fadmin' },
    })).toThrow(/encoded separator/i);
    for (const authoritativeUrl of [
      'https://example.com/safe/page?admin=true',
      'https://example.com/safe/page#admin',
      'https://example.com/safe\\admin',
      'https://example.com/safe/%00admin',
    ]) {
      expect(() => classifyBotActionPolicy({
        action: action({ action: 'snapshot', args: {} }),
        actionPolicy: policy,
        facts: { actorRole: 'member', authoritativeUrl },
      })).toThrow(/browser URL/i);
    }
    expect(() => validateBotActionPolicy({
      matcherVersion: 2,
      rules: [{
        id: 'host-path',
        effect: 'deny',
        risk: 'critical',
        match: { filePaths: { quantifier: 'any', globs: ['/Users/**'] } },
      }],
    })).toThrow(/virtual POSIX/i);
    expect(() => validateBotActionPolicy({
      matcherVersion: 2,
      rules: [{
        id: 'not-cel',
        effect: 'deny',
        risk: 'critical',
        match: { urlPathGlobs: ['/safe/(.*)'] },
      }],
    })).toThrow(/unsupported glob token/i);
  });

  it('defaults browser networking to public-only without changing legacy serialization', () => {
    expect(validateBotBrowserPolicy({})).toEqual({ allowedOrigins: [], deniedOrigins: [] });
    expect(effectiveBotBrowserNetworkPolicy({})).toEqual({ mode: 'public_only', hosts: [] });
    expect(validateBotBrowserPolicy({
      networkAccess: { mode: 'allowlist', hosts: ['EXAMPLE.com:443'] },
    })).toMatchObject({
      networkAccess: { mode: 'allowlist', hosts: ['example.com'] },
    });
  });

  it('evaluates every deny before matching prompt and allow rules', () => {
    const classification = classifyBotActionPolicy({
      action: action({ action: 'snapshot', args: {} }),
      actionPolicy: {
        defaultEffect: 'deny',
        defaultRisk: 'critical',
        rules: [
          { id: 'allow-read', effect: 'allow', risk: 'low', match: { actions: ['snapshot'] } },
          { id: 'prompt-browser', effect: 'prompt', risk: 'sensitive', match: { tool: 'browser' } },
          { id: 'deny-origin', effect: 'deny', risk: 'critical', match: { origins: ['https://example.com'] } },
        ],
      },
    });

    expect(classification).toMatchObject({
      effect: 'deny',
      risk: 'critical',
      approvalClass: 'none',
      ruleIds: ['deny-origin'],
    });
  });

  it('applies the selected Allow default to ordinary bounded browser work', () => {
    const allowByDefault = { defaultEffect: 'allow', defaultRisk: 'low', rules: [] };
    expect(classifyBotActionPolicy({
      action: action({ action: 'snapshot', args: {} }),
      actionPolicy: allowByDefault,
    })).toMatchObject({ effect: 'allow', operationKind: 'read', approvalClass: 'none' });

    expect(classifyBotActionPolicy({ action: action(), actionPolicy: allowByDefault })).toMatchObject({
      effect: 'allow',
      operationKind: 'write',
      risk: 'low',
      approvalClass: 'none',
    });

    expect(classifyBotActionPolicy({
      action: action({ target: { ref: 'button-1', goal: 'Open settings' } }),
      actionPolicy: allowByDefault,
    })).toMatchObject({ effect: 'deny', ruleIds: ['builtin.browser-interaction-unbounded'] });
  });

  it('hard-prompts production publication even under a broad Allow default', () => {
    const classification = classifyBotActionPolicy({
      action: action({
        target: {
          origin: 'https://example.com',
          goal: 'Publish the reviewed update to production',
          ref: 'button-2',
          intent: 'production publication',
        },
      }),
      actionPolicy: { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
    });

    expect(classification).toMatchObject({
      effect: 'prompt',
      risk: 'critical',
      approvalClass: 'requester',
      requireDistinctApprover: false,
      retainEvidence: false,
    });
  });

  it('lets ordinary sends and publication-like UI actions follow the Allow default', () => {
    for (const intent of ['send message', 'publish post', 'upload attachment']) {
      expect(classifyBotActionPolicy({
        action: action({
          target: {
            origin: 'https://example.com',
            goal: 'Complete a routine bounded interaction',
            ref: 'button-2',
            intent,
          },
        }),
        actionPolicy: { defaultEffect: 'allow', defaultRisk: 'low', rules: [] },
      })).toMatchObject({ effect: 'allow', risk: 'low', approvalClass: 'none' });
    }
  });

  it('makes purge, credential export, and broad autonomy critical requester confirmations', () => {
    for (const [tool, actionName] of [
      ['system', 'purge'],
      ['credential', 'export'],
      ['autonomy', 'broad'],
    ]) {
      expect(classifyBotActionPolicy({
        action: action({ tool, action: actionName, target: {}, args: {} }),
      })).toMatchObject({
        effect: 'prompt',
        risk: 'critical',
        approvalClass: 'requester',
        requireDistinctApprover: false,
      });
    }
  });

  it('binds expiry and every canonical action field into the decision hash', () => {
    const classification = classifyBotActionPolicy({ action: action() });
    const expiresAt = '2026-08-23T12:10:00.000Z';
    const firstAction = action({ limits: { maxAttempts: 1, decisionExpiresAt: expiresAt } });
    const first = bindBotActionPolicyDecision({
      classification,
      action: firstAction,
      now: () => NOW,
    });
    const changedArgs = bindBotActionPolicyDecision({
      classification,
      action: action({
        args: { ref: 'button-2' },
        limits: { maxAttempts: 1, decisionExpiresAt: expiresAt },
      }),
      now: () => NOW,
    });
    const changedTarget = bindBotActionPolicyDecision({
      classification,
      action: action({
        target: { ...firstAction.target, origin: 'https://other.example' },
        limits: { maxAttempts: 1, decisionExpiresAt: expiresAt },
      }),
      now: () => NOW,
    });
    const changedRevision = bindBotActionPolicyDecision({
      classification,
      action: action({
        revisionId: 'revision-2',
        limits: { maxAttempts: 1, decisionExpiresAt: expiresAt },
      }),
      now: () => NOW,
    });

    expect(first.actionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(changedArgs.actionHash).not.toBe(first.actionHash);
    expect(changedTarget.actionHash).not.toBe(first.actionHash);
    expect(changedRevision.actionHash).not.toBe(first.actionHash);
    expect(first.binding).toMatchObject({
      botId: 'bot-1',
      revisionId: 'revision-1',
      runId: 'run-1',
      initiatorUserId: 'user-1',
      computerScopeKey: 'bot:bot-1',
      limits: { decisionExpiresAt: expiresAt },
    });
  });
});

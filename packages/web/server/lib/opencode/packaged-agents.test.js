import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativeHarnessPolicies } from '@devryan/orchestration-runtime';
import { AGENT_PROMPT_RENDERER_HASH, AGENT_PROMPT_RENDERER_VERSION, describeAgentPromptTemplate, renderAgentPromptPolicies,
  resolveAgentPromptPolicies, setAgentPromptPolicySource } from './packaged-agents.js';

const projection = (overrides = {}) => ({ readOverlap: false, waitAny: true, compactResults: true, contextProjection: false,
  duplicateOutputs: false, adaptiveDelegation: false, ...overrides });
const template = [
  'Shared instructions.',
  '<!-- devryan:if adaptiveDelegation -->',
  'Implement small known changes yourself.',
  '<!-- devryan:end -->',
  '<!-- devryan:if !adaptiveDelegation -->',
  'Delegate every change.',
  '<!-- devryan:end -->',
  'Closing rule.',
].join('\n');

afterEach(() => setAgentPromptPolicySource(null));

describe('agent prompt policy source', () => {
  it('renders from the registered runtime projection instead of the web process environment', () => {
    const previous = process.env.DEVRYAN_ADAPTIVE_DELEGATION;
    process.env.DEVRYAN_ADAPTIVE_DELEGATION = '1';
    try {
      expect(resolveAgentPromptPolicies()).toEqual({ source: 'environment', policies: resolveNativeHarnessPolicies(process.env) });
      expect(renderAgentPromptPolicies(template)).toContain('Implement small known changes yourself.');
      setAgentPromptPolicySource(() => projection());
      expect(resolveAgentPromptPolicies()).toEqual({ source: 'runtime-projection', policies: projection() });
      expect(renderAgentPromptPolicies(template)).toBe('Shared instructions.\nDelegate every change.\nClosing rule.');
    } finally {
      if (previous === undefined) delete process.env.DEVRYAN_ADAPTIVE_DELEGATION;
      else process.env.DEVRYAN_ADAPTIVE_DELEGATION = previous;
    }
  });
  it('falls back to the environment until the runtime exists and rejects an incomplete projection', () => {
    setAgentPromptPolicySource(() => null);
    expect(resolveAgentPromptPolicies().source).toBe('environment');
    setAgentPromptPolicySource(() => ({ adaptiveDelegation: true }));
    expect(() => resolveAgentPromptPolicies()).toThrow(/incomplete policy projection/);
    expect(() => setAgentPromptPolicySource('not a function')).toThrow(TypeError);
  });
});

describe('agent prompt template derivation', () => {
  it('hashes the unrendered template with the renderer and attests the render for the given policies', () => {
    const off = describeAgentPromptTemplate(template, projection());
    const on = describeAgentPromptTemplate(template, projection({ adaptiveDelegation: true }));
    expect(off).toMatchObject({ rendererHash: AGENT_PROMPT_RENDERER_HASH, rendererVersion: AGENT_PROMPT_RENDERER_VERSION,
      templatePolicies: ['adaptiveDelegation'] });
    expect(on.templateHash).toBe(off.templateHash);
    expect(on.attestedContentHash).not.toBe(off.attestedContentHash);
    expect(off.attestedContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(describeAgentPromptTemplate(`${template}\nChanged.`, projection()).templateHash).not.toBe(off.templateHash);
    // A template without policy blocks attests its own (trimmed) text.
    expect(describeAgentPromptTemplate('Plain role.', projection()).templatePolicies).toEqual([]);
    expect(describeAgentPromptTemplate(null, projection())).toBeNull();
    expect(describeAgentPromptTemplate('<!-- devryan:if unknownPolicy -->\nx\n<!-- devryan:end -->', projection())).toBeNull();
  });
});

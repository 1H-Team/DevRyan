import { describe, expect, it } from 'vitest';
import { hasSiwcPlanUsage } from './chatgpt-siwc.js';

describe('chatgpt siwc helpers', () => {
  it('detects the plan-usage scope', () => {
    expect(hasSiwcPlanUsage(['openid', 'chatgpt.tokens.use.direct'])).toBe(true);
  });
});

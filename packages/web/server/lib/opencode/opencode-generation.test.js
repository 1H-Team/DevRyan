import { describe, expect, it } from 'vitest';

import {
  createCapabilityAbsentError,
  isCapabilityAbsentError,
  OPENCODE_CAPABILITY_ABSENT,
  OPENCODE_GENERATION_INVALID,
  resolveOpenCodeGeneration,
} from './opencode-generation.js';

describe('resolveOpenCodeGeneration', () => {
  it('accepts only an explicitly identified generation 2', () => {
    expect(resolveOpenCodeGeneration({ generation: () => 2 })).toBe(2);
    for (const client of [undefined, null, { generation: () => 1 }]) {
      expect(() => resolveOpenCodeGeneration(client)).toThrow(expect.objectContaining({
        code: OPENCODE_GENERATION_INVALID, status: 503, statusCode: 503,
      }));
    }
  });

  it('fails closed on a malformed client or an unknown generation', () => {
    expect(() => resolveOpenCodeGeneration({})).toThrow(expect.objectContaining({ code: OPENCODE_GENERATION_INVALID, status: 503 }));
    expect(() => resolveOpenCodeGeneration({ generation: () => 3 })).toThrow(expect.objectContaining({ code: OPENCODE_GENERATION_INVALID }));
    const clientFailure = Object.assign(new Error('unknown'), { code: 'opencode_generation_invalid', statusCode: 503 });
    expect(() => resolveOpenCodeGeneration({ generation: () => { throw clientFailure; } })).toThrow(clientFailure);
  });
});

describe('createCapabilityAbsentError', () => {
  it('is a typed 409 naming the capability', () => {
    const error = createCapabilityAbsentError('conversation_revert');
    expect(error).toMatchObject({ code: OPENCODE_CAPABILITY_ABSENT, status: 409, capability: 'conversation_revert', generation: 2 });
    expect(error.message).toBe('OpenCode 2 does not provide conversation_revert yet');
    expect(isCapabilityAbsentError(error)).toBe(true);
    expect(isCapabilityAbsentError(new Error('other'))).toBe(false);
    expect(createCapabilityAbsentError('x', { status: 501 }).status).toBe(501);
  });
});

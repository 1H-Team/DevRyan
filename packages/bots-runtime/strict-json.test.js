import { describe, expect, it } from 'bun:test';

import { parseStrictJson } from './strict-json.js';

describe('strict bounded JSON', () => {
  it('parses JSON while rejecting duplicate keys at any depth', () => {
    expect(parseStrictJson('{"a":1,"nested":{"b":2}}')).toEqual({ a: 1, nested: { b: 2 } });
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(/duplicate key/i);
    expect(() => parseStrictJson('{"nested":{"b":1,"b":2}}')).toThrow(/duplicate key/i);
  });

  it('enforces byte and complexity bounds before returning data', () => {
    expect(() => parseStrictJson('"abcdef"', { maximumBytes: 4 })).toThrow(/too large/i);
    expect(() => parseStrictJson('[[[0]]]', { maximumDepth: 1 })).toThrow(/nested/i);
    expect(() => parseStrictJson('[1,2,3]', { maximumNodes: 2 })).toThrow(/too many/i);
  });
});

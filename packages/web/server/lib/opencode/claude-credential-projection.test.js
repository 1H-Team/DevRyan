import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeKeychainService } from './claude-credential-projection.js';

const home = '/Users/fixture';
const account = path.join(home, '.claude');

describe('Claude keychain naming for migrated profiles', () => {
  it('names the keychain item exactly as Claude Code does', () => {
    expect(claudeKeychainService(account, home)).toBe('Claude Code-credentials');
    expect(claudeKeychainService(`${account}/`, home)).toBe('Claude Code-credentials');
    const custom = '/Users/fixture/profiles/work';
    const suffix = crypto.createHash('sha256').update(custom).digest('hex').slice(0, 8);
    expect(claudeKeychainService(custom, home)).toBe(`Claude Code-credentials-${suffix}`);
  });
});

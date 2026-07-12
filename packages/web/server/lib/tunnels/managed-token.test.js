import { describe, expect, it } from 'vitest';
import { normalizeManagedRemoteTunnelToken } from './managed-token.js';

const TOKEN = `eyJ${'a'.repeat(80)}`;

describe('normalizeManagedRemoteTunnelToken', () => {
  it.each([
    [TOKEN, TOKEN],
    [` cloudflared tunnel run --token ${TOKEN} `, TOKEN],
    [`cloudflared tunnel run --token=${TOKEN}`, TOKEN],
    [`sudo cloudflared service install '${TOKEN}'`, TOKEN],
    [`cloudflared.exe service install "${TOKEN}"`, TOKEN],
    [`brew install cloudflared && cloudflared tunnel run --token ${TOKEN}`, TOKEN],
    [`docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN}`, TOKEN],
  ])('normalizes supported input %#', (input, expected) => {
    expect(normalizeManagedRemoteTunnelToken(input)).toBe(expected);
  });

  it.each([
    '',
    'not a token',
    'cloudflared tunnel run --token',
    `unrelated-tool --token ${TOKEN}`,
    `cloudflared tunnel run --token ${TOKEN} --token garbage`,
    `cloudflared tunnel run --token ${TOKEN} --token ${TOKEN}`,
  ])(
    'rejects invalid input without echoing it: %s',
    (input) => {
      expect(() => normalizeManagedRemoteTunnelToken(input)).toThrow('Paste a raw Cloudflare tunnel token or a Cloudflare-generated connector command.');
      try {
        normalizeManagedRemoteTunnelToken(input);
      } catch (error) {
        expect(error.message).not.toContain(TOKEN);
      }
    },
  );
});

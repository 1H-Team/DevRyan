import { describe, expect, test } from 'bun:test';
import {
  EgressPolicyError,
  assertModelDestinationAllowed,
  isPublicEgressAddress,
  parseConnectAuthority,
} from './connect-policy.js';

const lookupPublic = async () => [
  { address: '104.18.6.192', family: 4 },
  { address: '2606:4700::6812:7c0', family: 6 },
];

describe('model egress CONNECT and HTTP destination policy', () => {
  test('allows only an exact active-revision authority after all DNS answers are public', async () => {
    const destination = await assertModelDestinationAllowed({
      hostname: 'API.OpenAI.com.',
      port: 443,
      allowedHosts: ['api.openai.com:443'],
      lookup: lookupPublic,
    });
    expect(destination).toMatchObject({
      hostname: 'api.openai.com',
      port: 443,
      authority: 'api.openai.com:443',
      address: '104.18.6.192',
    });
  });

  test('denies arbitrary hosts before DNS lookup', async () => {
    let lookedUp = false;
    await expect(assertModelDestinationAllowed({
      hostname: 'example.com',
      port: 443,
      allowedHosts: ['api.openai.com:443'],
      lookup: async () => {
        lookedUp = true;
        return [{ address: '93.184.216.34', family: 4 }];
      },
    })).rejects.toBeInstanceOf(EgressPolicyError);
    expect(lookedUp).toBe(false);
  });

  test('denies loopback, private, LAN, link-local, metadata, and sibling destinations', async () => {
    const cases = [
      ['127.0.0.1', '127.0.0.1:443'],
      ['10.0.0.4', '10.0.0.4:443'],
      ['169.254.169.254', '169.254.169.254:443'],
      ['::1', '[::1]:443'],
      ['host.docker.internal', 'host.docker.internal:443'],
      ['supervisor', 'supervisor:443'],
      ['metadata.google.internal', 'metadata.google.internal:443'],
    ];
    for (const [hostname, authority] of cases) {
      await expect(assertModelDestinationAllowed({
        hostname,
        port: 443,
        allowedHosts: [authority],
        lookup: lookupPublic,
      })).rejects.toBeInstanceOf(EgressPolicyError);
    }
  });

  test('denies a hostname if any DNS answer reaches a private network', async () => {
    await expect(assertModelDestinationAllowed({
      hostname: 'api.openai.com',
      port: 443,
      allowedHosts: ['api.openai.com:443'],
      lookup: async () => [
        { address: '104.18.6.192', family: 4 },
        { address: '192.168.1.8', family: 4 },
      ],
    })).rejects.toMatchObject({ code: 'bot_egress_destination_denied' });
  });

  test('parses strict CONNECT authorities and classifies reserved address families', () => {
    expect(parseConnectAuthority('api.openai.com:443')).toEqual({
      hostname: 'api.openai.com',
      port: 443,
    });
    expect(parseConnectAuthority('[2606:4700::6812:7c0]:443')).toEqual({
      hostname: '2606:4700::6812:7c0',
      port: 443,
    });
    for (const invalid of ['api.openai.com', 'user@api.openai.com:443', 'api.openai.com:0']) {
      expect(() => parseConnectAuthority(invalid)).toThrow(EgressPolicyError);
    }
    expect(isPublicEgressAddress('8.8.8.8')).toBe(true);
    expect(isPublicEgressAddress('172.20.0.2')).toBe(false);
    expect(isPublicEgressAddress('::ffff:127.0.0.1')).toBe(false);
  });
});

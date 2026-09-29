import { DevRyanClaudeTransportPlugin } from './devryan-claude-transport.mjs';
import { resolveSessionWorkingDirectory } from '../../lib/opencode/session-provider-spawn.js';

const { describe, expect, test } = process.env.VITEST
  ? await import('vitest')
  : await import('bun:test');

const directory = '/Users/dev/Projects/visual tweak 2/é';
const request = (baseURL, providerID = 'anthropic') => ({
  sessionID: 'ses_child',
  agent: 'designer',
  model: { providerID, id: 'claude-opus-5-5' },
  provider: { id: providerID, options: baseURL === undefined ? {} : { baseURL } },
  message: {},
});
const headersFor = async (hooks, input) => {
  const output = { headers: { 'x-opencode-session': 'ses_child' } };
  await hooks['chat.headers'](input, output);
  return output.headers;
};

describe('DevRyan Claude transport directory header', () => {
  test('names the requesting instance directory to the loopback Meridian proxy', async () => {
    const hooks = await DevRyanClaudeTransportPlugin({ directory });
    for (const baseURL of ['http://127.0.0.1:3456', 'http://localhost:51234/v1', 'http://[::1]:3456', 'https://127.0.0.1:3456']) {
      const headers = await headersFor(hooks, request(baseURL));
      expect(headers['x-opencode-session']).toBe('ses_child');
      expect(headers['x-devryan-directory']).toBe(encodeURIComponent(directory));
      // Header values stay ASCII; the proxy recovers the exact directory.
      expect(headers['x-devryan-directory']).toMatch(/^[\x21-\x7e]+$/);
      expect(resolveSessionWorkingDirectory(headers['x-devryan-directory'], { boundary: true, exists: () => true }))
        .toEqual({ resolution: { workingDirectory: directory, claimedWorkingDirectory: directory, fellBack: false } });
    }
  });

  test('never sends the directory to a remote endpoint or another provider', async () => {
    const hooks = await DevRyanClaudeTransportPlugin({ directory });
    for (const input of [request('https://api.anthropic.com/v1'), request('http://127.0.0.1.example.com:3456'),
      request(undefined), request('not a url'), request('http://127.0.0.1:3456', 'openai')]) {
      expect(await headersFor(hooks, input)).toEqual({ 'x-opencode-session': 'ses_child' });
    }
  });

  test('registers nothing without an absolute instance directory', async () => {
    for (const input of [undefined, {}, { directory: '' }, { directory: 'relative/project' }]) {
      expect(await DevRyanClaudeTransportPlugin(input)).toEqual({});
    }
  });
});

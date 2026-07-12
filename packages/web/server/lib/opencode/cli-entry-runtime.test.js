import { describe, expect, it } from 'vitest';

import { runCliEntryIfMain } from './cli-entry-runtime.js';

const createDependencies = ({ devMode }) => {
  const calls = {
    exitOnShutdown: [],
    startOptions: [],
  };
  const currentFilename = '/repo/server/index.js';
  const process = {
    argv: ['bun', currentFilename, '--port', '3914'],
    env: devMode ? { OPENCHAMBER_DEV_MODE: 'true' } : {},
  };

  return {
    calls,
    dependencies: {
      process,
      currentFilename,
      parseServeCliOptions: () => ({
        port: 3914,
        host: '127.0.0.1',
      }),
      defaultPort: 3001,
      cloudflareProvider: 'cloudflare',
      managedLocalMode: 'managed-local',
      setExitOnShutdown: (value) => calls.exitOnShutdown.push(value),
      startServer: async (options) => {
        calls.startOptions.push(options);
      },
    },
  };
};

describe('runCliEntryIfMain', () => {
  it('exits the watched development server after signal cleanup', () => {
    const { calls, dependencies } = createDependencies({ devMode: true });

    runCliEntryIfMain(dependencies);

    expect(calls.exitOnShutdown).toEqual([true]);
    expect(calls.startOptions).toHaveLength(1);
    expect(calls.startOptions[0]).toMatchObject({
      attachSignals: true,
      exitOnShutdown: true,
    });
  });
});

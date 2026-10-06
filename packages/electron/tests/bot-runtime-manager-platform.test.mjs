import { expect, mock, test } from 'bun:test';
import { createBotRuntimeManager } from '../bot-runtime-manager.mjs';

// Native platform qualification must not initialize the legacy POSIX service fixtures.
test('Windows Bot construction refuses before manifest, credentials, database or Docker work', () => {
  const touched = mock(() => { throw new Error('Unsupported host reached a runtime owner'); });
  expect(() => createBotRuntimeManager({ platform: 'win32', loadManifest: touched,
    loadRuntimeEnvironment: touched, loadDatabaseSql: touched, resolveDocker: touched,
    runProcess: touched, stateStore: { read: touched, write: touched } }))
    .toThrow(expect.objectContaining({ code: 'bots_platform_unsupported' }));
  expect(touched.mock.calls).toHaveLength(0);
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createRuntimeServiceNativeControl } from '../runtime-service-native.mjs';

describe('runtime-service native bridge loader', () => {
  test('loads only the fixed packaged bridge and sanitizes results', async () => {
    const loaded = [];
    const control = createRuntimeServiceNativeControl({
      platform: 'darwin',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      exists: () => true,
      load: (modulePath) => {
        loaded.push(modulePath);
        return {
          status: () => ({ ok: true, state: 'not_registered', code: null }),
          register: () => ({ ok: true, state: 'requires_approval' }),
          unregister: () => ({ ok: true, state: 'not_registered', code: null }),
        };
      },
    });

    assert.deepEqual(await control.status(), { ok: true, state: 'not_registered', code: null });
    assert.deepEqual(await control.register(), { ok: true, state: 'requires_approval', code: null });
    assert.deepEqual(loaded, [
      '/Applications/DevRyan.app/Contents/Resources/native/DevRyanRuntimeServiceControl.node',
    ]);
  });

  test('distinguishes missing, unloadable, and malformed bridges', async () => {
    assert.throws(
      () => createRuntimeServiceNativeControl({
        platform: 'darwin',
        resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
        exists: () => false,
      }),
      (error) => error.code === 'runtime_service_native_bridge_missing',
    );
    assert.throws(
      () => createRuntimeServiceNativeControl({
        platform: 'darwin',
        resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
        exists: () => true,
        load: () => { throw new Error('dlopen failed'); },
      }),
      (error) => error.code === 'runtime_service_native_bridge_load_failed',
    );

    const malformed = createRuntimeServiceNativeControl({
      platform: 'darwin',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      exists: () => true,
      load: () => ({
        status: () => ({ ok: true, state: 'surprise', code: null }),
        register: () => ({}),
        unregister: () => ({}),
      }),
    });
    await assert.rejects(
      malformed.status(),
      (error) => error.code === 'runtime_service_native_bridge_invalid',
    );
  });
});

import { expect, test } from 'bun:test';
import { desktopSshInstancesGet } from './desktopSsh';

test('normalizes saved SSH aliases to canonical DevRyan fields', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI__: { core: { invoke: async () => ({ instances: [{
      id: 'legacy', sshCommand: 'ssh example',
      remoteOpenchamber: { mode: 'external', preferredPort: 3000 },
      auth: { openchamberPassword: { enabled: false, store: 'never' } },
    }] }) } } },
  });
  try {
    const [instance] = (await desktopSshInstancesGet()).instances;
    expect(instance.remoteDevRyan).toMatchObject({ mode: 'external', preferredPort: 3000 });
    expect(instance.auth.devryanPassword).toEqual({ enabled: false, store: 'never' });
    expect('remoteOpenchamber' in instance).toBe(false);
    expect('openchamberPassword' in instance.auth).toBe(false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: Window }).window;
  }
});

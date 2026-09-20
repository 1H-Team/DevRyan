import { describe, expect, test } from 'bun:test';
import { createBrowserParkingPool, setBrowserSurfaceScheduling } from '../browser-parking.mjs';

describe('inactive browser scheduling', () => {
  test('manual and agent surfaces never share a parking host and cleanup is idempotent', () => {
    let created = 0, destroyed = 0;
    const pool = createBrowserParkingPool(() => {
      created += 1; let dead = false;
      return { isDestroyed: () => dead, destroy: () => { dead = true; destroyed += 1; } };
    });
    const manual = pool.windowFor('manual'), lease = pool.windowFor('lease');
    expect(manual).not.toBe(lease);
    expect(pool.windowFor('manual')).toBe(manual);
    lease.destroy();
    expect(pool.windowFor('lease')).not.toBe(lease);
    pool.close(); pool.close();
    expect(created).toBe(3); expect(destroyed).toBe(3);
    expect(() => pool.windowFor('unknown')).toThrow();
  });

  test('only parked manual tabs throttle; active views and parked leases keep running', () => {
    const calls = [];
    const view = { webContents: { setBackgroundThrottling: value => calls.push(value) } };
    for (const [kind, parked] of [['manual', true], ['manual', false], ['lease', true], ['lease', false]]) {
      setBrowserSurfaceScheduling({ kind, view }, parked);
    }
    expect(calls).toEqual([true, false, false, false]);
  });
});

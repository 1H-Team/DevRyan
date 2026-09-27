import { describe, expect, test } from 'bun:test';

import { botCapabilityCanStream, botCapabilityIsTransient } from './botCapabilityStream';

describe('Bot capability stream policy', () => {
  test('streams exactly while the local catalog is available, independently of Docker', () => {
    expect(botCapabilityCanStream({ state: 'healthy', catalogAvailable: true })).toBe(true);
    expect(botCapabilityCanStream({ state: 'docker_stopped', catalogAvailable: true })).toBe(true);
    expect(botCapabilityCanStream({ state: 'catalog_unavailable', catalogAvailable: false })).toBe(false);
    // Hosts without the catalog summary keep the previous state rule.
    expect(botCapabilityCanStream({ state: 'healthy' })).toBe(true);
    expect(botCapabilityCanStream({ state: 'migration_required' })).toBe(false);
  });

  test('stops polling in recovery and setup states and keeps retrying outages', () => {
    expect(botCapabilityIsTransient({ state: 'database_recovery_required' })).toBe(false);
    expect(botCapabilityIsTransient({ state: 'catalog_unavailable', database: { state: 'recovery_required' } })).toBe(false);
    expect(botCapabilityIsTransient({ state: 'catalog_unavailable', database: { state: 'update_required' } })).toBe(false);
    expect(botCapabilityIsTransient({ state: 'setup_required' })).toBe(false);
    expect(botCapabilityIsTransient({ state: 'unsupported_host' })).toBe(false);
    expect(botCapabilityIsTransient({ state: 'catalog_unavailable', database: { state: 'starting' } })).toBe(true);
    expect(botCapabilityIsTransient({ state: 'bots_maintenance', database: { state: 'maintenance' } })).toBe(true);
    expect(botCapabilityIsTransient({ state: 'docker_stopped', database: { state: 'unavailable' } })).toBe(true);
    expect(botCapabilityIsTransient({ state: 'bots_starting' })).toBe(true);
  });
});

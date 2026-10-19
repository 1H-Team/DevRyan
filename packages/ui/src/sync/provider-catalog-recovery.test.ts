import { expect, test } from 'bun:test'
import { createProviderCatalogRecovery } from './provider-catalog-recovery'

const event = (directory = '/repo', changes: Record<string, unknown> = {}) => ({
  type: 'devryan:provider-catalog', properties: { providerID: 'cursor-acp', directory, source: 'sdk', ...changes },
})
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }

test('coalesces actual SDK catalog invalidation and supersedes pending fallback loads', async () => {
  const calls: unknown[] = []
  let release: (() => void) | undefined
  const recovery = createProviderCatalogRecovery({ directory: () => '/repo', loadProviders: options => {
    calls.push(options); return new Promise<void>(resolve => { release = resolve })
  } })
  expect(recovery.handle('/repo', event())).toBe(true)
  expect(recovery.handle('/repo', event())).toBe(true)
  await flush()
  expect(calls).toEqual([{ directory: '/repo', force: true }])
  expect(recovery.handle('/repo', event())).toBe(true)
  expect(calls).toHaveLength(1)
  release?.(); await flush(); recovery.dispose()
})

test('ignores fallback, malformed, background and wrongly routed catalog notifications', async () => {
  let calls = 0
  const recovery = createProviderCatalogRecovery({ directory: () => '/repo', loadProviders: async () => { calls++ } })
  for (const [directory, payload] of [
    ['/repo', event('/repo', { source: 'fallback' })], ['/repo', event('/repo', { providerID: 'other' })],
    ['/repo', event('/repo', { models: [] })], ['/other', event('/other')], ['/other', event('/repo')],
    ['global', event('')], ['/repo', { type: 'devryan:provider-catalog', properties: null }],
  ] as const) expect(recovery.handle(directory, payload)).toBe(false)
  await flush(); expect(calls).toBe(0); recovery.dispose()
})

test('global notifications refresh only global configuration, and scope changes or disposal cancel queued work', async () => {
  let directory = '', calls = 0
  const recovery = createProviderCatalogRecovery({ directory: () => directory, loadProviders: async options => {
    expect(options).toEqual({ directory: null, force: true }); calls++
  } })
  expect(recovery.handle('global', event(''))).toBe(true)
  await flush(); expect(calls).toBe(1)
  directory = '/repo'
  expect(recovery.handle('/repo', event())).toBe(true)
  directory = '/replacement'; await flush(); expect(calls).toBe(1)
  directory = '/repo'
  expect(recovery.handle('/repo', event())).toBe(true)
  recovery.dispose(); await flush(); expect(calls).toBe(1)
  expect(recovery.handle('/repo', event())).toBe(false)
})

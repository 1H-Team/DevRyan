import { expect, test } from 'bun:test'
import { createClaudeCatalogRecovery } from './claude-catalog-recovery'

const harness = (options: { connected?: boolean | Error; listedAfterReloads?: number; delays?: number[] } = {}) => {
  const calls: unknown[] = []
  const slept: number[] = []
  let reloads = 0, statusReads = 0
  const listedAfter = options.listedAfterReloads ?? Number.POSITIVE_INFINITY
  const recovery = createClaudeCatalogRecovery({
    hasClaudeModels: () => reloads >= listedAfter,
    isConnected: async () => {
      statusReads++
      if (options.connected instanceof Error) throw options.connected
      return options.connected ?? true
    },
    reload: async (reloadOptions) => { calls.push(reloadOptions); reloads++; await recovery.check(reloadOptions.directory) },
    sleep: async (ms) => { slept.push(ms) },
    delays: options.delays ?? [10, 20, 30],
  })
  return { recovery, calls, slept, statusReads: () => statusReads }
}

test('re-reads a connected scope until Claude models are listed, then stops', async () => {
  const { recovery, calls, slept, statusReads } = harness({ listedAfterReloads: 2 })
  await recovery.check('/repo')
  expect(calls).toEqual([{ directory: '/repo', force: true }, { directory: '/repo', force: true }])
  expect(slept).toEqual([10, 20])
  // The reloads re-entered check() without starting a second cycle or status read.
  expect(statusReads()).toBe(1)
})

test('does nothing when Claude models are already listed', async () => {
  const { recovery, calls, statusReads } = harness({ listedAfterReloads: 0 })
  await recovery.check(null)
  expect(calls).toEqual([])
  expect(statusReads()).toBe(0)
})

test('does not reload when Claude is not connected or its status cannot be read', async () => {
  for (const connected of [false, new Error('claude_agent_status_failed')]) {
    const { recovery, calls, slept } = harness({ connected })
    await recovery.check('/repo')
    expect(calls).toEqual([])
    expect(slept).toEqual([])
  }
})

test('gives up after the bounded schedule and can run again on a later commit', async () => {
  const { recovery, calls, statusReads } = harness()
  await recovery.check(null)
  expect(calls).toEqual(Array.from({ length: 3 }, () => ({ directory: null, force: true })))
  await recovery.check(null)
  expect(calls).toHaveLength(6)
  expect(statusReads()).toBe(2)
})

test('scopes recover independently and a failed reload does not end the cycle', async () => {
  const calls: Array<string | null> = []
  const listed = new Set<string>()
  let failNext = true
  const recovery = createClaudeCatalogRecovery({
    hasClaudeModels: directory => listed.has(directory ?? ''),
    isConnected: async () => true,
    reload: async ({ directory }) => {
      calls.push(directory)
      if (failNext) { failNext = false; throw new Error('offline') }
      listed.add(directory ?? '')
    },
    sleep: async () => {},
    delays: [1, 1, 1],
  })
  await Promise.all([recovery.check('/repo'), recovery.check(null)])
  expect(calls.filter(directory => directory === '/repo')).toHaveLength(2)
  expect(calls.filter(directory => directory === null)).toHaveLength(1)
})

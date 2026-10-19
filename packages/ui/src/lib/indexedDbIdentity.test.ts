import { describe, expect, test } from 'bun:test'
import { selectIndexedDbName } from './indexedDbIdentity'

const canonical = 'devryan-records'
const legacy = 'openchamber-records'

describe('IndexedDB identity', () => {
  test('uses the existing legacy database after upgrade', async () => {
    expect(await selectIndexedDbName({ canonical, legacy, listDatabases: async () => [{ name: legacy }] })).toBe(legacy)
  })

  test('uses canonical on fresh installs and when both names exist', async () => {
    expect(await selectIndexedDbName({ canonical, legacy, listDatabases: async () => [] })).toBe(canonical)
    expect(await selectIndexedDbName({ canonical, legacy, listDatabases: async () => [{ name: legacy }, { name: canonical }] })).toBe(canonical)
  })

  test('keeps the legacy name when enumeration is unavailable or fails', async () => {
    expect(await selectIndexedDbName({ canonical, legacy })).toBe(legacy)
    expect(await selectIndexedDbName({ canonical, legacy, listDatabases: async () => { throw new Error('denied') } })).toBe(legacy)
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const headerSource = () => readFileSync(resolve(testDir, 'Header.tsx'), 'utf8')

describe('Header active-session diff stats', () => {
  test('isolates the active-session working-tree badge from the header shell', () => {
    const source = headerSource()

    expect(source).toContain('ActiveSessionChangesBadge')
    expect(source).toContain('sessionId={currentSessionId}')
    expect(source).toContain('directory={sessionDirectory || undefined}')
    expect(source).not.toContain('useSessionDiff')
    expect(source).not.toContain('resolveSessionDiffStats(currentSession?.summary')
  })
})

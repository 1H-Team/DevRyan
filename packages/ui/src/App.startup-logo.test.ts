import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "bun:test"

const testDir = dirname(fileURLToPath(import.meta.url))
const source = () => readFileSync(resolve(testDir, "App.tsx"), "utf8")

describe("StartupReadinessScreen logo", () => {
  test("uses the shared large-logo loading screen for every startup phase", () => {
    const code = source()

    expect(code).toContain("import { RuntimeLoadingScreen } from '@/components/ui/RuntimeLoadingScreen'")
    expect(code).toContain('<RuntimeLoadingScreen')
    expect(code).toContain('message={statusText}')
    expect(code).toContain("state={isError ? 'error' : 'loading'}")
    expect(code).not.toContain("import devRyanBlackLogoUrl")
    expect(code).not.toContain("import devRyanWhiteLogoUrl")
    expect(code).not.toContain('rounded-full border border-border')
    expect(code).not.toContain('animate-pulse pointer-events-none')
  })

  test("keeps startup retry behavior inside the unified screen", () => {
    const code = source()

    expect(code).toContain('onRetry={isError ? onRetry : undefined}')
    expect(code).toContain('isRetrying={isRetrying}')
    expect(code).not.toContain('size-2 rounded-full bg-destructive')
  })
})

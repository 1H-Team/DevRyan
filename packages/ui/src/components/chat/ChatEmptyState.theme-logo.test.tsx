import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

let themeVariant: string | undefined
mock.module("@/contexts/useThemeSystem", () => ({
  useThemeSystem: () => ({ currentTheme: themeVariant ? { metadata: { variant: themeVariant } } : null }),
}))
mock.module("@/sync/global-sync-store", () => ({
  useGlobalSyncStore: (select: (s: { error: null }) => unknown) => select({ error: null }),
}))
mock.module("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const { default: ChatEmptyState } = await import("./ChatEmptyState")
const { default: lightLogo } = await import("@/assets/DevRyan.svg")
const { default: darkLogo } = await import("@/assets/DevRyanWhite.svg")

const globals = globalThis as { document?: unknown }
const originalDocument = globals.document

const stubRoot = (opts: { dark?: boolean; splash?: string | null }) => {
  globals.document = {
    documentElement: {
      classList: { contains: (name: string) => name === "dark" && Boolean(opts.dark) },
      getAttribute: (name: string) => (name === "data-splash-variant" ? opts.splash ?? null : null),
    },
  }
}

const logoSrc = (markup: string) => markup.match(/<img[^>]* src="([^"]*)"/)?.[1]

beforeEach(() => {
  themeVariant = undefined
})
afterEach(() => {
  globals.document = originalDocument
})

describe("ChatEmptyState theme logo", () => {
  test("chooses the first-frame logo from the startup theme before hydration", () => {
    expect(darkLogo).not.toBe(lightLogo)

    stubRoot({})
    expect(logoSrc(renderToStaticMarkup(<ChatEmptyState />))).toBe(lightLogo)

    stubRoot({ dark: true })
    expect(logoSrc(renderToStaticMarkup(<ChatEmptyState />))).toBe(darkLogo)

    stubRoot({ splash: "dark" })
    expect(logoSrc(renderToStaticMarkup(<ChatEmptyState />))).toBe(darkLogo)
  })

  test("renders the light logo when there is no document to read a startup theme from", () => {
    globals.document = undefined
    expect(logoSrc(renderToStaticMarkup(<ChatEmptyState />))).toBe(lightLogo)
  })

  test("keeps the empty state from being selected or dragged", () => {
    stubRoot({})
    const markup = renderToStaticMarkup(<ChatEmptyState />)

    expect(markup).toContain("select-none")
    expect(markup).toMatch(/<img[^>]*class="[^"]*pointer-events-none/)
    expect(markup).toContain('draggable="false"')
  })
})

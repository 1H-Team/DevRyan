import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// safeStorage caches its storage instances and principal at module level, so each test
// loads a private copy of the module (query string = distinct module record).
let moduleCounter = 0
const loadSafeStorage = (): Promise<typeof import("./safeStorage")> =>
  import(`./safeStorage?isolated=${moduleCounter++}`)

describe("safe storage", () => {
  let originalWindow: PropertyDescriptor | undefined

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  })

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test("falls back to memory when storage getters are blocked", async () => {
    const { getSafeSessionStorage, getSafeStorage } = await loadSafeStorage()
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    })

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage blocked")
      },
    })
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("sessionStorage blocked")
      },
    })

    const localStorage = getSafeStorage()
    const sessionStorage = getSafeSessionStorage()

    localStorage.setItem("local-key", "local-value")
    sessionStorage.setItem("session-key", "session-value")

    expect(localStorage.getItem("local-key")).toBe("local-value")
    expect(sessionStorage.getItem("session-key")).toBe("session-value")
    expect(localStorage.length).toBe(1)
    expect(sessionStorage.length).toBe(1)
  })

  test("isolates persisted values and clear operations by principal", async () => {
    const { getSafeStorage, setStoragePrincipal } = await loadSafeStorage()
    const storage = getSafeStorage()
    setStoragePrincipal("user-a")
    storage.setItem("draft", "alpha")

    setStoragePrincipal("user-b")
    expect(storage.getItem("draft")).toBe(null)
    storage.setItem("draft", "beta")
    storage.clear()
    expect(storage.getItem("draft")).toBe(null)

    setStoragePrincipal("user-a")
    expect(storage.getItem("draft")).toBe("alpha")
  })
})

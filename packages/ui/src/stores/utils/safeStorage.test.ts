import { describe, expect, test } from "bun:test"
import { getSafeSessionStorage, getSafeStorage, setStoragePrincipal } from "./safeStorage"

describe("safe storage", () => {
  test("falls back to memory when storage getters are blocked", () => {
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

  test("isolates persisted values and clear operations by principal", () => {
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

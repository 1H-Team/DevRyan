import { describe, expect, test } from "bun:test"
import type { GitAPI, GitStatus } from "./api/types"
import { getGitStatus, gitPush, syncGitBranchForPush } from "./gitApi"

const status: GitStatus = {
  current: "main",
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
}

const withRuntimeGit = async (git: Partial<GitAPI>, callback: () => Promise<void>) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __DEVRYAN_RUNTIME_APIS__: { git },
    },
  })

  try {
    await callback()
  } finally {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, "window", previousWindowDescriptor)
    } else {
      delete (globalThis as { window?: Window }).window
    }
  }
}

describe("getGitStatus", () => {
  test("forwards light-mode options to runtime git APIs", async () => {
    let received: { directory: string; options?: { mode?: "light" } } | null = null
    const runtimeGit = {
      getGitStatus: async (directory: string, options?: { mode?: "light" }) => {
        received = { directory, options }
        return status
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      await getGitStatus("/repo", { mode: "light" })
    })

    expect(received).toEqual({ directory: "/repo", options: { mode: "light" } })
  })
})

describe("gitPush", () => {
  test("sends directly without reading status, fetching or pulling", async () => {
    const calls: string[] = []
    const unexpected = async (): Promise<never> => { throw new Error("Push must not synchronize first") }
    await withRuntimeGit({
      getGitStatus: unexpected,
      getRemotes: unexpected,
      gitFetch: unexpected,
      gitPull: unexpected,
      gitPush: async (directory, options) => {
        calls.push(directory)
        expect(options).toEqual({})
        return { success: true, pushed: [], repo: directory, ref: null }
      },
    }, async () => {
      expect(await gitPush("/repo")).toMatchObject({ success: true })
    })
    expect(calls).toEqual(["/repo"])
  })
})

describe("syncGitBranchForPush", () => {
  test("fetches, pulls a clean behind branch, then pushes ahead commits", async () => {
    const calls: string[] = []
    const statuses: GitStatus[] = [
      { ...status, current: "main", tracking: "origin/main", ahead: 1, behind: 0 },
      { ...status, current: "main", tracking: "origin/main", ahead: 1, behind: 2 },
      { ...status, current: "main", tracking: "origin/main", ahead: 1, behind: 0 },
    ]
    const runtimeGit = {
      getRemotes: async () => [{ name: "origin", fetchUrl: "git@example.com:repo.git", pushUrl: "git@example.com:repo.git" }],
      getGitStatus: async () => statuses.shift() ?? status,
      gitFetch: async (_directory: string, options?: { remote?: string; branch?: string }) => {
        calls.push(`fetch:${options?.remote ?? ""}:${options?.branch ?? ""}`)
        return { success: true }
      },
      gitPull: async (_directory: string, options?: { remote?: string; branch?: string; rebase?: boolean }) => {
        calls.push(`pull:${options?.remote ?? ""}:${options?.branch ?? ""}:${String(options?.rebase)}`)
        return { success: true, summary: { changes: 1, insertions: 1, deletions: 0 }, files: ["a.ts"], insertions: 1, deletions: 0 }
      },
      gitPush: async (_directory: string, options?: { remote?: string }) => {
        calls.push(`push:${options?.remote ?? ""}`)
        return { success: true, pushed: [], repo: "/repo", ref: null }
      },
    } as Partial<GitAPI> as GitAPI

    await withRuntimeGit(runtimeGit, async () => {
      const result = await syncGitBranchForPush("/repo")
      expect(result.pulledFileCount).toBe(1)
      expect(result.pushedChanges).toBe(true)
    })

    expect(calls).toEqual(["fetch:origin:main", "pull:origin:main:true", "push:origin"])
  })

  test("fetches only the tracked branch when tracking exists", async () => {
    const fetched: Array<{ remote?: string; branch?: string }> = []
    await syncGitBranchForPush("/repo", {}, {
      getGitStatus: async () => ({ ...status, current: "main", tracking: "origin/main", ahead: 1 }),
      getRemotes: async () => [{ name: "origin", fetchUrl: "git@example.com:repo.git", pushUrl: "git@example.com:repo.git" }],
      gitFetch: async (_directory, options) => {
        fetched.push(options ?? {})
        return { success: true }
      },
      gitPush: async () => ({ success: true, pushed: [], repo: "/repo", ref: null }),
    })
    expect(fetched).toEqual([{ remote: "origin", branch: "main" }])
  })

  test("fetches the remote without a branch on first publish", async () => {
    const fetched: Array<{ remote?: string; branch?: string }> = []
    await syncGitBranchForPush("/repo", {}, {
      getGitStatus: async () => ({ ...status, current: "main", tracking: null, ahead: 1 }),
      getRemotes: async () => [{ name: "origin", fetchUrl: "git@example.com:repo.git", pushUrl: "git@example.com:repo.git" }],
      gitFetch: async (_directory, options) => {
        fetched.push(options ?? {})
        return { success: true }
      },
      gitPush: async () => ({ success: true, pushed: [], repo: "/repo", ref: null }),
    })
    expect(fetched).toEqual([{ remote: "origin" }])
  })

  test("stops before pulling when the branch is behind and the worktree is dirty", async () => {
    const calls: string[] = []
    const dirtyBehind: GitStatus = {
      ...status,
      tracking: "origin/main",
      behind: 1,
      isClean: false,
      files: [{ path: "dirty.ts", index: " ", working_dir: "M" }],
    }
    const runtimeGit = {
      getRemotes: async () => [{ name: "origin", fetchUrl: "git@example.com:repo.git", pushUrl: "git@example.com:repo.git" }],
      getGitStatus: async () => dirtyBehind,
      gitFetch: async () => {
        calls.push("fetch")
        return { success: true }
      },
      gitPull: async () => {
        calls.push("pull")
        return { success: true, summary: { changes: 0, insertions: 0, deletions: 0 }, files: [], insertions: 0, deletions: 0 }
      },
      gitPush: async () => {
        calls.push("push")
        return { success: true, pushed: [], repo: "/repo", ref: null }
      },
    } as Partial<GitAPI> as GitAPI

    let thrown: unknown = null
    await withRuntimeGit(runtimeGit, async () => {
      try {
        await syncGitBranchForPush("/repo")
      } catch (error) {
        thrown = error
      }
    })

    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message.includes("dirty")).toBe(true)
    expect(calls).toEqual(["fetch"])
  })
})

describe('rebase push guards', () => {
  test('blocks before fetch even when rebase metadata is empty', async () => {
    let fetched = false
    await expect(syncGitBranchForPush('/repo', {}, {
      getGitStatus: async () => ({ ...status, rebaseInProgress: { headName: '', onto: '' } }),
      getRemotes: async () => [],
      gitFetch: async () => { fetched = true; return { success: true } },
    })).rejects.toThrow('Rebase in progress')
    expect(fetched).toBe(false)
  })

  test('never pushes after pull returns conflicts, including a stale status response', async () => {
    let pushed = false
    await expect(syncGitBranchForPush('/repo', {}, {
      getGitStatus: async () => ({ ...status, tracking: 'origin/main', ahead: 1, behind: 1 }),
      getRemotes: async () => [],
      gitFetch: async () => ({ success: true }),
      gitPull: async () => ({ success: false, conflict: true, conflictFiles: ['file'], files: [], insertions: 0, deletions: 0, summary: { changes: 0, insertions: 0, deletions: 0 } }),
      gitPush: async () => { pushed = true; return { success: true, pushed: [], repo: "/repo", ref: null } },
    })).rejects.toThrow('Pull did not complete')
    expect(pushed).toBe(false)
  })
})

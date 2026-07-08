import { describe, expect, mock, test } from "bun:test"

import type { GitAPI } from "@/lib/api/types"
import {
  checkoutBranchWithOptionalStash,
  finishCurrentBranchIntoMainWithOptionalStash,
  normalizeCheckoutBranchName,
} from "./branchCheckout"

const createGit = () => {
  const calls: string[] = []
  const git = {
    checkoutBranch: mock(async (_directory: string, branch: string) => {
      calls.push(`checkout:${branch}`)
      return { success: true, branch }
    }),
    stash: mock(async () => {
      calls.push("stash")
      return { success: true }
    }),
    stashPop: mock(async () => {
      calls.push("stashPop")
      return { success: true }
    }),
  } as unknown as GitAPI
  return { git, calls }
}

describe("branch checkout helper", () => {
  test("normalizes remote-prefixed branch names for checkout", () => {
    expect(normalizeCheckoutBranchName("remotes/origin/main")).toBe("origin/main")
    expect(normalizeCheckoutBranchName(" main ")).toBe("main")
  })

  test("clean checkout calls checkout directly", async () => {
    const { git, calls } = createGit()

    const result = await checkoutBranchWithOptionalStash({
      git,
      directory: "/repo",
      branch: "main",
      status: { current: "feature", tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
      restoreAfter: false,
    })

    expect(result).toEqual({ type: "checked-out", branch: "main", stashed: false, restored: false })
    expect(calls).toEqual(["checkout:main"])
  })

  test("dirty checkout requests stash confirmation without mutating", async () => {
    const { git, calls } = createGit()

    const result = await checkoutBranchWithOptionalStash({
      git,
      directory: "/repo",
      branch: "main",
      status: {
        current: "feature",
        tracking: null,
        ahead: 0,
        behind: 0,
        files: [{ path: "src/app.ts", index: " ", working_dir: "M" }],
        isClean: false,
      },
      restoreAfter: false,
    })

    expect(result).toEqual({ type: "needs-stash", branch: "main", dirtyFiles: 1 })
    expect(calls).toEqual([])
  })

  test("confirmed dirty checkout stashes, checks out, and restores", async () => {
    const { git, calls } = createGit()

    const result = await checkoutBranchWithOptionalStash({
      git,
      directory: "/repo",
      branch: "main",
      status: {
        current: "feature",
        tracking: null,
        ahead: 0,
        behind: 0,
        files: [{ path: "src/app.ts", index: " ", working_dir: "M" }],
        isClean: false,
      },
      stashConfirmed: true,
      restoreAfter: true,
    })

    expect(result).toEqual({ type: "checked-out", branch: "main", stashed: true, restored: true })
    expect(calls).toEqual(["stash", "checkout:main", "stashPop"])
  })

  test("attention states block checkout without stashing", async () => {
    const { git, calls } = createGit()

    const result = await checkoutBranchWithOptionalStash({
      git,
      directory: "/repo",
      branch: "main",
      attachment: {
        worktreeRoot: "/repo",
        cwd: "/repo",
        branch: "feature",
        headState: "branch",
        worktreeStatus: "ready",
        worktreeSource: "existing",
        legacy: false,
        degraded: false,
        attentionReason: "rebase",
      },
      status: { current: "feature", tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
      stashConfirmed: true,
      restoreAfter: true,
    })

    expect(result).toEqual({ type: "blocked", branch: "main", reason: "rebase in progress" })
    expect(calls).toEqual([])
  })
})

const createFinishGit = (options: {
  current?: string | null;
  branches?: string[];
  dirty?: boolean;
  mergeConflict?: boolean;
  deleteFails?: boolean;
}) => {
  const calls: string[] = []
  const current = Object.prototype.hasOwnProperty.call(options, "current") ? options.current : "feature"
  const git = {
    getGitStatus: mock(async () => {
      calls.push("status")
      return {
        current,
        tracking: null,
        ahead: 0,
        behind: 0,
        files: options.dirty === false ? [] : [{ path: "src/app.ts", index: " ", working_dir: "M" }],
        isClean: options.dirty === false,
      }
    }),
    getGitBranches: mock(async () => {
      calls.push("branches")
      const all = options.branches ?? ["feature", "main"]
      return {
        all,
        current: current ?? "",
        branches: Object.fromEntries(all.map((name) => [name, { current: name === current, name, commit: "", label: name }])),
      }
    }),
    stash: mock(async () => {
      calls.push("stash")
      return { success: true }
    }),
    checkoutBranch: mock(async (_directory: string, branch: string) => {
      calls.push(`checkout:${branch}`)
      return { success: true, branch }
    }),
    merge: mock(async (_directory: string, payload: { branch: string }) => {
      calls.push(`merge:${payload.branch}`)
      if (options.mergeConflict) {
        return { success: false, conflict: true, conflictFiles: ["src/app.ts"] }
      }
      return { success: true, conflict: false }
    }),
    deleteGitBranch: mock(async (_directory: string, payload: { branch: string }) => {
      calls.push(`delete:${payload.branch}`)
      if (options.deleteFails) {
        throw new Error("branch is not fully merged")
      }
      return { success: true }
    }),
    stashPop: mock(async () => {
      calls.push("stashPop")
      return { success: true }
    }),
  } as unknown as GitAPI
  return { git, calls }
}

describe("finish current branch into main helper", () => {
  test("stashes dirty changes, checks out main, merges the source branch, deletes it, and restores", async () => {
    const { git, calls } = createFinishGit({ current: "feature" })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result).toEqual({
      type: "merged",
      sourceBranch: "feature",
      targetBranch: "main",
      stashed: true,
      restored: true,
    })
    expect(calls).toEqual(["status", "branches", "stash", "checkout:main", "merge:feature", "delete:feature", "stashPop"])
  })

  test("blocks when local main is missing", async () => {
    const { git, calls } = createFinishGit({ current: "feature", branches: ["feature", "develop"] })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result).toEqual({ type: "blocked", reason: "local main branch is required" })
    expect(calls).toEqual(["status", "branches"])
  })

  test("blocks detached or missing current branch", async () => {
    const { git, calls } = createFinishGit({ current: null })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result).toEqual({ type: "blocked", reason: "current branch is required" })
    expect(calls).toEqual(["status", "branches"])
  })

  test("blocks when already on main", async () => {
    const { git, calls } = createFinishGit({ current: "main" })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result).toEqual({ type: "blocked", reason: "already on main" })
    expect(calls).toEqual(["status", "branches"])
  })

  test("returns conflict without deleting the source branch or restoring the stash", async () => {
    const { git, calls } = createFinishGit({ current: "feature", mergeConflict: true })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result).toEqual({
      type: "conflict",
      sourceBranch: "feature",
      targetBranch: "main",
      conflictFiles: ["src/app.ts"],
      stashed: true,
    })
    expect(calls).toEqual(["status", "branches", "stash", "checkout:main", "merge:feature"])
  })

  test("reports delete failure after a clean merge without restoring the stash", async () => {
    const { git, calls } = createFinishGit({ current: "feature", deleteFails: true })

    const result = await finishCurrentBranchIntoMainWithOptionalStash({
      git,
      directory: "/repo",
      restoreAfter: true,
    })

    expect(result.type).toBe("delete-failed")
    if (result.type === "delete-failed") {
      expect(result.sourceBranch).toBe("feature")
      expect(result.targetBranch).toBe("main")
      expect(result.stashed).toBe(true)
    }
    expect(calls).toEqual(["status", "branches", "stash", "checkout:main", "merge:feature", "delete:feature"])
  })
})

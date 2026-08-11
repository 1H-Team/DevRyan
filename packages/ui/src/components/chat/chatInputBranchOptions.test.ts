import { describe, expect, test } from "bun:test"

import {
  buildDraftLocalBranchOptions,
  decodeDraftBranchOptionValue,
  encodeDraftBranchOptionValue,
} from "./chatInputBranchOptions"

describe("chat input branch options", () => {
  test("builds local and remote branch options with provenance", () => {
    const options = buildDraftLocalBranchOptions({
      allBranches: ["feature", "main", "remotes/origin/main"],
      currentBranch: "feature",
    })

    expect(options).toEqual([
      { value: "branch:feature", label: "feature", remoteOnly: false, inWorktree: false },
      { value: "branch:main", label: "main", remoteOnly: false, inWorktree: false },
      { value: "branch:remotes/origin/main", label: "main", remoteOnly: true, inWorktree: false },
    ])
  })

  test("does not reintroduce a current branch removed from the supplied grant-filtered list", () => {
    const options = buildDraftLocalBranchOptions({
      allBranches: ["feature"],
      currentBranch: "main",
    })

    expect(options).toEqual([
      { value: "branch:feature", label: "feature", remoteOnly: false, inWorktree: false },
    ])
  })

  test("deduplicates same-name remotes while retaining a remote choice beside its local branch", () => {
    expect(buildDraftLocalBranchOptions({
      allBranches: ["main", "remotes/upstream/dev", "remotes/origin/dev", "remotes/origin/main"],
      currentBranch: "main",
    })).toEqual([
      { value: "branch:main", label: "main", remoteOnly: false, inWorktree: false },
      { value: "branch:remotes/origin/dev", label: "dev", remoteOnly: true, inWorktree: false },
      { value: "branch:remotes/origin/main", label: "main", remoteOnly: true, inWorktree: false },
    ])
  })

  test("marks only exact local branches that already have worktrees", () => {
    expect(buildDraftLocalBranchOptions({
      allBranches: ["Dev", "dev", "remotes/origin/Dev"],
      currentBranch: "main",
      worktreeBranches: ["refs/heads/Dev"],
    })).toEqual([
      { value: "branch:dev", label: "dev", remoteOnly: false, inWorktree: false },
      { value: "branch:Dev", label: "Dev", remoteOnly: false, inWorktree: true },
      { value: "branch:remotes/origin/Dev", label: "Dev", remoteOnly: true, inWorktree: false },
    ])
  })

  test("decodes branch option values separately from directory values", () => {
    expect(encodeDraftBranchOptionValue("main")).toBe("branch:main")
    expect(decodeDraftBranchOptionValue("branch:main")).toBe("main")
    expect(decodeDraftBranchOptionValue("/repo")).toBeNull()
  })
})

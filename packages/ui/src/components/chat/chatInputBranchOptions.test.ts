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
      { value: "branch:feature", label: "feature", remoteOnly: false },
      { value: "branch:main", label: "main", remoteOnly: false },
      { value: "branch:remotes/origin/main", label: "main", remoteOnly: true },
    ])
  })

  test("does not reintroduce a current branch removed from the supplied grant-filtered list", () => {
    const options = buildDraftLocalBranchOptions({
      allBranches: ["feature"],
      currentBranch: "main",
    })

    expect(options).toEqual([
      { value: "branch:feature", label: "feature", remoteOnly: false },
    ])
  })

  test("deduplicates same-name remotes while retaining a remote choice beside its local branch", () => {
    expect(buildDraftLocalBranchOptions({
      allBranches: ["main", "remotes/upstream/dev", "remotes/origin/dev", "remotes/origin/main"],
      currentBranch: "main",
    })).toEqual([
      { value: "branch:main", label: "main", remoteOnly: false },
      { value: "branch:remotes/origin/dev", label: "dev", remoteOnly: true },
      { value: "branch:remotes/origin/main", label: "main", remoteOnly: true },
    ])
  })

  test("decodes branch option values separately from directory values", () => {
    expect(encodeDraftBranchOptionValue("main")).toBe("branch:main")
    expect(decodeDraftBranchOptionValue("branch:main")).toBe("main")
    expect(decodeDraftBranchOptionValue("/repo")).toBeNull()
  })
})

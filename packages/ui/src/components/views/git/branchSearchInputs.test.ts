import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(testDir, path), "utf8");

describe("branch dropdown search inputs", () => {
  test("stop dropdown typeahead from intercepting branch search typing", () => {
    const branchSelector = read("BranchSelector.tsx");
    const integrateCommits = read("IntegrateCommitsSection.tsx");
    const newWorktreeDialog = read("../../session/NewWorktreeDialog.tsx");
    const directoryTree = read("../../session/DirectoryTree.tsx");

    expect(branchSelector).toContain("onKeyDown={stopDropdownTypeahead}");
    expect(integrateCommits).toContain("onKeyDown={(event) => event.stopPropagation()}");
    expect(newWorktreeDialog.match(/onKeyDown=\{stopDropdownTypeahead\}/g) ?? []).toHaveLength(2);
    expect(directoryTree.match(/onKeyDown=\{\(e\) => \{\n\s+e\.stopPropagation\(\);/g) ?? []).toHaveLength(2);
  });

  test("labels local branches that are already attached to worktrees", () => {
    const branchSelector = read("BranchSelector.tsx");

    expect(branchSelector).toContain("worktreeBranches?.has(branch)");
    expect(branchSelector).toContain("aria-label={t('gitView.branch.worktreeBadge')}");
    expect(branchSelector).toContain("{t('gitView.branch.worktreeBadge')}");
  });

  test("keeps remote-only selections namespaced during worktree resolution", () => {
    const branchSelector = read("BranchSelector.tsx");

    expect(branchSelector).toContain("handleCheckout(`remotes/${branch}`)");
  });
});

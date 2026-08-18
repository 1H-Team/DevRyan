import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const chatInputSource = readFileSync(
  fileURLToPath(new URL("./ChatInput.tsx", import.meta.url)),
  "utf8",
)
const contextUsageControlSource = readFileSync(
  fileURLToPath(new URL("./ComposerContextUsageControl.tsx", import.meta.url)),
  "utf8",
)

describe("ChatInput session directory reads", () => {
  test("derives currentSessionDirectory from the selected session", () => {
    expect(chatInputSource).toContain(
      "currentSessionId ? s.getDirectoryForSession(currentSessionId) : null",
    )
  })

  test("isolates authoritative context directory resolution from the full composer", () => {
    expect(chatInputSource).toContain(
      "fallbackDirectory={currentDirectory}",
    )
    expect(
      chatInputSource.match(/useUserMessageHistory\([\s\S]*currentSessionDirectory \?\? undefined/) ?? [],
    ).toHaveLength(1)
    expect(contextUsageControlSource).toContain("{ suspendPartUpdates: true }")
    expect(contextUsageControlSource).toContain("useEffectiveDirectory() ?? fallbackDirectory")
    expect(contextUsageControlSource).toContain("getContextUsageForSession(sessionId, directory)")
  })
})

describe("ChatInput existing-worktree branch switching", () => {
  test("keeps managed non-admin targets on the server-authoritative branch resolver", () => {
    const start = chatInputSource.indexOf("const handleDraftBranchCheckout")
    const end = chatInputSource.indexOf("const canFinishDraftCheckoutIntoMain", start)
    const handler = chatInputSource.slice(start, end)

    const managedGate = handler.indexOf("principal.scope === 'managed' && principal.role !== 'admin'")
    const managedResolver = handler.indexOf("await prepareManagedDraftBranchTarget(projectId, branch)")
    const genericCheckout = handler.indexOf("checkoutBranchWithOptionalStash")

    expect(managedGate).toBeGreaterThan(-1)
    expect(managedResolver).toBeGreaterThan(managedGate)
    expect(genericCheckout).toBeGreaterThan(managedResolver)
  })

  test("retargets the current draft when the generic resolver finds an existing worktree", () => {
    expect(chatInputSource).toContain("if (result.type === 'worktree-target') {")
    expect(chatInputSource).toContain("setNewSessionDraftTarget({ projectId, directoryOverride: result.directory }")
    expect(chatInputSource).toContain("toast.success(t('gitView.toast.switchedToWorktree'")
  })

  test("shows the accessible Worktree badge on attached local branches", () => {
    expect(chatInputSource).toContain("option.inWorktree ? (")
    expect(chatInputSource).toContain("t('gitView.branch.worktreeBadge')")
  })

  test("hides worktree creation from managed users without that capability", () => {
    expect(chatInputSource).toContain(
      "const canCreateWorktrees = principal.scope !== 'managed' || principal.policy.createWorktrees",
    )
    expect(chatInputSource).toContain("{canCreateWorktrees ? (")
  })
})

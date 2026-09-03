import { beforeEach, describe, expect, mock, test as bunTest } from "bun:test"

const test = bunTest

type PromptParams = {
  sessionID: string
  directory?: string
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
  variant?: string
  tools?: Record<string, boolean>
  format?: unknown
  parts?: Array<{ type: "text"; text: string; synthetic?: boolean }>
}

const createSessionCalls: Array<{ title: string | undefined; directory: string; parentId: string | null }> = []
const deleteSessionCalls: Array<{ sessionID: string; directory?: string }> = []
const promptCalls: PromptParams[] = []
const renderMagicPromptCalls: Array<{ key: string; variables?: Record<string, string> }> = []
const sessionModelSelections = new Map<string, { providerId: string; modelId: string }>()

let createdSessionCount = 0
let sessionCreateError: Error | null = null
let currentSessionId: string | null = null
let currentAgentName: string | undefined = "build-agent"
let currentProviderId: string | null = "provider-current"
let currentModelId: string | null = "model-current"
let currentVariant: string | null = "medium"
let promptResponseText = "```json\n[{\"subject\":\"feat: run commit workflow\",\"highlights\":[\"Committed selected files\"]}]\n```"
let promptResponseParts: Array<Record<string, unknown>> | null = null
let gitStatusResponse = {
  current: "feature/test",
  tracking: "origin/feature/test",
  ahead: 0,
  behind: 0,
  files: [] as Array<{ path: string; index: string; working_dir: string }>,
  isClean: true,
  diffStats: {} as Record<string, { insertions: number; deletions: number }>,
  mergeInProgress: null as { head: string; message: string } | null,
  rebaseInProgress: null as { headName: string; onto: string } | null,
}
let gitLogResponse = {
  all: [
    {
      hash: "abcdef1234567890",
      message: "feat: add generated output parsing",
    },
  ],
}
let gitDiffResponse = "diff --git a/src/git.ts b/src/git.ts\n+export const updated = true"
let gitFileDiffResponse = {
  original: "",
  modified: "export const updated = true",
  path: "src/git.ts",
  isBinary: false,
}
const gitDiffCalls: Array<{ path: string; staged?: boolean }> = []
const gitFileDiffCalls: Array<{ path: string; staged?: boolean }> = []
let gitStatusCalls = 0
let gitLogCalls = 0
const directGenerationRequests: Array<Record<string, unknown>> = []
let directGeneratedMessage = {
  subject: "feat: run commit workflow",
  highlights: [] as string[],
}
let directGeneratedPr = {
  title: "Add generated output parsing",
  body: "## Summary\n- Parse JSON from free Zen",
}
let directPrError: Error | null = null

mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId,
    }),
  },
}))

mock.module("@/sync/session-actions", () => ({
  createSession: mock(async (title: string | undefined, directory: string, parentId: string | null) => {
    createSessionCalls.push({ title, directory, parentId })
    if (sessionCreateError) return null
    createdSessionCount += 1
    const id = `legacy-generated-${createdSessionCount}`
    currentSessionId = id
    return { id }
  }),
  createSessionRecord: mock(async (title: string, directory: string, parentId: string | null) => {
    createSessionCalls.push({ title, directory, parentId })
    createdSessionCount += 1
    const id = `generated-${createdSessionCount}`
    return { id }
  }),
  consumeLastCreateSessionError: mock(() => {
    const error = sessionCreateError
    sessionCreateError = null
    return error
  }),
}))

mock.module("./gitApiHttp", () => ({
  getGitStatus: mock(async () => {
    gitStatusCalls += 1
    return gitStatusResponse
  }),
  getGitLog: mock(async () => {
    gitLogCalls += 1
    return gitLogResponse
  }),
  getGitDiff: mock(async (_directory: string, options: { path: string; staged?: boolean }) => {
    gitDiffCalls.push({ path: options.path, staged: options.staged })
    return { diff: gitDiffResponse }
  }),
  getGitFileDiff: mock(async (_directory: string, options: { path: string; staged?: boolean }) => {
    gitFileDiffCalls.push({ path: options.path, staged: options.staged })
    return gitFileDiffResponse
  }),
  generateCommitMessage: mock(async (_directory: string, request: Record<string, unknown>) => {
    directGenerationRequests.push(request)
    return directGeneratedMessage
  }),
  generateCommitMessageDraft: mock(async (_directory: string, request: Record<string, unknown>) => {
    directGenerationRequests.push(request)
    return { status: "complete", commits: [directGeneratedMessage] }
  }),
  generatePullRequestDescription: mock(async (_directory: string, request: Record<string, unknown>) => {
    directGenerationRequests.push(request)
    if (directPrError) throw directPrError
    return directGeneratedPr
  }),
  getCommitFiles: mock(async () => ({
    files: [
      { path: "src/generated.ts" },
    ],
  })),
}))

mock.module("@/stores/contextStore", () => ({
  useContextStore: {
    getState: () => ({
      getSessionAgentSelection: () => null,
      getSessionModelSelection: (sessionId: string) => sessionModelSelections.get(sessionId) ?? null,
      getAgentModelForSession: () => null,
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName,
      currentProviderId,
      currentModelId,
      currentVariant,
    }),
  },
}))

mock.module("./magicPrompts", () => ({
  renderMagicPrompt: mock(async (key: string, variables?: Record<string, string>) => {
    renderMagicPromptCalls.push({ key, variables })
    if (key === "git.commit.draft.visible") return "visible draft prompt"
    if (key === "git.commit.draft.instructions") {
      return `hidden draft prompt\n${variables?.selected_files ?? ""}\n${variables?.git_context ?? ""}`
    }
    if (key === "git.commit.plan.visible") return "visible plan prompt"
    if (key === "git.commit.plan.instructions") {
      return `hidden plan prompt\n${variables?.selected_files ?? ""}\n${variables?.git_context ?? ""}`
    }
    if (key === "git.commit.generate.visible") return "visible commit prompt"
    if (key === "git.commit.generate.instructions") {
      return [
        "hidden commit prompt",
        variables?.generation_mode,
        variables?.output_contract,
        variables?.safety_rules,
        variables?.selected_files,
        variables?.git_context,
      ].filter(Boolean).join("\n")
    }
    if (key === "git.pr.generate.visible") return "visible pr prompt"
    if (key === "git.pr.generate.instructions") {
      return [
        "hidden pr prompt",
        variables?.base_branch,
        variables?.head_branch,
        variables?.commits,
        variables?.changed_files,
        variables?.additional_context_block,
      ].filter(Boolean).join("\n")
    }
    return ""
  }),
}))

mock.module("./opencode/client", () => ({
  opencodeClient: {
    withDirectory: async (_directory: string, callback: () => Promise<unknown>) => callback(),
    getApiClient: () => ({
      session: {
        prompt: mock(async (params: PromptParams) => {
          promptCalls.push(params)
          return {
            data: {
              info: {},
              parts: promptResponseParts ?? [
                {
                  type: "text",
                  text: promptResponseText,
                },
              ],
            },
          }
        }),
        delete: mock(async (params: { sessionID: string; directory?: string }) => {
          deleteSessionCalls.push(params)
          return { data: true }
        }),
      },
    }),
  },
}))

const {
  generateCommitMessageDraft,
  generateCommitPlanPreview,
  generatePullRequestDescription,
} = await import("./gitApi")

const { buildCommitPlanContext, COMMIT_PLAN_CONTEXT_LIMITS } = await import("./git/commitPlanContext")

async function generateCommitMessageDraftQuietly(...args: Parameters<typeof generateCommitMessageDraft>) {
  return generateQuietly(() => generateCommitMessageDraft(...args))
}

async function generateCommitPlanPreviewQuietly(...args: Parameters<typeof generateCommitPlanPreview>) {
  return generateQuietly(() => generateCommitPlanPreview(...args))
}

async function generatePullRequestDescriptionQuietly(...args: Parameters<typeof generatePullRequestDescription>) {
  return generateQuietly(() => generatePullRequestDescription(...args))
}

async function generateQuietly<T>(callback: () => Promise<T>) {
  const originalInfo = console.info
  const originalWarn = console.warn
  const originalError = console.error
  console.info = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return await callback()
  } finally {
    console.info = originalInfo
    console.warn = originalWarn
    console.error = originalError
  }
}

describe("git generation routing", () => {
  beforeEach(() => {
    createSessionCalls.length = 0
    deleteSessionCalls.length = 0
    promptCalls.length = 0
    renderMagicPromptCalls.length = 0
    sessionModelSelections.clear()
    createdSessionCount = 0
    sessionCreateError = null
    currentSessionId = null
    currentAgentName = "build-agent"
    currentProviderId = "provider-current"
    currentModelId = "model-current"
    currentVariant = "medium"
    promptResponseText = "```json\n[{\"subject\":\"feat: run commit workflow\",\"highlights\":[\"Committed selected files\"]}]\n```"
    promptResponseParts = null
    gitStatusResponse = {
      current: "feature/test",
      tracking: "origin/feature/test",
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
      diffStats: {},
      mergeInProgress: null,
      rebaseInProgress: null,
    }
    gitLogResponse = {
      all: [
        {
          hash: "abcdef1234567890",
          message: "feat: add generated output parsing",
        },
      ],
    }
    gitDiffResponse = "diff --git a/src/git.ts b/src/git.ts\n+export const updated = true"
    gitFileDiffResponse = {
      original: "",
      modified: "export const updated = true",
      path: "src/git.ts",
      isBinary: false,
    }
    gitDiffCalls.length = 0
    gitFileDiffCalls.length = 0
    gitStatusCalls = 0
    gitLogCalls = 0
    directGenerationRequests.length = 0
    directGeneratedMessage = {
      subject: "feat: run commit workflow",
      highlights: [],
    }
    directGeneratedPr = {
      title: "Add generated output parsing",
      body: "## Summary\n- Parse JSON from free Zen",
    }
    directPrError = null
  })

  test("parses structured-output tool parts for commit plan preview", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/git.ts", index: "M", working_dir: " " }],
      diffStats: { "src/git.ts": { insertions: 2, deletions: 0 } },
    }
    promptResponseText = ""
    promptResponseParts = [
      {
        type: "tool",
        tool: "structuredoutput",
        state: {
          status: "completed",
          output: "[{\"subject\":\"fix(git): parse structured output\",\"highlights\":[\"Reads tool parts\"]}]",
        },
      },
    ]

    const result = await generateCommitPlanPreviewQuietly("/repo", ["src/git.ts"])

    expect(result).toEqual({
      status: "complete",
      commits: [
        {
          subject: "fix(git): parse structured output",
          highlights: ["Reads tool parts"],
        },
      ],
    })
  })

  test("draft generation delegates selected files to one host call without collecting client context", async () => {
    const result = await generateCommitMessageDraftQuietly("/repo", ["src/app.ts"])

    expect(result.commits[0]?.subject).toBe("feat: run commit workflow")
    expect(directGenerationRequests).toHaveLength(1)
    expect(directGenerationRequests[0]).toEqual({
      selectedFiles: ["src/app.ts"],
      stagedOnly: false,
    })
    expect(gitDiffCalls).toHaveLength(0)
    expect(gitFileDiffCalls).toHaveLength(0)
    expect(gitStatusCalls).toBe(0)
    expect(gitLogCalls).toBe(0)
    expect(renderMagicPromptCalls).toHaveLength(0)
    expect(createSessionCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
    expect(deleteSessionCalls).toHaveLength(0)
  })

  test("draft generation includes commit input guidance without making it authoritative", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/app.ts", index: "M", working_dir: " " }],
      diffStats: { "src/app.ts": { insertions: 2, deletions: 0 } },
    }

    await generateCommitMessageDraftQuietly("/repo", ["src/app.ts"], {
      commitMessageGuidance: "Prefer fix(auth): wording",
    })

    expect(directGenerationRequests[0]?.guidance).toBe("Prefer fix(auth): wording")
    expect(renderMagicPromptCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
  })

  test("draft generation returns only the first generated commit subject", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/app.ts", index: "M", working_dir: " " }],
      diffStats: { "src/app.ts": { insertions: 2, deletions: 0 } },
    }
    directGeneratedMessage = {
      subject: "fix(ui): fill commit input",
      highlights: ["Uses draft"],
    }

    const result = await generateCommitMessageDraftQuietly("/repo", ["src/app.ts"])

    expect(result).toEqual({
      status: "complete",
      commits: [
        {
          subject: "fix(ui): fill commit input",
          highlights: ["Uses draft"],
        },
      ],
    })
  })

  test("plan preview renders shared commit generation prompts with plan safety rules", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/git.ts", index: "M", working_dir: " " }],
      diffStats: { "src/git.ts": { insertions: 2, deletions: 0 } },
    }

    await generateCommitPlanPreviewQuietly("/repo", ["src/git.ts"], { stagedOnly: true })

    expect(renderMagicPromptCalls.map((call) => call.key)).toEqual([
      "git.commit.generate.visible",
      "git.commit.generate.instructions",
    ])
    expect(renderMagicPromptCalls[1]?.variables?.generation_mode).toBe("plan_preview")
    expect(renderMagicPromptCalls[1]?.variables?.selected_files).toBe("- src/git.ts")
    const text = promptCalls[0]?.parts?.map((part) => part.text).join("\n") ?? ""
    expect(text).toContain("visible commit prompt")
    expect(text).toContain("commit plan preview")
    expect(text).toContain("Do not stage, commit, pull, rebase, or push")
    expect(text).toContain("recentCommitSubjects")
    expect(text).toContain("staged-only")
  })

  test("preview prompt includes supplied git context", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/git.ts", index: "M", working_dir: " " }],
      diffStats: { "src/git.ts": { insertions: 2, deletions: 0 } },
    }

    await generateCommitPlanPreviewQuietly("/repo", ["src/git.ts"], { stagedOnly: true })

    const text = promptCalls[0]?.parts?.map((part) => part.text).join("\n") ?? ""
    expect(text).toContain("recentCommitSubjects")
    expect(text).toContain("feat: add generated output parsing")
    expect(text).toContain("src/git.ts")
    expect(text).toContain("staged-only")
  })

  test("preview filters returned files to the selected allowlist", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/git.ts", index: "M", working_dir: " " }],
      diffStats: { "src/git.ts": { insertions: 2, deletions: 0 } },
    }
    promptResponseText = "[{\"subject\":\"fix(git): scope files\",\"highlights\":[],\"files\":[\"src/git.ts\",\"src/other.ts\"]}]"

    const result = await generateCommitPlanPreviewQuietly("/repo", ["src/git.ts"])

    expect(result.commits[0]?.files).toEqual(["src/git.ts"])
  })

  test("blocks commit plan preview when merge conflicts are present", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      mergeInProgress: { head: "abc1234", message: "Merge branch 'main'" },
      files: [{ path: "src/conflict.ts", index: "UU", working_dir: " " }],
    }

    const result = await generateCommitPlanPreviewQuietly("/repo", ["src/conflict.ts"])

    expect(result).toEqual({
      status: "blocked",
      commits: [],
      message: "Merge or rebase conflicts must be resolved before generating a commit plan",
    })
    expect(promptCalls).toHaveLength(0)
    // Session creation is parallelized with context-building for latency,
    // so a blocked context leaves behind an unused session. It is cleaned up
    // via fire-and-forget delete; the user-visible result is still blocked
    // without any LLM prompt being sent.
    expect(createSessionCalls).toHaveLength(1)
  })

  test("sends the rendered Generate PR prompt directly without touching chat", async () => {
    currentSessionId = "active-session"
    sessionModelSelections.set("active-session", {
      providerId: "provider-active",
      modelId: "model-active",
    })
    const result = await generatePullRequestDescriptionQuietly("/repo", {
      base: "main",
      head: "feature/generated-output",
      context: "Prefer concise descriptions.",
    })

    expect(result).toEqual({
      title: "Add generated output parsing",
      body: "## Summary\n- Parse JSON from free Zen",
    })
    expect(directGenerationRequests).toHaveLength(1)
    expect(directGenerationRequests[0]?.base).toBe("main")
    expect(directGenerationRequests[0]?.head).toBe("feature/generated-output")
    expect(directGenerationRequests[0]?.context).toBe("Prefer concise descriptions.")
    expect(String(directGenerationRequests[0]?.prompt)).toContain("hidden pr prompt")
    expect(String(directGenerationRequests[0]?.prompt)).toContain("feat: add generated output parsing")
    expect(String(directGenerationRequests[0]?.prompt)).toContain("src/generated.ts")
    expect(promptCalls).toHaveLength(0)
    expect(createSessionCalls).toHaveLength(0)
    expect(deleteSessionCalls).toHaveLength(0)
  })

  test("does not require a selected model for direct PR generation", async () => {
    currentProviderId = null
    currentModelId = null
    const result = await generatePullRequestDescriptionQuietly("/repo", {
      base: "main",
      head: "feature/pr-session",
    })
    expect(result).toEqual(directGeneratedPr)
    expect(createSessionCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
    expect(deleteSessionCalls).toHaveLength(0)
  })

  test("surfaces direct PR generation failures without creating a session", async () => {
    directPrError = new Error("Unable to generate a pull request description with the available free Zen models")

    let generationError: unknown
    try {
      await generatePullRequestDescriptionQuietly("/repo", {
        base: "main",
        head: "feature/pr-session",
      })
    } catch (error) {
      generationError = error
    }

    expect(generationError).toBeInstanceOf(Error)
    expect((generationError as Error).message).toBe(directPrError.message)
    expect(createSessionCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
    expect(deleteSessionCalls).toHaveLength(0)
  })

  test("sends the resolvable session model as a fallback hint with the PR prompt", async () => {
    currentSessionId = "active-session"
    sessionModelSelections.set("active-session", {
      providerId: "provider-active",
      modelId: "model-active",
    })
    await generatePullRequestDescriptionQuietly("/repo", { base: "main", head: "feature/hint" })

    expect(directGenerationRequests).toHaveLength(1)
    expect(directGenerationRequests[0]?.providerId).toBe("provider-active")
    expect(directGenerationRequests[0]?.modelId).toBe("model-active")
    expect(String(directGenerationRequests[0]?.prompt)).toContain("hidden pr prompt")
  })

  test("omits the fallback model hint when no model is resolvable", async () => {
    currentProviderId = null
    currentModelId = null
    await generatePullRequestDescriptionQuietly("/repo", { base: "main", head: "feature/no-hint" })

    expect(directGenerationRequests).toHaveLength(1)
    expect(directGenerationRequests[0]?.providerId).toBe(undefined)
    expect(directGenerationRequests[0]?.modelId).toBe(undefined)
  })

  test("keeps the transport error code and attempts on PR generation failures", async () => {
    directPrError = Object.assign(new Error("Free models are exhausted"), {
      code: "FREE_ZEN_EXHAUSTED",
      attempts: [{ tier: "free_zen", model: "free-a", reason: "rate_limited" }],
    })

    let generationError: unknown
    try {
      await generatePullRequestDescriptionQuietly("/repo", { base: "main", head: "feature/code" })
    } catch (error) {
      generationError = error
    }

    expect((generationError as { code?: string }).code).toBe("FREE_ZEN_EXHAUSTED")
    expect((generationError as { attempts?: unknown[] }).attempts).toHaveLength(1)
  })
})

describe("buildCommitPlanContext", () => {
  beforeEach(() => {
    gitStatusResponse = {
      current: "feature/test",
      tracking: "origin/feature/test",
      ahead: 0,
      behind: 0,
      files: [{ path: "src/app.ts", index: "M", working_dir: " " }],
      isClean: false,
      diffStats: { "src/app.ts": { insertions: 2, deletions: 1 } },
      mergeInProgress: null,
      rebaseInProgress: null,
    }
    gitLogResponse = {
      all: [
        { hash: "111", message: "feat(ui): first" },
        { hash: "222", message: "fix(ui): second" },
      ],
    }
    gitDiffResponse = "diff --git a/src/app.ts b/src/app.ts\n+const updated = true"
    gitFileDiffResponse = {
      original: "",
      modified: "const updated = true",
      path: "src/app.ts",
      isBinary: false,
    }
  })

  test("requests staged-only diffs when stagedOnly is enabled", async () => {
    gitDiffCalls.length = 0
    gitFileDiffCalls.length = 0

    const result = await buildCommitPlanContext("/repo", ["src/app.ts"], { stagedOnly: true })

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.context.stagedOnly).toBe(true)
    expect(result.context.scope).toBe("staged-only")
    expect(gitFileDiffCalls).toEqual([{ path: "src/app.ts", staged: true }])
    expect(gitDiffCalls).toEqual([{ path: "src/app.ts", staged: true }])
  })

  test("includes recent commit subjects", async () => {
    const result = await buildCommitPlanContext("/repo", ["src/app.ts"])

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.context.recentCommitSubjects).toEqual([
      "feat(ui): first",
      "fix(ui): second",
    ])
  })

  test("truncates large diffs", async () => {
    gitDiffResponse = `+line\n`.repeat(COMMIT_PLAN_CONTEXT_LIMITS.maxDiffCharsPerFile + 50)

    const result = await buildCommitPlanContext("/repo", ["src/app.ts"])

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.context.selectedFiles[0]?.diffNote).toBe("diff truncated")
    expect(
      (result.context.selectedFiles[0]?.diff?.length ?? 0)
        <= COMMIT_PLAN_CONTEXT_LIMITS.maxDiffCharsPerFile + 32,
    ).toBe(true)
  })

  test("preserves binary summaries without fetching huge content", async () => {
    gitFileDiffResponse = {
      original: "",
      modified: "",
      path: "assets/logo.png",
      isBinary: true,
    }

    const result = await buildCommitPlanContext("/repo", ["assets/logo.png"])

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.context.selectedFiles[0]?.diff).toBe(undefined)
    expect(result.context.selectedFiles[0]?.diffNote).toBe("binary file (diff omitted)")
  })

  test("omits large file diffs using diff stats", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      files: [{ path: "src/large.ts", index: "M", working_dir: " " }],
      diffStats: {
        "src/large.ts": {
          insertions: COMMIT_PLAN_CONTEXT_LIMITS.largeFileLineThreshold + 1,
          deletions: 0,
        },
      },
    }

    const result = await buildCommitPlanContext("/repo", ["src/large.ts"])

    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.context.selectedFiles[0]?.diff).toBe(undefined)
    expect(result.context.selectedFiles[0]?.diffNote).toContain("large change")
  })

  test("blocks when rebase conflicts are present", async () => {
    gitStatusResponse = {
      ...gitStatusResponse,
      rebaseInProgress: { headName: "feature/test", onto: "abc1234" },
      files: [{ path: "src/conflict.ts", index: "UU", working_dir: " " }],
    }

    const result = await buildCommitPlanContext("/repo", ["src/conflict.ts"])

    expect(result).toEqual({
      status: "blocked",
      message: "Merge or rebase conflicts must be resolved before generating a commit plan",
    })
  })
})

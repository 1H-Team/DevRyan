import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { RevertTransaction } from "./revert-transactions"

export type FileDiff = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  [key: string]: unknown
}

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type SessionListStatus = "idle" | "loading" | "ready" | "error"

/** Native terminal result of the last run. Display metadata only. */
export type SessionOutcome = "succeeded" | "failed" | "interrupted"

/** Native fork provenance. Forks keep a null `parentID`; this never feeds the tree. */
export type SessionFork = {
  sessionID: string
  boundary: {
    type: "before" | "through"
    messageID: string
  }
}

/**
 * A session record as the UI stores it: the SDK `Session` plus the optional
 * native lifecycle and fork facts the v1 projection carries. Every field is
 * optional, so plain SDK sessions are display sessions too. Values reach the
 * stores only through `decodeDisplaySession`, which drops invalid ones.
 * Running state still comes only from `session.status`.
 */
export type DisplaySession = Session & {
  time: {
    busy?: number
    idle?: number
    viewed?: number
  }
  outcome?: SessionOutcome
  fork?: SessionFork
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  bootstrapError?: string
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionListStatus: SessionListStatus
  sessionListError?: string
  sessionTotal: number
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  session_user_activity: Record<string, number>
  revert_transaction: Record<string, RevertTransaction | undefined>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  path: Path
  projects: Project[]
  providers: ProviderListResponse
  providerAuth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  sessionTodo: Record<string, Todo[]>
}

export type InitError = {
  type: "init"
  message: string
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
  hasPendingBlockingRequests?: (directory: string) => boolean
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
  hasPendingBlockingRequests: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 40

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  status: "loading",
  agent: [],
  command: [],
  session: [],
  sessionListStatus: "idle",
  sessionListError: undefined,
  sessionTotal: 0,
  session_status: {},
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  limit: 5,
  session_user_activity: {},
  revert_transaction: {},
  message: {},
  part: {},
}

export const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  projects: [],
  providers: { all: [], connected: [], default: {} },
  providerAuth: {},
  config: {},
  reload: undefined,
  sessionTodo: {},
}

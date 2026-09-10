const RESUME_DEBOUNCE_MS = Number(process.env.OPENCODE_AUTORESUME_DEBOUNCE_MS ?? 2_000);
const RESUME_COOLDOWN_MS = Number(process.env.OPENCODE_AUTORESUME_COOLDOWN_MS ?? 8_000);
const MAX_RESUMES_PER_PARENT = 3;
const MAX_RESUMES_PER_FIXER_CHILD = 3;
const MAX_RESUMES_PER_EXPLORER_CHILD = 1;
const MAX_RESUMES_PER_DESIGNER_CHILD = 3;
const MAX_RESUMES_PER_COUNCIL_CHILD = 2;
const MAX_RESUMES_PER_LIBRARIAN_CHILD = 2;
const INCOMPLETE_TODO_STATUSES = new Set(["pending", "in_progress"]);
const TERMINAL_STATUS_CHILD_AGENTS = new Set(["fixer", "designer", "librarian", "explorer"]);

const CHILD_RESUME_CONFIG = {
  fixer: {
    maxResumes: MAX_RESUMES_PER_FIXER_CHILD,
    todoPrompt:
      "Continue your incomplete todos now. Do not stop until all actionable todos are completed, verification is run or explicitly skipped with reason, or you are blocked. Return your standard fixer status format when complete or blocked.",
    terminalPrompt:
      "Stop extended reasoning. Execute the delegated task using read/edit/bash tools now, or return blocked with your standard fixer status format if you cannot proceed. Finish with <status>complete</status> or <status>blocked</status> in the required output format.",
    shouldResume: (child) => hasIncompleteChildTodos(child) || child.hasTerminalStatus !== true,
    skipNoWorkReason: "fixer already returned terminal status",
  },
  explorer: {
    maxResumes: MAX_RESUMES_PER_EXPLORER_CHILD,
    prompt:
      "Return the required Explorer <results> block for the bounded context-location search if you have not done so. Report only relevant files, symbols, adjacent context, and migration candidates if relevant. Do not plan, propose implementation steps, or repeat prior findings. Finish with exactly one <status>complete</status> or <status>blocked</status>.",
    shouldResume: (child) => child.hasTerminalStatus !== true,
    skipNoWorkReason: "explorer already returned terminal status",
  },
  designer: {
    maxResumes: MAX_RESUMES_PER_DESIGNER_CHILD,
    todoPrompt:
      "Continue your incomplete UI/UX design-quality todos now. Do not stop until design changes or review findings are complete, visible validation is run or explicitly skipped with reason, or you are blocked. Return your standard designer status format when complete or blocked.",
    terminalPrompt:
      "Stop extended reasoning. Continue the delegated UI/UX design-quality work using tools now, or return blocked with your standard designer status format if you cannot proceed. Finish with <status>complete</status> or <status>blocked</status>.",
    shouldResume: (child) => hasIncompleteChildTodos(child) || child.hasTerminalStatus !== true,
    skipNoWorkReason: "designer already returned terminal status",
  },
  council: {
    maxResumes: MAX_RESUMES_PER_COUNCIL_CHILD,
    prompt:
      "You are stuck in an interactive question state. Do not ask questions. Do not request clarification. Call council_session immediately with the original task context if available. If that is not possible, return a structured failure report with Council Response, Councillor Details, and Council Summary explaining why.",
    shouldResume: (child) => child.needsNonInteractiveRecovery === true,
    skipNoWorkReason: "no council recovery needed",
  },
  librarian: {
    maxResumes: MAX_RESUMES_PER_LIBRARIAN_CHILD,
    prompt:
      "Continue the bounded research task now. Reuse sources and findings already gathered. Run at most one focused follow-up search, fetch, or docs lookup only if needed, then return the required <results> block with source URLs, a concise answer, and exactly one terminal status: <status>complete</status> or <status>blocked</status>. Do not keep researching for exhaustive coverage.",
    shouldResume: (child) => hasIncompleteChildTodos(child) || child.hasTerminalStatus !== true,
    skipNoWorkReason: "librarian already returned terminal status",
  },
};

const state = {
  parents: new Map(),
  children: new Map(),
  childToParent: new Map(),
};

function now() {
  return Date.now();
}

function getParent(sessionID) {
  let parent = state.parents.get(sessionID);
  if (!parent) {
    parent = {
      sessionID,
      children: new Set(),
      childDirty: false,
      hasDelegated: false,
      idle: false,
      lastChildEventAt: 0,
      lastResumeAt: 0,
      pendingTimer: undefined,
      pendingChildAgents: [],
      resumeCount: 0,
      seenSubtaskPartIds: new Set(),
      todos: [],
    };
    state.parents.set(sessionID, parent);
  }
  return parent;
}

function getChild(sessionID, parentSessionID) {
  let child = state.children.get(sessionID);
  if (!child) {
    child = {
      sessionID,
      parentSessionID,
      agent: undefined,
      idle: false,
      lastResumeAt: 0,
      needsNonInteractiveRecovery: false,
      hasTerminalStatus: false,
      pendingTimer: undefined,
      resumeCount: 0,
      todos: [],
    };
    state.children.set(sessionID, child);
  }

  if (parentSessionID && !child.parentSessionID) child.parentSessionID = parentSessionID;
  return child;
}

function assignPendingChildAgent(parent) {
  const agent = parent.pendingChildAgents.shift();
  if (!agent) return;

  for (const childID of parent.children) {
    const child = state.children.get(childID);
    if (child && !child.agent) {
      child.agent = agent;
      log("child-agent-identified", { childSessionID: child.sessionID, parentSessionID: child.parentSessionID, agent: child.agent });
      scheduleChildResume(child, `${child.agent} child identified`);
      return;
    }
  }

  parent.pendingChildAgents.unshift(agent);
}

function hasIncompleteTodos(parent) {
  return parent.todos.some((todo) => INCOMPLETE_TODO_STATUSES.has(todo.status));
}

// A child is treated as running until it reports idle. Newly created children
// start busy, so a dispatch cannot be reconciled before its child has spoken.
function findActiveChild(parent) {
  for (const childSessionID of parent.children) {
    const child = state.children.get(childSessionID);
    if (child && child.idle !== true) return child;
  }
  return undefined;
}

function hasIncompleteChildTodos(child) {
  return child.todos.some((todo) => INCOMPLETE_TODO_STATUSES.has(todo.status));
}

function getChildResumePrompt(child) {
  const config = CHILD_RESUME_CONFIG[child.agent];
  if (!config) return "";

  if (hasIncompleteChildTodos(child) && config.todoPrompt) {
    return config.todoPrompt;
  }
  if (child.hasTerminalStatus !== true && config.terminalPrompt) {
    return config.terminalPrompt;
  }
  return config.prompt ?? config.todoPrompt ?? config.terminalPrompt ?? "";
}

function isResumableChildAgent(agent) {
  return Boolean(CHILD_RESUME_CONFIG[agent]);
}

function getToolishName(part) {
  return [part.type, part.tool, part.toolName, part.name, part.function, part.call?.name, part.state?.name, part.metadata?.tool]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isInteractiveQuestionPart(part) {
  const name = getToolishName(part);
  return ["question", "ask", "input", "clarification"].some((token) => name.includes(token));
}

function getPartText(part) {
  return [part.text, part.content, part.message, part.delta, part.output, part.state?.text, part.call?.text]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function hasTerminalStatusText(part) {
  return /<status>\s*(complete|blocked)\s*<\/status>/i.test(getPartText(part));
}

function markChildEvent(childSessionID) {
  const parentSessionID = state.childToParent.get(childSessionID);
  if (!parentSessionID) return;

  const parent = getParent(parentSessionID);
  parent.childDirty = true;
  parent.lastChildEventAt = now();
  scheduleResume(parent, "child session updated");
}

function shouldResume(parent) {
  if (!parent.idle) return [false, "parent busy"];
  if (!parent.childDirty) return [false, "no completed child work"];
  if (parent.hasDelegated && parent.children.size === 0) return [false, "delegated work has no child session yet"];
  if (!parent.hasDelegated && parent.children.size === 0) return [false, "no delegated work"];
  if (!hasIncompleteTodos(parent) && !parent.hasDelegated) return [false, "no incomplete work"];
  // Dispatch barrier: never nudge the orchestrator while any dispatched child is
  // still working. Child idle/status events repeat, so without this the parent
  // was re-prompted every cooldown for the whole life of a running subagent.
  const activeChild = findActiveChild(parent);
  if (activeChild) return [false, "child still running"];
  if (parent.resumeCount >= MAX_RESUMES_PER_PARENT) return [false, "resume cap reached"];
  if (now() - parent.lastResumeAt < RESUME_COOLDOWN_MS) return [false, "cooldown active"];
  return [true, "ready"];
}

function scheduleResume(parent, reason) {
  if (parent.pendingTimer) return;

  parent.pendingTimer = setTimeout(async () => {
    parent.pendingTimer = undefined;
    await resumeParent(parent, reason);
  }, RESUME_DEBOUNCE_MS);
}

function shouldResumeChild(child) {
  if (!isResumableChildAgent(child.agent)) return [false, "not resumable child"];
  if (!child.idle) return [false, "child busy"];
  const config = CHILD_RESUME_CONFIG[child.agent];
  if (!config.shouldResume(child)) return [false, config.skipNoWorkReason];
  if (child.resumeCount >= config.maxResumes) return [false, `${child.agent} child resume cap reached`];
  if (now() - child.lastResumeAt < RESUME_COOLDOWN_MS) return [false, `${child.agent} child cooldown active`];
  return [true, "ready"];
}

function scheduleChildResume(child, reason) {
  if (!isResumableChildAgent(child.agent)) return;
  if (child.pendingTimer) return;

  child.pendingTimer = setTimeout(async () => {
    child.pendingTimer = undefined;
    await resumeChild(child, reason);
  }, RESUME_DEBOUNCE_MS);
}

async function resumeChild(child, reason) {
  const [ok, skipReason] = shouldResumeChild(child);
  if (!ok) {
    log(`${child.agent ?? "unknown"}-child-skip`, { childSessionID: child.sessionID, parentSessionID: child.parentSessionID, reason: skipReason });
    return;
  }

  child.lastResumeAt = now();
  child.resumeCount += 1;
  const config = CHILD_RESUME_CONFIG[child.agent];

  try {
    await state.client.session.promptAsync({
      sessionID: child.sessionID,
      agent: child.agent,
      parts: [
        {
          type: "text",
          text: getChildResumePrompt(child),
        },
      ],
    });
    if (child.agent === "council") child.needsNonInteractiveRecovery = false;
    log(`${child.agent}-child-resume`, { childSessionID: child.sessionID, parentSessionID: child.parentSessionID, reason });
  } catch (error) {
    log(`${child.agent ?? "unknown"}-child-error`, {
      childSessionID: child.sessionID,
      parentSessionID: child.parentSessionID,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resumeParent(parent, reason) {
  const [ok, skipReason] = shouldResume(parent);
  if (!ok) {
    log("skip", { parentSessionID: parent.sessionID, reason: skipReason });
    return;
  }

  parent.lastResumeAt = now();
  parent.resumeCount += 1;
  parent.childDirty = false;

  try {
    await state.client.session.promptAsync({
      sessionID: parent.sessionID,
      agent: "orchestrator",
      parts: [
        {
          type: "text",
          text: "Subagent work has completed. Reconcile the returned result, continue incomplete todos, verify if needed, and respond to the user only if the task is complete or blocked.",
        },
      ],
    });
    log("resume", { parentSessionID: parent.sessionID, reason });
  } catch (error) {
    parent.childDirty = true;
    log("error", {
      parentSessionID: parent.sessionID,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function log(event, data) {
  const payload = JSON.stringify({ event, plugin: "orchestrator-autoresume", ...data });
  console.error(payload);
}

function handleSessionCreated(event) {
  const info = event.properties?.info;
  if (!info?.id) return;

  if (info.parentID) {
    const parent = getParent(info.parentID);
    parent.children.add(info.id);
    parent.hasDelegated = true;
    state.childToParent.set(info.id, info.parentID);
    const child = getChild(info.id, info.parentID);
    if (typeof info.agent === "string") child.agent = info.agent;
    if (child.agent === "council") {
      log("council-child-created", { childSessionID: child.sessionID, parentSessionID: child.parentSessionID });
    }
    if (!child.agent) assignPendingChildAgent(parent);
    scheduleChildResume(child, "child session created");
    return;
  }

  getParent(info.id);
}

function handleTodoUpdated(event) {
  const sessionID = event.properties?.sessionID;
  if (!sessionID) return;

  const child = state.children.get(sessionID);
  if (child) {
    child.todos = event.properties.todos ?? [];

    if (!hasIncompleteChildTodos(child)) {
      child.resumeCount = 0;
    } else {
      scheduleChildResume(child, `${child.agent} child todo updated`);
    }

    return;
  }

  const parent = getParent(sessionID);
  const hadIncompleteTodos = hasIncompleteTodos(parent);
  parent.todos = event.properties.todos ?? [];

  // Only a real work cycle closing earns a fresh budget. Testing the new list
  // alone also matched "this parent has no todos at all", so every todo event in
  // a todo-less orchestrator zeroed the counter and the resume cap never bound.
  if (hadIncompleteTodos && !hasIncompleteTodos(parent)) {
    parent.resumeCount = 0;
    parent.childDirty = false;
  }
}

function handlePartUpdated(event) {
  const part = event.properties?.part;
  if (!part?.sessionID) return;

  if (part.type === "subtask") {
    const parent = getParent(part.sessionID);
    parent.hasDelegated = true;
    // Subtask parts stream, so the same dispatch arrives many times. Acting once
    // per part id keeps the agent queue accurate and stops repeat updates from
    // silently refilling the resume budget.
    if (typeof part.id === "string" && parent.seenSubtaskPartIds.has(part.id)) return;
    if (typeof part.id === "string") parent.seenSubtaskPartIds.add(part.id);
    // A new delegation is a new work cycle: allow this parent to be nudged again.
    parent.resumeCount = 0;
    parent.pendingChildAgents.push(part.agent);
    assignPendingChildAgent(parent);
    return;
  }

  const child = state.children.get(part.sessionID);
  if (child && TERMINAL_STATUS_CHILD_AGENTS.has(child.agent) && hasTerminalStatusText(part)) {
    child.hasTerminalStatus = true;
    child.resumeCount = 0;
    log(`${child.agent}-child-terminal-status`, { childSessionID: child.sessionID, parentSessionID: child.parentSessionID });
  }
  if (child?.agent === "council" && isInteractiveQuestionPart(part)) {
    child.needsNonInteractiveRecovery = true;
    log("council-child-question-detected", { childSessionID: child.sessionID, parentSessionID: child.parentSessionID });
    scheduleChildResume(child, "council child asked question");
  }
}

function handleSessionIdle(event) {
  const sessionID = event.properties?.sessionID;
  if (!sessionID) return;

  const childParentID = state.childToParent.get(sessionID);
  if (childParentID) {
    const child = getChild(sessionID, childParentID);
    child.idle = true;
    if (child.agent === "council") {
      log("council-child-idle", { childSessionID: child.sessionID, parentSessionID: child.parentSessionID });
    }
    scheduleChildResume(child, `${child.agent} child idle`);
    if (child.agent === "council" && child.needsNonInteractiveRecovery) return;
    markChildEvent(sessionID);
    return;
  }

  const parent = getParent(sessionID);
  parent.idle = true;
  scheduleResume(parent, "parent idle");
}

function handleSessionStatus(event) {
  const sessionID = event.properties?.sessionID;
  if (!sessionID) return;

  const childParentID = state.childToParent.get(sessionID);
  if (childParentID) {
    const child = getChild(sessionID, childParentID);
    child.idle = event.properties.status?.type === "idle";
    if (child.idle) {
      if (child.agent === "council") {
        log("council-child-idle", { childSessionID: child.sessionID, parentSessionID: child.parentSessionID });
      }
      scheduleChildResume(child, `${child.agent} child status idle`);
      if (child.agent === "council" && child.needsNonInteractiveRecovery) return;
      markChildEvent(sessionID);
    }
    return;
  }

  const parent = getParent(sessionID);
  parent.idle = event.properties.status?.type === "idle";
  if (parent.idle) scheduleResume(parent, "parent status idle");
}

export const OrchestratorAutoresumePlugin = async ({ client }) => {
  state.client = client;

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.created":
          handleSessionCreated(event);
          break;
        case "todo.updated":
          handleTodoUpdated(event);
          break;
        case "message.part.updated":
          handlePartUpdated(event);
          break;
        case "session.idle":
          handleSessionIdle(event);
          break;
        case "session.status":
          handleSessionStatus(event);
          break;
      }
    },
  };
};

export default OrchestratorAutoresumePlugin;

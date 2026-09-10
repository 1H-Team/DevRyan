import assert from "node:assert/strict";

process.env.OPENCODE_AUTORESUME_DEBOUNCE_MS = "1";
process.env.OPENCODE_AUTORESUME_COOLDOWN_MS = "0";

const { OrchestratorAutoresumePlugin } = await import("./orchestrator-autoresume.mjs");

const calls = [];
const plugin = await OrchestratorAutoresumePlugin({
  client: {
    session: {
      promptAsync: async (payload) => {
        calls.push(payload);
      },
    },
  },
});

async function emit(event) {
  await plugin.event({ event });
}

function wait(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await emit({
  type: "session.created",
  properties: {
    info: { id: "parent", title: "Parent", directory: "/tmp", version: "test", time: { created: 1, updated: 1 } },
  },
});

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-1",
      sessionID: "parent",
      messageID: "message-1",
      type: "subtask",
      prompt: "implement",
      description: "fixer task",
      agent: "fixer",
    },
    time: 1,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-fixer", parentID: "parent", title: "Fixer", directory: "/tmp", version: "test", time: { created: 2, updated: 2 } },
  },
});

await emit({
  type: "todo.updated",
  properties: {
    sessionID: "child-fixer",
    todos: [{ content: "finish implementation", status: "pending", priority: "high" }],
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-fixer", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-fixer" && call.agent === "fixer"),
  true,
  "idle fixer child with incomplete todos should be resumed",
);

const callsAfterFixer = calls.length;

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-2",
      sessionID: "parent",
      messageID: "message-2",
      type: "subtask",
      prompt: "inspect",
      description: "explorer task",
      agent: "explorer",
    },
    time: 2,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-explorer", parentID: "parent", title: "Explorer", directory: "/tmp", version: "test", time: { created: 3, updated: 3 } },
  },
});

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "child-explorer",
    part: {
      id: "explorer-result",
      sessionID: "child-explorer",
      messageID: "message-2a",
      type: "text",
      text: "<results><files><file>/tmp/app.js:1</file></files><answer>Found relevant context.</answer><confidence>high</confidence><status>complete</status></results>",
    },
    time: 2.5,
  },
});

await emit({
  type: "todo.updated",
  properties: {
    sessionID: "child-explorer",
    todos: [{ content: "inspect files", status: "pending", priority: "medium" }],
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-explorer", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-explorer" && call.agent === "explorer"),
  false,
  "idle explorer child with terminal findings should not be resumed for incomplete todos",
);
assert.equal(calls.length, callsAfterFixer, "terminal explorer findings with stale todos should not add child resume calls");

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-2b",
      sessionID: "parent",
      messageID: "message-2b",
      type: "subtask",
      prompt: "inspect without terminal status",
      description: "explorer missing terminal status",
      agent: "explorer",
    },
    time: 2.6,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-explorer-missing-status", parentID: "parent", title: "Explorer Missing Status", directory: "/tmp", version: "test", time: { created: 3.5, updated: 3.5 } },
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-explorer-missing-status", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-explorer-missing-status" && call.agent === "explorer"),
  true,
  "idle explorer child without terminal status should be resumed once for terminal-status recovery",
);
assert.equal(
  calls.find((call) => call.sessionID === "child-explorer-missing-status")?.parts?.[0]?.text.includes("todos"),
  false,
  "explorer recovery prompt should not ask it to continue todos",
);

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-3",
      sessionID: "parent",
      messageID: "message-3",
      type: "subtask",
      prompt: "polish UI",
      description: "designer task",
      agent: "designer",
    },
    time: 3,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-designer", parentID: "parent", title: "Designer", directory: "/tmp", version: "test", time: { created: 4, updated: 4 } },
  },
});

await emit({
  type: "todo.updated",
  properties: {
    sessionID: "child-designer",
    todos: [{ content: "finish UI polish", status: "pending", priority: "high" }],
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-designer", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-designer" && call.agent === "designer"),
  true,
  "idle designer child with incomplete todos should be resumed directly",
);

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-4",
      sessionID: "parent",
      messageID: "message-4",
      type: "subtask",
      prompt: "research docs",
      description: "librarian task",
      agent: "librarian",
    },
    time: 4,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-librarian", parentID: "parent", title: "Librarian", directory: "/tmp", version: "test", time: { created: 5, updated: 5 } },
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-librarian", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-librarian" && call.agent === "librarian"),
  true,
  "idle librarian child without terminal status should be resumed directly",
);

const callsAfterLibrarianResume = calls.length;

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "child-librarian",
    part: {
      id: "librarian-result",
      sessionID: "child-librarian",
      messageID: "message-5",
      type: "text",
      text: "<results><sources></sources><answer>Done.</answer><status>complete</status></results>",
    },
    time: 5,
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-librarian", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.length,
  callsAfterLibrarianResume,
  "librarian child with complete terminal status should not be resumed again",
);

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-5",
      sessionID: "parent",
      messageID: "message-6",
      type: "subtask",
      prompt: "research blocked docs",
      description: "blocked librarian task",
      agent: "librarian",
    },
    time: 6,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-librarian-blocked", parentID: "parent", title: "Librarian Blocked", directory: "/tmp", version: "test", time: { created: 7, updated: 7 } },
  },
});

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "child-librarian-blocked",
    part: {
      id: "librarian-blocked-result",
      sessionID: "child-librarian-blocked",
      messageID: "message-7",
      type: "text",
      text: "<results><sources></sources><answer>Need a source target.</answer><status>blocked</status></results>",
    },
    time: 7,
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-librarian-blocked", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.length,
  callsAfterLibrarianResume,
  "librarian child with blocked terminal status should not be resumed",
);

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-6",
      sessionID: "parent",
      messageID: "message-8",
      type: "subtask",
      prompt: "fix without todos",
      description: "fixer no-todo task",
      agent: "fixer",
    },
    time: 8,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-fixer-no-todos", parentID: "parent", title: "Fixer No Todos", directory: "/tmp", version: "test", time: { created: 8, updated: 8 } },
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-fixer-no-todos", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-fixer-no-todos" && call.agent === "fixer"),
  true,
  "idle fixer child without todos and without terminal status should be resumed",
);

const callsAfterFixerNoTodos = calls.length;

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "child-fixer-no-todos",
    part: {
      id: "fixer-complete-result",
      sessionID: "child-fixer-no-todos",
      messageID: "message-9",
      type: "text",
      text: "<summary>Done</summary><status>complete</status>",
    },
    time: 9,
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-fixer-no-todos", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.length,
  callsAfterFixerNoTodos,
  "fixer child with complete terminal status should not be resumed again",
);

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "parent",
    part: {
      id: "subtask-7",
      sessionID: "parent",
      messageID: "message-10",
      type: "subtask",
      prompt: "polish without todos",
      description: "designer no-todo task",
      agent: "designer",
    },
    time: 10,
  },
});

await emit({
  type: "session.created",
  properties: {
    info: { id: "child-designer-no-todos", parentID: "parent", title: "Designer No Todos", directory: "/tmp", version: "test", time: { created: 10, updated: 10 } },
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-designer-no-todos", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.some((call) => call.sessionID === "child-designer-no-todos" && call.agent === "designer"),
  true,
  "idle designer child without todos and without terminal status should be resumed",
);

const callsAfterDesignerNoTodos = calls.length;

await emit({
  type: "message.part.updated",
  properties: {
    sessionID: "child-designer-no-todos",
    part: {
      id: "designer-complete-result",
      sessionID: "child-designer-no-todos",
      messageID: "message-11",
      type: "text",
      text: "<status>complete</status>",
    },
    time: 11,
  },
});

await emit({
  type: "session.status",
  properties: { sessionID: "child-designer-no-todos", status: { type: "idle" } },
});

await wait();

assert.equal(
  calls.length,
  callsAfterDesignerNoTodos,
  "designer child with complete terminal status should not be resumed again",
);

console.log("orchestrator-autoresume harness passed");

// --- dispatch barrier: never nudge the orchestrator while a child is running ---

async function dispatch(parentID, partID, childID, agent) {
  await emit({
    type: "message.part.updated",
    properties: {
      sessionID: parentID,
      part: { id: partID, sessionID: parentID, messageID: `m-${partID}`, type: "subtask", prompt: "work", description: "task", agent },
      time: 1,
    },
  });
  await emit({
    type: "session.created",
    properties: {
      info: { id: childID, parentID, title: agent, directory: "/tmp", version: "test", time: { created: 2, updated: 2 } },
    },
  });
}

const parentResumes = (id) => calls.filter((call) => call.sessionID === id && call.agent === "orchestrator").length;

await emit({
  type: "session.created",
  properties: { info: { id: "p-barrier", title: "Barrier", directory: "/tmp", version: "test", time: { created: 1, updated: 1 } } },
});
await dispatch("p-barrier", "sub-b1", "child-b1", "builder");
await dispatch("p-barrier", "sub-b2", "child-b2", "builder");

// One child finishes while the other is still working.
await emit({ type: "session.status", properties: { sessionID: "p-barrier", status: { type: "idle" } } });
await emit({ type: "session.status", properties: { sessionID: "child-b1", status: { type: "idle" } } });
await wait();

assert.equal(
  parentResumes("p-barrier"),
  0,
  "parent must not be resumed while a dispatched child is still running",
);

// The barrier clears once every dispatched child has reported idle.
await emit({ type: "session.status", properties: { sessionID: "child-b2", status: { type: "idle" } } });
await emit({ type: "session.status", properties: { sessionID: "p-barrier", status: { type: "idle" } } });
await wait();

assert.equal(
  parentResumes("p-barrier"),
  1,
  "parent should be resumed once every dispatched child is idle",
);

// --- resume cap must bind for an orchestrator that keeps no todos ---

await emit({
  type: "session.created",
  properties: { info: { id: "p-cap", title: "Cap", directory: "/tmp", version: "test", time: { created: 1, updated: 1 } } },
});
await dispatch("p-cap", "sub-c1", "child-c1", "builder");

for (let attempt = 0; attempt < 8; attempt += 1) {
  // A todo-less parent used to have its counter zeroed by every todo event.
  await emit({ type: "todo.updated", properties: { sessionID: "p-cap", todos: [] } });
  await emit({ type: "session.status", properties: { sessionID: "p-cap", status: { type: "idle" } } });
  await emit({ type: "session.status", properties: { sessionID: "child-c1", status: { type: "idle" } } });
  await wait();
}

assert.equal(
  parentResumes("p-cap"),
  3,
  "repeated child idle events must not push a todo-less parent past the resume cap",
);

// --- repeated streaming updates of one subtask part must not refill the budget ---

for (let attempt = 0; attempt < 5; attempt += 1) {
  await emit({
    type: "message.part.updated",
    properties: {
      sessionID: "p-cap",
      part: { id: "sub-c1", sessionID: "p-cap", messageID: "m-sub-c1", type: "subtask", prompt: "work", description: "task", agent: "builder" },
      time: 1,
    },
  });
  await emit({ type: "session.status", properties: { sessionID: "p-cap", status: { type: "idle" } } });
  await emit({ type: "session.status", properties: { sessionID: "child-c1", status: { type: "idle" } } });
  await wait();
}

assert.equal(
  parentResumes("p-cap"),
  3,
  "re-emitting the same subtask part must not grant the parent a fresh resume budget",
);

// --- a genuinely new delegation does earn a fresh budget ---

await dispatch("p-cap", "sub-c2", "child-c2", "builder");
await emit({ type: "session.status", properties: { sessionID: "p-cap", status: { type: "idle" } } });
await emit({ type: "session.status", properties: { sessionID: "child-c1", status: { type: "idle" } } });
await emit({ type: "session.status", properties: { sessionID: "child-c2", status: { type: "idle" } } });
await wait();

assert.equal(
  parentResumes("p-cap"),
  4,
  "a new dispatch should let the parent be nudged again",
);

// --- closing a real todo cycle also earns a fresh budget ---

await emit({
  type: "session.created",
  properties: { info: { id: "p-todo", title: "Todo", directory: "/tmp", version: "test", time: { created: 1, updated: 1 } } },
});
await dispatch("p-todo", "sub-t1", "child-t1", "builder");
await emit({
  type: "todo.updated",
  properties: { sessionID: "p-todo", todos: [{ content: "reconcile", status: "pending", priority: "high" }] },
});

for (let attempt = 0; attempt < 5; attempt += 1) {
  await emit({ type: "session.status", properties: { sessionID: "p-todo", status: { type: "idle" } } });
  await emit({ type: "session.status", properties: { sessionID: "child-t1", status: { type: "idle" } } });
  await wait();
}

assert.equal(parentResumes("p-todo"), 3, "parent with incomplete todos still stops at the cap");

await emit({
  type: "todo.updated",
  properties: { sessionID: "p-todo", todos: [{ content: "reconcile", status: "completed", priority: "high" }] },
});
await emit({ type: "session.status", properties: { sessionID: "p-todo", status: { type: "idle" } } });
await emit({ type: "session.status", properties: { sessionID: "child-t1", status: { type: "idle" } } });
await wait();

assert.equal(
  parentResumes("p-todo"),
  4,
  "completing the outstanding todos should reopen the resume budget",
);

console.log("orchestrator-autoresume barrier + resume-cap checks passed");

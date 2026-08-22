import {
  createHarnessSuccess,
  createHarnessWarning,
  withHarnessResult,
} from './harness-result.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 70_000;
const DEFAULT_MCP_TIMEOUT_MS = 70_000;
// The xAI warm fans out one /experimental/tool fetch per Grok model after a
// /config/providers round trip, so it cannot share the 5s core budget without
// routinely reporting a timeout it would have survived.
const DEFAULT_XAI_TIMEOUT_MS = 20_000;
const MAX_SKILL_READS = 12;
const MAX_SKILL_BYTES = 64 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDirectory(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatError(error) {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Timed out';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function appendDirectoryQuery(requestPath, directory) {
  if (!directory) return requestPath;
  const separator = requestPath.includes('?') ? '&' : '?';
  return `${requestPath}${separator}directory=${encodeURIComponent(directory)}`;
}

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`OpenCode responded ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function createOpenCodeGetTask({ name, requestPath, directory, buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl }) {
  return async ({ signal }) => {
    const path = appendDirectoryQuery(requestPath, directory);
    const response = await fetchImpl(buildOpenCodeUrl(path), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal,
    });
    await readJson(response);
    return { name };
  };
}

function prioritizeSkills(skills) {
  return [...skills].sort((a, b) => {
    const aName = typeof a?.name === 'string' ? a.name : '';
    const bName = typeof b?.name === 'string' ? b.name : '';
    if (aName === 'using-superpowers') return -1;
    if (bName === 'using-superpowers') return 1;
    return aName.localeCompare(bName);
  });
}

function createSkillsTask({
  directory,
  discoverSkills,
  readSkillFile,
  getHiddenSkills,
  resolveApprovedSkills,
}) {
  return async () => {
    const discovered = discoverSkills(directory) || [];
    const hiddenSkills = typeof getHiddenSkills === 'function' ? await getHiddenSkills() : [];
    const visible = typeof resolveApprovedSkills === 'function'
      ? resolveApprovedSkills({ discoveredSkills: discovered, hiddenSkills })
      : discovered;
    const prioritized = prioritizeSkills(visible).slice(0, MAX_SKILL_READS);
    let bytesRead = 0;

    for (const skill of prioritized) {
      const skillPath = typeof skill?.path === 'string' ? skill.path : '';
      if (!skillPath) continue;
      if (bytesRead >= MAX_SKILL_BYTES) break;
      const content = await readSkillFile(skillPath);
      if (typeof content === 'string') {
        bytesRead += Buffer.byteLength(content, 'utf8');
      }
    }

    return {
      count: visible.length,
      readCount: prioritized.length,
      bytesRead,
    };
  };
}

function createTimeoutError() {
  const error = new Error('Timed out');
  error.name = 'TimeoutError';
  return error;
}

function createAgentRuntimeWarmup(dependencies = {}) {
  const buildOpenCodeUrl = typeof dependencies.buildOpenCodeUrl === 'function'
    ? dependencies.buildOpenCodeUrl
    : (requestPath) => requestPath;
  const getOpenCodeAuthHeaders = typeof dependencies.getOpenCodeAuthHeaders === 'function'
    ? dependencies.getOpenCodeAuthHeaders
    : () => ({});
  const fetchImpl = typeof dependencies.fetchImpl === 'function' ? dependencies.fetchImpl : fetch;
  const discoverSkills = typeof dependencies.discoverSkills === 'function' ? dependencies.discoverSkills : () => [];
  const readSkillFile = typeof dependencies.readSkillFile === 'function' ? dependencies.readSkillFile : () => '';
  const cursorPrewarm = typeof dependencies.cursorPrewarm === 'function' ? dependencies.cursorPrewarm : null;
  const warmXaiToolCatalog = typeof dependencies.warmXaiToolCatalog === 'function'
    ? dependencies.warmXaiToolCatalog
    : null;
  const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now();
  const inflightByDirectory = new Map();
  let latestResult = null;

  const buildHarness = (result) => {
    const issueCount = result.errors.length;
    if (result.timedOut || issueCount > 0) {
      return createHarnessWarning({
        summary: `Agent runtime warmup completed with ${issueCount || 1} issue${(issueCount || 1) === 1 ? '' : 's'}`,
        nextActions: ['Review warmup task diagnostics before starting latency-sensitive agent work'],
        artifacts: result.errors.map((error) => error.name),
        recovery: {
          rootCauseHint: result.timedOut
            ? 'One or more read-only warmup checks exceeded their timeout'
            : 'One or more read-only warmup checks returned an error',
          safeRetry: 'Retry warmup after OpenCode finishes starting or after refreshing runtime configuration',
          stopCondition: 'Stop retrying if the same task continues to fail after an OpenCode restart',
          retryable: true,
        },
      });
    }
    return createHarnessSuccess({
      summary: 'Agent runtime warmup completed',
      nextActions: [],
      artifacts: result.tasks.map((task) => task.name),
    });
  };

  const rememberLatest = (result) => {
    const errors = result.tasks
      .filter((task) => task.status !== 'ready')
      .map((task) => ({
        name: task.name,
        status: task.status,
        error: task.error || null,
      }));
    const enriched = withHarnessResult({
      ...result,
      errors,
    }, buildHarness({ ...result, errors }));
    latestResult = enriched;
    return enriched;
  };

  const runTask = async ({ name, task, timeoutMs }) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const startedAt = now();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          reject(createTimeoutError());
        }, timeoutMs);
      });
      await Promise.race([
        task({ signal: controller?.signal }),
        timeout,
      ]);
      return {
        name,
        status: 'ready',
        durationMs: Math.max(0, now() - startedAt),
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      return {
        name,
        status: isTimeout ? 'timeout' : 'error',
        durationMs: Math.max(0, now() - startedAt),
        error: formatError(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    warm(options = {}) {
      const directory = normalizeDirectory(options.directory);
      const directoryKey = directory ?? '';
      const existing = inflightByDirectory.get(directoryKey);
      if (existing) {
        // Joiners intentionally inherit the first caller's timeout configuration.
        return existing;
      }

      const warmPromise = (async () => {
      const timestamp = now();
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.trunc(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
      const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) && options.commandTimeoutMs > 0
        ? Math.trunc(options.commandTimeoutMs)
        : DEFAULT_COMMAND_TIMEOUT_MS;
      const mcpTimeoutMs = Number.isFinite(options.mcpTimeoutMs) && options.mcpTimeoutMs > 0
        ? Math.trunc(options.mcpTimeoutMs)
        : DEFAULT_MCP_TIMEOUT_MS;
      const xaiTimeoutMs = Number.isFinite(options.xaiTimeoutMs) && options.xaiTimeoutMs > 0
        ? Math.trunc(options.xaiTimeoutMs)
        : DEFAULT_XAI_TIMEOUT_MS;
      const coreTasks = [
        {
          name: 'health',
          task: createOpenCodeGetTask({
            name: 'health',
            requestPath: '/health',
            directory: null,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        {
          name: 'config',
          task: createOpenCodeGetTask({
            name: 'config',
            requestPath: '/config',
            directory,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        {
          name: 'providers',
          task: createOpenCodeGetTask({
            name: 'providers',
            requestPath: '/config/providers',
            directory,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        {
          name: 'agents',
          task: createOpenCodeGetTask({
            name: 'agents',
            requestPath: '/agent',
            directory,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        {
          name: 'sessionStatus',
          task: createOpenCodeGetTask({
            name: 'sessionStatus',
            requestPath: '/session/status',
            directory,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        {
          name: 'opencodeSkills',
          task: createOpenCodeGetTask({
            name: 'opencodeSkills',
            requestPath: '/skill',
            directory,
            buildOpenCodeUrl,
            getOpenCodeAuthHeaders,
            fetchImpl,
          }),
        },
        ...(cursorPrewarm ? [{
          name: 'cursorSdk',
          task: async () => {
            await cursorPrewarm({ directory });
            return { name: 'cursorSdk' };
          },
        }] : []),
        {
          name: 'skills',
          task: createSkillsTask({
            directory,
            discoverSkills,
            readSkillFile,
            getHiddenSkills: dependencies.getHiddenSkills,
            resolveApprovedSkills: dependencies.resolveApprovedSkills,
          }),
        },
      ];
      const mcpTask = {
        name: 'mcp',
        timeoutMs: mcpTimeoutMs,
        task: createOpenCodeGetTask({
          name: 'mcp',
          requestPath: '/mcp',
          directory,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
          fetchImpl,
        }),
      };
      const commandTask = {
        name: 'commands',
        timeoutMs: commandTimeoutMs,
        task: createOpenCodeGetTask({
          name: 'commands',
          requestPath: '/command',
          directory,
          buildOpenCodeUrl,
          getOpenCodeAuthHeaders,
          fetchImpl,
        }),
      };
      const xaiTask = warmXaiToolCatalog ? {
        name: 'xaiTools',
        timeoutMs: xaiTimeoutMs,
        task: async ({ signal }) => {
          await warmXaiToolCatalog({ directory, signal });
          return { name: 'xaiTools' };
        },
      } : null;

      const coreResultsPromise = Promise.all(coreTasks.map((taskConfig) => runTask({
        name: taskConfig.name,
        task: taskConfig.task,
        timeoutMs,
      })));
      const [coreResults, mcpResult, commandResult, xaiResult] = await Promise.all([
        coreResultsPromise,
        runTask({
          name: mcpTask.name,
          task: mcpTask.task,
          timeoutMs: mcpTask.timeoutMs,
        }),
        runTask({
          name: commandTask.name,
          task: commandTask.task,
          timeoutMs: commandTask.timeoutMs,
        }),
        xaiTask
          ? runTask({
            name: xaiTask.name,
            task: xaiTask.task,
            timeoutMs: xaiTask.timeoutMs,
          })
          : Promise.resolve(null),
      ]);
      // The skills task is always the final core task; keep it last in the
      // combined report so the task order stays stable for consumers.
      const skillsResult = coreResults[coreResults.length - 1];
      const results = [
        ...coreResults.slice(0, coreResults.length - 1),
        ...(xaiResult ? [xaiResult] : []),
        mcpResult,
        commandResult,
        skillsResult,
      ];
      return rememberLatest({
        status: 'ready',
        timestamp,
        directory,
        timedOut: results.some((task) => task.status === 'timeout'),
        tasks: results,
      });
      })();

      const sharedPromise = warmPromise.finally(() => {
        if (inflightByDirectory.get(directoryKey) === sharedPromise) {
          inflightByDirectory.delete(directoryKey);
        }
      });
      inflightByDirectory.set(directoryKey, sharedPromise);
      return sharedPromise;
    },

    getLatestResult() {
      return latestResult;
    },
  };
}

function registerAgentRuntimeWarmupRoute(app, warmupRuntime) {
  app.post('/api/startup/agent-runtime-warmup', async (req, res) => {
    try {
      const body = isObject(req.body) ? req.body : {};
      const result = await warmupRuntime.warm({
        directory: normalizeDirectory(body.directory),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        mcpTimeoutMs: DEFAULT_MCP_TIMEOUT_MS,
      });
      res.json(result);
    } catch (error) {
      res.json(withHarnessResult({
        status: 'ready',
        timedOut: false,
        tasks: [{
          name: 'agentRuntime',
          status: 'error',
          durationMs: 0,
          error: formatError(error),
        }],
      }, createHarnessWarning({
        summary: 'Agent runtime warmup failed before diagnostics completed',
        nextActions: ['Retry warmup after OpenCode reports ready'],
        recovery: {
          rootCauseHint: formatError(error),
          safeRetry: 'Retry the warmup endpoint after startup settles',
          stopCondition: 'Stop retrying if startup remains unavailable after restart',
          retryable: true,
        },
      })));
    }
  });
}

export { createAgentRuntimeWarmup, registerAgentRuntimeWarmupRoute };

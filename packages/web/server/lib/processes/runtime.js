import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  getOpenChamberDataDir,
  isManagedOpenCodeProcessCommand,
  readManagedOpenCodeRegistry,
  terminateManagedOpenCodePid,
} from '../opencode/managed-process-registry.js';

// Environment marker the tool-input guard plugin exports in front of agent
// shell commands when a project opts into process tracking.
export const SESSION_MARKER_ENV = 'DEVRYAN_SESSION_ID';
export const TRACKING_FILE_RELATIVE_PATH = path.join('processes', 'tracking.json');
export const DEFAULT_HEAVY_CHECK_SLOTS = 2;
const TRACKING_FILE_VERSION = 1;
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
// `lstart` has one-second resolution; both sides of a stop request derive from
// the same parse, but tolerate rounding by clients that re-serialize the value.
const STOP_STARTED_AT_TOLERANCE_MS = 1_000;
const EXEC_TIMEOUT_MS = 15_000;
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Dev-server patterns ported from packages/ui/src/lib/detectDevServer.ts
// (script names dev/start/preview/serve/develop plus the static python server),
// widened with the framework CLIs those scripts usually delegate to.
const DEV_SCRIPT_NAMES = '(?:dev|start|preview|serve|develop)';
const PACKAGE_MANAGER_RUN = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+(?:run|run-script))?(?:\s+--?[\w=./-]+)*`;
const DEV_SERVER_PATTERNS = [
  new RegExp(String.raw`(?:^|[\s;&|(])${PACKAGE_MANAGER_RUN}\s+${DEV_SCRIPT_NAMES}(?::[\w.-]+)?(?:\s|$)`, 'i'),
  /(?:^|[\s/])vite(?:\.js)?(?:\s+(?!build\b)|$)/i,
  /(?:^|[\s/])(?:next|nuxt|astro|remix|gatsby|svelte-kit|ng|expo|vercel|parcel|webpack|turbo|nodemon|ts-node-dev|tsx)\s+(?:run\s+)?(?:dev|develop|start|serve|preview|watch)\b/i,
  /(?:^|[\s/])webpack-dev-server\b/i,
  /(?:^|[\s/])(?:http-server|live-server|sirv|browser-sync)\b/i,
  /python3?\s+-m\s+http\.server\b/i,
  /(?:^|[\s/])(?:uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+(?:s|server)|php\s+artisan\s+serve|hugo\s+server|jekyll\s+serve|mkdocs\s+serve)\b/i,
];
const AGENT_CLI_PATTERN = /(?:^|[\s/])(?:claude|codex|cursor-agent)(?:\s|$)|(?:^|[\s/])opencode\s+run(?:\s|$)/i;
const LSP_PATTERN = /(?:^|[\s/])(?:typescript-language-server|tsserver(?:\.js)?|pyright-langserver|pylsp|gopls|rust-analyzer|clangd|lua-language-server|[\w.-]*-language-server|[\w.-]*-langserver|[\w.-]*lsp(?:-server)?)(?:\.js)?(?:\s|$)/i;
const MCP_PATTERN = /modelcontextprotocol|mcp[-_]server|(?:^|[\s/@_.-])mcp(?:[\s/@_.-]|$)/i;

const normalizePositiveInteger = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
};

export const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
};

const directoryMatches = (candidate, target) => {
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  return target.startsWith(candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`);
};

export const classifyProcessCommand = (command) => {
  const text = typeof command === 'string' ? command.replace(/\s+/g, ' ').trim() : '';
  if (!text) return 'other';
  if (LSP_PATTERN.test(text)) return 'lsp';
  if (MCP_PATTERN.test(text)) return 'mcp';
  if (AGENT_CLI_PATTERN.test(text)) return 'agent_cli';
  if (DEV_SERVER_PATTERNS.some((pattern) => pattern.test(text))) return 'dev_server';
  return 'other';
};

// `ps -o lstart` prints e.g. "Thu Sep  3 20:40:50 2026" (local time).
export const parseProcessStartTime = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(?:\w{3}\s+)?(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const date = new Date(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
};

const PS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export const parsePsTable = (text) => {
  if (typeof text !== 'string') return [];
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(PS_LINE_PATTERN);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: parseProcessStartTime(match[4]),
      command: match[5].trim(),
    });
  }
  return rows;
};

// `lsof -F pn` emits one field per line: `p<pid>` then `n<name>` per socket.
export const parseLsofListeners = (text) => {
  const portsByPid = new Map();
  if (typeof text !== 'string') return portsByPid;
  let currentPid = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('p')) {
      currentPid = normalizePositiveInteger(line.slice(1));
      if (currentPid && !portsByPid.has(currentPid)) portsByPid.set(currentPid, new Set());
      continue;
    }
    if (line.startsWith('n') && currentPid) {
      const port = normalizePositiveInteger(line.slice(line.lastIndexOf(':') + 1));
      if (port) portsByPid.get(currentPid).add(port);
    }
  }
  return portsByPid;
};

// Session ids are opaque tokens; restricting the charset also stops a trailing
// `;` from a `sh -c "export DEVRYAN_SESSION_ID=x; …"` command line leaking in.
const SESSION_MARKER_PATTERN = new RegExp(String.raw`(?:^|\s)${SESSION_MARKER_ENV}=["']?([A-Za-z0-9_.:-]+)`, 'g');

export const extractSessionMarker = (text) => {
  if (typeof text !== 'string' || !text) return null;
  let last = null;
  for (const match of text.matchAll(SESSION_MARKER_PATTERN)) {
    last = match[1];
  }
  return last;
};

// darwin: `ps -E` appends the environment to the command column (for
// processes whose environment the caller may read — Apple platform binaries
// hide theirs). Returns Map<pid, sessionId|null>.
export const parsePsEnvironmentTable = (text) => {
  const result = new Map();
  if (typeof text !== 'string') return result;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    result.set(Number(match[1]), extractSessionMarker(match[2]));
  }
  return result;
};

const defaultExec = (command, args, { allowNonZeroExit = false } = {}) => new Promise((resolve, reject) => {
  nodeExecFile(command, args, {
    encoding: 'utf8',
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: EXEC_TIMEOUT_MS,
    windowsHide: true,
  }, (error, stdout) => {
    const output = typeof stdout === 'string' ? stdout : '';
    if (error && !(allowNonZeroExit && output)) {
      if (allowNonZeroExit && error.code !== 'ENOENT' && typeof error.code === 'number') {
        resolve(output);
        return;
      }
      reject(error);
      return;
    }
    resolve(output);
  });
});

const httpError = (statusCode, message, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
};

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonFileAtomically = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
};

const normalizeProjectSetting = (directory, raw) => {
  const record = raw && typeof raw === 'object' ? raw : {};
  const heavyCheckSlots = Number.isFinite(record.heavyCheckSlots) && record.heavyCheckSlots >= 0
    ? Math.trunc(record.heavyCheckSlots)
    : DEFAULT_HEAVY_CHECK_SLOTS;
  return {
    directory,
    trackAgentProcesses: record.trackAgentProcesses === true,
    heavyCheckSlots,
  };
};

export const createProcessesRuntime = (options = {}) => {
  const platform = options.platform || process.platform;
  const exec = typeof options.exec === 'function' ? options.exec : defaultExec;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const env = options.env || process.env;
  const dataDir = typeof options.dataDir === 'string' && options.dataDir.trim()
    ? path.resolve(options.dataDir)
    : getOpenChamberDataDir(env);
  const trackingFilePath = path.join(dataDir, TRACKING_FILE_RELATIVE_PATH);
  const readRegistry = typeof options.readRegistry === 'function'
    ? options.readRegistry
    : () => readManagedOpenCodeRegistry({ env });
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (filePath) => fs.readFileSync(filePath, 'utf8');
  const terminate = typeof options.terminate === 'function'
    ? options.terminate
    : (pid, terminateOptions) => terminateManagedOpenCodePid(pid, {
      platform,
      processKill: options.processKill,
      ...terminateOptions,
    });
  const log = typeof options.log === 'function' ? options.log : (...args) => console.warn('[processes]', ...args);

  const readTrackingFile = () => {
    const parsed = readJsonFile(trackingFilePath);
    const projects = parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object'
      ? parsed.projects
      : {};
    return { version: TRACKING_FILE_VERSION, projects };
  };

  const findProjectSetting = (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) return null;
    const { projects } = readTrackingFile();
    // Exact match wins; otherwise the nearest configured ancestor applies.
    let bestKey = null;
    for (const key of Object.keys(projects)) {
      if (!directoryMatches(key, normalized)) continue;
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
    return bestKey ? normalizeProjectSetting(bestKey, projects[bestKey]) : null;
  };

  const getProjectSetting = async (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) throw httpError(400, 'directory is required');
    const { projects } = readTrackingFile();
    return normalizeProjectSetting(normalized, projects[normalized]);
  };

  const setProjectSetting = async (directory, value = {}) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) throw httpError(400, 'directory is required');
    const current = readTrackingFile();
    const previous = normalizeProjectSetting(normalized, current.projects[normalized]);
    const next = {
      trackAgentProcesses: typeof value.trackAgentProcesses === 'boolean'
        ? value.trackAgentProcesses
        : previous.trackAgentProcesses,
      heavyCheckSlots: Number.isFinite(value.heavyCheckSlots) && value.heavyCheckSlots >= 0
        ? Math.trunc(value.heavyCheckSlots)
        : previous.heavyCheckSlots,
    };
    writeJsonFileAtomically(trackingFilePath, {
      version: TRACKING_FILE_VERSION,
      updatedAt: now(),
      projects: { ...current.projects, [normalized]: next },
    });
    return normalizeProjectSetting(normalized, next);
  };

  const isTrackingEnabled = (directory) => findProjectSetting(directory)?.trackAgentProcesses === true;

  const readSessionMarkers = async (pids) => {
    const markers = new Map();
    if (pids.length === 0) return markers;
    if (platform === 'linux') {
      for (const pid of pids) {
        try {
          const environ = readFile(`/proc/${pid}/environ`);
          markers.set(pid, extractSessionMarker(String(environ).replace(/\0/g, ' ')));
        } catch {
          markers.set(pid, null);
        }
      }
      return markers;
    }
    try {
      const output = await exec('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], { allowNonZeroExit: true });
      for (const [pid, marker] of parsePsEnvironmentTable(output)) markers.set(pid, marker);
    } catch (error) {
      log('Failed to read process environments:', error?.message || error);
    }
    return markers;
  };

  const readListeningPorts = async (pids) => {
    if (pids.length === 0) return new Map();
    try {
      const output = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fpn'], { allowNonZeroExit: true });
      return parseLsofListeners(output);
    } catch (error) {
      if (error?.code !== 'ENOENT') log('Failed to read listening ports:', error?.message || error);
      return new Map();
    }
  };

  const snapshot = async ({ directory } = {}) => {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return { supported: false, platform, processes: [], orphanServers: [], generatedAt: now() };
    }
    const table = parsePsTable(await exec('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command=']));
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const childrenByPid = new Map();
    for (const row of table) {
      if (!childrenByPid.has(row.ppid)) childrenByPid.set(row.ppid, []);
      childrenByPid.get(row.ppid).push(row);
    }

    const filterDirectory = normalizeDirectory(directory);
    const records = readRegistry();
    const registryPids = new Set(records.map((record) => record.childPid));
    const roots = records
      .filter((record) => byPid.has(record.childPid))
      .filter((record) => {
        if (!filterDirectory) return true;
        const recordDirectory = normalizeDirectory(record.workingDirectory);
        return !recordDirectory || recordDirectory === filterDirectory;
      });

    const descendants = [];
    const rootByPid = new Map();
    const seen = new Set();
    for (const root of roots) {
      const queue = [...(childrenByPid.get(root.childPid) ?? [])];
      while (queue.length > 0) {
        const row = queue.shift();
        if (seen.has(row.pid) || registryPids.has(row.pid)) continue;
        seen.add(row.pid);
        rootByPid.set(row.pid, root);
        descendants.push(row);
        queue.push(...(childrenByPid.get(row.pid) ?? []));
      }
    }

    const orphanRows = table.filter((row) => (
      row.ppid === 1
      && !registryPids.has(row.pid)
      && !seen.has(row.pid)
      && isManagedOpenCodeProcessCommand(row.command, { binary: 'opencode' })
    ));

    const descendantPids = descendants.map((row) => row.pid);
    const [ports, markers] = await Promise.all([
      readListeningPorts([...descendantPids, ...orphanRows.map((row) => row.pid)]),
      readSessionMarkers(descendantPids),
    ]);

    const timestamp = now();
    const sessionByPid = new Map();
    // Children inherit the environment; when a wrapper hides its own (platform
    // binaries on macOS) fall back to the nearest attributed ancestor.
    const resolveSession = (row) => {
      if (sessionByPid.has(row.pid)) return sessionByPid.get(row.pid);
      // The exported marker is also visible in the wrapper shell's own command
      // line, which keeps attribution working when the environment is unreadable.
      let resolved = markers.get(row.pid) ?? extractSessionMarker(row.command);
      if (!resolved) {
        const parent = byPid.get(row.ppid);
        resolved = parent && seen.has(parent.pid) ? resolveSession(parent) : null;
      }
      sessionByPid.set(row.pid, resolved);
      return resolved;
    };

    const processes = descendants.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      startedAt: row.startedAt,
      ageMs: row.startedAt === null ? null : Math.max(0, timestamp - row.startedAt),
      command: row.command,
      category: classifyProcessCommand(row.command),
      ports: [...(ports.get(row.pid) ?? [])].sort((a, b) => a - b),
      sessionId: resolveSession(row),
      workingDirectory: normalizeDirectory(rootByPid.get(row.pid)?.workingDirectory) ?? null,
    }));

    const orphanServers = orphanRows.map((row) => {
      const listening = [...(ports.get(row.pid) ?? [])].sort((a, b) => a - b);
      const portFromCommand = row.command.match(/--port[=\s]+(\d+)/i);
      return {
        pid: row.pid,
        port: listening[0] ?? (portFromCommand ? Number(portFromCommand[1]) : null),
        command: row.command,
        ageMs: row.startedAt === null ? null : Math.max(0, timestamp - row.startedAt),
        startedAt: row.startedAt,
      };
    });

    return { supported: true, platform, processes, orphanServers, generatedAt: timestamp };
  };

  const collectDescendantPids = (processes, pid) => {
    const result = [];
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const entry of processes) {
        if (entry.ppid === current && !result.includes(entry.pid)) {
          result.push(entry.pid);
          queue.push(entry.pid);
        }
      }
    }
    return result;
  };

  const stopTarget = async (current, target) => {
    const descendantPids = collectDescendantPids(current.processes, target.pid);
    const terminated = await Promise.resolve(terminate(target.pid, { descendantPids })).catch(() => false);
    return { pid: target.pid, terminated: terminated === true, stoppedDescendants: descendantPids };
  };

  const stopProcess = async ({ pid, startedAt } = {}) => {
    const normalizedPid = normalizePositiveInteger(pid);
    if (!normalizedPid) throw httpError(400, 'pid must be a positive integer');
    const current = await snapshot();
    if (!current.supported) throw httpError(400, 'Process management is not supported on this platform', 'unsupported_platform');
    const target = current.processes.find((entry) => entry.pid === normalizedPid)
      ?? current.orphanServers.find((entry) => entry.pid === normalizedPid);
    if (!target) throw httpError(404, `Process ${normalizedPid} is not running under a managed OpenCode server`, 'process_not_found');
    const expectedStartedAt = Number(startedAt);
    if (
      !Number.isFinite(expectedStartedAt)
      || target.startedAt === null
      || Math.abs(target.startedAt - expectedStartedAt) > STOP_STARTED_AT_TOLERANCE_MS
    ) {
      throw httpError(409, `Process ${normalizedPid} was restarted since the list was taken; refresh and retry`, 'process_restarted');
    }
    return stopTarget(current, target);
  };

  // Session-delete hook: only dev servers, only when the marker matches, and only
  // while the owning project still opts into tracking.
  const stopSessionDevServers = async (sessionId, { directory } = {}) => {
    const normalizedSession = typeof sessionId === 'string' ? sessionId.trim() : '';
    const result = { sessionId: normalizedSession, stopped: [], skipped: [] };
    if (!normalizedSession) return result;
    const requestDirectory = normalizeDirectory(directory);
    if (requestDirectory && !isTrackingEnabled(requestDirectory)) return result;
    const current = await snapshot();
    if (!current.supported) return result;
    const targets = current.processes.filter((entry) => entry.category === 'dev_server' && entry.sessionId === normalizedSession);
    const handled = new Set();
    for (const target of targets) {
      if (handled.has(target.pid)) continue;
      const trackingDirectory = requestDirectory ?? target.workingDirectory;
      if (!trackingDirectory || !isTrackingEnabled(trackingDirectory)) {
        result.skipped.push({ pid: target.pid, reason: 'tracking-disabled' });
        continue;
      }
      const stopped = await stopTarget(current, target);
      handled.add(target.pid);
      for (const descendantPid of stopped.stoppedDescendants) handled.add(descendantPid);
      result.stopped.push(stopped);
    }
    return result;
  };

  return {
    dataDir,
    trackingFilePath,
    snapshot,
    stopProcess,
    stopSessionDevServers,
    getProjectSetting,
    setProjectSetting,
    isTrackingEnabled,
    findProjectSetting,
  };
};

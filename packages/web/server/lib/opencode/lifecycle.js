import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { formatPackagedAgentSyncConflicts } from './packaged-agent-sync.js';
import { buildVisibleSkillPolicy } from './skill-policy.js';
import { CONFIG_FILE, readConfigFile, writeConfig } from './shared.js';
import { migrateOpenchamberConfigToSidecar } from './openchamber-sidecar.js';
import { SLIM_REPLACED_AGENT_NAMES, resolveSlimConfig } from './slim-config.js';
import { createContextModeRecovery } from './context-mode-recovery.js';
import {
  buildContextModeStorageEnv,
  reapOrphanedManagedOpenCodeProcesses,
  registerManagedOpenCodeProcess,
  unregisterManagedOpenCodeProcess,
} from './managed-process-registry.js';

const isManagedOrchestrationOwnershipError = (error) => (
  error?.code === 'managed_orchestration_owner_conflict'
  || error?.code === 'managed_orchestration_ownership_lost'
);

// `opencode serve --log-level` accepts DEBUG | INFO | WARN | ERROR (verified
// against opencode 1.18.27). Without the flag the managed server logs at INFO
// and its opencode.log grows by tens of megabytes per session; WARN keeps
// failures visible while staying small. DEVRYAN_OPENCODE_LOG_LEVEL overrides it.
export const OPENCODE_LOG_LEVELS = Object.freeze(['DEBUG', 'INFO', 'WARN', 'ERROR']);
export const DEFAULT_OPENCODE_LOG_LEVEL = 'WARN';

export const resolveManagedOpenCodeLogLevel = (value = process.env.DEVRYAN_OPENCODE_LOG_LEVEL) => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return OPENCODE_LOG_LEVELS.includes(normalized) ? normalized : DEFAULT_OPENCODE_LOG_LEVEL;
};

/**
 * OpenCode 1.15+ rejects unknown top-level config keys, but DevRyan historically
 * stored its own per-agent overrides under a top-level `openchamber` key in the
 * shared opencode config file. We migrate that key into a DevRyan-owned sidecar
 * file just before launching the opencode binary so opencode boots cleanly. The
 * sidecar is the source of truth for openchamber-namespaced data going forward;
 * agents.js reads/writes through it. opencode hot-reads its config file, so we
 * never re-add the key to opencode's config — it lives only in the sidecar.
 */
function migrateOpenchamberKeyBeforeLaunch() {
  try {
    migrateOpenchamberConfigToSidecar({
      configFile: CONFIG_FILE,
      readConfigFile,
      writeConfig,
    });
  } catch (error) {
    console.warn('[OpenCode] Failed to migrate openchamber config key for launch:', error);
  }
}

function normalizeWorkingDirectoryCandidate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function isExistingDirectory(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveManagedWorkingDirectoryFromSettings(settings, fallbackDirectory, sanitizeProjects) {
  const candidates = [];
  const lastDirectory = normalizeWorkingDirectoryCandidate(settings?.lastDirectory);
  if (lastDirectory) {
    candidates.push(lastDirectory);
  }

  const projects = typeof sanitizeProjects === 'function'
    ? sanitizeProjects(settings?.projects)
    : (Array.isArray(settings?.projects) ? settings.projects : []);
  const activeProjectId = typeof settings?.activeProjectId === 'string' ? settings.activeProjectId : '';
  const activeProject = Array.isArray(projects)
    ? projects.find((project) => project?.id === activeProjectId)
    : null;
  const activeProjectDirectory = normalizeWorkingDirectoryCandidate(activeProject?.path);
  if (activeProjectDirectory) {
    candidates.push(activeProjectDirectory);
  }

  if (Array.isArray(projects)) {
    for (const project of projects) {
      const projectDirectory = normalizeWorkingDirectoryCandidate(project?.path);
      if (projectDirectory) {
        candidates.push(projectDirectory);
      }
    }
  }

  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }

  return normalizeWorkingDirectoryCandidate(fallbackDirectory) || os.homedir();
}

function normalizeAgentModelRef(agent) {
  const model = agent?.model;
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }
  if (model && typeof model === 'object' && !Array.isArray(model)) {
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (providerID && modelID) return `${providerID}/${modelID}`;
  }
  if (Array.isArray(agent?.modelRefs)) {
    const first = agent.modelRefs.find((entry) => typeof entry === 'string' && entry.trim());
    if (first) return first.trim();
  }
  return '';
}

function normalizeAgentVariant(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function agentVariantMatches({
  expectVariant,
  expectedModelRef,
  expectedVariant,
  loadedModelRef,
  loadedVariant,
}) {
  if (!expectVariant || loadedVariant === expectedVariant) {
    return true;
  }

  // OpenCode reports an empty variant when the model does not support or apply
  // the requested thinking level; the persisted config remains authoritative.
  return loadedModelRef === expectedModelRef
    && Boolean(expectedVariant)
    && !loadedVariant;
}

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    buildWslExecArgs,
    resolveWslExecutablePath,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOrchestrationEnvironment = async () => ({}),
    getManagedBrowserEnvironment = async () => ({}),
    getManagedOAuthEnvironment = async () => ({}),
    pauseManagedBrowserLeases = async () => null,
    resumeManagedBrowserLeases = async () => false,
    getActiveSessionCount = () => 0,
    getAuthoritativeActiveSessionCount = getActiveSessionCount,
    acquireContextModeAdmissionHold = () => () => {},
    recordContextModeRecoveryIncident = () => {},
    provisionUserProfile = async () => ({ ok: true, changed: false, conflicts: [] }),
    syncPackagedAgents = async () => ({ changed: false, conflicts: [] }),
    syncRuntimeAgentOverlays = async () => ({ changed: false, targetConfigDirectory: null }),
    readSettingsFromDisk = async () => ({}),
    sanitizeProjects = (value) => (Array.isArray(value) ? value : []),
    sanitizeHiddenSkills = (value) => (Array.isArray(value) ? value : []),
    discoverSkills = () => [],
    onOpenCodeRestarted = () => {},
    onStartupStatus = () => {},
  } = deps;

  const emitStartupStatus = (text) => {
    try {
      onStartupStatus(text);
    } catch { /* status display is best-effort */ }
  };

  let managedOrphanReapDone = false;
  let managedOrphanReapInFlight = null;
  const reapManagedOpenCodeOrphans = async () => {
    if (managedOrphanReapInFlight) return managedOrphanReapInFlight;
    managedOrphanReapInFlight = (async () => {
      try {
        const result = await reapOrphanedManagedOpenCodeProcesses();
        if (result.reaped.length > 0 || result.removed.length > 0) {
          console.log('[OpenCode] Managed process registry cleanup', {
            reaped: result.reaped.length,
            removed: result.removed.length,
            skipped: result.skipped.length,
          });
        }
        return result;
      } finally {
        managedOrphanReapInFlight = null;
      }
    })();
    return managedOrphanReapInFlight;
  };
  const reapManagedOpenCodeOrphansOnce = async () => {
    if (managedOrphanReapDone) return null;
    managedOrphanReapDone = true;
    return reapManagedOpenCodeOrphans();
  };

  const hasChildProcessExited = (child) => {
    if (!child) return true;
    if (typeof child.hasExited === 'function') return child.hasExited();
    return child.exitCode !== null && child.exitCode !== undefined
      || child.signalCode !== null && child.signalCode !== undefined;
  };

  const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
    if (!child || hasChildProcessExited(child)) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    };

    const onClose = () => finish(true);
    const onError = () => finish(hasChildProcessExited(child));
    const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

    child.once('close', onClose);
    child.once('error', onError);
  });

  const waitForPortRelease = (port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, 150);
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(500);
      };

      attempt();
    });
  };

  const killProcessOnPort = (port) => {
    const numericPort = Number(port);
    if (!Number.isFinite(numericPort) || numericPort <= 0 || numericPort > 65535) {
      return [];
    }
    if (process.platform === 'win32') {
      return [];
    }

    let stdout = '';
    try {
      const result = spawnSync('lsof', ['-nP', '-t', `-iTCP:${Math.trunc(numericPort)}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2500,
      });
      stdout = typeof result?.stdout === 'string' ? result.stdout : '';
    } catch {
      return [];
    }

    const pids = stdout
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
      }
    }

    if (pids.length > 0) {
      setTimeout(() => {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
          }
        }
      }, 1200).unref?.();
    }

    return pids;
  };

  const closeManagedOpenCodeChild = async (child) => {
    if (!child) {
      return true;
    }

    const pid = child.pid;
    if (!pid || hasChildProcessExited(child)) {
      return await waitForChildProcessClose(child, 250);
    }

    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
      }

      if (await waitForChildProcessClose(child, 800)) {
        return true;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/t'], {
          stdio: 'ignore',
          timeout: 3000,
          windowsHide: true,
        });
      } catch {
      }

      if (await waitForChildProcessClose(child, 1500)) {
        return true;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
      }

      return await waitForChildProcessClose(child, 3000);
    }

    // Kill the whole process group (negative pid) so the opencode server's
    // spawned MCP children (npm exec mobbin-mcp, railway mcp, resend-mcp, etc.)
    // are reaped together. The server is launched detached as its own group
    // leader (see spawn below); without this, each shutdown orphans the MCP
    // fleet and they accumulate into hundreds of processes / GBs of RSS. Fall
    // back to a direct child kill if the group signal cannot be delivered.
    const killManaged = (signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
        }
      }
    };

    killManaged('SIGTERM');

    if (await waitForChildProcessClose(child, 2500)) {
      return true;
    }

    killManaged('SIGKILL');

    return await waitForChildProcessClose(child, 1000);
  };

  const formatCapturedOutput = ({ stdout, stderr }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const createManagedOpenCodeServerProcess = async ({ hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0 }) => {
    let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const logLevel = resolveManagedOpenCodeLogLevel();
    let args = ['serve', '--hostname', hostname, '--port', String(port), '--log-level', logLevel];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      const wslBinary = state.resolvedWslBinary || resolveWslExecutablePath();
      if (!wslBinary) {
        throw new Error('WSL executable not found while attempting to launch OpenCode from WSL');
      }

      const wslOpencode = state.resolvedWslOpencodePath && state.resolvedWslOpencodePath.trim().length > 0
        ? state.resolvedWslOpencodePath.trim()
        : 'opencode';
      const serveHost = hostname === '127.0.0.1' ? '0.0.0.0' : hostname;

      binary = wslBinary;
      args = buildWslExecArgs([
        wslOpencode,
        'serve',
        '--hostname',
        serveHost,
        '--port',
        String(port),
        '--log-level',
        logLevel,
      ], state.resolvedWslDistro);
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        args = [...(Array.isArray(launchSpec.args) ? launchSpec.args : []), ...args];
      }
    }

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    migrateOpenchamberKeyBeforeLaunch();

    const child = spawn(binary, args, {
      cwd,
      env: processEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Launch the server as its own process-group leader on Unix so shutdown
      // can kill the entire group (server + every MCP child it spawns) in one
      // signal. Windows uses taskkill /t for tree termination instead, so it
      // stays attached there.
      detached: process.platform !== 'win32',
    });

    // Register before the ready-wait: a crash in the up-to-30s window between
    // spawn and readiness must not leave an untracked orphan behind.
    if (child.pid) {
      registerManagedOpenCodeProcess({
        childPid: child.pid,
        ownerPid: process.pid,
        port,
        binary,
        hostRuntime: 'web',
        hostname,
        startedAt: Date.now(),
        workingDirectory: cwd,
      });
    }

    let url;
    try {
      url = await new Promise((resolve, reject) => {
      // Diagnostics capture keeps a bounded tail, and the listening-line scan
      // only walks the unscanned remainder — the previous whole-accumulator
      // re-split was O(n²) and uncapped until the marker line appeared.
      const OUTPUT_CAPTURE_MAX_CHARS = 256 * 1024;
      const SCAN_REMAINDER_MAX_CHARS = 8 * 1024;
      const appendBoundedTail = (current, chunkText) => {
        const next = current + chunkText;
        return next.length > OUTPUT_CAPTURE_MAX_CHARS
          ? next.slice(next.length - OUTPUT_CAPTURE_MAX_CHARS)
          : next;
      };
      let stdout = '';
      let stderr = '';
      let scanRemainder = '';
      let done = false;
      const finish = (handler, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        handler(value);
      };

      const onStdout = (chunk) => {
        const text = chunk.toString();
        stdout = appendBoundedTail(stdout, text);
        scanRemainder += text;
        const lines = scanRemainder.split('\n');
        for (const line of lines) {
          if (!line.startsWith('opencode server listening')) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            finish(reject, new Error(`Failed to parse server url from output: ${line}`));
            return;
          }
          finish(resolve, match[1]);
          return;
        }
        // Keep only the trailing partial line for the next scan.
        scanRemainder = lines[lines.length - 1] ?? '';
        if (scanRemainder.length > SCAN_REMAINDER_MAX_CHARS) {
          scanRemainder = scanRemainder.slice(-SCAN_REMAINDER_MAX_CHARS);
        }
      };

      const onStderr = (chunk) => {
        stderr = appendBoundedTail(stderr, chunk.toString());
      };

      const onExit = (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
          ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
          : '';
        finish(reject, new Error(`OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${formatCapturedOutput({ stdout, stderr })}`));
      };

      const onError = (error) => {
        finish(reject, error);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
      }, timeout);

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('exit', onExit);
      child.on('error', onError);
      });
    } catch (error) {
      const closed = await closeManagedOpenCodeChild(child);
      if (closed && child.pid) {
        unregisterManagedOpenCodeProcess(child.pid);
      }
      throw error;
    }

    return {
      url,
      hasExited: () => hasChildProcessExited(child),
      async close() {
        const closed = await closeManagedOpenCodeChild(child);
        if (closed) {
          unregisterManagedOpenCodeProcess(child.pid);
        } else {
          console.warn(`[OpenCode] Managed process ${child.pid} did not confirm close; keeping registry record for orphan cleanup.`);
        }
      },
    };
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const isOpenCodeProcessHealthy = async () => {
    const startedAt = Date.now();
    let succeeded = false;
    const recordProbe = () => {
      state.openCodeProbe = { checkedAt: Date.now(), succeeded, durationMs: Date.now() - startedAt,
        lastSuccessAt: succeeded ? Date.now() : (state.openCodeProbe?.lastSuccessAt ?? null),
        lastFailureAt: succeeded ? (state.openCodeProbe?.lastFailureAt ?? null) : Date.now() };
    };
    if (!state.openCodeProcess || !state.openCodePort) {
      recordProbe();
      return false;
    }

    try {
      const response = await fetch(buildOpenCodeUrl('/global/health', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      if (body?.healthy === true && typeof body.version === 'string' && body.version.trim().length > 0) {
        state.openCodeVersion = body.version.trim();
      }
      succeeded = body?.healthy === true;
      return succeeded;
    } catch {
      return false;
    } finally {
      recordProbe();
    }
  };

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/global/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const syncManagedAgentRuntimeConfig = async () => {
    if (state.isExternalOpenCode || env.ENV_SKIP_OPENCODE_START) {
      return {
        changed: false,
        conflicts: [],
        runtimeApplied: false,
        requiresReload: false,
        runtimeMessage: 'Agent model defaults were saved, but DevRyan cannot apply them to a configured external OpenCode runtime automatically.',
      };
    }

    let settings = {};
    try {
      settings = await readSettingsFromDisk();
    } catch {
      settings = {};
    }

    const resolvedWorkingDirectory = resolveManagedWorkingDirectoryFromSettings(
      settings,
      state.openCodeWorkingDirectory,
      sanitizeProjects
    );
    if (resolvedWorkingDirectory && resolvedWorkingDirectory !== state.openCodeWorkingDirectory) {
      state.openCodeWorkingDirectory = resolvedWorkingDirectory;
      syncToHmrState();
    }

    const hiddenSkills = sanitizeHiddenSkills(settings?.hiddenSkills) || [];
    const profileResult = await provisionUserProfile();
    if (profileResult?.ok === false) {
      throw new Error(profileResult.error || 'Failed to provision the OpenCode user profile');
    }
    if (Array.isArray(profileResult?.conflicts) && profileResult.conflicts.length > 0) {
      console.warn('[OpenCode] Preserved user-modified managed profile files', profileResult.conflicts);
    }
    for (const warning of Array.isArray(profileResult?.warnings) ? profileResult.warnings : []) {
      console.warn(`[OpenCode] ${warning}`);
    }
    const skills = discoverSkills(state.openCodeWorkingDirectory);
    const skillPolicy = buildVisibleSkillPolicy({ skills, hiddenSkills });
    const slimConfig = resolveSlimConfig(state.openCodeWorkingDirectory);
    const packagedResult = await syncPackagedAgents({
      agentOverrides: {},
      skillPolicy,
      excludedAgentNames: slimConfig.enabled ? Array.from(SLIM_REPLACED_AGENT_NAMES) : [],
    });
    const conflicts = Array.isArray(packagedResult?.conflicts) ? packagedResult.conflicts : [];
    if (conflicts.length > 0) {
      const message = formatPackagedAgentSyncConflicts(conflicts)
        || 'Packaged agent sync conflict';
      console.warn(`[OpenCode] ${message} Continuing with existing runtime agent files.`);
    }
    const overlayResult = await syncRuntimeAgentOverlays({
      workingDirectory: state.openCodeWorkingDirectory,
      skillPolicy,
    });

    if (packagedResult?.changed) {
      console.log('[OpenCode] Synced packaged agents', {
        written: packagedResult.written ?? [],
        updated: packagedResult.updated ?? [],
        removed: packagedResult.removed ?? [],
      });
    }

    if (overlayResult?.changed) {
      console.log('[OpenCode] Synced runtime agent overlays', {
        written: overlayResult.written ?? [],
        updated: overlayResult.updated ?? [],
        removed: overlayResult.removed ?? [],
        targetConfigDirectory: overlayResult.targetConfigDirectory ?? null,
      });
    }

    return {
      changed: Boolean(packagedResult?.changed || overlayResult?.changed),
      conflicts,
      packaged: packagedResult ?? { changed: false, conflicts: [] },
      overlays: overlayResult ?? { changed: false, targetConfigDirectory: null },
      targetConfigDirectory: overlayResult?.targetConfigDirectory ?? null,
      slimPreset: slimConfig.pluginEnabled && slimConfig.activePreset ? slimConfig.activePreset : null,
      slimConfigDirectory: slimConfig.pluginEnabled ? slimConfig.configDirectory : null,
      runtimeApplied: true,
      requiresReload: true,
    };
  };

  const startOpenCodeOnce = async () => {
    // Electron provisions the managed browser skill here so the immediately
    // following skill discovery/overlay sync sees it on this same launch.
    // External and non-Electron runtimes return an empty object without IO.
    const browserEnvironmentInput = await getManagedBrowserEnvironment();
    emitStartupStatus('Preparing plugins and agents…');
    const agentRuntimeConfig = await syncManagedAgentRuntimeConfig();
    emitStartupStatus('Starting OpenCode…');

    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings({ strict: true });
    ensureOpencodeCliEnv();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    const envPath = typeof buildManagedOpenCodePath === 'function'
      ? buildManagedOpenCodePath()
      : typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath()
      : process.env.PATH;
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    const orchestrationEnvironmentInput = await (async () => {
      try {
        return await getManagedOrchestrationEnvironment();
      } catch (error) {
        if (!isManagedOrchestrationOwnershipError(error)) throw error;
        console.warn('[OpenCode] Managed orchestration is unavailable; continuing without the private bridge', {
          code: error.code,
        });
        return {};
      }
    })();
    const orchestrationUrl = typeof orchestrationEnvironmentInput?.DEVRYAN_ORCHESTRATION_URL === 'string'
      ? orchestrationEnvironmentInput.DEVRYAN_ORCHESTRATION_URL.trim()
      : '';
    const orchestrationToken = typeof orchestrationEnvironmentInput?.DEVRYAN_ORCHESTRATION_TOKEN === 'string'
      ? orchestrationEnvironmentInput.DEVRYAN_ORCHESTRATION_TOKEN.trim()
      : '';
    const orchestrationAccountDefaults = orchestrationEnvironmentInput?.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS === '1'
      ? '1'
      : '';
    if (Boolean(orchestrationUrl) !== Boolean(orchestrationToken)) {
      throw new Error('Managed orchestration bridge URL and token must be provided together');
    }
    if (orchestrationUrl) {
      const parsedBridgeUrl = new URL(orchestrationUrl);
      if (
        parsedBridgeUrl.protocol !== 'http:'
        || parsedBridgeUrl.hostname !== '127.0.0.1'
        || parsedBridgeUrl.pathname !== '/rpc'
      ) {
        throw new Error('Managed orchestration bridge must use the private IPv4 loopback RPC endpoint');
      }
    }
    const browserDiscoveryUrl = typeof browserEnvironmentInput?.DEVRYAN_BROWSER_CDP_DISCOVERY_URL === 'string'
      ? browserEnvironmentInput.DEVRYAN_BROWSER_CDP_DISCOVERY_URL.trim()
      : '';
    const browserToken = typeof browserEnvironmentInput?.DEVRYAN_BROWSER_CDP_TOKEN === 'string'
      ? browserEnvironmentInput.DEVRYAN_BROWSER_CDP_TOKEN.trim()
      : '';
    const agentBrowserBinary = typeof browserEnvironmentInput?.DEVRYAN_AGENT_BROWSER_BIN === 'string'
      ? browserEnvironmentInput.DEVRYAN_AGENT_BROWSER_BIN.trim()
      : '';
    const browserEnvironmentValueCount = [browserDiscoveryUrl, browserToken, agentBrowserBinary]
      .filter(Boolean).length;
    if (browserEnvironmentValueCount !== 0 && browserEnvironmentValueCount !== 3) {
      throw new Error('Managed agent browser discovery URL, token, and binary must be provided together');
    }
    if (browserDiscoveryUrl) {
      const parsedDiscoveryUrl = new URL(browserDiscoveryUrl);
      if (
        parsedDiscoveryUrl.protocol !== 'http:'
        || parsedDiscoveryUrl.hostname !== '127.0.0.1'
        || !parsedDiscoveryUrl.port
        || parsedDiscoveryUrl.pathname !== '/api/desktop/browser-cdp'
        || parsedDiscoveryUrl.search
        || parsedDiscoveryUrl.hash
      ) {
        throw new Error('Managed agent browser discovery must use the private IPv4 loopback endpoint');
      }
      if (!path.isAbsolute(agentBrowserBinary)) {
        throw new Error('Managed agent browser binary path must be absolute');
      }
    }
    const processEnvironment = {
      ...shellEnv,
      ...process.env,
      PATH: envPath,
      ...buildContextModeStorageEnv(),
      OPENCODE_SERVER_PASSWORD: openCodePassword,
      // NOTE: We intentionally do NOT set OPENCODE_DISABLE_DEFAULT_PLUGINS or
      // launch with `--pure`. Both disable required provider/bundled plugin
      // surfaces. The generated runtime overlay is the plugin allowlist owner.
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS || 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      ...(agentRuntimeConfig?.slimPreset
        ? { OH_MY_OPENCODE_SLIM_PRESET: agentRuntimeConfig.slimPreset }
        : {}),
      ...(agentRuntimeConfig?.slimConfigDirectory
        ? { DEVRYAN_OPENCODE_USER_CONFIG_DIR: agentRuntimeConfig.slimConfigDirectory }
        : {}),
      ...(agentRuntimeConfig?.targetConfigDirectory
        ? { OPENCODE_CONFIG_DIR: agentRuntimeConfig.targetConfigDirectory }
        : {}),
    };
    delete processEnvironment.OPENCODE_DISABLE_DEFAULT_PLUGINS;
    delete processEnvironment.OPENCODE_DISABLE_EXTERNAL_SKILLS;
    delete processEnvironment.DEVRYAN_ORCHESTRATION_URL;
    delete processEnvironment.DEVRYAN_ORCHESTRATION_TOKEN;
    delete processEnvironment.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS;
    delete processEnvironment.DEVRYAN_BROWSER_CDP_DISCOVERY_URL;
    delete processEnvironment.DEVRYAN_BROWSER_CDP_TOKEN;
    delete processEnvironment.DEVRYAN_AGENT_BROWSER_BIN;
    delete processEnvironment.DEVRYAN_OPENAI_OAUTH_URL;
    delete processEnvironment.DEVRYAN_OPENAI_OAUTH_TOKEN;
    Object.assign(processEnvironment, await getManagedOAuthEnvironment());
    for (const key of Object.keys(processEnvironment)) {
      if (key.startsWith('AGENT_BROWSER_')) delete processEnvironment[key];
    }
    if (orchestrationUrl) {
      processEnvironment.DEVRYAN_ORCHESTRATION_URL = orchestrationUrl;
      processEnvironment.DEVRYAN_ORCHESTRATION_TOKEN = orchestrationToken;
      if (orchestrationAccountDefaults) {
        processEnvironment.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS = orchestrationAccountDefaults;
      }
    }
    if (browserDiscoveryUrl) {
      processEnvironment.DEVRYAN_BROWSER_CDP_DISCOVERY_URL = browserDiscoveryUrl;
      processEnvironment.DEVRYAN_BROWSER_CDP_TOKEN = browserToken;
      processEnvironment.DEVRYAN_AGENT_BROWSER_BIN = agentBrowserBinary;
    }

    try {
      const serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: processEnvironment,
      });

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      if (await waitForReady(serverInstance.url, 10000)) {
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        return serverInstance;
      }

      try {
        await serverInstance.close();
      } catch {
      }
      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      syncToHmrState();
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await startOpenCodeOnce();
      } catch (error) {
        lastError = error;
        if (
          error?.code === 'OPENCODE_BINARY_INVALID'
          || error?.code === 'PACKAGED_AGENT_SYNC_CONFLICT'
          || isManagedOrchestrationOwnershipError(error)
        ) {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        emitStartupStatus(`Retrying OpenCode startup (attempt ${attempt + 1} of ${START_OPEN_CODE_MAX_ATTEMPTS})…`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  const restartOpenCode = async () => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      if (state.isExternalOpenCode) {
        console.log('Re-probing configured external OpenCode runtime...');
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`Configured external OpenCode runtime on port ${probePort} is healthy`);
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      // Hold admission closed across the full managed-child replacement. The
      // lease runtime invalidates and drains old-epoch acquisition before this
      // returns, then remains paused until the new child is installed.
      const browserLeaseResetHandle = await pauseManagedBrowserLeases('opencode_restart');
      try {
        const portToRelease = state.openCodePort;

        if (state.openCodeProcess) {
          console.log('Stopping existing OpenCode process...');
          try {
            await state.openCodeProcess.close();
          } catch (error) {
            console.warn('Error closing OpenCode process:', error);
          }
          state.openCodeProcess = null;
          syncToHmrState();
        }

        if (!(await waitForPortRelease(portToRelease, 5000))) {
          console.warn(`Timed out waiting for OpenCode port ${portToRelease} to be released`);
        }

        if (env.ENV_CONFIGURED_OPENCODE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
          setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.openCodeApiPrefixDetected = true;
        state.openCodeApiPrefix = '';
        if (state.openCodeApiDetectionTimer) {
          clearTimeout(state.openCodeApiDetectionTimer);
          state.openCodeApiDetectionTimer = null;
        }

        // Sweep the registry on every managed restart: orphans from crashed
        // owners otherwise survive until the next full app launch and race the
        // replacement child on rotating MCP OAuth refresh tokens.
        await reapManagedOpenCodeOrphans();

        state.lastOpenCodeError = null;
        state.openCodeProcess = await startOpenCode();
        syncToHmrState();

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
      } finally {
        await resumeManagedBrowserLeases(browserLeaseResetHandle);
      }
    })();

    try {
      await state.currentRestartPromise;
      try {
        void Promise.resolve(onOpenCodeRestarted()).catch((error) => {
          console.warn(`OpenCode restart callback failed: ${error?.message || error}`);
        });
      } catch (error) {
        console.warn(`OpenCode restart callback failed: ${error?.message || error}`);
      }
    } catch (error) {
      console.error(`Failed to restart OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      if (!env.ENV_CONFIGURED_OPENCODE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const [configResult, agentResult] = await Promise.all([
          fetch(buildOpenCodeUrl('/config', ''), {
            method: 'GET',
            headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          }).catch((error) => error),
          fetch(buildOpenCodeUrl('/agent', ''), {
            method: 'GET',
            headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          }).catch((error) => error),
        ]);

        if (configResult instanceof Error) {
          lastError = configResult;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        if (!configResult.ok) {
          lastError = new Error(`OpenCode config endpoint responded with status ${configResult.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        await configResult.json().catch(() => null);

        if (agentResult instanceof Error) {
          lastError = agentResult;
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        if (!agentResult.ok) {
          lastError = new Error(`Agent endpoint responded with status ${agentResult.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        await agentResult.json().catch(() => []);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300, expected = {}) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const expectedModelRef = typeof expected.expectedAgentModelRef === 'string'
      ? expected.expectedAgentModelRef.trim()
      : '';
    const expectVariant = Object.prototype.hasOwnProperty.call(expected, 'expectedAgentVariant');
    const expectedVariant = normalizeAgentVariant(expected.expectedAgentVariant);
    const deadline = Date.now() + timeoutMs;
    let lastSeenAgent = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });

        if (response.ok) {
          const agents = await response.json();
          const agent = Array.isArray(agents)
            ? agents.find((entry) => entry?.name === agentName)
            : null;
          if (agent) {
            lastSeenAgent = agent;
            const loadedModelRef = normalizeAgentModelRef(agent);
            const loadedVariant = normalizeAgentVariant(agent.variant);
            const modelMatches = !expectedModelRef || loadedModelRef === expectedModelRef;
            const variantMatches = agentVariantMatches({
              expectVariant,
              expectedModelRef,
              expectedVariant,
              loadedModelRef,
              loadedVariant,
            });
            if (modelMatches && variantMatches) {
              return;
            }
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastSeenAgent && expectedModelRef) {
      const loadedModelRef = normalizeAgentModelRef(lastSeenAgent) || 'unknown';
      const loadedVariant = normalizeAgentVariant(lastSeenAgent.variant);
      const variantMatches = agentVariantMatches({
        expectVariant,
        expectedModelRef,
        expectedVariant,
        loadedModelRef,
        loadedVariant,
      });
      const variantSuffix = !variantMatches
        ? ` and variant "${loadedVariant || '(none)'}"; expected variant "${expectedVariant || '(none)'}"`
        : '';
      throw new Error(`Agent "${agentName}" loaded with model "${loadedModelRef}"${variantSuffix}; expected "${expectedModelRef}"`);
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const applyOpenCodeConfigChanges = async ({ scopes = [], changes = [] } = {}) => {
    const options = [...changes]
      .reverse()
      .map((entry) => entry?.metadata)
      .find((metadata) => metadata && typeof metadata === 'object') || {};
    const { agentName, expectedAgentModelRef, expectedAgentVariant } = options;
    const agentReadyTimeoutMs = Number.isFinite(options.agentReadyTimeoutMs) && options.agentReadyTimeoutMs > 0
      ? Math.trunc(options.agentReadyTimeoutMs)
      : 15000;
    const agentReadyIntervalMs = Number.isFinite(options.agentReadyIntervalMs) && options.agentReadyIntervalMs > 0
      ? Math.trunc(options.agentReadyIntervalMs)
      : 300;

    console.log(`Applying saved OpenCode configuration scopes: ${scopes.join(', ') || 'runtime'}`);
    if (state.isExternalOpenCode || env.ENV_SKIP_OPENCODE_START) {
      throw new Error('DevRyan cannot restart a configured external OpenCode runtime');
    }

    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode();

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      if (agentName) {
        await waitForAgentPresence(agentName, agentReadyTimeoutMs, agentReadyIntervalMs, {
          expectedAgentModelRef,
          ...(Object.prototype.hasOwnProperty.call(options, 'expectedAgentVariant') ? { expectedAgentVariant } : {}),
        });
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
      return {
        runtimeApplied: true,
        requiresReload: false,
      };
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error('Failed to apply saved OpenCode configuration:', error.message);
      throw error;
    }
  };

  const bootstrapOpenCodeAtStartup = async () => {
    try {
      await reapManagedOpenCodeOrphansOnce();
      syncFromHmrState();
      if (await isOpenCodeProcessHealthy()) {
        const syncResult = await syncManagedAgentRuntimeConfig();
        if (syncResult?.changed) {
          console.log('[HMR] Managed agent runtime config changed; restarting reused OpenCode process');
          await restartOpenCode();
        } else {
          console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
        }
      } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using configured external OpenCode runtime at ${label} (skip-start mode)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using configured external OpenCode runtime at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_SKIP_OPENCODE_START && !env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(4096)) {
        console.log('Using configured external OpenCode runtime at http://localhost:4096 (skip-start mode)');
        setOpenCodePort(4096);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_SKIP_OPENCODE_START) {
        console.log('OpenCode skip-start enabled; not launching managed OpenCode server');
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.isExternalOpenCode = false;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        return;
      } else {
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.lastOpenCodeError = null;
        state.openCodeProcess = await startOpenCode();
        syncToHmrState();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * A managed child that has actually exited is safe to restart immediately.
   * A live child reporting busy is never killed on a health timeout because
   * long-running model/tool work can starve the health endpoint.
   */
  const shouldPreserveBusyProcessAfterHealthFailure = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      return false;
    }

    if (hasChildProcessExited(state.openCodeProcess)) {
      return false;
    }

    console.warn(`[lifecycle] OpenCode health check failed with ${activeCount} busy session(s); preserving the live process`);
    return true;
  };

  const triggerHealthCheck = async () => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;

    try {
      const healthy = await isOpenCodeProcessHealthy();
      if (!healthy) {
        if (shouldPreserveBusyProcessAfterHealthFailure()) return;
        console.log('[lifecycle] immediate health check: OpenCode not healthy, restarting...');
        await restartOpenCode();
      }
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    state.healthCheckInterval = setInterval(async () => {
      if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;

      try {
        const healthy = await isOpenCodeProcessHealthy();
        if (!healthy) {
          if (shouldPreserveBusyProcessAfterHealthFailure()) return;
          console.log('OpenCode process not running, restarting...');
          await restartOpenCode();
        }
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, healthCheckIntervalMs);
  };

  const contextModeRecovery = createContextModeRecovery({
    restartOpenCode,
    getActiveSessionCount: getAuthoritativeActiveSessionCount,
    isExternalOpenCode: () => state.isExternalOpenCode || Boolean(env.ENV_SKIP_OPENCODE_START),
    acquireAdmissionHold: acquireContextModeAdmissionHold,
    recordIncident: recordContextModeRecoveryIncident,
  });

  return {
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    applyOpenCodeConfigChanges,
    // Settings routes that only change the runtime overlay (agent-runtime
    // switches) re-run the same sync a start does, without restarting.
    syncManagedAgentRuntimeConfig,
    bootstrapOpenCodeAtStartup,
    startHealthMonitoring,
    triggerHealthCheck,
    killProcessOnPort,
    waitForPortRelease,
    observeContextModeToolFailure: contextModeRecovery.observeContextModeToolFailure,
    getContextModeRecoveryStatus: contextModeRecovery.getStatus,
  };
};

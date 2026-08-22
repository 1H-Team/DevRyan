import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { type OpenCodeManager } from './opencode';
import { handleStandardGitBridgeMessage } from './bridge-git-runtime';
import { handleSpecialGitBridgeMessage } from './bridge-git-special-runtime';
import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { handleConfigBridgeMessage } from './bridge-config-runtime';
import { handleDiagnosticsBridgeMessage } from './bridge-diagnostics-runtime';
import { handleEvidenceBridgeMessage } from './bridge-evidence-runtime';
import { getVsCodeCursorSdkRuntime, handleSystemBridgeMessage } from './bridge-system-runtime';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import { handleManagedOrchestrationBridgeMessage } from './bridge-orchestration-runtime';
import type { VsCodeManagedOrchestrationRuntime } from './managedOrchestrationRuntime';
import { createGlobalAgentsMdRuntime } from './globalAgentsMdRuntime';
import {
  fetchOpenCodeSkillsFromApi,
  persistSettings,
  readSettings,
  readMagicPromptOverrides,
  saveMagicPromptOverride,
  resetMagicPromptOverride,
  resetAllMagicPromptOverrides,
} from './bridge-settings-runtime';
import { execGit } from './bridge-git-process-runtime';
import {
  parseDroppedFileReference,
  readUriAsAttachment,
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  searchDirectory,
  resolveFileReadPath,
  resolveFileMutationPath,
  resolveExecCwdPath,
  fetchModelsMetadata,
} from './bridge-fs-helpers-runtime';
import {
  tryHandleLocalFsProxy,
  buildUnavailableApiResponse,
  sanitizeForwardHeaders,
  collectHeaders,
  base64EncodeUtf8,
} from './bridge-localfs-proxy-runtime';
import { createOpenCodeUpdateRuntime } from '../../web/server/lib/opencode/opencode-update-runtime.js';
import { handleConfigApplyBridgeMessage, markVsCodeConfigChange } from './configApplyRuntime';
import {
  getXaiPromptToolOverrides,
  refreshXaiProviderPayload,
  refreshXaiToolModel,
  supportsXaiProvider,
} from './xaiToolCatalogRuntime';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
  errorData?: unknown;
}

export interface BridgeContext {
  manager?: OpenCodeManager;
  context?: vscode.ExtensionContext;
  managedOrchestrationRuntime?: VsCodeManagedOrchestrationRuntime;
  postMessage?: (message: unknown) => void | Promise<void>;
}

const GITHUB_LATEST_RELEASE_API_URL = 'https://api.github.com/repos/1H-Team/DevRyan/releases/latest';
const COMPATIBILITY_UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL;
const UPDATE_CHECK_URL = COMPATIBILITY_UPDATE_CHECK_URL || GITHUB_LATEST_RELEASE_API_URL;
const GITHUB_BACKEND_DISABLED_ERROR = 'DevRyan VS Code backend GitHub integration is disabled. Use native VS Code GitHub integrations.';
const openCodeUpdateRuntime = createOpenCodeUpdateRuntime();


export async function handleBridgeMessage(message: BridgeRequest, ctx?: BridgeContext): Promise<BridgeResponse> {
  const { id, type, payload } = message;

  try {
    const orchestrationResponse = await handleManagedOrchestrationBridgeMessage(
      message,
      ctx?.managedOrchestrationRuntime,
    );
    if (orchestrationResponse) {
      return orchestrationResponse;
    }
    const standardGitResponse = await handleStandardGitBridgeMessage({ id, type, payload });
    if (standardGitResponse) {
      return standardGitResponse;
    }
    const specialGitResponse = await handleSpecialGitBridgeMessage(
      { id, type, payload },
      ctx,
      { readSettings, execGit }
    );
    if (specialGitResponse) {
      return specialGitResponse;
    }
    const fsResponse = await handleFsBridgeMessage(
      { id, type, payload },
      {
        resolveUserPath,
        listDirectoryEntries,
        normalizeFsPath,
        execGit,
        searchDirectory,
        resolveFileReadPath,
        resolveFileMutationPath,
        resolveExecCwdPath,
        parseDroppedFileReference,
        readUriAsAttachment,
      }
    );
    if (fsResponse) {
      return fsResponse;
    }
    const diagnosticsResponse = await handleDiagnosticsBridgeMessage({ id, type, payload });
    if (diagnosticsResponse) {
      return diagnosticsResponse;
    }
    const evidenceResponse = await handleEvidenceBridgeMessage({ id, type, payload });
    if (evidenceResponse) {
      return evidenceResponse;
    }
    const configApplyResponse = await handleConfigApplyBridgeMessage(message, ctx);
    if (configApplyResponse) {
      return configApplyResponse;
    }
    const configResponse = await handleConfigBridgeMessage(
      { id, type, payload },
      ctx,
      {
        readSettings,
        persistSettings,
        readMagicPromptOverrides,
        saveMagicPromptOverride,
        resetMagicPromptOverride,
        resetAllMagicPromptOverrides,
        fetchOpenCodeSkillsFromApi,
        markConfigChange: (reason, metadata, changed) => markVsCodeConfigChange(
          ctx,
          reason,
          metadata,
          changed,
        ),
        getGlobalAgentsMdRuntime: (context) => createGlobalAgentsMdRuntime({
          agentsMdPath: path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
          refreshRuntime: ({ changed } = {}) => markVsCodeConfigChange(
            context,
            'global behavior (AGENTS.md) updated',
            {},
            changed !== false,
          ),
          isEditable: () => context?.manager?.getDebugInfo()?.mode !== 'external',
        }),
        checkForOpenCodeUpdates: (input) => openCodeUpdateRuntime.checkForUpdates(input),
      },
    );
    if (configResponse) {
      return configResponse;
    }
    const systemResponse = await handleSystemBridgeMessage(
      { id, type, payload },
      ctx,
      {
        resolveUserPath,
        fetchModelsMetadata,
        updateCheckUrl: UPDATE_CHECK_URL,
        updateCheckUsesCompatibilityContract: Boolean(COMPATIBILITY_UPDATE_CHECK_URL),
        markConfigChange: (reason, metadata, changed) => markVsCodeConfigChange(
          ctx,
          reason,
          metadata,
          changed,
        ),
      },
    );
    if (systemResponse) {
      return systemResponse;
    }
    const proxyResponse = await handleProxyBridgeMessage(
      { id, type, payload },
      ctx,
      {
        tryHandleLocalFsProxy,
        buildUnavailableApiResponse,
        sanitizeForwardHeaders,
        collectHeaders,
        base64EncodeUtf8,
        getCachedCursorProvider: () => getVsCodeCursorSdkRuntime().getCachedVirtualProvider(),
        refreshCursorProvider: async () => {
          await getVsCodeCursorSdkRuntime().refreshVirtualProvider({ reason: 'providers_route' });
        },
        getXaiPromptToolOverrides,
        supportsXaiProvider,
        refreshXaiProviderPayload,
        refreshXaiToolModel,
      },
    );
    if (proxyResponse) {
      return proxyResponse;
    }

    switch (type) {
      case 'api:github/auth:status':
      case 'api:github/auth:start':
      case 'api:github/auth:complete':
      case 'api:github/auth:disconnect':
      case 'api:github/auth:activate':
      case 'api:github/me':
      case 'api:github/pr:status':
      case 'api:github/pr:create':
      case 'api:github/pr:update':
      case 'api:github/pr:merge':
      case 'api:github/pr:ready':
      case 'api:github/issues:list':
      case 'api:github/issues:get':
      case 'api:github/issues:comments':
      case 'api:github/pulls:list':
      case 'api:github/pulls:context':
      case 'api:github/repo:upstream':
      case 'api:github/repo:branches': {
        return { id, type, success: false, error: GITHUB_BACKEND_DISABLED_ERROR };
      }

      default:
        return { id, type, success: false, error: `Unknown message type: ${type}` };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const operationError = err as {
      operationId?: unknown;
      bootstrap?: unknown;
    };
    const errorData = (
      typeof operationError?.operationId === 'string'
      || (operationError?.bootstrap !== null && typeof operationError?.bootstrap === 'object')
    ) ? {
        ...(typeof operationError.operationId === 'string'
          ? { operationId: operationError.operationId }
          : {}),
        ...(operationError.bootstrap !== null && typeof operationError.bootstrap === 'object'
          ? { bootstrap: operationError.bootstrap }
          : {}),
      } : undefined;
    return { id, type, success: false, error: errorMessage, ...(errorData ? { errorData } : {}) };
  }
}

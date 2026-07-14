import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { type OpenCodeManager } from './opencode';
import { handleStandardGitBridgeMessage } from './bridge-git-runtime';
import { handleSpecialGitBridgeMessage } from './bridge-git-special-runtime';
import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { handleConfigBridgeMessage } from './bridge-config-runtime';
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
}

export interface BridgeContext {
  manager?: OpenCodeManager;
  context?: vscode.ExtensionContext;
  managedOrchestrationRuntime?: VsCodeManagedOrchestrationRuntime;
  postMessage?: (message: unknown) => void | Promise<void>;
}

const CLIENT_RELOAD_DELAY_MS = 800;

const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';
const GITHUB_BACKEND_DISABLED_ERROR = 'DevRyan VS Code backend GitHub integration is disabled. Use native VS Code GitHub integrations.';


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
        clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
        getGlobalAgentsMdRuntime: (context) => createGlobalAgentsMdRuntime({
          agentsMdPath: path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md'),
          refreshRuntime: async () => {
            await context?.manager?.restart();
          },
          isEditable: () => context?.manager?.getDebugInfo()?.mode !== 'external',
        }),
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
        clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
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
    return { id, type, success: false, error: errorMessage };
  }
}

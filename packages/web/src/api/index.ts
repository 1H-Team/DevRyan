import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { createWebTerminalAPI } from './terminal';
import { createWebGitAPI } from './git';
import { createWebFilesAPI } from './files';
import { createWebSettingsAPI } from './settings';
import { createWebPermissionsAPI } from './permissions';
import { createWebNotificationsAPI } from './notifications';
import { createWebToolsAPI } from './tools';
import { createWebPushAPI } from './push';
import { createWebGitHubAPI } from './github';
import { createWebDiagnosticsAPI } from './diagnostics';
import { createWebEvidenceAPI } from './evidence';
import { createWebProcessesAPI } from './processes';
import { createWebSessionPlansAPI } from './sessionPlans';
import { createWebContextUsageAPI } from './contextUsage';

export const createWebAPIs = (): RuntimeAPIs => ({
  runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: 'web' },
  terminal: createWebTerminalAPI(),
  git: createWebGitAPI(),
  files: createWebFilesAPI(),
  sessionPlans: createWebSessionPlansAPI(),
  settings: createWebSettingsAPI(),
  permissions: createWebPermissionsAPI(),
  notifications: createWebNotificationsAPI(),
  github: createWebGitHubAPI(),
  push: createWebPushAPI(),
  diagnostics: createWebDiagnosticsAPI(),
  evidence: createWebEvidenceAPI(),
  processes: createWebProcessesAPI(),
  contextUsage: createWebContextUsageAPI(),
  tools: createWebToolsAPI(),
});

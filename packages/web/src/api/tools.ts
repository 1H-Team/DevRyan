import type { ToolsAPI } from '@openchamber/ui/lib/api/types';
import { buildToolManifest, normalizeToolIds } from '../../../ui/src/lib/tools/manifest';

type ToolsAPIOptions = {
  getDirectory?: () => string | null | undefined;
};

const fetchAvailableTools = async (): Promise<string[]> => {
  const response = await fetch('/api/experimental/tool/ids');

  if (!response.ok) {
    throw new Error(`Tools API returned ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error('Tools API returned invalid data format');
  }

  return normalizeToolIds(data);
};

export const createWebToolsAPI = (options: ToolsAPIOptions = {}): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    return fetchAvailableTools();
  },

  async getToolManifest() {
    return buildToolManifest({
      toolIds: await fetchAvailableTools(),
      sourceRuntime: 'web',
      directory: options.getDirectory?.() ?? null,
    });
  },
});

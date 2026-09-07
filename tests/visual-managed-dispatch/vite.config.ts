import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()],
  resolve: { alias: [
    { find: /^@opencode-ai\/sdk\/v2$/, replacement: '@opencode-ai/sdk/v2/client' },
    { find: '@openchamber/orchestration-runtime', replacement: path.resolve(root, '../../packages/orchestration-runtime/index.js') },
    { find: '@/sync/sync-context', replacement: path.join(root, 'fixture-sync.ts') },
    { find: '@', replacement: path.resolve(root, '../../packages/ui/src') },
  ] },
  server: { host: '127.0.0.1', port: 4191, strictPort: true, watch: { ignored: ['**/.tmp/**'] } },
});

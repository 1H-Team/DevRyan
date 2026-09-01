import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()],
  resolve: { alias: [
    { find: '@/lib/primaryRecoveryApi', replacement: path.join(root, 'fixture-api.ts') },
    { find: '@', replacement: path.resolve(root, '../../packages/ui/src') },
  ] },
  server: { host: '127.0.0.1', port: 4189, strictPort: true, watch: { ignored: ['**/.tmp/**'] } },
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()], resolve: { alias: [
    { find: '@/sync/session-ui-store', replacement: path.join(root, 'session-host.ts') },
    { find: '@', replacement: path.resolve(root, '../../packages/ui/src') },
] }, server: { host: '127.0.0.1', port: 4191, strictPort: true } });

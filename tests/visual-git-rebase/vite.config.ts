import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root, plugins: [react()], define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: JSON.stringify('fixture') }, resolve: { alias: {
    '@opencode-ai/sdk/v2': path.resolve(root, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js'),
    '@': path.resolve(root, '../../packages/ui/src'),
} }, server: { host: '127.0.0.1', port: 4198, strictPort: true } });

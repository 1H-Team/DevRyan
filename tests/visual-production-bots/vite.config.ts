import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '../..');

export default defineConfig({
  root: directory,
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@opencode-ai/sdk/v2',
        replacement: path.join(repositoryRoot, 'node_modules/@opencode-ai/sdk/dist/v2/client.js'),
      },
      { find: '@openchamber/ui', replacement: path.join(repositoryRoot, 'packages/ui/src') },
      { find: '@', replacement: path.join(repositoryRoot, 'packages/ui/src') },
    ],
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify('visual-fixture'),
  },
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
  },
  build: {
    outDir: path.join(directory, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
    },
  },
});

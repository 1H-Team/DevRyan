import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    root,
    cacheDir: path.resolve(root, '../../.cache/qa/chat-improvements-vite'),
    plugins: [{ name: 'fixture-rich-diff-failure', enforce: 'pre',
        transform(code, id) {
            if (id.endsWith('/message/parts/ToolPart.tsx')) {
                return code.replace("from '@pierre/diffs/react'", "from '@fixture/rich-diff'");
            }
        },
    }, react()],
    define: { 'process.env': {}, global: 'globalThis', __APP_VERSION__: JSON.stringify('chat-improvements-fixture') },
    resolve: { alias: [
        { find: '@fixture/rich-diff', replacement: path.join(root, 'rich-diff.jsx') },
        { find: '@/hooks/useEffectiveDirectory', replacement: path.join(root, 'directory-context.ts') },
        { find: '@opencode-ai/sdk/v2', replacement: path.resolve(root, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js') },
        { find: '@openchamber/ui', replacement: path.resolve(root, '../../packages/ui/src') },
        { find: '@', replacement: path.resolve(root, '../../packages/ui/src') },
    ] },
    server: { host: '127.0.0.1', port: 4197, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
});

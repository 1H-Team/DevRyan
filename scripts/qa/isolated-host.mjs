import './isolated-home.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const runtimeRoot = process.env.DEVRYAN_QA_RUNTIME_ROOT;
const runtime = process.env.DEVRYAN_QA_RUNTIME;
if (!runtimeRoot || !['web', 'electron'].includes(runtime)) throw new Error('QA runtime root and web/electron runtime are required');
const privateEnvironment = JSON.parse(await readFile(path.join(runtimeRoot, 'credentials.env.json'), 'utf8'));
for (const [key, value] of Object.entries(privateEnvironment)) {
    if (!['MERIDIAN_PROFILES', 'MERIDIAN_DEFAULT_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(key) || typeof value !== 'string') {
        throw new Error('Unexpected private QA credential environment field');
    }
    process.env[key] = value;
}

if (runtime === 'electron') {
    const { app } = await import('electron');
    const logs = path.join(runtimeRoot, 'logs');
    await mkdir(logs, { recursive: true, mode: 0o700 });
    app.setPath('home', process.env.DEVRYAN_QA_HOME);
    app.setAppLogsPath(logs);
    await import('../../packages/electron/main.mjs');
} else {
    process.chdir(repositoryRoot);
    const { startWebUiServer } = await import('../../packages/web/server/index.js');
    const server = await startWebUiServer({ host: '127.0.0.1', port: Number(process.env.OPENCHAMBER_PORT), attachSignals: true });
    await writeFile(path.join(runtimeRoot, 'ready.json'), JSON.stringify({
        origin: `http://127.0.0.1:${server.getPort()}`,
        opencodePort: server.getOpenCodePort(),
        managedOrchestration: server.getManagedOrchestrationDiagnostics(),
    }, null, 2), { mode: 0o600 });
}

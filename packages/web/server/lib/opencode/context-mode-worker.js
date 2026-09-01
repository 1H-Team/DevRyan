import { parentPort, workerData } from 'node:worker_threads';

if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== '1'
  || process.env.CONTEXT_MODE_PROJECT_DIR !== workerData.projectDir) {
  throw new Error('Context Mode worker environment isolation is unavailable');
}

// The executor reports children as soon as they spawn, including detached
// background commands. The host retains their lifecycle if this worker fails.
globalThis[Symbol.for('devryan.context-mode.process')] = (event) => {
  parentPort.postMessage({ type: 'process', ...event });
};
const ready = import('./server.js');
let active = false;
parentPort.on('message', async (request) => {
  if (request?.type === 'close') {
    if (active) return;
    const mod = await ready;
    mod.devryanCloseWorker();
    parentPort.postMessage({ type: 'closed' });
    parentPort.close();
    return;
  }
  if (request?.type !== 'execute') return;
  try {
    if (active || request.projectDir !== workerData.projectDir || request.scope !== workerData.scope
      || typeof request.sessionId !== 'string' || !request.sessionId) {
      throw new Error('invalid worker scope or concurrent dispatch');
    }
    active = true;
    const mod = await ready;
    const registered = mod.REGISTERED_CTX_TOOLS.find((tool) => tool.name === request.name);
    if (!registered) throw new Error('unknown Context Mode tool');
    const result = await mod.withProjectDirOverride({ projectDir: request.projectDir, sessionId: request.sessionId },
      () => registered.handler(request.args));
    parentPort.postMessage({ type: 'result', id: request.id, result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: request.id,
      error: typeof error?.message === 'string' ? error.message : 'tool execution failed; outcome may be unknown' });
  } finally {
    active = false;
  }
});

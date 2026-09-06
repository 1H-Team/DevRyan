import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { waitForQaHostReady } from './host-readiness.mjs';

const serve = async (handler, action) => {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await action(origin); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
};

test('retries a stalled health request and startup503 without blocking the renderer', async () => {
  let calls = 0;
  await serve((_req, res) => {
    calls++;
    if (calls === 1) return;
    if (calls === 2) { res.writeHead(503).end(); return; }
    res.end(JSON.stringify({ isOpenCodeReady: true, openCodeVersion: 'fixture' }));
  }, async origin => {
    const ready = await waitForQaHostReady({ origin, timeoutMs: 1000, requestTimeoutMs: 30, intervalMs: 5 });
    assert.deepEqual(ready, { origin, openCodeVersion: 'fixture' });
    // Scheduling can expire another short request while the host is ready;
    // the contract is recovery after both forced failures within the deadline.
    assert.ok(calls >= 3);
  });
});

test('finds the packaged host origin from its actual CDP page and fails on permanent errors', async () => {
  await serve((req, res) => {
    if (req.url === '/json/list') {
      res.end(JSON.stringify([{ type: 'page', url: `http://${req.headers.host}/?session=test` }])); return;
    }
    res.writeHead(401).end();
  }, async origin => {
    await assert.rejects(waitForQaHostReady({ debugPort: Number(new URL(origin).port), timeoutMs: 1000, requestTimeoutMs: 30 }), /HTTP 401/);
  });
});

test('Bun retries its ConnectionRefused startup error until the owned host listens', async () => {
  const script = `
    import http from 'node:http';
    import { waitForQaHostReady } from ${JSON.stringify(new URL('./host-readiness.mjs', import.meta.url).href)};
    const server = http.createServer((_req,res)=>res.end(JSON.stringify({isOpenCodeReady:true,openCodeVersion:'fixture'})));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    await new Promise(resolve=>server.close(resolve));
    const origin='http://127.0.0.1:'+port;
    let initialCode;
    try { await fetch(origin); } catch(error) { initialCode=error.code; }
    const ready=waitForQaHostReady({origin,timeoutMs:1500,requestTimeoutMs:50,intervalMs:5});
    setTimeout(()=>server.listen(port,'127.0.0.1'),100);
    try { console.log(JSON.stringify({initialCode,...await ready})); }
    finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  `;
  const { stdout } = await promisify(execFile)('bun', ['--eval', script], { timeout: 5000 });
  const result = JSON.parse(stdout);
  assert.equal(result.initialCode, 'ConnectionRefused');
  assert.equal(result.openCodeVersion, 'fixture');
});

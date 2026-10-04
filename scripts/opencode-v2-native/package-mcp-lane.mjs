import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** Loopback MCP responses are fixture data. The compiled native MCP service,
 * original tool registry and actual host control ledger execute the calls. */
export async function createCompiledMcpLane() {
  const sockets = new Set(), calls = [], methods = [];
  let firstFailure, closed = false;
  const check = () => { if (firstFailure) throw firstFailure; };
  const server = createServer((request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    void (async () => {
      assert.equal(closed, false); assert.equal(request.url, '/mcp');
      assert.equal(request.headers.authorization, undefined, 'MCP fixture received an unexpected credential');
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.write(': compiled MCP fixture\n\n'); return;
      }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
      assert.equal(request.method, 'POST');
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 65536); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.jsonrpc, '2.0'); assert.equal(typeof input.method, 'string'); methods.push(input.method);
      if (input.id === undefined) { assert.equal(input.method, 'notifications/initialized'); response.writeHead(202).end(); return; }
      let result;
      if (input.method === 'initialize') result = { protocolVersion: input.params.protocolVersion,
        capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'compiled-owned-mcp', version: '1' } };
      else if (input.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Return an exact owned fixture value',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] };
      else if (input.method === 'tools/call') {
        assert.equal(input.params.name, 'lookup'); assert.deepEqual(Object.keys(input.params.arguments), ['value']);
        assert.match(input.params.arguments.value, /^compiled-location-(one|two)$/); assert.ok(calls.length < 2);
        calls.push({ requestID: input.id, value: input.params.arguments.value });
        result = { content: [{ type: 'text', text: `owned MCP result ${input.params.arguments.value}` }], isError: false };
      } else if (input.method === 'prompts/list') result = { prompts: [] };
      else if (input.method === 'resources/list') result = { resources: [] };
      else if (input.method === 'resources/templates/list') result = { resourceTemplates: [] };
      else throw new Error(`Unexpected fixture MCP method: ${input.method}`);
      json(200, { jsonrpc: '2.0', id: input.id, result });
    })().catch(error => { firstFailure ??= error; if (!response.headersSent) json(500, { error: 'Owned MCP fixture failed' }); else response.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const configuration = { compiled: { type: 'remote', url: `http://127.0.0.1:${server.address().port}/mcp`, oauth: false, enabled: true, timeout: 10000 } };
  return { configuration, check,
    async run({ invoke, directory, secondDirectory, secondSessionID }) {
      assert.notEqual(directory, secondDirectory);
      for (const [name, options] of [['one', {}], ['two', { directory: secondDirectory, sessionID: secondSessionID }]]) {
        check(); const value = `compiled-location-${name}`;
        const call = await invoke({ id: `compiled-remote-mcp-${name}`, tool: 'compiled_lookup', control: true, input: { value } }, options);
        assert.equal(call.state.status, 'completed'); assert.ok(call.state.output.includes(`owned MCP result ${value}`));
        check(); assert.equal(calls.filter(row => row.value === value).length, 1, 'MCP tool executed more than once');
      }
      assert.equal(calls.length, 2); assert.ok(methods.includes('initialize')); assert.ok(methods.includes('tools/list'));
      return { id: 'compiled-remote-mcp-two-locations', status: 'passed', calls: calls.length,
        source: 'compiled-native-mcp-original-registry-actual-http-and-host-control-ledger', oauth: 'separate-native-graph-qualification' };
    },
    async close() {
      if (closed) return; closed = true;
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy(); await stopped; check();
    },
  };
}

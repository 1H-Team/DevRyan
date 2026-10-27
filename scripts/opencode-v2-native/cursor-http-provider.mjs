import http from 'node:http';

// Exact pinned @cursor/sdk 1.0.28 protobuf wire fields: AgentServerMessage
// interaction_update=1; InteractionUpdate text_delta=1, turn_ended=14;
// TextDeltaUpdate text=1. The actual SDK decodes and persists these replies.
const bytesField = (number, bytes) => {
  const length = [];
  for (let value = bytes.length; ; value >>>= 7) {
    length.push((value & 127) | (value > 127 ? 128 : 0));
    if (value <= 127) break;
  }
  return Buffer.concat([Buffer.from([number * 8 + 2, ...length]), bytes]);
};
const frame = (bytes, flags = 0) => {
  const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
};
const interaction = (number, bytes) => frame(bytesField(1, bytesField(number, bytes)));

/** Loopback responses only. No SDK events, Agent implementation, or process
 * receipt is replaced. Request payloads and authorization headers stay private. */
export async function createCursorHttpProvider({ onRequest = () => {}, text = 'Owned Cursor transport reply', hold = false, expectedApiKey,
  models = [{ id: 'composer', displayName: 'Owned Composer' }] } = {}) {
  const sockets = new Set(), streams = new Set();
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    let size = 0;
    for await (const bytes of request) {
      size += bytes.length;
      if (size > 4 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
    }
    const selectedCredentialObserved = ['/auth/exchange_user_api_key', '/v1/me'].includes(pathname) && expectedApiKey
      ? request.headers.authorization === `Bearer ${expectedApiKey()}` : undefined;
    onRequest({ pathname, requestBytes: size, ...(selectedCredentialObserved === undefined ? {} : { selectedCredentialObserved }) });
    if (pathname === '/auth/exchange_user_api_key') {
      if (selectedCredentialObserved === false) { response.writeHead(401);response.end();return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accessToken: 'owned-loopback-access-token' })); return;
    }
    if (pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: models })); return;
    }
    if (pathname === '/v1/me') {
      if (selectedCredentialObserved === false) { response.writeHead(401); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ apiKeyName: 'Owned loopback account', userId: 1,
        userEmail: 'owned@example.invalid', createdAt: '2026-01-01T00:00:00.000Z' })); return;
    }
    if (pathname === '/agent.v1.AgentService/RunSSE') {
      response.writeHead(200, { 'content-type': 'application/connect+proto' });
      streams.add(response); response.on('close', () => streams.delete(response));
      return;
    }
    if (pathname === '/aiserver.v1.BidiService/BidiAppend') {
      response.writeHead(200, { 'content-type': 'application/proto' }); response.end();
      for (const stream of streams) {
        stream.write(interaction(1, bytesField(1, Buffer.from(text))));
        if (!hold) { stream.write(interaction(14, Buffer.alloc(0))); stream.end(frame(Buffer.from('{}'), 2)); }
      }
      return;
    }
    if (/\/(GetServerConfig|GetUserPrivacyMode|GetTeamAdminSettingsOrEmptyIfNotInTeam|BootstrapStatsig|UpdateConversationMetadata|TrackEvents)$/.test(pathname)) {
      response.writeHead(200, { 'content-type': 'application/proto' }); response.end(); return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'unimplemented', message: 'owned_cursor_route_unexpected' }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseURL: `http://127.0.0.1:${server.address().port}`,
    release() { for (const response of streams) { response.write(interaction(14, Buffer.alloc(0))); response.end(frame(Buffer.from('{}'), 2)); } },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

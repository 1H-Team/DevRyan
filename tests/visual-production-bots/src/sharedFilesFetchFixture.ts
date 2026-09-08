// Install before components import the default Bots API, which captures fetch.
// This fixture owns only the Shared inventory endpoint; all other requests pass through.
const fetchOutsideFixture = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const match = new URL(address, location.href).pathname.match(/^\/api\/bots\/([^/]+)\/channels\/([^/]+)\/shared-files$/);
  if (!match) return fetchOutsideFixture(input, init);
  const sharedFiles = new URLSearchParams(location.search).get('state') === 'computer_shown' ? [{
    id: 'visual-shared-file', botId: match[1], channelId: match[2], objectId: null, messageId: null,
    senderUserId: null, direction: 'bot', filename: 'lunar-explorer.png', contentType: 'image/png',
    sha256: null, size: 204800, computerPath: '/workspace/Shared/lunar-explorer.png', copyState: 'ready',
    errorCode: null, createdAt: '2026-09-07T12:00:00Z', updatedAt: '2026-09-07T12:00:00Z',
  }] : [];
  return new Response(JSON.stringify({ sharedFiles }), { headers: { 'Content-Type': 'application/json' } });
};

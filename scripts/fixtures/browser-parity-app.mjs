const portFlagIndex = process.argv.indexOf('--port');
const requestedPort = portFlagIndex >= 0 ? Number.parseInt(process.argv[portFlagIndex + 1] || '', 10) : 41739;
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 41739;

const html = (page) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Browser parity fixture · ${page}</title>
    <link rel="stylesheet" href="/fixture.css">
  </head>
  <body>
    <main>
      <p class="eyebrow">DevRyan browser parity fixture</p>
      <h1>${page === 'home' ? 'Host-routed project app' : 'History restored across navigation'}</h1>
      <article id="inspect-card" data-testid="inspect-card">
        <strong>Selectable element</strong>
        <span>This card is used to verify hover highlighting and screenshot annotation.</span>
      </article>
      <nav>
        <a href="${page === 'home' ? '/page-two' : '/'}">${page === 'home' ? 'Open page two' : 'Return home'}</a>
        <button id="emit" type="button">Emit console events</button>
      </nav>
      <dl>
        <div><dt>API</dt><dd id="api-status">waiting</dd></div>
        <div><dt>WebSocket</dt><dd id="ws-status">connecting</dd></div>
        <div><dt>Cookie</dt><dd id="cookie-status">waiting</dd></div>
      </dl>
    </main>
    <script src="/fixture.js"></script>
  </body>
</html>`;

const css = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; background: #0d1321; color: #f8fafc; }
main { width: min(720px, calc(100% - 48px)); margin: 0 auto; padding: 64px 0; }
.eyebrow { color: #7dd3fc; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
h1 { margin: 10px 0 28px; font-size: clamp(32px, 6vw, 56px); line-height: 1.02; }
#inspect-card { display: grid; gap: 8px; border: 1px solid #38bdf8; border-radius: 18px; padding: 24px; background: #172033; box-shadow: 0 18px 50px #0006; }
#inspect-card strong { color: #bae6fd; font-size: 20px; }
#inspect-card span { color: #cbd5e1; line-height: 1.5; }
nav { display: flex; gap: 12px; margin: 22px 0; }
a, button { border: 0; border-radius: 10px; padding: 11px 15px; background: #0284c7; color: white; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; }
button { background: #334155; }
dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
dl div { border-radius: 12px; background: #111827; padding: 14px; }
dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
dd { margin: 5px 0 0; font-weight: 650; }
`;

const javascript = `
const emitEvents = () => {
  console.log('fixture log', { route: location.pathname });
  console.warn('fixture warning');
  console.error('fixture error');
};
document.querySelector('#emit')?.addEventListener('click', emitEvents);
emitEvents();
fetch('/api/ping').then((response) => response.json()).then((payload) => {
  document.querySelector('#api-status').textContent = payload.ok ? 'connected' : 'failed';
  console.info('fixture API response', payload);
});
fetch('/api/session').then((response) => response.json()).then((payload) => {
  document.querySelector('#cookie-status').textContent = payload.viewer || 'isolated';
  console.info('fixture cookie response', payload);
});
const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(protocol + '//' + location.host + '/hmr');
socket.addEventListener('open', () => {
  document.querySelector('#ws-status').textContent = 'connected';
  socket.send('ping');
});
socket.addEventListener('message', (event) => console.info('fixture HMR message', event.data));
socket.addEventListener('error', () => {
  document.querySelector('#ws-status').textContent = 'failed';
  console.error('fixture HMR connection failed');
});
`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request, serverHandle) {
    const url = new URL(request.url);
    if (url.pathname === '/hmr' && serverHandle.upgrade(request)) return;
    if (url.pathname === '/fixture.css') {
      return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }
    if (url.pathname === '/fixture.js') {
      return new Response(javascript, { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    }
    if (url.pathname === '/api/ping') return Response.json({ ok: true, route: url.pathname });
    if (url.pathname === '/api/session') {
      const cookie = request.headers.get('cookie') || '';
      const viewer = cookie.match(/(?:^|;\s*)fixture_viewer=([^;]+)/)?.[1] || null;
      return Response.json({ viewer });
    }
    if (url.pathname !== '/' && url.pathname !== '/page-two') {
      return new Response('Not found', { status: 404 });
    }
    const viewer = url.searchParams.get('viewer');
    return new Response(html(url.pathname === '/' ? 'home' : 'page-two'), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...(viewer ? { 'Set-Cookie': `fixture_viewer=${encodeURIComponent(viewer)}; Path=/; HttpOnly; SameSite=Lax` } : {}),
      },
    });
  },
  websocket: {
    open(socket) { socket.send('connected'); },
    message(socket, message) { if (String(message) === 'ping') socket.send('update-ready'); },
  },
});

console.log(`Browser parity fixture: http://localhost:${server.port}/`);

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

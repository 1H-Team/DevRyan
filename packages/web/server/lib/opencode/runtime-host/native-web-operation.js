const fail = () => Object.assign(new Error('native_web_operation_unavailable'), { code: 'native_web_operation_unavailable', status: 403 });

/** Translate an already-normalized client request into the actual 2.0.20 service effect. */
export function nativeWebOperation(spec) {
  const url = new URL(spec.path, 'http://127.0.0.1'), body = spec.body ?? {};
  if (spec.method === 'POST' && ['/api/session', '/devryan/session'].includes(url.pathname)) {
    const { location, ...input } = body;
    return { sessionID: body.parentID, directory: location?.directory ?? spec.directory,
      effects: [{ operation: 'session.create', input: url.pathname === '/devryan/session' ? input : body }] };
  }
  const match = /^\/api\/session\/(ses[A-Za-z0-9_-]+)(.*)$/.exec(url.pathname);
  if (!match) throw fail();
  const [, sessionID, suffix] = match;
  const effect = (operation, input) => ({ sessionID, directory: spec.directory, effects: [{ operation, input }] });
  const sessionInput = (input = body) => ({ sessionID, ...input });
  if (spec.method === 'DELETE' && suffix === '' && spec.operation === 'sessions.remove') return effect('session.remove', undefined);
  if (spec.method === 'PATCH' && suffix === '') {
    if (Object.keys(body).some(key => !['title','metadata','permissions'].includes(key))) throw fail();
    const effects = [];
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title) throw fail();
      effects.push({ operation: 'session.rename', input: sessionInput({ title: body.title }) });
    }
    if (body.metadata !== undefined) {
      if (spec.operation !== 'sessions.archive') throw fail();
      effects.push({ operation: 'session.setMetadata', input: sessionInput({ metadata: body.metadata }) });
    }
    if (body.permissions !== undefined) effects.push({ operation: 'session.setPermissions', input: sessionInput({ permissions: body.permissions }) });
    return { sessionID, directory: spec.directory, effects };
  }
  if (spec.method === 'POST') {
    if (suffix === '/interrupt') return effect(url.searchParams.get('resume') === 'true' ? 'session.interrupt.resume' : 'session.interrupt',
      url.searchParams.has('resume') ? { resume: url.searchParams.get('resume') === 'true' } : {});
    const operation = { '/prompt':'session.prompt', '/agent':'session.switchAgent', '/model':'session.switchModel',
      '/compact':'session.compact', '/fork':'session.fork' }[suffix];
    if (operation) return effect(operation, sessionInput());
    if (suffix === '/skill') return effect('session.skill', sessionInput({ skill: body.id, resume: body.resume }));
    if (suffix === '/command') { const { name, ...rest } = body; return effect('session.command', sessionInput({ command: name, ...rest })); }
    const permission = /^\/permission\/([^/]+)\/reply$/.exec(suffix);
    if (permission) return effect('permission.reply', { requestID: decodeURIComponent(permission[1]), reply: body.decision, message: body.message });
    const form = /^\/form\/([^/]+)\/reply$/.exec(suffix);
    if (form) return effect('form.reply', { id: decodeURIComponent(form[1]), answer: body.answer });
  }
  const form = /^\/form\/([^/]+)$/.exec(suffix);
  if (form && spec.method === 'DELETE') return effect('form.cancel', { id: decodeURIComponent(form[1]) });
  throw fail();
}

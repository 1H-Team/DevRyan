// A group handler factory of the toy group: the functions it makes are the
// group's even when code outside the group registers them (the toy table names
// it in handlerFactories, so the host claims what it returns).
export function createToyFactoryRuntime() {
  return { middleware(_req, res) { res.json({ route: 'factory' }); } };
}
/** The same kind of handler, not made through a named factory: registered by edge code, it is the edge's. */
export function unclaimedMiddleware(_req, res) { res.json({ route: 'unclaimed' }); }

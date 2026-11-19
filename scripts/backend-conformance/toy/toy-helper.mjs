// A registration helper outside the toy group's files: a route it registers
// for the group is still the group's (the group file is on the call stack).
export function registerThroughHelper(app, routePath, handler) {
  app.get(routePath, handler);
}
/** Registers a route from a timer callback of this (non-group) file: whoever runs then, no group frame is on its stack. */
export function registerLaterFromHelper(app) {
  setImmediate(() => { app.get('/api/toy-late/from-helper', (_req, res) => { res.json({}); }); });
}

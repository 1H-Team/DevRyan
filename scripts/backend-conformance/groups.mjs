// The route groups the backend conformance harness can host (BH1; design
// file 31 §2.1, §9 "Next groups"). Each entry names the group's real
// registrar, the edge profile in front of it (edge.mjs), the source files
// that count as the group's, the dependencies the real server hands the
// registrar (the composition table pins where the server makes that call),
// handler factories whose functions count as the group's wherever they are
// registered, and declared background work. A new group is a new entry here
// and a span table in the composition drift module; the host and the tap do
// not change.
import fs from 'node:fs';
import path from 'node:path';

export const GROUPS = Object.freeze({
  'magic-prompts': Object.freeze({
    edge: 'web-api',
    registrar: Object.freeze({ module: 'packages/web/server/lib/magic-prompts/routes.js', export: 'registerMagicPromptRoutes' }),
    // Handlers live in the registrar file; the runtime they call is the group's too.
    files: Object.freeze(['packages/web/server/lib/magic-prompts/routes.js', 'packages/web/server/lib/magic-prompts/runtime.js']),
    // The server's feature-routes call passes these; the data root is the harness's.
    dependencies: ({ dataRoot }) => ({ fsPromises: fs.promises, path, devryanDataDir: dataRoot }),
    // Values for route parameters in the reach check's probe requests.
    parameterValues: Object.freeze({ id: 'git.pr.generate.visible' }),
    handlerFactories: Object.freeze([]),
    // Work the group starts on purpose and does not wait for, each with why (none for this group).
    declaredBackground: Object.freeze([]),
  }),
});

/** A group entry, or null. */
export const groupNamed = (name, table = GROUPS) => (Object.hasOwn(table, name) ? table[name] : null);

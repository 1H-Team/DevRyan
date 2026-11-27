// The reach check and the layer-stack check (BH1; the fix round's decisions 3
// and 4), on the product route census (enumerateServerRoutes, run in a child
// process by the census module).
//
// Reach: every census layer before the group's first route that applies to a
// group route must come from a composed step's file or a listed omission.
// Whether a layer applies is decided by the router's own matching, never by
// comparing path strings: each layer is registered alone on a throwaway router
// of the server's express (case-insensitive, non-strict, as the app is
// configured), and the router is asked to handle a request for every group
// route and method, with its parameters filled in.
//
// Layer stack: the layers the group host registered before the group (as the
// tap recorded them, with their files and lines) must be the layers the census
// records for the composed steps' files, in the same order (top level) and the
// same set (inside mounted routers). Both sides run the product's registrars,
// so a difference is the re-statement composing something else.
import path from 'node:path';
import { EDGE_STEPS, REACH_OMISSIONS, REPOSITORY_ROOT, SERVER_ROOT, importFromServer } from './edge.mjs';

/** A concrete request path for a route pattern: parameters filled in, wildcards given a segment. */
export function concreteRequestPath(pattern, values = {}) {
  return pattern
    .replace(/\{\*([A-Za-z0-9_]+)\}/g, (_whole, name) => values[name] ?? `probe-${name}`)
    .replace(/\*([A-Za-z0-9_]+)/g, (_whole, name) => values[name] ?? `probe-${name}`)
    .replace(/:([A-Za-z0-9_]+)\??/g, (_whole, name) => values[name] ?? `probe-${name}`)
    .replace(/[{}]/g, '');
}
const patternOf = (layerPath) => (typeof layerPath === 'string' && layerPath.startsWith('regex:') ? new RegExp(layerPath.slice(6)) : layerPath);

/**
 * Whether `layer` ({ kind: 'use'|'route', method, path }) would run for a
 * `method` request to `url`, by the router of `express`.
 */
export async function layerApplies({ express, layer, method, url }) {
  const router = express.Router({ caseSensitive: false, strict: false, mergeParams: false });
  let matched = false;
  const hit = (_req, _res) => { matched = true; };
  const layerPath = layer.path === null || layer.path === undefined ? null : patternOf(layer.path);
  try {
    if (layer.kind === 'use' || layer.method === 'USE') {
      if (layerPath === null) router.use(hit); else router.use(layerPath, hit);
    } else {
      const verb = String(layer.method ?? 'ALL').toLowerCase();
      const route = router.route(layerPath);
      if (typeof route[verb] !== 'function') return { applies: true, why: `unknown method ${layer.method}: counted as applying` };
      route[verb](hit);
    }
  } catch (error) {
    return { applies: true, why: `the router refused the layer's path (${error.message}): counted as applying` };
  }
  const req = { method, url, originalUrl: url, headers: {} };
  const res = { setHeader() {}, getHeader() {}, end() {}, headersSent: false };
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try { router.handle(req, res, done); } catch { done(); }
    if (matched) done();
    // The router calls the handler or `done` synchronously or on a later tick; both settle here.
    const poll = () => { if (matched) done(); else if (!settled) setImmediate(poll); };
    setImmediate(poll);
  });
  return { applies: matched };
}

/** Methods a group route answers: its own, and HEAD for GET (the router runs GET routes for HEAD). */
const requestMethods = (method) => (method === 'GET' ? ['GET', 'HEAD'] : method === 'ALL' ? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] : [method]);

/** Group routes of the census: those whose file is a group file. */
export const groupRoutesOf = ({ group, census }) => {
  const groupFiles = new Set(group.files.map((file) => path.relative(SERVER_ROOT, path.join(REPOSITORY_ROOT, file))));
  return { groupFiles, routes: census.routes.filter((route) => groupFiles.has(route.file)) };
};

/**
 * The reach check on a census result. `values` fills route parameters
 * (`{ id: 'x' }`); `omissions` defaults to `REACH_OMISSIONS`. Returns problems (strings).
 */
export async function reachProblems({ group, census, values = {}, express, omissions = REACH_OMISSIONS }) {
  express ??= await importFromServer('express');
  const problems = [];
  const { groupFiles, routes: groupRoutes } = groupRoutesOf({ group, census });
  if (groupRoutes.length === 0) return [`reach: the census records no route from ${[...groupFiles].join(', ')}`];
  const first = Math.min(...groupRoutes.map((route) => route.order));
  const composedFiles = new Set(EDGE_STEPS.flatMap((step) => step.layers ?? []));
  const omitted = new Map(omissions.map((entry) => [entry.file, entry.reason]));
  const used = new Set();
  // Candidate requests: each group route with its parameters filled in, and each layer's own literal path
  // when the group route matches it (a mount on /api/x/foo applies to a group route /api/x/:id for id foo).
  const probes = groupRoutes.flatMap((route) => requestMethods(route.method).map((method) => ({ method, url: concreteRequestPath(route.path, values), route })));
  const layers = [
    ...census.mounts.filter((mount) => mount.order < first).map((mount) => ({ kind: 'use', ...mount })),
    ...census.routes.filter((route) => route.order < first && !groupFiles.has(route.file)).map((route) => ({ kind: 'route', ...route })),
  ];
  for (const layer of layers) {
    let hit = null;
    const own = typeof layer.path === 'string' && !layer.path.startsWith('regex:') ? concreteRequestPath(layer.path, values) : null;
    const candidates = [...probes];
    if (own) {
      for (const route of groupRoutes) for (const method of requestMethods(route.method)) {
        if ((await layerApplies({ express, layer: { kind: 'route', method: route.method === 'ALL' ? 'ALL' : method, path: route.path }, method, url: own })).applies) candidates.push({ method, url: own, route });
      }
    }
    for (const probe of candidates) {
      const result = await layerApplies({ express, layer, method: probe.method, url: probe.url });
      if (result.applies) { hit = { probe, why: result.why }; break; }
    }
    if (!hit) continue;
    if (composedFiles.has(layer.file)) continue;
    if (omitted.has(layer.file)) { used.add(layer.file); continue; }
    problems.push(`reach: ${layer.kind} ${layer.method && layer.kind === 'route' ? `${layer.method} ` : ''}${layer.path ?? '<every path>'} from ${layer.file}:${layer.line} runs for ${hit.probe.method} ${hit.probe.url} (group route ${hit.probe.route.method} ${hit.probe.route.path}) before the group, and no composed step installs it${hit.why ? ` (${hit.why})` : ''}`);
  }
  for (const file of omitted.keys()) if (!used.has(file)) problems.push(`reach: the omission of ${file} matches no layer`);
  return problems;
}

const key = (entry) => `${entry.file}:${entry.line}`;
const dedupe = (list) => list.filter((entry, index) => index === 0 || key(entry) !== key(list[index - 1]));

/** Whether any of `probes` would run `entry` ({ kind, method, path }). */
async function appliesToAny({ express, entry, probes }) {
  for (const probe of probes) if ((await layerApplies({ express, layer: entry, method: probe.method, url: probe.url })).applies) return true;
  return false;
}

/**
 * The layer-stack check: the layers of the composed steps that run for the
 * group's requests, in the group host (the tap's registration records,
 * absolute files) and in the census, must be the same, in the same order at
 * the top level and as the same set inside mounted routers. Layers that run
 * for none of the group's requests are left out on both sides (the reach check
 * covers them, and the host leaves some out on purpose).
 */
export async function layerStackProblems({ group, census, hostRegistrations, values = {}, express }) {
  express ??= await importFromServer('express');
  const problems = [];
  const { groupFiles, routes: groupRoutes } = groupRoutesOf({ group, census });
  if (groupRoutes.length === 0) return [`layer stack: the census records no route from ${[...groupFiles].join(', ')}`];
  const first = Math.min(...groupRoutes.map((route) => route.order));
  const composedFiles = new Set(EDGE_STEPS.flatMap((step) => step.layers ?? []));
  const probes = groupRoutes.flatMap((route) => requestMethods(route.method).map((method) => ({ method, url: concreteRequestPath(route.path, values) })));
  const relative = (file) => (file ? path.relative(SERVER_ROOT, file) : null);
  const censusEntries = [...census.mounts.map((mount) => ({ ...mount, kind: 'use' })), ...census.routes.map((route) => ({ ...route, kind: 'route' }))]
    .filter((entry) => entry.order < first && composedFiles.has(entry.file))
    .sort((a, b) => a.order - b.order || Number(a.viaRouter) - Number(b.viaRouter));
  // The group's own registrar starts where its window opens (a claimed handler can be the group's before that).
  const firstGroup = hostRegistrations.findIndex((entry) => entry.inWindow ?? entry.group);
  const before = (firstGroup < 0 ? hostRegistrations : hostRegistrations.slice(0, firstGroup)).map((entry) => ({ ...entry, file: relative(entry.file) }))
    .filter((entry) => composedFiles.has(entry.file));
  const applicable = async (entries) => { const out = []; for (const entry of entries) if (await appliesToAny({ express, entry, probes })) out.push(entry); return out; };
  const censusTop = dedupe(await applicable(censusEntries.filter((entry) => !entry.viaRouter)));
  const hostTop = dedupe(await applicable(before.filter((entry) => entry.top && entry.kind !== 'param')));
  const length = Math.max(censusTop.length, hostTop.length);
  for (let index = 0; index < length; index += 1) {
    if (key(censusTop[index] ?? {}) === key(hostTop[index] ?? {})) continue;
    const show = (entry) => (entry ? `${key(entry)} (${entry.kind} ${entry.method && entry.kind === 'route' ? `${entry.method} ` : ''}${entry.path ?? '<every path>'})` : '<none>');
    problems.push(`layer stack: layer ${index + 1} that runs for the group's requests is ${show(hostTop[index])} in the group host and ${show(censusTop[index])} in the census`);
    break;
  }
  const censusNested = new Set((await applicable(censusEntries.filter((entry) => entry.viaRouter))).map(key));
  const hostNested = new Set(before.filter((entry) => !entry.top).map(key));
  for (const entry of censusNested) if (!hostNested.has(entry)) problems.push(`layer stack: the census mounts ${entry} inside a router, running for the group's requests; the group host does not`);
  return problems;
}

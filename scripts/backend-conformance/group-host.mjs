#!/usr/bin/env node
// The group host (BH1; design file 31 §5.1 arm R): one process that serves
// ONE route group as the real server serves it, the group's real registrar
// behind the real edge (edge.mjs), on loopback, on a data root the harness
// gives it, observed by the tap (tap.mjs) loaded as a preload.
//
//   node --import=<tap.mjs> scripts/backend-conformance/group-host.mjs --group=<name> --data-root=<dir>
//       [--listen=127.0.0.1:0] [--control=127.0.0.1:0] [--table=<module in this folder>] [--variants=<name>,...]
//       [--stubs=<name>=http://127.0.0.1:<port>,...]   harness stubs, handed to the group table's dependencies
//
// It refuses (exit 64) outside the test isolation guard, without an armed tap
// set up for the same group, on an unknown group, variant or option, and on a
// data root that is not a private canonical directory. When serving it prints
// one line on stdout:
//   {"ready":{"listen":<port>,"control":<port>,"pid":<pid>,"tap":<record file>,"group":<name>,"variants":{<name>:<port>}}}
// The control port answers
//   GET  /quiescent?seq=n[&timeoutMs=t]  once exchange n has ended and nothing it started is pending:
//        {"seq","quiescent":true,"pending":[],"blind":[...],"crossed":[...]}; when t ms (default 30000,
//        at most 600000) pass first: {"seq","quiescent":false,"pending":[{type,site}],...}
//   GET  /pending?seq=n                 what exchange n still has pending, at once
//   GET  /status                        the last exchange, registration problems, absent dependencies the edge called
//   GET  /registrations                 every registration the tap saw (for the layer-stack check)
//   POST /stop                          stops the host (exit 0)
// SIGTERM, SIGINT and SIGHUP stop it (exit 0); so does the end of its stdin
// when stdin is a pipe (its launcher died, whatever the signal), and a change
// of its parent process. A startup failure exits 1.
//
// `--variants` (toy tables only) composes the edge once more per named
// variant of the table entry, each on its own app, port and data root
// (<data-root>/variant-<name>): planted re-statements the self-test's probes
// must catch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tap } from './tap.mjs';
import { isolationRefusal } from './run-scratch.mjs';
import { EDGE_STEPS, REPOSITORY_ROOT, SERVER_ROOT, composeEdge, createAbsentDependencies, importFromServer } from './edge.mjs';
import { GROUPS } from './groups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXIT = Object.freeze({ stopped: 0, startup: 1, refused: 64 });
const OPTIONS = new Set(['group', 'data-root', 'listen', 'control', 'table', 'variants', 'stubs', 'home']);
const QUIESCENT_DEFAULT_MS = 30_000;
const QUIESCENT_MAX_MS = 600_000;

function parse(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match || !OPTIONS.has(match[1]) || Object.hasOwn(options, match[1])) return { error: `unknown, repeated or malformed option ${argument}` };
    options[match[1]] = match[2];
  }
  if (!options.group || !options['data-root']) return { error: '--group and --data-root are required' };
  return { options };
}
const address = (text, fallback) => {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(text ?? fallback);
  if (!match || Number(match[1]) > 65535) return null;
  return { host: '127.0.0.1', port: Number(match[1]) };
};
const refuse = (message) => { process.stderr.write(`group host: refused: ${message}\n`); return EXIT.refused; };
const privateDirectory = (directory) => {
  const stat = (() => { try { return fs.lstatSync(directory); } catch { return null; } })();
  return path.isAbsolute(directory) && stat?.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && fs.realpathSync(directory) === directory;
};
const sourceDigest = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return null; } };

/**
 * What the edge left on a request, read at the group's entry with the
 * product's own functions (design §6, the envelope's fields): the
 * request-context store's assignment, the peer (a direct local request; a
 * tunnel owner's), and whether the principal's authorisation is live (the
 * check the product's long-lived routes repeat: the connection's, else the
 * auth controller's, lib/orchestration/routes.js).
 */
async function entryObserver(state) {
  const fromServer = (relative) => import(pathToFileURL(path.join(SERVER_ROOT, relative)).href);
  const { getRequestAssignment, getRequestPrincipal } = await fromServer('lib/multi-user/request-context.js');
  const { isDirectLocalRequest } = await fromServer('lib/security/direct-local-request.js');
  const { getTunnelOwnerPrincipal } = await fromServer('lib/tunnels/access-control.js');
  return (req) => {
    const principal = req.principal ?? null;
    const check = principal ? (state.multiUserRuntime?.connection?.captureAuthorization?.(principal) ?? state.uiAuthController?.captureAuthorization?.(principal) ?? null) : null;
    return {
      assignment: getRequestAssignment(),
      storePrincipalIsRequestPrincipal: getRequestPrincipal() === principal,
      peer: { directLocal: isDirectLocalRequest(req) === true, tunnel: getTunnelOwnerPrincipal(req) !== null },
      authorizationActive: typeof check === 'function' ? check() === true : null,
    };
  };
}

async function loadTable(option) {
  if (!option) return { table: GROUPS, file: path.join(HERE, 'groups.mjs') };
  const file = path.resolve(option);
  if (!file.startsWith(`${HERE}${path.sep}`) || fs.realpathSync(file) !== file) throw new Error('--table must name a module inside the harness folder');
  return { table: (await import(pathToFileURL(file).href)).GROUPS, file };
}

/** The group's handler factories, wrapped so that every function they return is claimed as the group's. */
async function claimedFactories(group) {
  const factories = {};
  for (const entry of group.handlerFactories ?? []) {
    const original = (await import(pathToFileURL(path.join(REPOSITORY_ROOT, entry.module)).href))[entry.export];
    if (typeof original !== 'function') throw new Error(`${entry.module} exports no ${entry.export}`);
    factories[entry.export] = (...args) => {
      const made = original(...args);
      if (typeof made === 'function') tap.claimHandler(made);
      else if (made && typeof made === 'object') for (const value of Object.values(made)) if (typeof value === 'function') tap.claimHandler(value);
      return made;
    };
  }
  return factories;
}

/**
 * The framework's shared objects, property by property (descriptors compared by identity). A module that
 * patches one while the host composes (express.response.json, ServerResponse.prototype.setHeader,
 * compression.filter, fs.promises.writeFile) changes what every group sees in a way no composition table
 * can read from the server's text: the host refuses to serve. The tap's own patches are made at preload, before.
 */
async function frameworkSnapshot(express) {
  const compression = await importFromServer('compression');
  const objects = {
    express, 'express.application': express.application, 'express.request': express.request, 'express.response': express.response, compression,
    'http.Server.prototype': http.Server.prototype, 'http.ServerResponse.prototype': http.ServerResponse.prototype, 'http.OutgoingMessage.prototype': http.OutgoingMessage.prototype,
    'http.IncomingMessage.prototype': http.IncomingMessage.prototype, 'fs.promises': fs.promises,
  };
  const take = () => new Map(Object.entries(objects).map(([name, object]) => [name, new Map(Reflect.ownKeys(object).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]))]));
  const before = take();
  const same = (left, right) => left && right && ['value', 'get', 'set'].every((field) => left[field] === right[field]);
  return () => {
    const changed = [];
    for (const [name, now] of take()) {
      const then = before.get(name);
      for (const key of new Set([...then.keys(), ...now.keys()])) if (!same(then.get(key), now.get(key))) changed.push(`composing the edge and the group changed ${name}.${String(key)} (${now.has(key) ? (then.has(key) ? 'replaced' : 'added') : 'removed'})`);
    }
    return changed;
  };
}

/** Ends the host when its launcher is gone: stdin (a pipe) ends, or the parent process changes. */
function watchLauncher(stop) {
  let kind = null;
  try { const stat = fs.fstatSync(0); kind = stat.isFIFO() ? 'pipe' : stat.isSocket() ? 'socket' : null; } catch { kind = null; }
  if (kind) {
    process.stdin.on('end', () => { stop('the launcher closed stdin'); });
    process.stdin.on('error', () => { stop('stdin failed'); });
    process.stdin.resume();
  }
  const parent = process.ppid;
  const timer = setInterval(() => { if (process.ppid !== parent) stop('the launcher process is gone'); }, 500);
  timer.unref();
}

export async function main(argv = process.argv.slice(2)) {
  const refusal = isolationRefusal();
  if (refusal) return refuse(refusal);
  const parsed = parse(argv);
  if (parsed.error) return refuse(parsed.error);
  const { options } = parsed;
  const listen = address(options.listen, '127.0.0.1:0');
  const control = address(options.control, '127.0.0.1:0');
  if (!listen || !control) return refuse('--listen and --control take 127.0.0.1:<port>');
  let loaded;
  try { loaded = await loadTable(options.table); } catch (error) { return refuse(error.message); }
  const { table } = loaded;
  const group = Object.hasOwn(table, options.group) ? table[options.group] : null;
  if (!group) return refuse(`unknown group ${options.group}`);
  const variants = options.variants ? options.variants.split(',') : [];
  for (const name of variants) if (!Object.hasOwn(group.variants ?? {}, name)) return refuse(`unknown variant ${name} of group ${options.group}`);
  if (!tap.armed) return refuse('the tap is not armed: start the host with --import=<tap.mjs> and DEVRYAN_BACKEND_TAP');
  if (tap.setup.group !== options.group || tap.setup.servers !== 'tagged') return refuse(`the tap is set up for group ${tap.setup.group} (${tap.setup.servers} servers), not ${options.group}`);
  const groupFiles = group.files.map((file) => path.join(REPOSITORY_ROOT, file));
  const tapped = new Set(tap.setup.groupFiles);
  if (groupFiles.length !== tapped.size || groupFiles.some((file) => !tapped.has(file))) return refuse('the tap setup names other group files than the group table');
  const declared = (entries) => JSON.stringify(entries.map((entry) => [entry.file, entry.line ?? null, entry.reason]).sort());
  if (declared(group.declaredBackground.map((entry) => ({ ...entry, file: path.join(REPOSITORY_ROOT, entry.file) }))) !== declared(tap.setup.declaredBackground)) return refuse('the tap setup declares other background work than the group table');
  const stubs = {};
  for (const entry of options.stubs ? options.stubs.split(',') : []) {
    const match = /^([a-z0-9][a-z0-9-]*)=(http:\/\/127\.0\.0\.1:\d{1,5})$/.exec(entry);
    if (!match || Object.hasOwn(stubs, match[1])) return refuse(`--stubs takes <name>=http://127.0.0.1:<port>, each name once (${entry})`);
    stubs[match[1]] = match[2];
  }
  const dataRoot = options['data-root'];
  if (!privateDirectory(dataRoot)) return refuse('--data-root must be an existing private canonical directory');
  // --home: the HOME the harness gives both arms (a directory of its run, tracked like the data root). The
  // isolation check above ran on the guard's HOME; the group's modules, imported below, see this one.
  if (options.home !== undefined) {
    if (!privateDirectory(options.home)) return refuse('--home must be an existing private canonical directory');
    Object.assign(process.env, { HOME: options.home, XDG_CONFIG_HOME: path.join(options.home, '.config'), XDG_DATA_HOME: path.join(options.home, '.local', 'share'), XDG_STATE_HOME: path.join(options.home, '.local', 'state'), XDG_CACHE_HOME: path.join(options.home, '.cache') });
  }

  // The product's own express, so the tap's router patch is the one it uses.
  const express = await importFromServer('express');
  const absent = createAbsentDependencies();
  let registrar;
  let factories;
  try {
    registrar = (await import(pathToFileURL(path.join(REPOSITORY_ROOT, group.registrar.module)).href))[group.registrar.export];
    if (typeof registrar !== 'function') throw new Error(`${group.registrar.module} exports no ${group.registrar.export}`);
    factories = await claimedFactories(group);
  } catch (error) { process.stderr.write(`group host: ${error.message}\n`); return EXIT.startup; }
  const hub = (channel) => (payload) => tap.recordHub(channel, payload);
  const onTail = (req) => tap.markTail(req);

  /** Composes one app: the edge (or none), the group, the tail stand-in. */
  const composeOne = async (variant, root) => {
    const app = express();
    tap.markTopRouter(app.router);
    const registerGroup = async () => {
      tap.beginGroupRegistration(options.group);
      try { await registrar(app, group.dependencies({ dataRoot: root, hub, factories, absent, stubs })); } finally { tap.endGroupRegistration(); }
    };
    if (group.edge === 'web-api') {
      const replace = { ...(group.edgeReplace?.({ factories }) ?? {}), ...(variant ? group.variants[variant]({ factories }) : {}) };
      return composeEdge({ app, express, http, dataRoot: root, absent, registerGroup, onTail, replace });
    }
    // No edge at all: the registrar alone on the app (the self-test's toys; the JS candidate adapter of BH4 builds on it).
    if (group.edge === 'bare') { const server = http.createServer(app); await registerGroup(); return { server }; }
    throw new Error(`unknown edge profile ${group.edge}`);
  };
  const composed = [];
  const frameworkChanges = await frameworkSnapshot(express);
  try {
    composed.push({ name: null, state: await composeOne(null, dataRoot) });
    for (const variant of variants) {
      const root = path.join(dataRoot, `variant-${variant}`);
      fs.mkdirSync(root, { mode: 0o700 });
      composed.push({ name: variant, state: await composeOne(variant, root) });
    }
  } catch (error) {
    process.stderr.write(`group host: composing the edge failed: ${error.stack ?? error}\n`);
    return EXIT.startup;
  }
  absent.seal();
  const groupRegistrations = tap.registrations().filter((entry) => entry.group);
  const problems = [...tap.problems(), ...(groupRegistrations.length ? [] : ['the group registered nothing']), ...frameworkChanges()];
  if (problems.length) { process.stderr.write(`group host: registration problems:\n${problems.map((line) => `  - ${line}`).join('\n')}\n`); return EXIT.startup; }
  tap.recordHost({
    group: options.group, edge: group.edge, steps: group.edge === 'web-api' ? EDGE_STEPS.map((step) => step.id) : [], variants,
    sources: Object.fromEntries(['edge.mjs', 'tap.mjs', 'group-host.mjs', path.relative(HERE, loaded.file)].map((name) => [name, sourceDigest(path.join(HERE, name))])),
    groupSources: Object.fromEntries(group.files.map((file) => [file, sourceDigest(path.join(REPOSITORY_ROOT, file))])),
  });

  for (const { state } of composed) tap.tagServer(state.server);
  if (group.edge === 'web-api') tap.observeEntry(await entryObserver(composed[0].state));
  const controlServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let replied = false;
    const reply = (status, body) => {
      if (replied) return;
      replied = true;
      const text = `${JSON.stringify(body)}\n`;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' });
      res.end(text);
    };
    const seq = Number(url.searchParams.get('seq'));
    if (req.method === 'GET' && url.pathname === '/quiescent') {
      const asked = Number(url.searchParams.get('timeoutMs') ?? QUIESCENT_DEFAULT_MS);
      if (!Number.isInteger(asked) || asked < 1 || asked > QUIESCENT_MAX_MS) return reply(400, { error: `timeoutMs must be an integer from 1 to ${QUIESCENT_MAX_MS}` });
      const timer = setTimeout(() => { tap.flushOf(seq); reply(200, { seq, quiescent: false, pending: tap.pendingOf(seq), ...tap.blindOf(seq) }); }, asked);
      tap.whenQuiescent(seq).then((result) => { clearTimeout(timer); reply(200, result); }, (error) => { clearTimeout(timer); reply(404, { error: error.message }); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/pending') return reply(200, { seq, pending: tap.pendingOf(seq), ...tap.blindOf(seq) });
    if (req.method === 'GET' && url.pathname === '/status') return reply(200, { lastSeq: tap.lastSeq(), problems: tap.problems(), absentCalls: absent.calls() });
    if (req.method === 'GET' && url.pathname === '/registrations') return reply(200, { registrations: tap.registrations() });
    if (req.method === 'POST' && url.pathname === '/stop') { reply(200, { stopping: true }); stop('asked to stop'); return; }
    return reply(404, { error: 'not found' });
  });
  let stopping = null;
  const servers = composed.map(({ state }) => state.server);
  const stop = () => {
    tap.flushAll();
    stopping ??= Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      if (server.listening) server.close(() => resolve()); else resolve();
    }))).then(() => new Promise((resolve) => { controlServer.closeAllConnections?.(); if (controlServer.listening) controlServer.close(() => resolve()); else resolve(); }));
    return stopping;
  };
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(index === 0 ? listen.port : 0, listen.host, resolve); });
    }
    await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(control.port, control.host, resolve); });
  } catch (error) { process.stderr.write(`group host: cannot listen: ${error.message}\n`); return EXIT.startup; }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { stop(); });
  watchLauncher(stop);
  process.stdout.write(`${JSON.stringify({ ready: { listen: servers[0].address().port, control: controlServer.address().port, pid: process.pid, tap: tap.file, group: options.group,
    variants: Object.fromEntries(composed.slice(1).map(({ name, state }) => [name, state.server.address().port])) } })}\n`);
  await new Promise((resolve) => { servers[0].once('close', resolve); });
  await stop();
  return EXIT.stopped;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
  // Product modules may hold timers (caches, watchers); the host's life ends with its servers.
  process.exit();
}

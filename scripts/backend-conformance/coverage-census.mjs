// The coverage census of a route group (BH5; design file 31 §8.3): what a
// port of the group must reproduce, and whether a scenario row that passed
// exercises it. It imports only Node built-ins; its inputs are data (the
// group's items read from its source by census-source.mjs, the reference's
// recordings, the judged rows and the census waivers), so its judgement is
// tested on fixed inputs.
//
// The items:
//   route      every route and method the group registers (the tap's registration records,
//              checked against the registrar's source), and HEAD for every GET route (Express
//              answers HEAD with the GET handler)
//   principal  every route crossed with every principal class (design §6)
//   form       every request form the framework handles before the group's code that applies
//              to the route (FORMS below): routing rules, body parsing, conditional requests,
//              encodings, limits; and, per path, the methods no route of the group registers
//   code       every branch, answer, throw, dependency call and envelope read of the group's
//              files (census-source.mjs)
//   error      each error a write the group makes can meet in a data-root state, as the group
//              declares them (`errors`: a call item and the codes; Node's message starts with the code)
//
// How an item is established as exercised, never from a scenario's own claim:
//   - a route or principal item: a reference exchange whose tap record says the group was
//     entered (`kind: group`) through that registration (`entry.registration`), by that method,
//     with that principal;
//   - a form item: a reference exchange whose recorded request (the tap's raw request: method,
//     URL as the client sent it, headers, body bytes) has the form, and whose answer the tap
//     attributes to the group, the edge (`kind: edge`) or the tail stand-in (`kind: tail`): the
//     item's owner is what the tap saw;
//   - a code item: the reference host's block coverage of the group's files (block-coverage.mjs),
//     taken at every quiescence answer, so each take belongs to one exchange of one process
//     (`process`, `seq`), and the item's position counted above zero in a take of that exchange
//     (code run at the host's start counts for the scenario's recording row). V8 counts the block
//     entered, not the construct run (a call that throws before it, an awaited argument that
//     rejects), so two kinds need the exchange to show it too: an answer counts only when the tap
//     saw the group write that exchange's answer (its status line, a header or the body) from
//     inside the answer's span; a call that writes (writes: true) counts only when its step changed
//     the data root (`touched`: the steps whose tree changed, rule last-writer's reading);
//   - an error item: its call item counted in a take of that exchange, and the exchange's answer
//     holds `<code>:` (Node's message).
// And then only through a row that ended so: an exchange the group answered counts when its
// row passed (R = R' and R = J, or the candidate): `exercised`. An exchange the edge or the tail
// answered counts when its row is waived for exactly that check (`edge-exchange`,
// `tail-exchange`): stable R against R', never sent to a candidate, so such an item is
// `reference only`, counted apart: nothing of a candidate was judged on it. A concurrent step's
// admissible serialisations are reference-only reruns and credit nothing. A waived,
// inconclusive, unstable, unrecordable or failed row exercises nothing. An item no such row
// exercised is a gap, unless a census waiver names it (its whole id) with a reason; a waiver
// that names no item, or an item that is exercised or reference only, is a problem. Every gap
// and problem makes the run incomplete (exit 2).
//
// What the census cannot see is in docs/TESTING.md ("The census").

export const CENSUS_VERSION = 2;
export const STATUSES = Object.freeze(['exercised', 'reference-only', 'waived', 'gap']);
const RECORDING_ROW = 'recording';

// ------------------------------------------------------------------ requests
const lower = (text) => String(text).toLowerCase();
/** The tap's raw headers as a map of lowercased names to their values, in order. */
export function headerMap(rawHeaders = []) {
  const map = new Map();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = lower(rawHeaders[index]);
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(String(rawHeaders[index + 1]));
  }
  return map;
}
const header = (obs, name) => obs.headers.get(name)?.join(', ') ?? null;
const contentType = (obs) => {
  const value = header(obs, 'content-type');
  if (value === null) return null;
  const [type, ...params] = value.split(';');
  const charset = params.map((param) => param.trim().split('=')).find(([key]) => lower(key) === 'charset')?.[1]?.replace(/^"|"$/g, '') ?? null;
  return { type: lower(type.trim()), charset: charset === null ? null : lower(charset) };
};
const isJsonType = (type) => type === 'application/json' || /^application\/[^/]*\+json$/.test(type ?? '');
const encodingOf = (obs) => lower(header(obs, 'content-encoding') ?? 'identity').trim();
const bodyText = (obs) => obs.body.toString('utf8');
const parsed = (obs) => { try { return { value: JSON.parse(bodyText(obs).replace(/^\uFEFF/, '')) }; } catch { return null; } };
const plainJson = (obs) => { const ct = contentType(obs); return ct && ct.type === 'application/json' && (ct.charset === null || ct.charset === 'utf-8') && encodingOf(obs) === 'identity' && obs.body.length > 0; };
const validUtf8 = (bytes) => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; } };

/** Whether JSON text has an object with the same key twice (strings and escapes read; the text need not be valid). */
export function hasDuplicateKey(text) {
  const stack = [];
  let index = 0;
  const readString = () => { let out = ''; index += 1; while (index < text.length && text[index] !== '"') { if (text[index] === '\\') { out += text.slice(index, index + 2); index += 2; } else { out += text[index]; index += 1; } } index += 1; return out; };
  let expectKey = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') { stack.push(new Set()); expectKey = true; index += 1; } else if (char === '[') { stack.push(null); expectKey = false; index += 1; } else if (char === '}' || char === ']') { stack.pop(); index += 1; } else if (char === ',') { expectKey = stack.at(-1) instanceof Set; index += 1; } else if (char === '"') {
      const value = readString();
      if (expectKey && stack.at(-1) instanceof Set) { if (stack.at(-1).has(value)) return true; stack.at(-1).add(value); expectKey = false; }
    } else index += 1;
  }
  return false;
}
/** Text outside JSON strings (numbers, literals, punctuation). */
const outsideStrings = (text) => text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
const LONE_SURROGATE = /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/;

/** A route's path as a matcher of request paths the way Express 5 routes them by default: case-insensitive, an optional trailing slash, a parameter one non-empty segment. */
export function routeMatcher(routePath) {
  if (/[*(){}?+]/.test(routePath.replace(/:[A-Za-z_]\w*/g, ''))) return null;
  const pattern = routePath.split('/').map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.\\^$|[\]]/g, '\\$&'))).join('/');
  return new RegExp(`^${pattern}/?$`, 'i');
}
const pathOf = (url) => url.split('?')[0];
const literalSegments = (routePath) => routePath.split('/').map((segment) => (segment.startsWith(':') ? null : segment));
const safeDecode = (segment) => { try { return decodeURIComponent(segment); } catch { return segment; } };
/** The path with its segments decoded and its empty segments dropped: how a router that normalises before matching would read it. */
const normalisedPath = (url) => `/${pathOf(url).split('/').filter(Boolean).map(safeDecode).join('/')}`;
/** The parameter segments of a request path for a route (by position), as written. */
const parameterSegments = (obs, route) => pathOf(obs.url).split('/').filter((_segment, index) => literalSegments(route.path)[index] === null);
const MALFORMED_ESCAPE = /%(?![0-9a-fA-F]{2})/;
const ENCODED_SLASH = /%2f/i;
const otherCase = (obs, route) => pathOf(obs.url).split('/').some((segment, index) => { const literal = literalSegments(route.path)[index]; return literal !== null && literal !== undefined && segment !== literal && lower(segment) === lower(literal); });

/**
 * The request forms (each: id, what it is, which routes it applies to, and
 * whether an observed exchange has it). `applies(route)` gets
 * `{ method, path, reads }` (reads: what the handler reads of the request,
 * from its source); `has(obs, route)` gets the observation (method, url,
 * headers, body, status) and the route. A form is the request as the
 * framework sees it before the group's code, and, where the framework's
 * decision is the form (a fresh conditional GET, a refused body), the answer
 * that decision gives.
 */
export const FORMS = Object.freeze([
  { id: 'trailing-slash', what: 'the path with a trailing slash (Express routes it to the route: non-strict)', applies: () => true, has: (obs, route) => !route.path.endsWith('/') && pathOf(obs.url).endsWith('/') },
  // Another letter case: Express routes it case-insensitively, but the shared body parser chooses its limit by the path as written, so
  // on a route that reads a body the two outcomes (the body parsed, or left unparsed) are two forms; the tap says which one it was.
  { id: 'letter-case', what: 'the path in another letter case (Express routes it case-insensitively)', applies: (route) => !route.reads.includes('body'), has: otherCase },
  { id: 'letter-case-body-parsed', what: 'the path in another letter case whose spelling the shared parser still parses the body for', applies: (route) => route.reads.includes('body'), has: (obs, route) => otherCase(obs, route) && obs.bodyParsed === true },
  { id: 'letter-case-body-unparsed', what: 'the path in another letter case whose spelling the shared parser leaves the body unparsed for (its limit is chosen by the path as written, case-sensitively)', applies: (route) => route.reads.includes('body'), has: (obs, route) => otherCase(obs, route) && obs.bodyParsed === false },
  { id: 'query-string', what: 'a query string the handler does not read', applies: (route) => !route.reads.includes('query'), has: (obs) => obs.url.includes('?') },
  // A percent-encoded parameter: decoded by Express (an ordinary escape), decoded into a slash inside the parameter (%2F), or not
  // decodable (a % without two hex digits: the router refuses it before the group). Each is its own behaviour.
  { id: 'param-percent-encoded', what: 'a route parameter with an ordinary percent escape (Express decodes it)', applies: (route) => route.path.includes('/:'), has: (obs, route) => parameterSegments(obs, route).some((segment) => segment.includes('%') && !MALFORMED_ESCAPE.test(segment) && !ENCODED_SLASH.test(segment)) },
  { id: 'param-percent-slash', what: 'a route parameter holding %2F (Express decodes it into a slash inside the parameter)', applies: (route) => route.path.includes('/:'), has: (obs, route) => parameterSegments(obs, route).some((segment) => ENCODED_SLASH.test(segment) && !MALFORMED_ESCAPE.test(segment)) },
  { id: 'param-percent-malformed', what: 'a route parameter with a % not followed by two hex digits (the router cannot decode it and refuses it)', applies: (route) => route.path.includes('/:'), has: (obs, route) => parameterSegments(obs, route).some((segment) => MALFORMED_ESCAPE.test(segment)) },
  // Spellings that reach this route only through a router that decodes or normalises before matching: Express does neither, so they
  // are not this route's (the tail answers them); matched by the normalised path.
  { id: 'literal-percent-encoded', what: 'a literal segment of the path percent-encoded (Express matches literals as written: not this route)', normalised: true, applies: () => true, has: (obs, route) => pathOf(obs.url).split('/').some((segment, index) => { const literal = literalSegments(route.path)[index]; return literal !== null && literal !== undefined && segment.includes('%') && lower(safeDecode(segment)) === lower(literal); }) },
  { id: 'empty-segment', what: 'the path with an empty segment (a doubled slash: Express does not collapse it, so not this route)', normalised: true, applies: () => true, has: (obs) => pathOf(obs.url).slice(1).replace(/\/$/, '').split('/').some((segment) => segment === '') },
  { id: 'body-malformed-json', what: 'a JSON body that does not parse (the shared parser answers)', applies: () => true, has: (obs) => obs.bodyComplete !== false && plainJson(obs) && !parsed(obs) },
  { id: 'conditional-fresh', what: 'If-None-Match with the current ETag (Express answers 304)', applies: (route) => route.method === 'GET', has: (obs) => header(obs, 'if-none-match') !== null && obs.status === 304 },
  { id: 'conditional-stale', what: 'If-None-Match with another ETag (a full answer)', applies: (route) => route.method === 'GET', has: (obs) => header(obs, 'if-none-match') !== null && obs.status !== 304 && !/no-cache/i.test(header(obs, 'cache-control') ?? '') },
  { id: 'conditional-no-cache', what: 'If-None-Match with the current ETag and Cache-Control: no-cache (never fresh: a full answer)', applies: (route) => route.method === 'GET', has: (obs) => header(obs, 'if-none-match') !== null && /no-cache/i.test(header(obs, 'cache-control') ?? '') },
  { id: 'if-modified-since', what: 'If-Modified-Since with no Last-Modified answered (never fresh)', applies: (route) => route.method === 'GET', has: (obs) => header(obs, 'if-modified-since') !== null && header(obs, 'if-none-match') === null },
  { id: 'conditional-on-write', what: 'If-None-Match on a method that is not GET or HEAD (never answered 304)', applies: (route) => route.method !== 'GET', has: (obs) => header(obs, 'if-none-match') !== null },
  { id: 'accept-encoding-gzip', what: 'Accept-Encoding: gzip (the edge compresses; the group answers the same)', applies: (route) => route.method === 'GET', has: (obs) => /gzip/i.test(header(obs, 'accept-encoding') ?? '') },
  { id: 'json-array', what: 'a JSON array body', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && Array.isArray(parsed(obs)?.value) },
  { id: 'json-primitive', what: 'a JSON body that is not an object or array (the strict parser answers)', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && parsed(obs) !== null && (parsed(obs).value === null || typeof parsed(obs).value !== 'object') },
  { id: 'json-wrong-type-field', what: 'a JSON object whose field has another type than the handler expects', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && Object.values(parsed(obs)?.value ?? {}).some((value) => value !== null && typeof value !== 'string') && !Array.isArray(parsed(obs)?.value) },
  { id: 'json-duplicate-key', what: 'an object with a key twice (the last wins in JSON.parse)', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && hasDuplicateKey(bodyText(obs)) },
  { id: 'json-lone-surrogate', what: 'an escaped lone surrogate (JSON.parse keeps it)', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && LONE_SURROGATE.test(bodyText(obs)) },
  { id: 'json-big-integer', what: 'an integer beyond 2^53 (JSON.parse rounds it)', applies: (route) => route.reads.includes('body'), has: (obs) => plainJson(obs) && /(?:^|[^\d.eE])-?\d{16,}(?![\d.eE])/.test(outsideStrings(bodyText(obs))) },
  { id: 'json-not-utf8', what: 'body bytes that are not UTF-8 (decoded with replacement characters)', applies: (route) => route.reads.includes('body'), has: (obs) => isJsonType(contentType(obs)?.type) && encodingOf(obs) === 'identity' && !validUtf8(obs.body) },
  { id: 'json-bom', what: 'a UTF-8 byte-order mark before the JSON (the parser drops it)', applies: (route) => route.reads.includes('body'), has: (obs) => isJsonType(contentType(obs)?.type) && obs.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) },
  { id: 'json-empty', what: 'an empty body with a JSON type (no body is parsed)', applies: (route) => route.reads.includes('body'), has: (obs) => isJsonType(contentType(obs)?.type) && obs.body.length === 0 },
  { id: 'json-charset-utf8', what: 'an explicit charset=utf-8', applies: (route) => route.reads.includes('body'), has: (obs) => contentType(obs)?.charset === 'utf-8' },
  { id: 'json-charset-other', what: 'a JSON body in another charset (the shared parser refuses it)', applies: (route) => route.reads.includes('body'), has: (obs) => isJsonType(contentType(obs)?.type) && contentType(obs).charset !== null && contentType(obs).charset !== 'utf-8' },
  { id: 'json-plus-type', what: 'an application/*+json type', applies: (route) => route.reads.includes('body'), has: (obs) => /^application\/[^/]*\+json$/.test(contentType(obs)?.type ?? '') },
  { id: 'not-json-type', what: 'a body of a type no shared parser reads (text/plain)', applies: (route) => route.reads.includes('body'), has: (obs) => obs.body.length > 0 && contentType(obs) !== null && !isJsonType(contentType(obs).type) && contentType(obs).type !== 'application/x-www-form-urlencoded' },
  { id: 'no-content-type', what: 'a body with no Content-Type', applies: (route) => route.reads.includes('body'), has: (obs) => obs.body.length > 0 && contentType(obs) === null },
  { id: 'urlencoded', what: 'an application/x-www-form-urlencoded body (the shared parser reads it, extended)', applies: (route) => route.reads.includes('body'), has: (obs) => contentType(obs)?.type === 'application/x-www-form-urlencoded' },
  { id: 'encoding-gzip', what: 'a gzip request body (the parser inflates it)', applies: (route) => route.reads.includes('body'), has: (obs) => encodingOf(obs) === 'gzip' },
  { id: 'encoding-deflate', what: 'a deflate request body (the parser inflates it)', applies: (route) => route.reads.includes('body'), has: (obs) => encodingOf(obs) === 'deflate' },
  { id: 'encoding-brotli', what: 'a brotli request body (the parser decompresses it)', applies: (route) => route.reads.includes('body'), has: (obs) => encodingOf(obs) === 'br' },
  { id: 'encoding-unsupported', what: 'a request body in an encoding the parser does not know (it refuses it)', applies: (route) => route.reads.includes('body'), has: (obs) => !['identity', 'gzip', 'deflate', 'br'].includes(encodingOf(obs)) },
  { id: 'body-over-limit', what: 'a body over the shared parser\'s limit for the path (it refuses it with 413)', applies: (route) => route.reads.includes('body'), has: (obs) => obs.status === 413 },
]);
/** Forms of a path rather than a route: a method no route of the group registers on it, answered by whatever comes after the group. */
export const PATH_FORMS = Object.freeze([
  { id: 'options', what: 'OPTIONS (no route of the group registers it)', has: (obs, methods) => obs.method === 'OPTIONS' && !methods.has('OPTIONS') },
  { id: 'unregistered-method', what: 'a method no route of the group registers on the path', has: (obs, methods) => !['OPTIONS', 'HEAD'].includes(obs.method) && !methods.has(obs.method) },
]);

// ------------------------------------------------------------------ coverage
/** The count V8's take gives position `at` in function `fn` ([start, end]): the innermost range of that function holding it; 0 when the function did not run. */
export function countAt(take, file, fn, at) {
  const script = take.files?.find((entry) => entry.file === file);
  const found = script?.functions.find((entry) => entry.start === fn[0] && entry.end === fn[1]);
  if (!found) return 0;
  let best = null;
  for (const [start, end, count] of found.ranges) if (start <= at && at < end && (best === null || end - start <= best[1] - best[0])) best = [start, end, count];
  return best ? best[2] : 0;
}
/** Whether a take shows the item's probe executed. */
export function probeExecuted(take, item) {
  const at = countAt(take, item.file, item.fn, item.probe.at);
  if (item.probe.minus === undefined) return at > 0;
  return at > countAt(take, item.file, item.fn, item.probe.minus);
}

// ------------------------------------------------------------------ evidence
const rowCounts = (row) => {
  if (!row) return null;
  if (row.outcome === 'passed' && !row.whole) return 'passed';
  if (row.outcome === 'passed' && row.whole) return 'recording';
  if (row.outcome === 'inconclusive' && row.waived && row.checks?.length === 1 && row.checks[0] === 'edge-exchange') return 'edge';
  if (row.outcome === 'inconclusive' && row.waived && row.checks?.length === 1 && row.checks[0] === 'tail-exchange') return 'tail';
  return null;
};

/** Where the tap saw the group write an exchange's answer: its status line (answeredBy) and every header operation, each a group frame. */
const answerSites = (tap) => [tap?.answeredBy, ...(tap?.response?.ops ?? []).map((op) => op.origin)].filter((origin) => origin?.owner === 'group' && typeof origin.file === 'string' && Number.isInteger(origin.line));

/**
 * Every exchange of a reference recording as an observation: the row it
 * belongs to, the arm's process and sequence number, the tap's kind and
 * entry, the request as the tap recorded it, the answer, and the sites the
 * group answered from. A concurrent step's admissible serialisations are
 * observations of the same row marked `serial` (reference-only reruns: they
 * own their coverage takes, and credit nothing).
 */
export function observationsOf(scenarioId, recording, principalClass = (name) => name, touched = null) {
  const out = [];
  for (const step of recording.steps ?? []) {
    const records = [...(step.exchanges ?? []).map((record) => [record, false]), ...(step.admissible ?? []).flatMap((serial) => (serial.exchanges ?? []).map((record) => [record, true]))];
    for (const [record, serial] of records) {
      if (record.notSent !== undefined || !record.tap) continue;
      const tap = record.tap;
      out.push({
        row: `${scenarioId}/${step.id}`, scenario: scenarioId, step: step.id, serial, process: record.process ?? null, seq: record.armSeq ?? null,
        kind: tap.kind, registration: tap.entry?.registration ? { method: tap.entry.registration.method, path: tap.entry.registration.path } : null,
        method: tap.request?.method ?? null, url: tap.request?.startUrl ?? '', headers: headerMap(tap.request?.rawHeaders), body: Buffer.from(tap.request?.body ?? '', 'base64'),
        bodyComplete: tap.request?.bodyComplete ?? null, bodyParsed: tap.entry ? tap.entry.bodyParsedByEdge === true : null,
        status: tap.response?.status ?? null, answer: Buffer.from(tap.response?.body ?? '', 'base64').toString('utf8'), sites: answerSites(tap),
        principal: record.principal ?? null, principalClass: record.principal ? principalClass(record.principal) : null,
        touched: touched === null ? null : touched.has(step.id),
      });
    }
  }
  return out;
}

const short = (text, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const answerOf = (obs) => `${obs.method} ${short(obs.url, 50)} -> ${obs.status} ${short(obs.answer.replace(/\s+/g, ' '), 60)}`;
const sameFile = (site, item) => site.file === item.file || site.file === item.realFile || site.file.endsWith(`/${item.relative}`);
const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
/** Whether the tap saw the group answer this exchange from inside the answer item's span (by line alone when a site has no column). */
export function answeredAt(obs, item) {
  if (!item.span) return false;
  return obs.sites.some((site) => sameFile(site, item) && (Number.isInteger(site.column) ? before(item.span.from, site) && before(site, item.span.to) : site.line >= item.span.from.line && site.line <= item.span.to.line));
}

/**
 * The census. Inputs (all data):
 *   group          the group's name
 *   items          the code items (census-source.mjs)
 *   routes         the routes the registrar's source registers, with what each handler reads
 *   recordings     [{ scenario, recording, touched }]: the reference recording of every scenario of
 *                  the group, and the ids of its steps whose data-root tree changed (null: unknown)
 *   rows           the judged rows (outcomes.mjs judgeRun: outcome, checks, waived, whole)
 *   waivers        { <item id>: { reason } }: items no scenario can exercise, each with why
 *   principals     [{ name, class }]: the principal classes every route is crossed with
 *   sources        { <file>: digest } of the files read now, checked against what the host ran
 *   sourceProblems what the source reading could not read (census-source.mjs groupItems)
 *   errors         [{ call, codes, why }]: the errors a write call of the group can meet in a data-root
 *                  state, each an item `error <code> <call>`
 *   declarations   the group's comparer declarations (closure.mjs): rules P and W at declared keys,
 *                  and the effect kinds it can cause; each is said unused when the group declares none
 * Returns `{ items, gaps, problems, sole, counts }`: every item with its status
 * (exercised, reference-only, waived, gap), the rows that exercised it and the owners seen.
 */
export function judgeCensus({ group, items: codeItems, routes, recordings, rows, waivers = {}, principals = [], sources = null, sourceProblems = [], errors = [], declarations = null }) {
  const problems = [...sourceProblems.map((text) => `source: ${text}`)];
  const notes = [];
  // The comparer's declared rules: unused when nothing is declared; a declared key the census cannot yet show fired is a problem.
  for (const [key, rule] of [['identifierKeys', 'P (identifiers paired by position)'], ['timeKeys', 'W (times against windows)'], ['effects', 'effects (hub events, outbound calls, children)']]) {
    if (!declarations) continue;
    if ((declarations[key] ?? []).length === 0) notes.push(`rule ${rule}: unused, the group declares nothing for it`);
    else problems.push(`rule ${rule} is declared for ${declarations[key].join(', ')}, and the census cannot yet show that it applied at a passed row`);
  }
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const classOf = new Map(principals.map((entry) => [entry.name, entry.class]));
  // The registrations the tap saw against the routes the source registers.
  const registrations = recordings[0]?.recording.registrations ?? [];
  for (const { scenario, recording, touched } of recordings) {
    const mine = JSON.stringify((recording.registrations ?? []).map((entry) => [entry.kind, entry.method, entry.path]));
    if (mine !== JSON.stringify(registrations.map((entry) => [entry.kind, entry.method, entry.path]))) problems.push(`the reference of ${scenario} registered other routes than the reference of ${recordings[0].scenario}`);
    if (!(recording.coverage ?? []).length) problems.push(`the reference of ${scenario} has no block coverage (its host ran without --coverage): no code item can be established`);
    if (sources && !recording.groupSources) problems.push(`the reference of ${scenario} does not say which group files its host ran (no digests): the census cannot tell they are the files read now`);
    if (sources) for (const [file, digest] of Object.entries(recording.groupSources ?? {})) if (sources[file] !== digest) problems.push(`the group file ${file} the reference of ${scenario} ran (${digest}) is not the one read now (${sources[file] ?? 'absent'})`);
    if (touched === null || touched === undefined) problems.push(`the reference of ${scenario} comes without the steps that changed its data root: no write call can be established`);
  }
  const routeRegistrations = registrations.filter((entry) => entry.kind === 'route');
  for (const entry of registrations) if (entry.kind !== 'route') problems.push(`the group registered a ${entry.kind} (${entry.path}) the census has no items for`);
  for (const entry of routeRegistrations) if (!routes.some((route) => route.method === entry.method && route.path === entry.path)) problems.push(`the tap saw route ${entry.method} ${entry.path} (${entry.file}:${entry.line}) that the registrar's source does not register as a literal app.<method>(path, handler)`);
  for (const route of routes) if (!routeRegistrations.some((entry) => entry.method === route.method && entry.path === route.path)) problems.push(`the registrar's source registers ${route.method} ${route.path} (line ${route.line}), which the tap never saw registered`);
  const routeList = routeRegistrations.map((entry) => ({ method: entry.method, path: entry.path, reads: routes.find((route) => route.method === entry.method && route.path === entry.path)?.reads ?? [], matcher: routeMatcher(entry.path) }));
  for (const route of routeList) if (!route.matcher) problems.push(`route ${route.method} ${route.path} uses path syntax the census cannot match requests against`);

  // The universe.
  const items = [];
  const add = (item) => items.push({ ...item, exercisedBy: [], owners: new Set(), evidence: null });
  for (const route of routeList) {
    add({ id: `route ${route.method} ${route.path}`, kind: 'route', label: `${route.method} ${route.path}`, route });
    if (route.method === 'GET') add({ id: `route HEAD ${route.path}`, kind: 'route', label: `HEAD ${route.path} (Express answers it with the GET handler)`, route: { ...route, method: 'HEAD', implicitOf: 'GET' } });
  }
  const classes = [...new Set(principals.map((entry) => entry.class))];
  for (const route of routeList) for (const principalClass of classes) add({ id: `principal ${principalClass} ${route.method} ${route.path}`, kind: 'principal', label: `${route.method} ${route.path} as ${principalClass}`, route, principalClass });
  for (const route of routeList) for (const form of FORMS) if (form.applies(route)) add({ id: `form ${form.id} ${route.method} ${route.path}`, kind: 'form', label: `${route.method} ${route.path}: ${form.what}`, route, form });
  const paths = [...new Set(routeList.map((route) => route.path))];
  for (const routePath of paths) for (const form of PATH_FORMS) add({ id: `form ${form.id} ${routePath}`, kind: 'path-form', label: `${routePath}: ${form.what}`, routePath, form, methods: new Set(routeList.filter((route) => route.path === routePath).flatMap((route) => (route.method === 'GET' ? ['GET', 'HEAD'] : [route.method]))) });
  for (const item of codeItems) add({ ...item, kind: 'code', codeKind: item.kind });
  const codeById = new Map(codeItems.map((item) => [item.id, item]));
  for (const declared of errors) {
    const call = codeById.get(declared.call);
    if (!call || call.kind !== 'call') { problems.push(`declared errors of ${declared.call}: no call item has that id`); continue; }
    for (const code of declared.codes) add({ id: `error ${code} ${declared.call}`, kind: 'error', label: `${call.label} meets ${code} (${declared.why})`, code, call, relative: call.relative, line: call.line });
  }
  const ids = new Set();
  for (const item of items) { if (ids.has(item.id)) problems.push(`item ${item.id} appears twice`); ids.add(item.id); }

  // The observations and what each row's exchanges ran.
  const touchedOf = new Map(recordings.map(({ scenario, touched }) => [scenario, touched === null || touched === undefined ? null : new Set(touched)]));
  const observations = recordings.flatMap(({ scenario, recording }) => observationsOf(scenario, recording, (name) => classOf.get(name) ?? name, touchedOf.get(scenario)));
  const exercise = (item, obs, how) => { item.exercisedBy.push(obs.row); item.owners.add(how); item.evidence ??= answerOf(obs); };
  const targets = (route, obs, normalised = false) => {
    const method = obs.method === route.method || (route.method === 'GET' && obs.method === 'HEAD');
    if (normalised) return obs.kind !== 'group' && method && route.matcher?.test(normalisedPath(obs.url));
    if (obs.kind === 'group') return obs.registration?.path === route.path && (obs.registration.method === route.method || (route.method === 'GET' && obs.method === 'HEAD'));
    return route.matcher?.test(pathOf(obs.url)) && method;
  };
  for (const obs of observations) {
    if (obs.serial) continue;
    const counts = rowCounts(rowById.get(obs.row));
    const owner = obs.kind === 'group' && counts === 'passed' ? 'group' : obs.kind === 'edge' && counts === 'edge' ? 'edge' : obs.kind === 'tail' && counts === 'tail' ? 'tail' : null;
    if (!owner) continue;
    for (const item of items) {
      if (item.kind === 'route') {
        if (owner === 'group' && obs.method === item.route.method && obs.registration?.path === item.route.path && obs.registration.method === (item.route.implicitOf ?? item.route.method)) exercise(item, obs, 'group');
      } else if (item.kind === 'principal') {
        if (obs.principalClass === item.principalClass && targets(item.route, obs)) exercise(item, obs, owner);
      } else if (item.kind === 'form') {
        if (targets(item.route, obs, item.form.normalised === true) && item.form.has(obs, item.route)) exercise(item, obs, owner);
      } else if (item.kind === 'path-form') {
        const matches = routeList.some((route) => route.path === item.routePath && route.matcher?.test(pathOf(obs.url)));
        if (matches && item.form.has(obs, item.methods)) exercise(item, obs, owner);
      }
    }
  }
  // Block coverage: each take belongs to the exchange (process, seq) it was taken for, or, at seq 0, to the host's start or stop.
  const codeItemsHere = items.filter((item) => item.kind === 'code');
  const errorItems = items.filter((item) => item.kind === 'error');
  // Every function V8 reports must be one the source reading found (its span is some item's `fn`): else its blocks cannot be placed.
  const knownFunctions = new Set(codeItems.map((item) => `${item.file}\0${item.fn[0]}\0${item.fn[1]}`));
  const unplaced = new Set();
  for (const { scenario, recording } of recordings) {
    const exchangeRow = new Map();
    for (const obs of observations.filter((entry) => entry.scenario === scenario)) if (obs.process !== null && obs.seq !== null) exchangeRow.set(`${obs.process}:${obs.seq}`, obs);
    for (const take of recording.coverage ?? []) {
      for (const script of take.files ?? []) for (const fn of script.functions) {
        const key = `${script.file}\0${fn.start}\0${fn.end}`;
        if (!knownFunctions.has(key) && !unplaced.has(key)) { unplaced.add(key); problems.push(`V8 reported a function ${fn.name || '(anonymous)'} at ${script.file}:${fn.start}-${fn.end} that no item of the source names: its blocks cannot be placed`); }
        if (fn.block === false && fn.ranges.some(([, , count]) => count > 0)) problems.push(`V8 counted function ${fn.name || '(anonymous)'} at ${script.file}:${fn.start} without block counts`);
      }
      let obs = null;
      let rowId;
      if (take.seq > 0) {
        obs = exchangeRow.get(`${take.process}:${take.seq}`) ?? null;
        rowId = obs?.row ?? null;
      } else rowId = take.phase === 'start' ? `${scenario}/${RECORDING_ROW}` : null;
      const ran = codeItemsHere.filter((item) => probeExecuted(take, item));
      if (!ran.length) continue;
      if (!rowId) { problems.push(`a coverage take of ${scenario} (process ${take.process}, ${take.phase}, exchange ${take.seq}) ran group code no exchange of the recording owns: ${ran.slice(0, 3).map((item) => item.id).join('; ')}`); continue; }
      // Group code during an exchange the edge or the tail answered: the tap and V8 disagree about who answered it.
      if (obs && obs.kind !== 'group') { problems.push(`a coverage take of ${scenario} (process ${take.process}, exchange ${take.seq}, ${obs.row}) ran group code during an exchange the ${obs.kind} answered: ${ran.slice(0, 3).map((item) => item.id).join('; ')}`); continue; }
      if (obs?.serial) continue;
      const counts = rowCounts(rowById.get(rowId));
      const credited = (take.seq > 0 && counts === 'passed' && obs?.kind === 'group') || (take.seq === 0 && counts === 'recording');
      if (!credited) continue;
      for (const item of ran) {
        // What V8 cannot tell from a block count: an answer must be the exchange's answer, a write must have changed the tree.
        if (item.codeKind === 'answer' && !(obs && answeredAt(obs, item))) continue;
        if (item.codeKind === 'call' && item.writes && !(obs && obs.touched === true)) continue;
        item.exercisedBy.push(rowId); item.owners.add('group'); item.evidence ??= obs ? answerOf(obs) : 'at the host\'s start';
      }
      if (obs) for (const item of errorItems) if (ran.includes(byIdOf(items, item.call.id)) && obs.answer.includes(`${item.code}:`)) { item.exercisedBy.push(rowId); item.owners.add('group'); item.evidence ??= answerOf(obs); }
    }
  }

  // Waivers, gaps, and what each scenario alone exercises.
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const [id, waiver] of Object.entries(waivers)) {
    if (!byId.has(id)) { problems.push(`census waiver ${id} names no item`); continue; }
    if (typeof waiver?.reason !== 'string' || waiver.reason.trim().length < 20) problems.push(`census waiver ${id} has no reason`);
    else if (byId.get(id).exercisedBy.length) problems.push(`census waiver ${id} waives an item that is exercised (${byId.get(id).exercisedBy[0]})`);
  }
  const gaps = [];
  for (const item of items) {
    item.exercisedBy = [...new Set(item.exercisedBy)];
    const waiver = Object.hasOwn(waivers, item.id) ? waivers[item.id] : null;
    item.status = item.owners.has('group') ? 'exercised' : item.exercisedBy.length ? 'reference-only' : waiver && typeof waiver.reason === 'string' && waiver.reason.trim().length >= 20 ? 'waived' : 'gap';
    item.waived = item.status === 'waived' ? waiver.reason : null;
    if (item.status === 'gap') gaps.push(`${group}: ${item.id} (${item.kind === 'code' || item.kind === 'error' ? `${item.relative}:${item.line}` : item.label}) is exercised by no row that passed`);
  }
  const sole = {};
  for (const { scenario } of recordings) sole[scenario] = items.filter((item) => item.exercisedBy.length && item.exercisedBy.every((row) => row.startsWith(`${scenario}/`))).map((item) => item.id);
  const counts = { items: items.length, ...Object.fromEntries(STATUSES.map((status) => [status, 0])) };
  for (const item of items) counts[item.status] += 1;
  // The items as data: a route's method and path, a form's id, an error's call id; no matcher or predicate.
  const plain = (item) => ({ ...Object.fromEntries(Object.entries(item).filter(([key]) => !['route', 'form', 'methods', 'call'].includes(key))), ...(item.route ? { route: { method: item.route.method, path: item.route.path } } : {}), ...(item.form ? { form: item.form.id } : {}), ...(item.call ? { call: item.call.id } : {}), owners: [...item.owners].sort() });
  return { version: CENSUS_VERSION, notes, items: items.map(plain), gaps, problems, sole, counts };
}
const byIdOf = (items, id) => items.find((item) => item.id === id);

/** The census as report lines: one per item, then each scenario's sole exercises, then the counts. */
export function censusLines(census) {
  const lines = [];
  const mark = { exercised: 'CENSUS ok  ', 'reference-only': 'CENSUS ref ', waived: 'CENSUS waived', gap: 'CENSUS GAP ' };
  for (const item of census.items) {
    const where = item.kind === 'code' || item.kind === 'error' ? ` (${item.relative}:${item.line})` : '';
    const by = () => ` <- ${item.exercisedBy[0]}${item.exercisedBy.length > 1 ? ` (+${item.exercisedBy.length - 1})` : ''} [${item.owners.join('+')}]`;
    const how = item.status === 'exercised' ? by() : item.status === 'reference-only' ? `${by()} (reference only: never sent to a candidate)` : item.status === 'waived' ? `: ${item.waived}` : '';
    lines.push(`${mark[item.status]} ${item.id}${where}${how}`);
  }
  for (const [scenario, ids] of Object.entries(census.sole)) lines.push(`CENSUS sole ${scenario}: ${ids.length} items exercised by this scenario alone`);
  for (const note of census.notes ?? []) lines.push(`CENSUS note ${note}`);
  for (const problem of census.problems) lines.push(`CENSUS PROBLEM ${problem}`);
  lines.push(`census: ${census.counts.items} items: ${census.counts.exercised} exercised, ${census.counts['reference-only']} reference only, ${census.counts.waived} waived, ${census.counts.gap} gaps; ${census.problems.length} problems`);
  return lines;
}

/** The census without one scenario: its recording and rows removed (the items that lose their only exercise become gaps). */
export function withoutScenario(input, scenarioId) {
  return { ...input, recordings: input.recordings.filter((entry) => entry.scenario !== scenarioId), rows: input.rows.filter((row) => !row.id.startsWith(`${scenarioId}/`)) };
}

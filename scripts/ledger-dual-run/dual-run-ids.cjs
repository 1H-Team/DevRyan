// The identifier protocol of a comparable dual run, shared by every
// implementation (docs/TESTING.md, "Identifiers and time").
//
// With LEDGER_DUAL_RUN_IDS=<seed> in its environment, a ledger draws every
// random identifier from this function instead of its random source:
//
//   protocolUUID(seed, call, site, n)
//     = the hex of sha256(`${seed}:${call}:${site}:${n}`), laid out as a UUID
//       (8-4-4-4-12) with the version nibble set to 4 and the variant nibble to 8
//
// where `call` is the `id` of the seam `call` message whose work draws it
// (work a call started counts for that call even after its result was sent;
// anything else is `background`), `site` is one of SITES below, and `n` counts
// draws per (call, site) from 1. A UUID used without dashes or as a hex token
// is the same value transformed as the implementation transforms it.
//
// The names are the contract; how an implementation finds them in its own
// code is its business. ID_SITES maps the JavaScript ledger's draws to them by
// the source text around each draw (the line and the next), so a moved line
// or a comment keeps its name and an edited draw falls out of the table loudly
// (the preload logs it, the harness fails the run).
'use strict';
const { createHash } = require('node:crypto');

/** Every named draw site, with what it names. */
const SITES = Object.freeze({
  lease: 'a lease token (views/<token>, refs/devryan/leases/<token>, leases/<sha256(token)>.json)',
  document: 'a file document ID (files/<sha256(id)>.json)',
  operation: 'an operation ID (operations/<sha256(id)>.json): publications, reconciled outside changes, direct receipts',
  materialization: 'a materialization intent (materializations/<id>/ pages)',
  transaction: 'a revert, redo or file-restore transaction ID',
  hold: 'a native admission hold ID',
  removal: 'a native removal intent ID',
  standby: 'a parked or discarded view folder (view-standby/<id>)',
  temporary: 'any temporary file name, never left at rest (.pending-*, tmp_obj_*, *.devryan-*, *.index, *.metadata-index, lock and atomic-write temporaries)',
  'lock-owner': 'the ownerToken of a cross-process lock file (owner.lock), never left at rest',
});

/** [site, file basename (null: any), pattern over the draw's line and the next]. First match wins. */
const ID_SITES = Object.freeze([
  ['lease', 'session-mutations.js', /const token = randomUUID\(\), viewDirectory = /],
  ['document', 'session-mutations.js', /doc \?\?= \{ id: randomUUID\(\), published: null \}/],
  ['operation', 'session-mutations.js', /operation = (doc \? )?\{ id: randomUUID\(\), sequence: next\(repo\)/],
  ['materialization', 'session-mutations.js', /const id = randomUUID\(\);\n\s*await repo\.db\.setList\(`materializations\//],
  ['transaction', 'session-mutations.js', /const id = randomUUID\(\);\n\s*repo\.db\.remove\(key\('last-redos'/],
  ['transaction', 'session-mutations.js', /const id = randomUUID\(\), tx = \{ id, rootSessionID: input\.sessionID/],
  ['transaction', 'session-mutations.js', /const id = randomUUID\(\);\n\s*\/\/ A hidden descendant may still publish/],
  ['hold', 'session-mutations.js', /holds: \[\.\.\.state\.holds, \{ id: randomUUID\(\), ownerID, removalID: intent\.id \}\]/],
  ['hold', 'session-mutations.js', /: \{ id: randomUUID\(\), ownerID: input\.ownerID/],
  ['removal', 'session-mutations.js', /const intent = \{ id: randomUUID\(\), directory: input\.directory/],
  ['standby', 'session-mutations.js', /path\.join\((?:record\.root|repo\.root|root), 'view-standby'\)?,? ?(?:directory = path\.join\(parent, )?randomUUID\(\)\)|path\.join\(parent, randomUUID\(\)\)/],
  ['temporary', null, /\.devryan-\$\{randomUUID\(\)\}`|\.pending-\$\{randomUUID\(\)\}`|tmp_obj_\$\{crypto\.randomUUID\(\)\}`|\$\{crypto\.randomUUID\(\)\}\.(?:metadata-)?index`|\.\$\{VERIFIED_OBJECTS_FILE\}-\$\{randomUUID\(\)\}`|\.tmp-\$\{process\.pid\}-\$\{crypto\.randomUUID\(\)\}`|randomId \?\? \(\(\) => crypto\.randomUUID\(\)/],
  ['lock-owner', 'atomic-file.js', /ownerToken = \(options\.randomToken \?\? \(\(\) => crypto\.randomUUID\(\)/],
]);

/** The site name of a JavaScript draw, from its file's basename and the text of its line and the next; null when unlisted. */
function siteOf(file, text) {
  for (const [site, basename, pattern] of ID_SITES) if ((basename === null || basename === file) && pattern.test(text)) return site;
  return null;
}

function protocolUUID(seed, call, site, n) {
  const hex = createHash('sha256').update(`${seed}:${call}:${site}:${n}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { SITES, ID_SITES, siteOf, protocolUUID };

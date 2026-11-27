// What a group's source says it can do (BH5, the census; design file 31
// §8.3): every branch, answer, throw and dependency call of the group's
// files, read with the repository's TypeScript, each with the position whose
// block coverage says whether an exchange took it (block-coverage.mjs), and
// what each route handler reads of the request and of the principal envelope.
//
// An item is `{ id, kind, file, line, label, fn: [start, end], probe }`:
//   kind    module | function | then | else | case | loop | catch | true | false | decides | reached
//           | answer | throw | call | envelope
//   fn      the span of the innermost function holding it, as V8 reports that
//           function's own range (the module itself is [0, length])
//   probe   { at } executed when the count at `at` is above zero; { at, minus } when the count
//           at `at` is above the count at `minus` (an if without an else: it ran and its then did
//           not; an operand of a || or && chain: it was evaluated and the next one was not)
// The id names the file, the function path and the construct by its text
// (not by its line), with `#n` for a repeat, so a waiver keeps naming the
// same construct when lines move and stops matching when the construct
// changes: a text cut for length carries a digest of the whole text
// (`…~<8 hex>`), so an edit past the cut changes the id too.
//
// An answer item also carries its span (`span: { from, to }`, 1-based line
// and column): the census credits it only through an exchange whose tap saw
// the group write its answer from inside that span (coverage-census.mjs).
// A handler's request parameter is read only through `req.<part>`; any other
// use (destructuring it, passing it on, a computed member) is recorded as
// opaque on its route, and the census reads that as a problem. Every module
// a group file imports is listed (`imports`), and groupItems names each
// relative import that is not one of the group's files.
//
// Not items, because V8 counts no block for them: the short-circuit of `?.`,
// a default value of a parameter or a destructuring, and which of two equal
// branches of a chain decided (`a || b` true at a, or false at b and true at
// b, are told apart only through the next operand). A computed property or
// a call through a variable (`res[name]()`, `const send = res.json`) is not
// seen as an answer; it is still inside a block that is an item.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ts = createRequire(path.join(HERE, '../../package.json'))('@typescript/typescript6');

const ROUTE_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'all']);
const ANSWER_METHODS = new Set(['status', 'json', 'send', 'end', 'sendStatus', 'set', 'setHeader', 'header', 'type', 'redirect', 'sendFile', 'download', 'cookie', 'clearCookie', 'write', 'writeHead', 'location', 'attachment', 'format', 'jsonp', 'vary', 'append', 'removeHeader']);
/** Methods of an injected file-system dependency that change the tree. */
export const WRITE_CALLS = Object.freeze(new Set(['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'symlink', 'link', 'chmod', 'chown', 'lchown', 'truncate', 'utimes', 'lutimes', 'open', 'createWriteStream', 'writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync']));
/** What of the request a handler reads, by property of its first parameter. */
const REQUEST_PARTS = Object.freeze({ body: 'body', params: 'params', query: 'query', headers: 'headers', get: 'headers', header: 'headers', cookies: 'cookies', principal: 'principal', ip: 'peer', ips: 'peer', socket: 'peer', connection: 'peer', originalUrl: 'originalUrl', hostname: 'headers', protocol: 'peer', secure: 'peer' });
/** The envelope fields (design §6) each request part or product reader stands for. */
const ENVELOPE_OF = Object.freeze({ principal: 'principal', peer: 'peer', originalUrl: 'originalUrl' });
const CONTEXT_READERS = Object.freeze({ getRequestPrincipal: 'principal', getRequestAssignment: 'assignment', isDirectLocalRequest: 'peer', getTunnelOwnerPrincipal: 'peer', captureAuthorization: 'authorizationActive' });

/** Every request part a handler can read (what an opaque use of the request is taken to read). */
export const ALL_REQUEST_PARTS = Object.freeze([...new Set(Object.values(REQUEST_PARTS))].sort());

/** A construct's text on one line, cut at `max` characters; a cut text ends with a digest of the whole (an id must change with any edit). */
const squash = (text, max = 70) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…~${crypto.createHash('sha256').update(flat).digest('hex').slice(0, 8)}`;
};

/** The name a function literal goes by: its own, its variable's, its property's, or what it is handed to. */
function functionName(node, source) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) return parent.name.getText(source);
  if (ts.isCallExpression(parent)) {
    const route = routeCall(parent, source);
    if (route) return `${route.method} ${route.path} handler`;
    return `${squash(parent.expression.getText(source), 40)}(callback)`;
  }
  return `anonymous@${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

/** `app.<method>('<path>', ...handlers)`: the route a call registers, or null. */
function routeCall(call, source) {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  if (!ROUTE_METHODS.has(method) || call.arguments.length < 2) return null;
  const first = call.arguments[0];
  if (!ts.isStringLiteralLike(first)) return null;
  const receiver = call.expression.expression.getText(source);
  return { method: method.toUpperCase(), path: first.text, receiver };
}

/** Flattens a chain of the same logical operator into its operands, left to right. */
function chainOperands(node, kind) {
  const out = [];
  const walk = (expr) => {
    const inner = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === kind) { walk(inner.left); walk(inner.right); } else out.push(expr);
  };
  walk(node);
  return out;
}
const LOGICAL = new Map([[ts.SyntaxKind.BarBarToken, '||'], [ts.SyntaxKind.AmpersandAmpersandToken, '&&'], [ts.SyntaxKind.QuestionQuestionToken, '??']]);

/** `req.<part>` (or `req?.<part>`): the request read through a part the census knows. */
const isReadOfPart = (node) => ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && Object.hasOwn(REQUEST_PARTS, node.parent.name.text);
/** The identifier is not a use of the variable: a declaration's name, a property name, a member name. */
const isDeclarationName = (node) => {
  const parent = node.parent;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)) return true;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return true;
  return false;
};

/**
 * The items of one file. `text` is its source (the bytes V8 compiled);
 * `relative` the name items carry; `dependencies` the names the registrar's
 * dependencies are bound to in the group's files (calls on them are `call`
 * items, a `writes` flag on file-system writes).
 */
export function fileItems({ file, relative = path.basename(file), text = fs.readFileSync(file, 'utf8'), dependencies = [] }) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const items = [];
  const routes = [];
  const seen = new Map();
  const dependencyNames = new Set(dependencies);
  const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const placeOf = (pos) => { const { line, character } = source.getLineAndCharacterOfPosition(pos); return { line: line + 1, column: character + 1 }; };
  const imports = [];
  const add = (kind, node, label, fnStack, probe, extra = {}) => {
    const fn = fnStack.at(-1);
    const base = `${relative}:${fn.path}:${kind} ${label}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    items.push({ id: count === 1 ? base : `${base}#${count}`, kind, file, relative, line: lineOf(node.getStart(source)), label, fn: fn.span, function: fn.path, probe, ...extra });
  };
  const visit = (node, fnStack, handler) => {
    if (ts.isFunctionLike(node) && node.body) {
      const name = functionName(node, source);
      const fnPath = fnStack.length > 1 ? `${fnStack.at(-1).path}>${name}` : name;
      const route = ts.isCallExpression(node.parent) ? routeCall(node.parent, source) : null;
      const frame = { path: fnPath, span: [node.getStart(source), node.end] };
      const stack = [...fnStack, frame];
      add('function', node, name, stack, { at: node.body.getStart(source) });
      const first = node.parameters[0]?.name;
      const nextHandler = route ? { route, request: first && ts.isIdentifier(first) ? first.text : null, response: node.parameters[1]?.name?.getText(source) ?? null, reads: new Set(), opaque: [], line: lineOf(node.getStart(source)) } : handler;
      // A request parameter written as a pattern (`({ body }, res) =>`): what it reads is not `req.<part>`.
      if (route && first && !ts.isIdentifier(first)) nextHandler.opaque.push({ line: lineOf(first.getStart(source)), text: squash(first.getText(source), 60) });
      if (route) routes.push(nextHandler);
      ts.forEachChild(node, (child) => visit(child, stack, nextHandler));
      return;
    }
    if (ts.isIfStatement(node)) {
      const condition = squash(node.expression.getText(source));
      add('then', node, `if (${condition})`, fnStack, { at: node.thenStatement.getStart(source) });
      if (node.elseStatement) add('else', node, `if (${condition})`, fnStack, { at: node.elseStatement.getStart(source) });
      else add('else', node, `if (${condition}) (no else)`, fnStack, { at: node.getStart(source), minus: node.thenStatement.getStart(source) });
    } else if (ts.isConditionalExpression(node)) {
      const condition = squash(node.condition.getText(source));
      add('true', node, `${condition} ? ${squash(node.whenTrue.getText(source), 30)}`, fnStack, { at: node.whenTrue.getStart(source) });
      add('false', node, `${condition} : ${squash(node.whenFalse.getText(source), 30)}`, fnStack, { at: node.whenFalse.getStart(source) });
    } else if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind) && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === node.operatorToken.kind && node.parent.left === node)) {
      // The outermost node of a chain of one operator: one item per operand.
      const operator = LOGICAL.get(node.operatorToken.kind);
      const operands = chainOperands(node, node.operatorToken.kind);
      const chain = squash(node.getText(source), 50);
      operands.forEach((operand, index) => {
        const label = `${squash(operand.getText(source), 50)} (operand ${index + 1} of ${operator} chain ${chain})`;
        if (index < operands.length - 1) add('decides', operand, label, fnStack, { at: operand.getStart(source), minus: operands[index + 1].getStart(source) });
        else add('reached', operand, label, fnStack, { at: operand.getStart(source) });
      });
    } else if (ts.isCatchClause(node)) {
      add('catch', node, `catch (${node.variableDeclaration?.getText(source) ?? ''})`, fnStack, { at: node.block.getStart(source) });
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      const label = ts.isCaseClause(node) ? `case ${squash(node.expression.getText(source), 40)}` : 'default';
      add('case', node, label, fnStack, { at: node.statements[0]?.getStart(source) ?? node.getStart(source) });
    } else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      add('loop', node, `${squash(node.getText(source).split('{')[0], 50)} body`, fnStack, { at: node.statement.getStart(source) });
    } else if (ts.isThrowStatement(node)) {
      add('throw', node, squash(node.expression.getText(source)), fnStack, { at: node.getStart(source) });
    } else if (ts.isCallExpression(node)) {
      callItem(node, fnStack, handler);
    }
    if (handler && handler.request && ts.isIdentifier(node) && node.text === handler.request && !isReadOfPart(node) && !isDeclarationName(node)) {
      // Any other use of the request (destructured, handed on, a computed member): the census cannot read what it reads.
      const statement = ts.findAncestor(node, (entry) => ts.isStatement(entry)) ?? node;
      handler.opaque.push({ line: lineOf(node.getStart(source)), text: squash(statement.getText(source), 60) });
    }
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      imports.push({ specifier: ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null, line: lineOf(node.getStart(source)) });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      imports.push({ specifier: node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : null, line: lineOf(node.getStart(source)) });
    }
    if (handler && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === handler.request && Object.hasOwn(REQUEST_PARTS, node.name.text)) {
      const part = REQUEST_PARTS[node.name.text];
      handler.reads.add(part);
      if (ENVELOPE_OF[part]) add('envelope', node, `${ENVELOPE_OF[part]} (${node.getText(source)})`, fnStack, { at: node.getStart(source) }, { field: ENVELOPE_OF[part] });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && Object.hasOwn(CONTEXT_READERS, node.expression.text)) {
      add('envelope', node, `${CONTEXT_READERS[node.expression.text]} (${node.expression.text}())`, fnStack, { at: node.getStart(source) }, { field: CONTEXT_READERS[node.expression.text] });
    }
    ts.forEachChild(node, (child) => visit(child, fnStack, handler));
  };
  // A call is an item once, at the outermost call of its chain (`res.status(400).json(...)` is one answer).
  const counted = new Set();
  const callItem = (node, fnStack, handler) => {
    let outer = node;
    while (ts.isPropertyAccessExpression(outer.parent) && ts.isCallExpression(outer.parent.parent) && outer.parent.parent.expression === outer.parent) outer = outer.parent.parent;
    if (counted.has(outer)) return;
    let base = outer.expression;
    while (ts.isCallExpression(base) || ts.isPropertyAccessExpression(base)) base = ts.isCallExpression(base) ? base.expression : base.expression;
    if (!ts.isIdentifier(base)) return;
    const text = squash(outer.getText(source), 90);
    if (handler && base.text === handler.response) {
      const methods = [];
      for (let at = outer; ts.isCallExpression(at) && ts.isPropertyAccessExpression(at.expression); at = at.expression.expression) methods.unshift(at.expression.name.text);
      if (!methods.some((method) => ANSWER_METHODS.has(method))) return;
      counted.add(outer);
      add('answer', outer, text, fnStack, { at: outer.getStart(source) }, { route: `${handler.route.method} ${handler.route.path}`, span: { from: placeOf(outer.getStart(source)), to: placeOf(outer.end) } });
    } else if (dependencyNames.has(base.text) && ts.isPropertyAccessExpression(outer.expression)) {
      counted.add(outer);
      const method = outer.expression.name.text;
      add('call', outer, text, fnStack, { at: outer.getStart(source) }, { dependency: base.text, method, writes: WRITE_CALLS.has(method) });
    }
  };
  const top = [{ path: '(module)', span: [0, text.length] }];
  // The module's own evaluation (at import, so at the host's start).
  items.push({ id: `${relative}:(module):module`, kind: 'module', file, relative, line: 1, label: 'the module is evaluated', fn: top[0].span, function: '(module)', probe: { at: 0 } });
  visit(source, top, null);
  return { items, imports, routes: routes.map((entry) => ({ method: entry.route.method, path: entry.route.path, line: entry.line, file, reads: entry.opaque.length ? [...ALL_REQUEST_PARTS] : [...entry.reads].sort(), opaque: entry.opaque })) };
}

/**
 * Every item of a group's files (absolute paths), the routes its source
 * registers with what each handler reads, and the problems of the reading:
 * a relative import of a group file that is not a group file (its code would
 * have no items) unless `outside` names it (absolute path: a module the group
 * uses that is not its own, such as a shared product helper), an import the
 * reader cannot resolve (not a literal), and a handler whose use of the
 * request it cannot read.
 */
export function groupItems({ files, dependencies = [], root = path.dirname(files[0] ?? ''), outside = [] }) {
  const items = [];
  const routes = [];
  const problems = [];
  const own = new Set(files.map((file) => path.resolve(file)));
  const declared = new Set(outside.map((file) => path.resolve(file)));
  for (const file of files) {
    const relative = path.relative(root, file) || path.basename(file);
    const found = fileItems({ file, relative, dependencies });
    items.push(...found.items);
    routes.push(...found.routes);
    for (const entry of found.imports) {
      if (entry.specifier === null) { problems.push(`${relative}:${entry.line} imports a module named by an expression: the census cannot tell whether its code is the group's`); continue; }
      if (!entry.specifier.startsWith('.') && !entry.specifier.startsWith('/')) continue;
      const target = path.resolve(path.dirname(file), entry.specifier);
      if (!own.has(target) && !declared.has(target)) problems.push(`${relative}:${entry.line} imports ${entry.specifier} (${path.relative(root, target)}), which is not one of the group's files: its code has no census items (add it to the group's files, or declare it as a module outside the group)`);
    }
    for (const route of found.routes) for (const use of route.opaque) problems.push(`the handler of ${route.method} ${route.path} (${relative}:${use.line}) uses its request in a way the census cannot read (${use.text}): the forms that depend on what it reads cannot be derived, so every form is applied to it`);
  }
  const ids = new Set();
  for (const item of items) { if (ids.has(item.id)) throw new Error(`census: item id ${item.id} appears twice`); ids.add(item.id); }
  return { items, routes, problems };
}

// The composition drift detector (BH1; design file 31 §10 risk 1, the fix
// round's decision 1). Pure: it reads source text it is handed and a table of
// classified statements, and returns problems. The table of the real server
// and the check of the real files live in the drift module (docs/TESTING.md),
// which the self-test never loads and nothing it loads names: an edit to the
// server's composition must neither select nor fail the self-test (decision 2).
//
// A span is the run of statements of one block, from a start statement to the
// statement that makes the group's call, and the statements after it to the
// end of the block (they still run before any request: a setting Express
// reads per request, a layer the group can pass a request to). A statement is
// relevant when it
//   - mentions a tracked name: the roots (the app, the HTTP server, the edge's
//     state objects) and every name a relevant statement binds, after it;
//   - reads a root as a property (`state.expressApp.use(…)`);
//   - mutates an object the composition uses: a property of anything an entry
//     or a definition reads, of an import, or of a span parameter
//     (`express.response.json = …`, `Object.assign(compression, …)`);
//   - calls, or passes, a function of this file whose body reaches a tracked
//     name, directly or through another such function.
// Comments never count (the source is parsed, and statements are compared as
// printed without comments, with strings in single quotes and without
// parentheses around a bare name or literal). Every relevant statement, and
// every statement that declares or assigns a name a classified entry reads
// (transitively), must match a table entry by its printed text, in table
// order. Anything else is drift:
//   unclassified  a relevant statement no entry covers
//   changed       an entry whose statement is no longer there in that text
//   moved         an entry whose statement is there, out of table order
// A name a classified entry reads that no statement of the span declares is
// looked up in the whole file; each of its declarations must match the
// table's `definitions` (a re-stated helper or binding outside the span, the
// import of a registrar). A not-applicable entry must read every name it calls
// through to hand over the app or the server, so the module that registers is
// pinned (the reach check reads the census, which imports its own copy).
//
// What reading the text cannot see, by construction: a patch or a setting made
// in another module (a module that changes express.response when imported, a
// registrar that calls app.set), a function defined in another module that
// reaches the app, and what a caller does with the app this file returns. The
// group host refuses to serve when composing the edge changed the framework's
// shared objects (group-host.mjs, framework snapshot), which covers a module
// the host loads; a module only the server loads is seen by neither.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The repository's own TypeScript (a root devDependency the import-boundary checker already uses).
const ts = createRequire(path.join(HERE, '../../package.json'))('@typescript/typescript6');

export const CLASSES = Object.freeze(['composed', 'not-applicable', 'no-request']);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
// Spellings that never change what a statement does: a string's quotes, and parentheses around a bare name or literal.
const spelling = (context) => (root) => {
  const visit = (node) => {
    if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text, true);
    if (ts.isParenthesizedExpression(node) && (ts.isIdentifier(node.expression) || ts.isStringLiteral(node.expression) || ts.isNumericLiteral(node.expression))) return visit(node.expression);
    return ts.visitEachChild(node, visit, context);
  };
  return visit(root);
};

/** A statement as compared: printed without comments, single-quoted, without redundant parentheses, whitespace collapsed. */
export const statementText = (node, sourceFile) => {
  const result = ts.transform(node, [spelling]);
  try { return printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], sourceFile).replace(/\s+/g, ' ').trim(); } finally { result.dispose(); }
};
export const textDigest = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const GLOBAL_NAMES = new Set(['Object', 'Array', 'Promise', 'JSON', 'console', 'process', 'Number', 'String', 'Boolean', 'Symbol', 'Reflect', 'Math', 'Date', 'Error', 'Map', 'Set', 'URL', 'Buffer', 'globalThis', 'setTimeout', 'setImmediate', 'clearTimeout', 'queueMicrotask', 'structuredClone']);
const isFunctionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

/** Names a node reads (identifiers in reference position; property names and declared names excluded). */
export function referencedNames(node) {
  const names = new Set();
  const visit = (current) => {
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const notReference = (ts.isPropertyAccessExpression(parent) && parent.name === current)
        || (ts.isPropertyAssignment(parent) && parent.name === current)
        || (ts.isBindingElement(parent) && parent.propertyName === current)
        || (ts.isMethodDeclaration(parent) && parent.name === current)
        || (ts.isPropertyDeclaration(parent) && parent.name === current)
        || (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent));
      if (!notReference) names.add(current.text);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

const bindingNames = (name, out) => {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
};
const assignmentTargets = (target, out) => {
  if (ts.isIdentifier(target)) out.add(target.text);
  else if (ts.isObjectLiteralExpression(target)) for (const property of target.properties) {
    if (ts.isShorthandPropertyAssignment(property)) out.add(property.name.text);
    else if (ts.isPropertyAssignment(property)) assignmentTargets(property.initializer, out);
  } else if (ts.isArrayLiteralExpression(target)) for (const element of target.elements) assignmentTargets(element, out);
  else if (ts.isParenthesizedExpression(target)) assignmentTargets(target.expression, out);
};
/** Names a statement declares or assigns, outside nested functions. */
export function boundNames(statement) {
  const names = new Set();
  const visit = (node) => {
    if (node !== statement && isFunctionLike(node)) { if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text); return; }
    if (ts.isVariableDeclaration(node)) bindingNames(node.name, names);
    else if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    else if (ts.isClassDeclaration(node) && node.name) names.add(node.name.text);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assignmentTargets(node.left, names);
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return names;
}

/** The name an access chain starts from (`a` of `a.b[c].d`), or null. */
const rootOf = (expression) => {
  let current = expression;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isCallExpression(current))) current = current.expression;
  return current && ts.isIdentifier(current) ? current.text : null;
};
const isAccess = (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
const MUTATORS = new Set(['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Object.setPrototypeOf', 'Reflect.set', 'Reflect.defineProperty', 'Reflect.deleteProperty', 'Reflect.setPrototypeOf']);
/** Names whose objects a node mutates anywhere inside it: `x.y = …`, `x.y++`, `delete x.y`, `Object.assign(x…, …)`. */
export function mutatedNames(node) {
  const names = new Set();
  const add = (target) => { const name = rootOf(target); if (name) names.add(name); };
  const visit = (current) => {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isAccess(current.left)) add(current.left);
    else if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator) && isAccess(current.operand)) add(current.operand);
    else if (ts.isDeleteExpression(current) && isAccess(current.expression)) add(current.expression);
    else if (ts.isCallExpression(current) && current.arguments.length && MUTATORS.has(current.expression.getText().replace(/\s+/g, ''))) add(current.arguments[0]);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}
/** Property names a node reads through an access (`state.expressApp`, `state['server']`). */
const propertyNames = (node) => {
  const names = new Set();
  const visit = (current) => {
    if (ts.isPropertyAccessExpression(current)) names.add(current.name.text);
    else if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) names.add(current.argumentExpression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
};
/** The names a file imports. */
const importedNames = (sourceFile) => {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : null;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else if (bindings) for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
};
/** The names a function reads that it does not declare itself (its free names). */
const freeNames = (fn) => {
  const declared = new Set();
  const visit = (node) => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) bindingNames(node.name, declared);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name && node !== fn) declared.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  const names = referencedNames(fn.body ?? fn);
  for (const name of declared) names.delete(name);
  return names;
};
const functionsCache = new WeakMap();
/** Every function of the file bound to a name (declarations, and variables initialised with a function), by name. */
const functionsOf = (sourceFile) => {
  if (functionsCache.has(sourceFile)) return functionsCache.get(sourceFile);
  const byName = new Map();
  const add = (name, fn) => { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(freeNames(fn)); };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) add(node.name.text, node);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) add(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  functionsCache.set(sourceFile, byName);
  return byName;
};
/** The file's functions that read a tracked name, directly or through another such function. */
const reachingFunctions = (functions, tracked) => {
  const reaching = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, bodies] of functions) {
      if (reaching.has(name)) continue;
      if (bodies.some((free) => [...free].some((read) => tracked.has(read) || reaching.has(read)))) { reaching.add(name); grew = true; }
    }
  }
  return reaching;
};
/** The names a statement calls through to hand over a tracked name, outside nested functions (`register` of `register(app)`, `runtime` of `runtime.attach(app)`). */
const registrarRoots = (statement, tracked) => {
  const names = new Set();
  const visit = (node) => {
    if (node !== statement && isFunctionLike(node)) return;
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (node.arguments ?? []).some((argument) => ts.isIdentifier(argument) && tracked.has(argument.text))) {
      const name = rootOf(node.expression);
      if (name) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return names;
};

/** The innermost-first chain of nodes of `sourceFile` matching `predicate`. */
const findAll = (sourceFile, predicate) => {
  const found = [];
  const visit = (node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(sourceFile);
  return found;
};
const calleeText = (call, sourceFile) => call.expression.getText(sourceFile).replace(/\s+/g, '');

/**
 * The span of a file. `spec` is one of
 *   { start: '<a statement, as printed>', endCall: '<callee text>' }
 *       the block holding the start statement, from it to the statement that holds the end call;
 *   { functionNamed: '<name>', endCall: '<callee text>' }
 *       the body of the function bound to that name, from its first statement to the end call's statement.
 * Returns `{ statements: [{ node, text, digest, line }], endIndex, parameters, sourceFile }` or `{ problem }`.
 */
export function spanOf({ file, text, spec }) {
  const sourceFile = parse(file, text);
  let block;
  let first;
  let parameters = [];
  if (spec.start) {
    // Cheap filter first (the raw text is never shorter than the printed one minus comments), then the printed comparison.
    const startLength = spec.start.replace(/\s+/g, '').length;
    const starts = findAll(sourceFile, (node) => ts.isStatement(node) && ts.isBlock(node.parent) && node.getEnd() - node.getStart(sourceFile) < startLength * 4 + 64
      && node.getText(sourceFile).replace(/\s+/g, '').length >= startLength && statementText(node, sourceFile) === spec.start);
    if (starts.length !== 1) return { problem: `${file}: the composition start "${spec.start}" is found ${starts.length} times, not once` };
    block = starts[0].parent;
    first = block.statements.indexOf(starts[0]);
  } else {
    const functions = findAll(sourceFile, (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === spec.functionNamed
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.initializer.body && ts.isBlock(node.initializer.body));
    if (functions.length !== 1) return { problem: `${file}: the function ${spec.functionNamed} is found ${functions.length} times, not once` };
    block = functions[0].initializer.body;
    parameters = functions[0].initializer.parameters.map((parameter) => parameter.name.getText(sourceFile));
    first = 0;
  }
  const holdsEnd = (statement) => findAll(statement, (node) => ts.isCallExpression(node) && calleeText(node, sourceFile) === spec.endCall).length > 0;
  // The statements from the start to the end of the block: the span is up to the end call; what follows
  // still runs before any request (settings Express reads per request, layers the group can pass a request to).
  const statements = [];
  let endIndex = -1;
  for (let index = first; index < block.statements.length; index += 1) {
    const node = block.statements[index];
    const printed = statementText(node, sourceFile);
    statements.push({ node, text: printed, digest: textDigest(printed), line: lineOf(sourceFile, node) });
    if (endIndex < 0 && holdsEnd(node)) endIndex = statements.length - 1;
  }
  if (endIndex < 0) return { problem: `${file}: no statement after the span start calls ${spec.endCall}` };
  const ends = findAll(block, (node) => ts.isCallExpression(node) && calleeText(node, sourceFile) === spec.endCall);
  if (ends.length !== 1) return { problem: `${file}: ${spec.endCall} is called ${ends.length} times in the span's block, not once` };
  return { statements, endIndex, parameters, sourceFile };
}

const declarationCache = new WeakMap();
/** Every statement of the file that declares `name` (variable, function, class, import, parameter), printed. */
export function declarationsOf(sourceFile, name) {
  if (!declarationCache.has(sourceFile)) {
    const all = new Map();
    const add = (declared, holder) => {
      for (const one of declared) {
        if (!all.has(one)) all.set(one, []);
        all.get(one).push(holder);
      }
    };
    const visit = (node) => {
      const names = new Set();
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bindingNames(node.name, names);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
      else if ((ts.isImportClause(node) && node.name) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
      if (names.size) {
        let holder = node;
        if (!ts.isParameter(node)) while (holder.parent && !ts.isSourceFile(holder.parent) && !ts.isBlock(holder.parent) && !ts.isCaseClause(holder.parent)) holder = holder.parent;
        add(names, holder);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    declarationCache.set(sourceFile, all);
  }
  return (declarationCache.get(sourceFile).get(name) ?? []).map((holder) => {
    const printed = statementText(holder, sourceFile);
    return { text: printed, digest: textDigest(printed), line: lineOf(sourceFile, holder) };
  });
}

/** Longest common subsequence of two digest lists, as index pairs. */
function commonSubsequence(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) {
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

const short = (text) => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

/**
 * Checks one span against its table. `table` is
 *   { file, spec, roots: [names] | 'first-parameter', entries: [{ class, digest, text?, step?, reads?, reason }],
 *     definitions: { [name]: { digests: [digest, ...], reads?: [names], reason } } }
 * Returns `{ problems: [string], statements: [{ line, text, digest, entry }] }`.
 */
export function checkSpan({ table, text }) {
  const problems = [];
  const span = spanOf({ file: table.file, text, spec: table.spec });
  if (span.problem) return { problems: [span.problem], statements: [] };
  for (const entry of table.entries) if (!CLASSES.includes(entry.class)) problems.push(`table ${table.file}: entry ${entry.digest} has unknown class ${entry.class}`);
  const statements = span.statements;
  const roots = new Set(table.roots === 'first-parameter' ? span.parameters.slice(0, 1) : table.roots);
  const references = statements.map((statement) => referencedNames(statement.node));
  const bound = statements.map((statement) => boundNames(statement.node));
  const byDigest = new Map(table.entries.map((entry) => [entry.digest, entry]));
  // Names whose objects the group's composition uses: what any entry or definition reads, the file's imports, the span's parameters.
  const used = new Set([...table.entries.flatMap((entry) => entry.reads ?? []), ...Object.keys(table.definitions ?? {}), ...importedNames(span.sourceFile), ...span.parameters]);
  const mutated = statements.map((statement) => mutatedNames(statement.node));
  const rootProperties = statements.map((statement) => propertyNames(statement.node));
  const functions = functionsOf(span.sourceFile);
  const relevant = new Set();
  const reasons = new Map();
  // A statement is relevant when it mentions a tracked name (the roots, and every name a relevant statement binds,
  // for the statements after it), names a root as a property (state.expressApp), mutates an object the composition
  // uses (express.response.json = …), or calls a function of this file that reaches a tracked name. Until nothing changes.
  let aliases = new Set(roots);
  for (let round = 0; round < 8; round += 1) {
    const before = relevant.size;
    const reaching = reachingFunctions(functions, aliases);
    const tracked = new Set(roots);
    statements.forEach((_statement, index) => {
      const mention = [...references[index], ...bound[index]].find((name) => tracked.has(name));
      const helper = [...references[index]].find((name) => reaching.has(name));
      const property = [...rootProperties[index]].find((name) => roots.has(name));
      const mutation = [...mutated[index]].find((name) => used.has(name) || tracked.has(name));
      const why = mention ? `it mentions ${mention}` : property ? `it reads ${property} as a property` : mutation ? `it mutates ${mutation}, an object the composition uses`
        : helper ? `it calls ${helper}, a function of this file that reaches the app, the server or an alias of them` : reasons.get(index);
      if (!why) return;
      reasons.set(index, why);
      relevant.add(index);
      for (const name of bound[index]) tracked.add(name);
    });
    const grew = tracked.size !== aliases.size;
    aliases = tracked;
    if (relevant.size === before && !grew) break;
  }
  relevant.add(span.endIndex);
  // Bindings read by composed entries, through the statements of the span that bind them (transitively).
  const declaredAt = (name, before) => { const at = []; for (let index = 0; index < before; index += 1) if (bound[index].has(name)) at.push(index); return at; };
  const outside = new Set();
  const queue = [...relevant];
  const required = new Set(relevant);
  while (queue.length) {
    const index = queue.shift();
    const entry = byDigest.get(statements[index].digest);
    const reads = entry?.reads ?? [];
    for (const name of reads) {
      if (!references[index].has(name)) problems.push(`table ${table.file}: the entry at line ${statements[index].line} reads ${name}, which its statement does not mention`);
      const at = declaredAt(name, index);
      if (!at.length) { outside.add(name); continue; }
      for (const where of at) if (!required.has(where)) { required.add(where); queue.push(where); }
    }
  }
  // Statements the table classifies count wherever they are, so a classified statement that is no longer required still matches.
  statements.forEach((statement, index) => { if (byDigest.has(statement.digest)) required.add(index); });
  // A not-applicable statement is proven by the reach check on the census, which imports its own copy of each
  // registrar: what it calls through must be read, so the table pins which module that is.
  for (const statement of statements) {
    const entry = byDigest.get(statement.digest);
    if (entry?.class !== 'not-applicable') continue;
    for (const name of registrarRoots(statement.node, aliases)) {
      if (aliases.has(name) || GLOBAL_NAMES.has(name) || (entry.reads ?? []).includes(name)) continue;
      problems.push(`table ${table.file}: the not-applicable entry at line ${statement.line} calls through ${name}, which its reads do not list (its definition decides which module registers)`);
    }
  }
  const order = [...required].sort((a, b) => a - b);
  const actual = order.map((index) => statements[index].digest);
  const expected = table.entries.map((entry) => entry.digest);
  const pairs = commonSubsequence(actual, expected);
  const matchedActual = new Set(pairs.map(([i]) => i));
  const matchedExpected = new Set(pairs.map(([, j]) => j));
  const remainingExpected = new Map();
  expected.forEach((digest, j) => { if (!matchedExpected.has(j)) remainingExpected.set(digest, j); });
  const moved = new Set();
  actual.forEach((digest, i) => {
    if (matchedActual.has(i)) return;
    const statement = statements[order[i]];
    if (remainingExpected.has(digest)) {
      moved.add(remainingExpected.get(digest));
      problems.push(`moved: ${table.file}:${statement.line} ${short(statement.text)} — classified, but out of the table's order`);
      return;
    }
    const where = order[i] > span.endIndex;
    const why = relevant.has(order[i]) ? `${where ? 'after the group\'s call, ' : ''}${reasons.get(order[i]) ?? 'it holds the group\'s call'}` : 'a classified statement reads a name it binds';
    problems.push(`unclassified: ${table.file}:${statement.line} ${short(statement.text)} — ${why}, and no table entry covers it`);
  });
  expected.forEach((_digest, j) => {
    if (matchedExpected.has(j) || moved.has(j)) return;
    const entry = table.entries[j];
    problems.push(`changed: ${table.file}: the ${entry.class} statement ${short(entry.text ?? entry.digest)} is no longer there in that text`);
  });
  // Definitions outside the span: each pinned name's declarations must be the pinned ones; a definition's own reads are followed too.
  const definitionQueue = [...outside].sort();
  const seenDefinitions = new Set(definitionQueue);
  while (definitionQueue.length) {
    const name = definitionQueue.shift();
    const found = declarationsOf(span.sourceFile, name);
    const wanted = table.definitions?.[name];
    if (!wanted) { problems.push(`unclassified: ${table.file}: a classified statement reads ${name}, declared outside the span, and the table pins no definition of it`); continue; }
    if (JSON.stringify(found.map((entry) => entry.digest).sort()) !== JSON.stringify([...wanted.digests].sort())) {
      const lines = found.map((entry) => `line ${entry.line}: ${short(entry.text)}`).join('; ') || 'none';
      problems.push(`changed: ${table.file}: the definition of ${name}, which a classified statement reads, is not the one the table pins (now ${lines})`);
    }
    for (const next of wanted.reads ?? []) if (!seenDefinitions.has(next)) { seenDefinitions.add(next); definitionQueue.push(next); }
  }
  // A pinned definition nothing reads is a stale table, reported only when nothing else is (a changed reader also stops reading it).
  if (!problems.length) for (const name of Object.keys(table.definitions ?? {})) if (!seenDefinitions.has(name)) problems.push(`table ${table.file}: a definition of ${name} is pinned, but no classified statement reads it from outside the span`);
  return {
    problems,
    statements: order.map((index) => ({ line: statements[index].line, text: statements[index].text, digest: statements[index].digest, entry: byDigest.get(statements[index].digest) ?? null })),
    outside: [...seenDefinitions].sort(),
  };
}

/** The statements a table's check sees in a span as it is now, with digests and their entries (for re-reviewing a table; never used to pass a check). */
export function draftTable({ table, text }) {
  const span = spanOf({ file: table.file, text, spec: table.spec });
  if (span.problem) throw new Error(span.problem);
  return checkSpan({ table, text }).statements;
}

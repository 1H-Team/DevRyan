// The runtime the product's ledger worker builds, replaced for the
// conformance tests by a module hook (proto-js-process.mjs beside this
// file): every method of the product's runtime, each failing with
// `mutation_method_unimplemented` as the native build's do, then the stub
// methods. The worker itself is the product's, unchanged.
import { productMethods } from './generate-methods.mjs';
import { createStubGlobal, stubMethods } from './stub-interpreter.mjs';

const unimplemented = () => Object.assign(new Error('mutation_method_unimplemented'), { code: 'mutation_method_unimplemented' });

export function createSessionMutationRuntime(options = {}) {
  const observers = Object.fromEntries(['onChange', 'onMaterialize', 'onDiagnostic', 'onLockTiming']
    .filter((name) => typeof options[name] === 'function').map((name) => [name, options[name]]));
  const product = Object.fromEntries(productMethods().map((name) => [name, async () => { throw unimplemented(); }]));
  return { ...product, ...stubMethods(createStubGlobal({ observers })) };
}

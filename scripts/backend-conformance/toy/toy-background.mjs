// Declared background work of the toy group: the toy group table lists this
// file as a declared site, so work started here is never pending.
export async function declaredWork(gate) {
  // The gate's promise is created here, so it is declared work too.
  await gate();
  await Promise.resolve();
}

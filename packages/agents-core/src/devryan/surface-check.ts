// Compile-time proof that the implementation is assignable to the declared
// package surface (../../index.d.ts), which is all the runtime host sees.
// Type-only: nothing here is emitted or imported at runtime.
import type * as Declared from '../../index';
import type * as Implementation from './index';

type Assignable<Actual extends Expected, Expected> = Actual;

export type ReviewedSurfaceCheck = Assignable<
  Omit<typeof Implementation, 'default'>,
  Omit<typeof Declared, 'default'>
>;
// The default export's setup is not proven here: it is written against
// upstream's structural v2 context types (src/v2/types.ts), not the SDK's
// Context. The host's restricted context and the native agents-core lanes
// verify it at runtime.

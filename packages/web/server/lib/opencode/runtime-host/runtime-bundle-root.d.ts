import type { RuntimeBundleBinding } from './runtime-bundle-binding.js';
export function resolveRuntimeBundleRoot(environment: Readonly<Record<string, string | undefined>>, home: string): string;
export function readNativeShellBundleBinding(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly existsSync: (file: string) => boolean;
  readonly readRuntimeBundleBinding: (environment: Readonly<Record<string, string | undefined>>, options: { readonly allowHeldInspection: boolean }) => RuntimeBundleBinding | null;
}): RuntimeBundleBinding | null;

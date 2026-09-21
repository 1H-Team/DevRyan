import { readFileSync } from 'node:fs';
import { GhosttyRuntime } from './runtime';

// Deterministic unit fixtures read the checked-in WASM directly. Other UI
// suites mock global fetch; no network response is an authority for this asset.
let runtime: Promise<GhosttyRuntime> | undefined;
export function loadFixtureRuntime() {
  return runtime ??= GhosttyRuntime.load(new Uint8Array(
    readFileSync(new URL('./vendor/ghostty-vt.wasm', import.meta.url)),
  ).buffer);
}

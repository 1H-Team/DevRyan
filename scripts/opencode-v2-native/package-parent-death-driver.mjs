import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { runNativePackageAcceptance } from '../verify-opencode-v2-package.mjs';
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
let bytes = '';
for await (const chunk of process.stdin) { bytes += chunk; assert.ok(Buffer.byteLength(bytes) <= 65536); }
const input = JSON.parse(bytes);
const result = await runNativePackageAcceptance({ artifactRoot: input.artifactRoot, diagnostic: true,
  onParentDeathReady: evidence => new Promise((_, reject) => process.send({ type: 'parent-death-ready', evidence }, error => { if (error) reject(error); })) });
throw new Error(`Parent-death probe stopped before its controlled crash: ${result.error?.code ?? result.error?.message ?? result.status}`);

// Compatibility command; only the compiled native v2 acceptance owner runs.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseNativeExecutionAcceptanceArguments(args, environment = process.env) {
  if (environment.DEVRYAN_TEST_OPENCODE_BINARY) throw new Error('Legacy binary selection is retired');
  if (args.length && (args.length !== 2 || args[0] !== '--artifact-root' || !args[1])) throw new Error('Usage: --artifact-root <verified-repository-native-v2-directory>');
  const selected = args[1] ?? environment.DEVRYAN_TEST_NATIVE_ARTIFACT_ROOT;
  if (!selected) throw new Error('Explicit verified native v2 artifact root required');
  const artifactRoot = path.resolve(selected);
  if (!artifactRoot.startsWith(root + path.sep)) throw new Error('Native acceptance artifacts must remain inside the repository');
  return { artifactRoot };
}
export async function runNativeExecutionAcceptance(args = process.argv.slice(2)) {
  const options = parseNativeExecutionAcceptanceArguments(args);
  const { runNativePackageAcceptance } = await import('./verify-opencode-v2-package.mjs');
  const result = await runNativePackageAcceptance(options);
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await runNativeExecutionAcceptance();

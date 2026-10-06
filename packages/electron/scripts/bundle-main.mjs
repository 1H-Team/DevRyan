/**
 * Bundle main.mjs into a single file. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@openchamber/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 * Why external matters: packages/web/server pulls in bun-pty, which has
 * a top-level `import { dlopen } from "bun:ffi"`. If we inline it here,
 * Node's ESM loader sees `bun:ffi` at package load time and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before any runtime guard can skip it.
 * Leaving @openchamber/web external means the conditional
 * `if (isBunRuntime) await import('bun-pty')` stays dynamic and is never
 * reached under Electron.
 *
 * @openchamber/harness-runtime intentionally remains inline if Electron ever
 * imports it directly. Runtime ownership also imports its cross-process lock;
 * the package is dependency-free ESM with no native loader edge.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const repository = path.resolve(root, '../..');

export async function bundleElectronMain({ outdir = path.join(root, 'dist-bundle') } = {}) {
  outdir = path.resolve(outdir);
  // Bun emits module-label comments relative to process.cwd(), even with an
  // explicit build root. Use a child rather than changing the caller's cwd.
  if (process.cwd() !== repository) {
    const child = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), '--outdir', outdir], {
      cwd: repository,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if (await child.exited !== 0) throw new Error('Electron main-process bundling failed');
    return path.join(outdir, 'main.mjs');
  }
  const settings = {
    root: repository,
    entrypoints: [path.join(root, 'main.mjs'), path.join(root, 'desktop-update-install.mjs'), path.join(root, 'desktop-update-install-windows.mjs')],
    outdir,
    target: 'node',
    format: 'esm',
    external: [
      'electron',
      '@openchamber/web',
      '@openchamber/web/*',
      'bun-pty',
      'node-pty',
      'better-sqlite3',
    ],
    minify: false,
    sourcemap: 'none',
    naming: '[name].mjs',
    metafile: true,
  };
  const build = async () => {
    const result = await Bun.build(settings);
    if (!result.success) {
      for (const msg of result.logs) console.error(msg);
      throw new Error('Electron main-process bundling failed');
    }
    return result;
  };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const inventory = async result => {
    const files = new Set([...Object.keys(result.metafile.inputs), 'bun.lock',
      path.relative(repository, fileURLToPath(import.meta.url))]);
    const inputs = [];
    for (const file of files) {
      const absolute = await fs.realpath(path.resolve(repository, file));
      if (!absolute.startsWith(repository + path.sep)) throw new Error('Electron bundle input escaped repository');
      inputs.push({ file: path.relative(repository, absolute), sha256: hash(await fs.readFile(absolute)) });
    }
    return inputs.sort((a, b) => a.file.localeCompare(b.file));
  };
  // Inventory first, then require the exact same input bytes and graph around
  // the final build. Keep raw entry bytes bound to that closure for packaging.
  const inputs = await inventory(await build());
  const final = await build();
  if (JSON.stringify(await inventory(final)) !== JSON.stringify(inputs)) throw new Error('Electron bundle inputs changed during build');
  const main = path.join(outdir, 'main.mjs');
  await fs.writeFile(path.join(outdir, 'main.inputs.json'), JSON.stringify({ schema: 1,
    workingDirectory: repository, bunVersion: Bun.version, bunRevision: Bun.revision,
    entrypoint: path.relative(repository, settings.entrypoints[0]),
    mainSha256: hash(await fs.readFile(main)),
    installerSha256: hash(await fs.readFile(path.join(outdir, 'desktop-update-install.mjs'))),
    windowsInstallerSha256: hash(await fs.readFile(path.join(outdir, 'desktop-update-install-windows.mjs'))), inputs }, null, 2) + '\n');
  return main;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--outdir' || !args[1])) {
    throw new Error('Usage: bundle-main.mjs [--outdir directory]');
  }
  console.log(`[electron] main.mjs bundled -> ${await bundleElectronMain(args.length ? { outdir: args[1] } : undefined)}`);
}

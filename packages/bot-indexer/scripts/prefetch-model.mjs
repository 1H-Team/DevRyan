import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@xenova/transformers';

const MODEL = Object.freeze({
  id: 'Xenova/all-MiniLM-L6-v2',
  revision: '08a308f628bc9d6774b7922f319eb1b65afa1a82',
  quantized: true,
  onnxSha256: '2f9a2cd8a5955f62908d5087be47516e9d91849f50579c3e47c73fd2c563b224',
});

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const cacheDirectory = path.resolve(process.env.DEVRYAN_BOT_MODEL_CACHE || '/opt/devryan/model-cache');
const manifestPath = path.resolve(
  process.env.DEVRYAN_BOT_MODEL_MANIFEST || '/opt/devryan/model-cache-manifest.json',
);
const sbomPath = path.resolve(process.env.DEVRYAN_BOT_SBOM_PATH || '/opt/devryan/sbom.cdx.json');

const hashBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const collectFiles = async (directory, root = directory) => {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Model cache symlink is forbidden: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, root));
    if (entry.isFile()) {
      const bytes = await fs.readFile(absolute);
      files.push(Object.freeze({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        bytes: bytes.byteLength,
        sha256: hashBytes(bytes),
      }));
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o755 });
env.cacheDir = cacheDirectory;
env.allowRemoteModels = true;
env.allowLocalModels = true;
let extractor;
let loadError;
for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    extractor = await pipeline('feature-extraction', MODEL.id, {
      revision: MODEL.revision,
      quantized: MODEL.quantized,
    });
    break;
  } catch (error) {
    loadError = error;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
}
if (!extractor) throw loadError || new Error('Pinned embedding model could not be prefetched');
await extractor(['DevRyan offline model integrity probe'], { pooling: 'mean', normalize: true });
await extractor.dispose?.();

const files = await collectFiles(cacheDirectory);
if (!files.some(({ sha256 }) => sha256 === MODEL.onnxSha256)) {
  const graphs = files.filter(({ path: filePath }) => filePath.endsWith('.onnx'));
  throw new Error(
    `Pinned quantized ONNX hash ${MODEL.onnxSha256} was not downloaded; cached graphs: ${JSON.stringify(graphs)}`,
  );
}
const packageJson = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
const packageLockBytes = await fs.readFile(path.join(packageDirectory, 'package-lock.json'));
const generatedAt = new Date(
  Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH))
    ? Number(process.env.SOURCE_DATE_EPOCH) * 1_000
    : Date.now(),
).toISOString();
const manifest = {
  version: 1,
  generatedAt,
  model: MODEL,
  files,
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });

const components = files.map((file) => ({
  type: 'file',
  name: file.path,
  hashes: [{ alg: 'SHA-256', content: file.sha256 }],
  properties: [{ name: 'devryan.bytes', value: String(file.bytes) }],
}));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      type: 'application',
      name: packageJson.name,
      version: packageJson.version,
      hashes: [{ alg: 'SHA-256', content: hashBytes(packageLockBytes) }],
      properties: [
        { name: 'devryan.package-lock', value: 'package-lock.json' },
        { name: 'devryan.transformers.version', value: packageJson.dependencies['@xenova/transformers'] },
        { name: 'devryan.sqlite.version', value: packageJson.dependencies['better-sqlite3'] },
        { name: 'devryan.model.id', value: MODEL.id },
        { name: 'devryan.model.revision', value: MODEL.revision },
        { name: 'devryan.model.quantized', value: String(MODEL.quantized) },
      ],
    },
  },
  components,
};
await fs.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o444 });

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeImageGeneration } from '../opencode/runtime-host/native-image-generation.js';
import { createNativeReadGuard } from '../opencode/runtime-host/native-read-paths.js';

/** Preserve the reviewed executor; its I/O stays scoped to this Bot invocation. */
export async function createBotNativeImageTool({ directory, access, originals, fetchImpl }) {
  originals ??= await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.resolve('opencode-gpt-imagegen'))), 'devryan.js')).href);
  const original = (await originals.GptImagePlugin({})).tool.gpt_imagegen;
  const guard = createNativeReadGuard({ directory });
  return { ...original, async execute(input, context) {
    const signal = context.abort ?? new AbortController().signal;
    const check = async file => { signal.throwIfAborted(); await guard(file); signal.throwIfAborted(); };
    const out = path.resolve(directory, input.out);
    await check(out);
    let referenceBytes = 0;
    const generate = createNativeImageGeneration({ originals, fetchImpl,
      withImageGeneration: (_invocation, action) => action({
        access: () => access('access', { signal }), recheck: () => check(out),
      }),
    });
    return originals.withReviewedImagegenOwner({
      readFile: async file => {
        await check(file);
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          referenceBytes += before.size;
          if (!before.isFile() || before.size > 20 * 1024 * 1024 || referenceBytes > 32 * 1024 * 1024) throw Error('bot_image_reference_too_large');
          const bytes = await handle.readFile(), after = await handle.stat();
          if (bytes.length !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('bot_image_reference_changed');
          await check(file);
          return bytes;
        } finally { await handle.close(); }
      },
      writeFile: async (file, bytes) => {
        await check(file);
        const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { await handle.writeFile(bytes); await check(file); } finally { await handle.close(); }
      },
      generate: async (args, referenceImages) => (await generate({}, { ...args, referenceImages }, { signal })).base64,
    }, () => original.execute({ ...input, out }, { ...context, directory }));
  } };
}

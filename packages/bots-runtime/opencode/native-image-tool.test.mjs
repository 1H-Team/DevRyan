import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBotNativeImageTool } from '../../web/server/lib/bots/native-image-tool.mjs';
import { prepareReviewedNativeInputs, reviewedNativeInputPlugin } from '../../../scripts/native-runtime-assets.mjs';

test('Bot image wrapper retains original request, reference and versioned output while bounding cancellation and paths', async () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const parent = path.join(repository, '.cache/bot-native-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'image-'));
  const directory = path.join(root, 'workspace');
  await fs.mkdir(directory);
  const modulePath = path.join(root, 'reviewed.mjs');
  const build = await Bun.build({ entrypoints: [path.join(repository, 'packages/web/runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js')], target: 'node',
    plugins: [reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))] });
  if (!build.success) throw new AggregateError(build.logs, 'Reviewed image fixture build failed');
  await fs.writeFile(modulePath, await build.outputs[0].text());
  const originals = await import(pathToFileURL(modulePath).href);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPz8AAAAASUVORK5CYII=', 'base64');
  let account = 'fixture-one', calls = 0, blocked = false, settled = false, started;
  const pending = new Promise(resolve => { started = resolve; });
  const image = await createBotNativeImageTool({ directory, originals,
    access: async operation => { expect(operation).toBe('access'); return { accessToken: account, accountId: 'fixture-account' }; },
    fetchImpl: async (_url, init) => {
      calls++;
      expect(init.headers.get('Authorization')).toBe(`Bearer ${account}`);
      const body = JSON.parse(init.body);
      expect(body.model).toBe('gpt-6-astra');
      expect(body.reasoning.effort).toBe('medium');
      if (blocked) {
        started();
        return new Response(new ReadableStream({
          start(controller) { init.signal.addEventListener('abort', () => { settled = true; controller.error(init.signal.reason); }, { once: true }); },
          cancel() { settled = true; },
        }));
      }
      return new Response(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: png.toString('base64') } })}\n\n`);
    },
  });
  try {
    const input = { prompt: 'Fixture pixel', out: 'pixel.png', quality: 'low' };
    const first = await image.execute(input, {});
    expect(first.metadata.out).toBe(path.join(directory, 'pixel.png'));
    expect(await fs.readFile(first.metadata.out)).toEqual(png);
    account = 'fixture-two';
    const second = await image.execute({ ...input, images: ['pixel.png'] }, {});
    expect(second.metadata.out).toBe(path.join(directory, 'pixel-v2.png'));
    expect(await fs.readFile(first.metadata.out)).toEqual(png);
    await expect(image.execute({ ...input, out: '../escape/denied.png' }, {})).rejects.toThrow('native_read_root_denied');
    expect(await fs.stat(path.join(root, 'escape')).catch(() => null)).toBeNull();
    await fs.symlink(root, path.join(directory, 'outside'));
    await expect(image.execute({ ...input, out: 'outside/denied.png' }, {})).rejects.toThrow('native_read_root_denied');
    await expect(image.execute({ ...input, images: ['../reviewed.mjs'] }, {})).rejects.toThrow('native_read_root_denied');
    expect(calls).toBe(2);
    blocked = true;
    const abort = new AbortController();
    const result = image.execute({ ...input, out: 'cancelled.png' }, { abort: abort.signal });
    await pending; abort.abort();
    await expect(result).rejects.toThrow();
    expect(settled).toBe(true);
    expect(await fs.stat(path.join(directory, 'cancelled.png')).catch(() => null)).toBeNull();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 10_000);

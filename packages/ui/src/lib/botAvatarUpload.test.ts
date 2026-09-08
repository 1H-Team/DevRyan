import { describe, expect, test } from 'bun:test';
import { avatarDimensions, encodeAvatarCanvas, prepareBotAvatar } from '@/lib/botAvatarUpload';

describe('Bot avatar preparation', () => {
  test('bounds dimensions while preserving aspect ratio without upscaling', () => {
    expect(avatarDimensions(4096, 2048)).toEqual({ width: 256, height: 128 });
    expect(avatarDimensions(100, 400)).toEqual({ width: 64, height: 256 });
    expect(avatarDimensions(32, 64)).toEqual({ width: 32, height: 64 });
    expect(() => avatarDimensions(0, 10)).toThrow();
  });
  test('rejects unsupported and oversized files before decoding', async () => {
    await expect(prepareBotAvatar(new File(['text'], 'avatar.svg', { type: 'image/svg+xml' }))).rejects.toThrow('PNG');
    await expect(prepareBotAvatar(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'avatar.png', { type: 'image/png' }))).rejects.toThrow('5 MiB');
  });
  test('encodes WebP or falls back to transparency-capable PNG and reports encoding failure', async () => {
    const types: string[] = [];
    const canvas = { toBlob(callback: BlobCallback, type: string) {
      types.push(type); callback(type === 'image/webp' ? null : new Blob(['png'], { type }));
    } } as unknown as HTMLCanvasElement;
    expect((await encodeAvatarCanvas(canvas)).type).toBe('image/png');
    expect(types).toEqual(['image/webp', 'image/png']);
    const webp = { toBlob(callback: BlobCallback) { callback(new Blob(['webp'], { type: 'image/webp' })); } } as unknown as HTMLCanvasElement;
    expect((await encodeAvatarCanvas(webp)).type).toBe('image/webp');
    const broken = { toBlob(callback: BlobCallback) { callback(null); } } as unknown as HTMLCanvasElement;
    await expect(encodeAvatarCanvas(broken)).rejects.toThrow('encoded');
  });
});

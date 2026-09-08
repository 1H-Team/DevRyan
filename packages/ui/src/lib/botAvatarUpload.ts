export const avatarDimensions = (width: number, height: number) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Invalid image dimensions');
  const scale = Math.min(1, 256 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export const encodeAvatarCanvas = async (canvas: HTMLCanvasElement): Promise<Blob> => {
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  const webp = await encode('image/webp');
  if (webp?.type === 'image/webp' && webp.size > 0) return webp;
  const png = webp?.type === 'image/png' ? webp : await encode('image/png');
  if (!png || png.type !== 'image/png' || png.size === 0) throw new Error('Image could not be encoded');
  return png;
};

export const prepareBotAvatar = async (file: File) => {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Avatar images must be 5 MiB or smaller.');
  const bitmap = await createImageBitmap(file);
  let blob: Blob;
  try {
    const canvas = document.createElement('canvas');
    const dimensions = avatarDimensions(bitmap.width, bitmap.height);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image could not be resized');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await encodeAvatarCanvas(canvas);
  } finally {
    bitmap.close();
  }
  const contentType: 'image/webp' | 'image/png' = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image'));
    reader.onerror = () => reject(new Error('Image could not be read'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, avatar: { contentType, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) } };
};

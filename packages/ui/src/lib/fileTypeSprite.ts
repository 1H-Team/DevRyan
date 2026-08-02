const FILE_TYPE_SPRITE_ROOT_ID = 'oc-file-type-icon-sprite-root';

let isMounted = false;
let hasLoadStarted = false;
const listeners = new Set<() => void>();

const notifyListeners = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const attachSprite = (spriteContent: string): void => {
  if (document.getElementById(FILE_TYPE_SPRITE_ROOT_ID)) {
    isMounted = true;
    return;
  }

  const root = document.createElement('div');
  root.id = FILE_TYPE_SPRITE_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.position = 'absolute';
  root.style.width = '0';
  root.style.height = '0';
  root.style.overflow = 'hidden';
  root.innerHTML = spriteContent;
  document.body.appendChild(root);
  isMounted = true;
};

// The sprite is close to a megabyte of markup, so it is loaded as its own chunk
// instead of being inlined into the startup bundle. Consumers render their
// `<use>` element only once this resolves, which is what makes the reference
// resolve against a symbol that did not exist during the first paint.
export const ensureFileTypeSprite = (): void => {
  if (hasLoadStarted || typeof document === 'undefined') {
    return;
  }
  hasLoadStarted = true;

  void import('../assets/icons/file-types/sprite.svg?raw').then(({ default: spriteContent }) => {
    const attach = () => {
      attachSprite(spriteContent);
      notifyListeners();
    };

    if (document.body) {
      attach();
      return;
    }

    document.addEventListener('DOMContentLoaded', attach, { once: true });
  });
};

export const isFileTypeSpriteMounted = (): boolean => isMounted;

export const getFileTypeSpriteServerSnapshot = (): boolean => false;

export const subscribeToFileTypeSprite = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

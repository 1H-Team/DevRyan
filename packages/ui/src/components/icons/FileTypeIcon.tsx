import React from 'react';
import { cn } from '@/lib/utils';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import {
  ensureFileTypeSprite,
  getFileTypeSpriteServerSnapshot,
  isFileTypeSpriteMounted,
  subscribeToFileTypeSprite,
} from '@/lib/fileTypeSprite';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';

type FileTypeIconProps = {
  filePath: string;
  extension?: string;
  className?: string;
};

ensureFileTypeSprite();

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({ filePath, extension, className }) => {
  const theme = useOptionalThemeSystem();
  const variant = theme?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
  const iconHref = getFileTypeIconHref(filePath, { extension, themeVariant: variant });
  const isSpriteMounted = React.useSyncExternalStore(
    subscribeToFileTypeSprite,
    isFileTypeSpriteMounted,
    getFileTypeSpriteServerSnapshot
  );

  return (
    <svg
      className={cn('h-4 w-4 flex-shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      {isSpriteMounted ? <use href={iconHref} xlinkHref={iconHref} /> : null}
    </svg>
  );
};

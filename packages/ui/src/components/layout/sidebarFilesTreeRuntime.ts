import type { RuntimeDescriptor } from '@/lib/api/types';

export const shouldShowSidebarFileRowActions = (
  runtime: Pick<RuntimeDescriptor, 'platform' | 'isDesktop'>,
): boolean => runtime.platform !== 'web';

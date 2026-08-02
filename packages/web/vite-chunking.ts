export const resolveDependencyPackageName = (id: string): string | undefined => {
  const normalizedId = id.replaceAll('\\', '/');
  const suffixIndex = normalizedId.search(/[?#]/);
  const pathname = suffixIndex === -1 ? normalizedId : normalizedId.slice(0, suffixIndex);
  const rootedId = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const nodeModulesMarker = '/node_modules/';
  const nodeModulesIndex = rootedId.lastIndexOf(nodeModulesMarker);

  if (nodeModulesIndex === -1) return undefined;

  const dependencyPath = rootedId.slice(nodeModulesIndex + nodeModulesMarker.length);
  const segments = dependencyPath.split('/');
  const firstSegment = segments[0];

  if (!isPackageSegment(firstSegment)) return undefined;
  if (firstSegment.startsWith('.')) return undefined;

  if (!firstSegment.startsWith('@')) return firstSegment;
  if (firstSegment.length === 1) return undefined;

  const secondSegment = segments[1];
  if (!isPackageSegment(secondSegment)) return undefined;
  if (secondSegment.startsWith('.') || secondSegment.startsWith('@')) return undefined;

  return `${firstSegment}/${secondSegment}`;
};

// Vite's `__vitePreload` runtime helper is a virtual module every chunk that
// dynamic-imports depends on. Left unassigned, Rollup folds it into whichever
// vendor chunk it prefers — it picked `vendor-syntax`, which made the entry
// chunk a static importer of react-syntax-highlighter's ~590KB refractor
// payload. Pinning it to its own chunk keeps that merge target from moving.
const VITE_PRELOAD_HELPER_ID = 'vite/preload-helper';

export const isVitePreloadHelperId = (id: string): boolean => (
  id.replace(/^\0/, '').startsWith(VITE_PRELOAD_HELPER_ID)
);

export const resolveVendorChunkName = (id: string): string | undefined => {
  if (isVitePreloadHelperId(id)) return 'vendor-vite-preload';

  const packageName = resolveDependencyPackageName(id);
  if (!packageName) return undefined;

  if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
  if (packageName === 'zustand') return 'vendor-zustand';
  if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk';

  if (
    packageName === 'react-markdown'
    || packageName === 'remark'
    || packageName.startsWith('remark-')
    || packageName === 'rehype'
    || packageName.startsWith('rehype-')
  ) {
    return 'vendor-markdown';
  }

  if (packageName.startsWith('@base-ui/')) return 'vendor-base-ui';

  if (packageName === 'react-syntax-highlighter' || packageName === 'highlight.js') {
    return 'vendor-syntax';
  }

  return undefined;
};

const isPackageSegment = (segment: string | undefined): segment is string => (
  Boolean(segment)
  && segment !== '.'
  && segment !== '..'
  && !segment.includes('?')
  && !segment.includes('#')
  && !segment.includes('\0')
);

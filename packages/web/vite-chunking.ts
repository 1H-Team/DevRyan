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

export const resolveVendorChunkName = (id: string): string | undefined => {
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

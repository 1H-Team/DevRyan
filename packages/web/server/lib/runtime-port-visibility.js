export const getPublicRuntimePort = (runtimePort, {
  startupSkipped = false,
  externallyManaged = false,
} = {}) => (
  startupSkipped || externallyManaged ? null : runtimePort
);

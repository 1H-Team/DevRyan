export * from '../../packages/ui/src/sync/sync-context';
const fixtureState = { permission: {} };
export const useDirectorySync = <T,>(select: (state: typeof fixtureState) => T): T => select(fixtureState);

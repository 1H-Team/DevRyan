import { createStore } from 'zustand/vanilla';
export * from '../../packages/ui/src/sync/sync-context';
export const fixtureSessions = createStore(() => ({ session: [{ id: 'ses_visual_child', title: 'Managed designer task' }, { id: 'ses_visual_fixer_child', title: 'Verify and Stabilize Guest Chat Geometry' }] }));
export const useDirectoryStore = () => fixtureSessions;
export const useSessionStatus = () => undefined;
const resync = async () => undefined;
export const useSyncResyncSession = () => resync;

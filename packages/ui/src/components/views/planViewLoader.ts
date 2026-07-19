import { importWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export const loadPlanView = () =>
  import('@/components/views/PlanView').then((module) => ({ default: module.PlanView }));

export const preloadPlanView = () => importWithChunkRecovery(loadPlanView);

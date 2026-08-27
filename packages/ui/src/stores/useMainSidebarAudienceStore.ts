import { create } from 'zustand';
import { getAuthPrincipal, hasAuthCapability } from '@/lib/authSession';

export type ProductAudience = 'coding-agents' | 'bots';

type MainSidebarAudienceState = {
  audience: ProductAudience;
  setAudience: (audience: ProductAudience) => void;
};

export const useMainSidebarAudienceStore = create<MainSidebarAudienceState>((set) => ({
  audience: 'coding-agents',
  setAudience: (audience) => set((state) => {
    const allowedAudience = audience === 'bots'
      && !hasAuthCapability(getAuthPrincipal(), 'bots')
      ? 'coding-agents'
      : audience;
    return state.audience === allowedAudience ? state : { audience: allowedAudience };
  }),
}));

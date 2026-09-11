import type { SupabaseConnectionAPI } from '@openchamber/ui/lib/api/types';

export const createWebSupabaseConnectionAPI = (): SupabaseConnectionAPI => ({
  async getStatus() {
    const response = await fetch('/api/system/supabase-connection', { cache: 'no-store' });
    if ([401, 403, 404].includes(response.status)) return null;
    if (!response.ok) throw new Error('Unable to read the Supabase connection');
    return response.json();
  },
  async setEnabled(enabled) {
    const response = await fetch('/api/system/supabase-connection', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error('Unable to change the Supabase connection');
    return response.json();
  },
});

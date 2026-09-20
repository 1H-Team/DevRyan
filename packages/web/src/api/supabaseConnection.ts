import type { SupabaseConnectionAPI } from '@openchamber/ui/lib/api/types';
import { isSupabaseConnectionStatus, SupabaseConnectionError } from '@openchamber/ui/lib/api/supabaseConnection';

async function request(init: RequestInit) {
  try {
    const response = await fetch('/api/system/supabase-connection', init);
    if (!response.ok) {
      const kind = response.status === 401 ? 'unauthenticated'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'temporary';
      throw new SupabaseConnectionError(kind, response.status);
    }
    const status: unknown = await response.json();
    if (!isSupabaseConnectionStatus(status)) throw new SupabaseConnectionError('temporary', response.status);
    return status;
  } catch (error) {
    if (error instanceof SupabaseConnectionError) throw error;
    throw new SupabaseConnectionError('temporary');
  }
}

export const createWebSupabaseConnectionAPI = (): SupabaseConnectionAPI => ({
  async getStatus() {
    return request({ cache: 'no-store' });
  },
  async setEnabled(enabled) {
    return request({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ enabled }),
    });
  },
});

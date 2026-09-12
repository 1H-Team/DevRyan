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
    if (!response.ok) {
      const detail = await response.json().then((body: unknown) => (
        body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error : null
      )).catch(() => null);
      throw new Error(detail ? `Unable to change the Supabase connection: ${detail}` : 'Unable to change the Supabase connection');
    }
    return response.json();
  },
});

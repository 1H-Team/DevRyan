import { AsyncLocalStorage } from 'node:async_hooks';
import { HostRefusal } from './host-refusal.js';

const requests = new AsyncLocalStorage<string>();
export const requestIntegrationGrant = () => requests.getStore();
export function runWithIntegrationGrant<A>(headers: Headers, action: () => Promise<A>): Promise<A> {
  const token = headers.get('x-devryan-native-integration-grant');
  if (token === null) return action();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HostRefusal('native_integration_header_invalid', 403, 'integration.request');
  return requests.run(token, action);
}

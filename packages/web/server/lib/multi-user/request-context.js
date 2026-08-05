import { AsyncLocalStorage } from 'node:async_hooks';

const requestPrincipalStorage = new AsyncLocalStorage();

export const runWithRequestPrincipal = (principal, callback, context = {}) => (
  requestPrincipalStorage.run({ principal: principal || null, ...context }, callback)
);

export const getRequestPrincipal = () => requestPrincipalStorage.getStore()?.principal || null;

export const getRequestAssignment = () => requestPrincipalStorage.getStore()?.assignment || null;

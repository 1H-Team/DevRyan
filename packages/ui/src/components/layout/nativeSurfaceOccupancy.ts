import React from 'react';

export type NativeSurfaceOccupancyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
};

export type NativeSurfaceOccupancy = NativeSurfaceOccupancyRect & {
  surfaceId: string;
};

const entries = new Map<string, NativeSurfaceOccupancy>();
const listeners = new Set<() => void>();
let snapshot: NativeSurfaceOccupancy | null = null;

const sameOccupancy = (left: NativeSurfaceOccupancy | null, right: NativeSurfaceOccupancy | null): boolean => (
  left?.surfaceId === right?.surfaceId
  && left?.x === right?.x
  && left?.y === right?.y
  && left?.width === right?.width
  && left?.height === right?.height
  && left?.right === right?.right
  && left?.bottom === right?.bottom
);

const publish = (next: NativeSurfaceOccupancy | null) => {
  if (sameOccupancy(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
};

const latestEntry = (): NativeSurfaceOccupancy | null => {
  const values = Array.from(entries.values());
  return values[values.length - 1] ?? null;
};

export const setNativeSurfaceOccupancy = (
  surfaceId: string,
  rect: NativeSurfaceOccupancyRect | null,
): void => {
  if (!surfaceId) return;
  if (!rect) {
    entries.delete(surfaceId);
    publish(latestEntry());
    return;
  }
  const next = { surfaceId, ...rect };
  entries.delete(surfaceId);
  entries.set(surfaceId, next);
  publish(next);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): NativeSurfaceOccupancy | null => snapshot;
const getServerSnapshot = (): null => null;

export const useNativeSurfaceOccupancy = (): NativeSurfaceOccupancy | null => (
  React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
);

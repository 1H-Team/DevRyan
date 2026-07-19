const privateToolIntervals = new WeakMap();

export const retainPrivateToolInterval = (event, interval = {}) => {
  if (!event || typeof event !== 'object') return event;
  privateToolIntervals.set(event, Object.freeze({
    start: interval?.start,
    end: interval?.end,
  }));
  return event;
};

export const consumePrivateToolIntervals = (events = []) => {
  const intervals = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const interval = privateToolIntervals.get(event);
    if (interval) intervals.set(event, interval);
    privateToolIntervals.delete(event);
  }
  return intervals;
};

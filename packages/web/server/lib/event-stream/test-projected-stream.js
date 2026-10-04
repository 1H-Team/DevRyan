// Transport-only tests inject projection results; native event mappings are
// exercised separately by the vector and loopback-fixture suites.
export const projectedFrame = (payload, { id, directory = payload?.properties?.directory } = {}) => (
  `data: ${JSON.stringify({ type: 'test.projected', id, location: { directory }, payload })}\n\n`
);

export const createProjectedStreamClient = () => ({
  generation: () => 2,
  events: {
    url: () => 'http://127.0.0.1:4096/api/event',
    createProjector: () => ({
      handleGap() {},
      takeReseedRequests: () => [],
      project: (event) => [{ payload: event.payload, eventId: event.id, directory: event.location?.directory ?? 'global' }],
    }),
  },
});

// The mounted transcript window holds whole turns but is sized in rows (each
// prompt plus every tool call, text and reasoning part of the replies): one
// orchestrator turn can carry hundreds of tool rows. Up to
// `maxRowsBeforeWindowing` rows (and `initialTurns` turns) everything mounts;
// beyond that the newest `initialRows` mount, and each reveal adds `batchRows`.
// A turn larger than the budget still mounts whole, as does the newest turn.
export const TURN_WINDOW_DEFAULTS = {
    initialTurns: 10,
    batchTurns: 8,
    prefetchBuffer: 16,
    maxRowsBeforeWindowing: 60,
    initialRows: 40,
    batchRows: 40,
} as const;

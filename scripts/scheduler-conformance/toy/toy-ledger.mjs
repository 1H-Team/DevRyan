// The toy's reference ledger encoder (toy/target.json `savedState`): the bytes a saved state is written as.
export const encodeLedgerSnapshot = (state) => `${JSON.stringify(state)}\n`;

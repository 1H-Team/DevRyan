const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Cursor SDK 1.0.28 EditResultSchema returns the executed edit's diffString.
// Write/Delete results expose sizes and sometimes only the resulting content;
// neither establishes a before/after diff. Never substitute requested args or
// the SDK runtime's synthesized workspace patch for missing execution evidence.
export function cursorToolReceiptMetadata(message) {
  if (message?.name !== 'edit' || message.status !== 'completed' || !object(message.result)
    || message.result.status !== 'success' || !object(message.result.value)
    || typeof message.result.value.diffString !== 'string') return {};
  return { diff: message.result.value.diffString };
}

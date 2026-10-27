const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the private interview notify owner creates this native status row.
 * User rows remain turn parents even if their metadata or text is synthetic. */
export const isNativeStatusMessage = value => object(value) && value.type === 'synthetic'
  && value.metadata?.devryan?.v === 1 && value.metadata.devryan.origin === 'interview'
  && value.metadata.devryan.statusOnly === true;

/** Generic synthetic input and native maintenance continuations still parent turns. */
export const isNativeTurnParent = value => object(value)
  && (value.type === 'user' || value.type === 'compaction' || value.type === 'synthetic' && !isNativeStatusMessage(value));

/** Canonical projection provenance; caller metadata alone never supplies it. */
export const isNativeStatusRecord = value => object(value) && value.info?.role === 'user'
  && value.nativeStatus?.source === 'native-sequence' && value.nativeStatus.kind === 'status-only';

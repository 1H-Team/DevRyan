import { normalizeAbortSource, type AbortSource } from '@devryan/orchestration-runtime';
import { isRecord, readNonEmptyString, readString } from './guards';

/**
 * The error an assistant message carries (`info.error`), decoded once. Each
 * field is a string or undefined. `detail` is the first non-empty of
 * `data.message`, `message` and `name`: an empty `data.message` never hides a
 * real message. `abortSource` is the DevRyan abort source the host attached to
 * a `MessageAbortedError` as `data.source`, when it is a known source.
 */
export type AssistantMessageError = {
  readonly name: string | undefined;
  readonly message: string | undefined;
  readonly dataMessage: string | undefined;
  readonly detail: string | undefined;
  readonly abortSource?: AbortSource;
};

/** Decodes an error value (`info.error`); undefined when it is not an object. */
export const decodeAssistantMessageError = (error: unknown): AssistantMessageError | undefined => {
  if (!isRecord(error)) return undefined;
  const name = readString(error.name);
  const message = readString(error.message);
  const dataMessage = isRecord(error.data) ? readString(error.data.message) : undefined;
  const decoded = { name, message, dataMessage, detail: readNonEmptyString(dataMessage, message, name) };
  const abortSource = name === 'MessageAbortedError' && isRecord(error.data)
    ? normalizeAbortSource(error.data.source) : 'unknown';
  return abortSource === 'unknown' ? decoded : { ...decoded, abortSource };
};

/** Decodes the error of a message `info`; undefined when it has none. */
export const readAssistantMessageError = (info: unknown): AssistantMessageError | undefined => (
  isRecord(info) ? decodeAssistantMessageError(info.error) : undefined
);

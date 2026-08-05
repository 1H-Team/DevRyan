const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

const readSdkErrorMessage = (error: unknown, seen: Set<object>): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (!error || typeof error !== 'object') {
    return String(error);
  }
  if (seen.has(error)) {
    return UNKNOWN_ERROR_MESSAGE;
  }
  seen.add(error);

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim().length > 0) {
    return message;
  }

  const errorValue = (error as { error?: unknown }).error;
  if (typeof errorValue === 'string' && errorValue.trim().length > 0) {
    return errorValue;
  }
  if (errorValue && typeof errorValue === 'object') {
    const nestedMessage = readSdkErrorMessage(errorValue, seen);
    if (nestedMessage !== UNKNOWN_ERROR_MESSAGE) {
      return nestedMessage;
    }
  }

  try {
    return JSON.stringify(error) || UNKNOWN_ERROR_MESSAGE;
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
};

export const getSdkErrorMessage = (error: unknown): string => (
  readSdkErrorMessage(error, new Set<object>())
);

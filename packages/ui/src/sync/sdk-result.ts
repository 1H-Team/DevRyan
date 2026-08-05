import { getSdkErrorMessage } from '@/lib/opencode/sdk-error';

export function unwrapSdkResult<T>(
  result: { data?: T; error?: unknown; response?: { status?: number } },
  name: string,
): T {
  if (result.error) {
    const rawError = result.error
    const status = result.response?.status
    const message = getSdkErrorMessage(rawError)
    const error = new Error(`${name} failed${status !== undefined ? ` (${status})` : ""}: ${message}`)
    if (status !== undefined) {
      ;(error as Error & { status?: number }).status = status
    }
    throw error
  }

  if (result.data === undefined) {
    const error = new Error(`${name} returned no data`)
    ;(error as Error & { status?: number }).status = 503
    throw error
  }

  return result.data
}

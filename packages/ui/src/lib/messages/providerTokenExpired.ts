export const PROVIDER_TOKEN_EXPIRED_MESSAGE =
  "This provider's sign-in has expired and could not be refreshed automatically. Reconnect it in Settings → Providers, then retry.";

/**
 * Distinguishes an expired-and-unrefreshable credential from a generic auth failure.
 *
 * Retrying or switching models cannot fix this one — only re-authenticating can — so it earns
 * copy that says so. It must be checked before {@link isLikelyProviderAuthFailure}, which is
 * broader and would otherwise swallow it into vaguer advice.
 *
 * Worth knowing: OpenAI's own wording, "Provided authentication token is expired.", matches none
 * of the generic auth heuristics ("expired token" is not "token is expired"), so before this
 * existed the user saw the raw provider error with no hint that reconnecting was the fix.
 */
export const isLikelyProviderTokenExpired = (value: unknown): boolean => {
  if (typeof value !== "string") {
    return false;
  }

  const detail = value.toLowerCase().trim();
  if (!detail) {
    return false;
  }

  return (
    detail.includes("token is expired") ||
    detail.includes("token has expired") ||
    detail.includes("authentication token is expired") ||
    detail.includes("could not be refreshed") ||
    detail.includes("session expired")
  );
};

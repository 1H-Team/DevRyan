const normalizeProviderRetryMessage = (value) => (
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : ''
);

export const PROVIDER_USAGE_LIMIT_FAILURE_KIND = 'provider_usage_limit';

export const classifyProviderRetryFailure = (value) => {
  const message = normalizeProviderRetryMessage(value);
  if (!message) return null;
  return message.includes('out of usage')
    || message.includes('usage limit')
    || message.includes('hit your limit')
    || message.includes('session limit')
    || message.includes('rate limit')
    || message.includes('rate limited')
    || message.includes('quota limit')
    || message.includes('quota exceeded')
    || message.includes('quota has been exceeded')
    || message.includes('insufficient quota')
    ? PROVIDER_USAGE_LIMIT_FAILURE_KIND
    : null;
};

export const isDefiniteProviderUsageLimit = (value) => {
  return classifyProviderRetryFailure(value) === PROVIDER_USAGE_LIMIT_FAILURE_KIND;
};

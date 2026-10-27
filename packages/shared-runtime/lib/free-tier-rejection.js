// Zen refuses free-tier requests it does not recognize as OpenCode agent
// traffic. That is a request-shape policy, not a model fault. One pattern for
// helper generation, free model rotation and the session failure card.
const FREE_TIER_REJECTED_PATTERN = /free tier can only be used/i;

export const isFreeTierRejectedMessage = (message) => FREE_TIER_REJECTED_PATTERN.test(String(message ?? ''));

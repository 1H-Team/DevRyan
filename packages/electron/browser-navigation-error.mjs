export const isBenignNavigationAbort = (error) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (error.errno === -3) {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return message.includes('ERR_ABORTED') || message.includes(' (-3) loading ');
};

type TabAuxClickEvent = {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
};

export const handleClosableTabAuxClick = (
  event: TabAuxClickEvent,
  tabID: string,
  onClose: ((tabID: string) => void) | undefined,
): boolean => {
  if (event.button !== 1 || !onClose) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  onClose(tabID);
  return true;
};

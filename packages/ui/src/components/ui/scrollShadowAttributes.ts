type ScrollShadowEdge = "top" | "bottom" | "left" | "right";

const setAttributeIfChanged = (element: HTMLElement, name: string, value: string) => {
  if (element.getAttribute(name) === value) return;
  element.setAttribute(name, value);
};

const removeAttributeIfPresent = (element: HTMLElement, name: string) => {
  if (!element.hasAttribute(name)) return;
  element.removeAttribute(name);
};

export const syncScrollShadowAttributes = (
  element: HTMLElement,
  hasBefore: boolean,
  hasAfter: boolean,
  prefix: Extract<ScrollShadowEdge, "top" | "left">,
  suffix: Extract<ScrollShadowEdge, "bottom" | "right">,
) => {
  const beforeAttribute = `data-${prefix}-scroll`;
  const afterAttribute = `data-${suffix}-scroll`;
  const bothAttribute = `data-${prefix}-${suffix}-scroll`;

  if (hasBefore && hasAfter) {
    setAttributeIfChanged(element, bothAttribute, "true");
    removeAttributeIfPresent(element, beforeAttribute);
    removeAttributeIfPresent(element, afterAttribute);
    return;
  }

  setAttributeIfChanged(element, beforeAttribute, String(hasBefore));
  setAttributeIfChanged(element, afterAttribute, String(hasAfter));
  removeAttributeIfPresent(element, bothAttribute);
};

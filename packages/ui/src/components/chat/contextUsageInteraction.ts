export const isContextUsageOutsideInteraction = (
    target: Node | null,
    pane: HTMLElement | null,
    trigger: HTMLElement | null,
): boolean => {
    if (!target) return false;
    return !pane?.contains(target) && !trigger?.contains(target);
};

export const clampThinkingPosition = (position: number, count: number) => Math.max(0, Math.min(count - 1, position));

/** Hysteresis prevents midpoint jitter; preview stays close to the latched stop. */
export function getThinkingDetent(position: number, selected: number, count: number) {
    const bounded = clampThinkingPosition(position, count);
    let index = selected;
    while (index < count - 1 && bounded - index >= 0.6) index += 1;
    while (index > 0 && bounded - index <= -0.6) index -= 1;
    return { index, position: index + (bounded - index) * 0.18 };
}

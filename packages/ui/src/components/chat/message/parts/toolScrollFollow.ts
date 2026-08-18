export const TOOL_OUTPUT_FOLLOW_THRESHOLD_PX = 24;

export const isWithinToolOutputBottomThreshold = (
    scrollHeight: number,
    scrollTop: number,
    clientHeight: number,
    threshold = TOOL_OUTPUT_FOLLOW_THRESHOLD_PX,
) => scrollHeight - (scrollTop + clientHeight) <= threshold;

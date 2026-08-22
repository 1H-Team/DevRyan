import type { Part } from '@opencode-ai/sdk/v2';
import { isKnownClippedXaiReasoningPreview } from './reasoningRenderPolicy';

export interface ReasoningGroupRow<Activity> {
    type: 'reasoning-group';
    activities: Activity[];
}

type ReasoningRow<Activity> = {
    type: 'reasoning';
    activity: Activity;
};

export const scanConsecutiveReasoningParts = (
    parts: readonly Part[],
    start: number,
): number => {
    if (start < 0 || start >= parts.length || parts[start]?.type !== 'reasoning') {
        return start;
    }

    let end = start;
    while (end + 1 < parts.length && parts[end + 1]?.type === 'reasoning') {
        end += 1;
    }
    return end;
};

export const coalesceConsecutiveReasoningRows = <
    Activity,
    Row extends { type: string },
>(rows: readonly Row[]): Array<Row | ReasoningGroupRow<Activity>> => {
    if (!rows.some((row) => row.type === 'reasoning')) {
        return rows.slice();
    }

    const coalesced: Array<Row | ReasoningGroupRow<Activity>> = [];
    let index = 0;

    while (index < rows.length) {
        const row = rows[index];
        if (row.type !== 'reasoning') {
            coalesced.push(row);
            index += 1;
            continue;
        }

        const activities: Activity[] = [];
        let end = index;
        while (end < rows.length && rows[end]?.type === 'reasoning') {
            activities.push((rows[end] as Row & ReasoningRow<Activity>).activity);
            end += 1;
        }

        if (activities.length === 1) {
            coalesced.push(row);
        } else {
            coalesced.push({ type: 'reasoning-group', activities });
        }
        index = end;
    }

    return coalesced;
};

export const hasDisplayableReasoningText = (
    part: Part,
    providerID?: string | null,
): boolean => {
    if (isKnownClippedXaiReasoningPreview(part, providerID)) {
        return false;
    }

    const partWithText = part as Part & { text?: string; content?: string };
    const text = partWithText.text || partWithText.content || '';
    return text.trim().length > 0;
};

type ReasoningActivity = {
    kind: string;
    part: Part;
    providerID?: string | null;
};

export const filterKnownClippedXaiReasoningActivities = <Activity extends ReasoningActivity>(
    activities: Activity[],
    fallbackProviderID?: string | null,
): Activity[] => {
    let filtered: Activity[] | null = null;

    activities.forEach((activity, index) => {
        const shouldHide = activity.kind === 'reasoning'
            && isKnownClippedXaiReasoningPreview(
                activity.part,
                activity.providerID ?? fallbackProviderID,
            );

        if (shouldHide) {
            filtered ??= activities.slice(0, index);
            return;
        }

        filtered?.push(activity);
    });

    return filtered ?? activities;
};

export const isReasoningPartActive = (part: Part): boolean => {
    const time = (part as Part & { time?: { end?: number } }).time;
    return typeof time?.end !== 'number';
};

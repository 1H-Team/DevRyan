export interface ModelPickerScrollContainer {
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly isConnected: boolean;
}

export interface ModelPickerScrollSnapshot {
    container: ModelPickerScrollContainer;
    scrollTop: number;
}

export const captureModelPickerScroll = (
    container: ModelPickerScrollContainer | null,
): ModelPickerScrollSnapshot | null => {
    if (!container) {
        return null;
    }

    return {
        container,
        scrollTop: container.scrollTop,
    };
};

export const restoreModelPickerScroll = (
    snapshot: ModelPickerScrollSnapshot,
): boolean => {
    if (!snapshot.container.isConnected) {
        return false;
    }

    const maxScrollTop = Math.max(
        0,
        snapshot.container.scrollHeight - snapshot.container.clientHeight,
    );
    snapshot.container.scrollTop = Math.min(
        Math.max(0, snapshot.scrollTop),
        maxScrollTop,
    );
    return true;
};

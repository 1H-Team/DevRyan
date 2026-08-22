import React from 'react';

type IntersectionObserverFactory = new (
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
) => IntersectionObserver;

export const observeNearViewport = (
    element: Element,
    onNear: () => void,
    Observer: IntersectionObserverFactory | undefined = globalThis.IntersectionObserver,
): (() => void) => {
    if (!Observer) {
        onNear();
        return () => undefined;
    }
    let triggered = false;
    const observer = new Observer((entries) => {
        if (triggered || !entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) return;
        triggered = true;
        onNear();
        observer.disconnect();
    }, { rootMargin: '640px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
};

export const useNearViewport = <TElement extends Element>(): {
    ref: React.RefObject<TElement | null>;
    isNearViewport: boolean;
} => {
    const ref = React.useRef<TElement>(null);
    const [isNearViewport, setIsNearViewport] = React.useState(false);

    React.useEffect(() => {
        const element = ref.current;
        if (!element || isNearViewport) return;
        return observeNearViewport(element, () => setIsNearViewport(true));
    }, [isNearViewport]);

    return { ref, isNearViewport };
};

import React from 'react';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { cn } from '@/lib/utils';
import { isWithinToolOutputBottomThreshold } from './toolScrollFollow';

interface ToolScrollableSectionProps {
    children: React.ReactNode;
    maxHeightClass?: string;
    className?: string;
    outerClassName?: string;
    disableHorizontal?: boolean;
    followOutput?: boolean;
    contentVersion?: string | number;
}

export const ToolScrollableSection: React.FC<ToolScrollableSectionProps> = ({
    children,
    maxHeightClass = 'max-h-[60vh]',
    className,
    outerClassName,
    disableHorizontal = false,
    followOutput = false,
    contentVersion,
}) => {
    const scrollRef = React.useRef<HTMLElement>(null);
    const pinnedRef = React.useRef(followOutput);
    const wasFollowingRef = React.useRef(false);

    React.useLayoutEffect(() => {
        const scrollElement = scrollRef.current;
        if (!followOutput || !scrollElement) {
            wasFollowingRef.current = false;
            return;
        }

        if (!wasFollowingRef.current) pinnedRef.current = true;
        wasFollowingRef.current = true;
        if (!pinnedRef.current) return;
        scrollElement.scrollTop = scrollElement.scrollHeight;
    }, [contentVersion, followOutput]);

    const handleScroll = React.useCallback(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement || !followOutput) return;
        pinnedRef.current = isWithinToolOutputBottomThreshold(
            scrollElement.scrollHeight,
            scrollElement.scrollTop,
            scrollElement.clientHeight,
        );
    }, [followOutput]);

    const handleWheel = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (followOutput && event.deltaY < 0) pinnedRef.current = false;
    }, [followOutput]);

    const handleTouchMove = React.useCallback(() => {
        if (followOutput) pinnedRef.current = false;
    }, [followOutput]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
        if (!followOutput) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pinnedRef.current = false;
    }, [followOutput]);

    return (
        <div className={cn('w-full min-w-0 flex-none overflow-hidden', outerClassName)}>
            <ScrollShadow
                ref={scrollRef}
                className={cn(
                    'tool-output-surface p-2 rounded-xl w-full min-w-0',
                    maxHeightClass,
                    disableHorizontal ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
                    className,
                )}
                size={24}
                style={{ overflowAnchor: 'none' }}
                onScroll={handleScroll}
                onWheel={handleWheel}
                onTouchMove={handleTouchMove}
                onKeyDownCapture={handleKeyDown}
            >
                <div className="w-full min-w-0">
                    {children}
                </div>
            </ScrollShadow>
        </div>
    );
};

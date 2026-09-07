import * as React from 'react';
import { Popover } from '@base-ui/react/popover';
import { RiFlashlightFill, RiLightbulbLine } from '@remixicon/react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { cn } from '@/lib/utils';
import { resolveChatThinkingLevel } from '@/lib/providers/chatThinking';
import { formatEffortLabel } from './mobileControlsUtils';
import { clampThinkingPosition, getThinkingDetent } from './thinkingSliderBehavior';

type ThinkingSliderProps = {
    levels: string[];
    value?: string | null;
    onChange(value: string): void;
    providerId?: string;
    disabled?: boolean;
    fastMode?: { enabled: boolean; onChange(enabled: boolean): void };
};

export const ThinkingSlider = React.memo(function ThinkingSlider({ levels, value, onChange, providerId, disabled = false, fastMode }: ThinkingSliderProps) {
    const selected = resolveChatThinkingLevel(value, levels);
    const selectedIndex = Math.max(0, levels.indexOf(selected ?? ''));
    const [preview, setPreview] = React.useState<{ index: number; position: number } | null>(null);
    const drag = React.useRef<{ pointerId: number; index: number; startX: number; origin: number; left: number; width: number } | null>(null);
    const index = preview?.index ?? selectedIndex;
    const position = preview?.position ?? selectedIndex;
    const interactive = !disabled && levels.length > 1;
    const label = levels.length ? formatEffortLabel(levels[index], { providerId }) : 'Fast Mode';
    const reduceMotion = useReducedMotion();
    const target = useMotionValue(position);
    const spring = useSpring(target, { stiffness: 1000, damping: 46, mass: 0.45 });
    const left = useTransform(reduceMotion ? target : spring, (next) => `${levels.length <= 1 ? 50 : clampThinkingPosition(next, levels.length) / (levels.length - 1) * 100}%`);
    React.useLayoutEffect(() => { target.set(position); }, [position, target]);
    // Model changes discard an in-flight preview before a new choice can commit.
    const identity = `${providerId}:${levels.join('|')}:${value}:${disabled}`;
    React.useLayoutEffect(() => { drag.current = null; setPreview(null); }, [identity]);
    if (!levels.length && !fastMode) return null;

    const commit = (next: number) => { if (levels[next]) onChange(levels[next]); };
    return (
        <div className="thinking-slider min-w-0" data-thinking-level={levels[index]}>
            <div className="mb-1 flex min-h-6 items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 typography-meta font-medium text-foreground">
                    <RiLightbulbLine aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="sr-only" aria-live="polite" aria-atomic="true">{label}</span>
                    <span aria-hidden="true" className="grid overflow-hidden py-1">
                        {reduceMotion ? <span>{label}</span> : <AnimatePresence initial={false}>
                            <motion.span key={label} className="col-start-1 row-start-1"
                                initial={{ opacity: 0, y: 6, filter: 'blur(2px)' }}
                                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                                exit={{ opacity: 0, y: -6, filter: 'blur(2px)' }}
                                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                                {label}
                            </motion.span>
                        </AnimatePresence>}
                    </span>
                </span>
                <button type="button" aria-label="Fast Mode" aria-pressed={fastMode?.enabled ?? false}
                    disabled={disabled || !fastMode}
                    title={fastMode ? 'Fast Mode' : 'Fast Mode Unavailable'}
                    onClick={() => fastMode?.onChange(!fastMode.enabled)}
                    className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30',
                        fastMode?.enabled ? 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]' : 'text-muted-foreground',
                        fastMode && 'cursor-pointer hover:bg-foreground/10')}>
                    <RiFlashlightFill aria-hidden="true" className="h-5 w-5" />
                </button>
            </div>
            {levels.length > 0 ? <div
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label="Thinking Level"
                aria-valuemin={0}
                aria-valuemax={Math.max(0, levels.length - 1)}
                aria-valuenow={index}
                aria-valuetext={label}
                aria-orientation="horizontal"
                aria-disabled={!interactive}
                className={cn('relative flex h-11 touch-none select-none items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring', interactive ? 'cursor-pointer' : 'cursor-default', disabled && 'opacity-50')}
                onKeyDown={(event) => {
                    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
                    if (!interactive || (delta === undefined && event.key !== 'Home' && event.key !== 'End')) return;
                    event.preventDefault(); event.stopPropagation();
                    commit(event.key === 'Home' ? 0 : event.key === 'End' ? levels.length - 1 : clampThinkingPosition(selectedIndex + (delta ?? 0), levels.length));
                }}
                onPointerDown={(event) => {
                    if (!interactive || event.button !== 0 || drag.current) return;
                    event.preventDefault(); event.currentTarget.focus();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const left = rect.left + 10;
                    const width = Math.max(1, rect.width - 20);
                    const raw = clampThinkingPosition((event.clientX - left) / width * (levels.length - 1), levels.length);
                    const onThumb = Math.abs(event.clientX - (left + selectedIndex / (levels.length - 1) * width)) <= 14;
                    const start = onThumb ? selectedIndex : Math.round(raw);
                    drag.current = { pointerId: event.pointerId, index: start, origin: start, startX: event.clientX, left, width };
                    setPreview({ index: start, position: start });
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const current = drag.current;
                    if (!current || current.pointerId !== event.pointerId) return;
                    const next = getThinkingDetent(current.origin + (event.clientX - current.startX) / current.width * (levels.length - 1), current.index, levels.length);
                    current.index = next.index;
                    setPreview(next);
                }}
                onPointerUp={(event) => {
                    const current = drag.current;
                    if (!current || current.pointerId !== event.pointerId) return;
                    drag.current = null; setPreview(null);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    commit(current.index);
                }}
                onPointerCancel={() => { drag.current = null; setPreview(null); }}
                onLostPointerCapture={() => { drag.current = null; setPreview(null); }}
            >
                <div aria-hidden="true" className="relative h-5 w-full rounded-full bg-foreground/15">
                    <div className="absolute inset-x-[10px] top-1/2">
                        {levels.map((level, stop) => <span key={level} className="absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30" style={{ left: `${levels.length === 1 ? 50 : stop / (levels.length - 1) * 100}%` }} />)}
                        <motion.span data-thinking-thumb className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm" style={{ left }} />
                    </div>
                </div>
            </div> : null}
        </div>
    );
});

export function ThinkingSliderPopover({ trigger, children, disabled }: { trigger: React.ReactElement; children: React.ReactNode; disabled?: boolean }) {
    const [open, setOpen] = React.useState(false);
    const popupRef = React.useRef<HTMLDivElement>(null);
    return <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={trigger} disabled={disabled} />
        <Popover.Portal>
            <Popover.Positioner side="top" align="center" sideOffset={12} collisionPadding={12} className="z-[100]">
                <Popover.Popup ref={popupRef} initialFocus={() => popupRef.current?.querySelector<HTMLElement>('[role="slider"]') ?? true}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
                    aria-label="Thinking Options" className="w-[min(280px,calc(100vw-24px))] rounded-xl border border-border/60 bg-background/95 p-5 shadow-xl outline-none backdrop-blur-xl">
                    {children}
                    <Popover.Arrow className="absolute -bottom-[5px] h-[10px] w-[10px] rotate-45 border-b border-r border-border/60 bg-background" />
                </Popover.Popup>
            </Popover.Positioner>
        </Popover.Portal>
    </Popover.Root>;
}

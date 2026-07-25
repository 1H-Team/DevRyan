import React from "react";

import { syncScrollShadowAttributes } from "./scrollShadowAttributes";

export type ScrollShadowProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  orientation?: "vertical" | "horizontal";
  offset?: number;
  size?: number;
  isEnabled?: boolean;
  hideTopShadow?: boolean;
  hideBottomShadow?: boolean;
  observeMutations?: boolean;
  onVisibilityChange?: (state: "both" | "none" | "top" | "bottom" | "left" | "right") => void;
  /**
   * Forwarded to the rendered element (kept in `...rest`). When `as` is a
   * framer-motion component this lets callers mark the scroller as a layout
   * scroll container so descendant layout animations stay smooth.
   */
  layoutScroll?: boolean;
};

function mergeRefs<T>(...refs: Array<React.Ref<T>>): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(value);
      } else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    });
  };
}

const removeAttributeIfPresent = (element: HTMLElement, name: string) => {
  if (!element.hasAttribute(name)) return;
  element.removeAttribute(name);
};

export const ScrollShadow = React.forwardRef<HTMLElement, ScrollShadowProps>(
      (
      {
        as: Component = "div",
        orientation = "vertical",
        offset = 0,
        size = 48,
        isEnabled = true,
        hideTopShadow = false,
        hideBottomShadow = false,
        observeMutations = true,
        onVisibilityChange,
        style,
        className,
        children,
        ...rest
    },
    ref,
  ) => {
    const internalRef = React.useRef<HTMLElement>(null);
    const visibleRef = React.useRef<"both" | "none" | "top" | "bottom" | "left" | "right">("none");

    const dataScrollShadow = (rest as Record<string, unknown>)["data-scroll-shadow"];
    delete (rest as Record<string, unknown>)["data-scroll-shadow"];

    const mergedStyle = React.useMemo<React.CSSProperties>(() => {
      const next: React.CSSProperties = {
        ...(style as React.CSSProperties),
      };
      (next as Record<string, string>)["--scroll-shadow-size"] = `${size}px`;
      return next;
    }, [size, style]);

    const clearAttributes = React.useCallback((el: HTMLElement) => {
      ["top", "bottom", "top-bottom", "left", "right", "left-right"].forEach((attr) => {
        removeAttributeIfPresent(el, `data-${attr}-scroll`);
      });
    }, []);

    const checkOverflow = React.useCallback(() => {
      const el = internalRef.current;
      if (!el) return;

      if (!isEnabled) {
        clearAttributes(el);
        return;
      }

      // Subpixel tolerance: on hi-DPI (Retina) and with fractional scrollTop,
      // scrollTop+clientHeight can fall ~0.5px short of scrollHeight at the very end,
      // which would otherwise keep the bottom fade visible after fully scrolling.
      const SUBPIXEL_TOLERANCE = 1;
      const hasBefore =
        orientation === "vertical"
          ? el.scrollTop > offset + SUBPIXEL_TOLERANCE
          : el.scrollLeft > offset + SUBPIXEL_TOLERANCE;
      let hasAfter =
        orientation === "vertical"
          ? el.scrollHeight - (el.scrollTop + el.clientHeight) > offset + SUBPIXEL_TOLERANCE
          : el.scrollWidth - (el.scrollLeft + el.clientWidth) > offset + SUBPIXEL_TOLERANCE;

      const effectiveHasBefore = hideTopShadow && orientation === "vertical" ? false : hasBefore;

      if (hideBottomShadow && orientation === "vertical") {
        hasAfter = false;
      }

      syncScrollShadowAttributes(
        el,
        effectiveHasBefore,
        hasAfter,
        orientation === "vertical" ? "top" : "left",
        orientation === "vertical" ? "bottom" : "right",
      );

      const next = effectiveHasBefore && hasAfter ? "both" : effectiveHasBefore ? (orientation === "vertical" ? "top" : "left") : hasAfter ? (orientation === "vertical" ? "bottom" : "right") : "none";
      if (next !== visibleRef.current) {
        visibleRef.current = next;
        onVisibilityChange?.(next);
      }
    }, [clearAttributes, hideTopShadow, hideBottomShadow, isEnabled, offset, onVisibilityChange, orientation]);

    React.useEffect(() => {
      const el = internalRef.current;
      if (!el) return;

      // Throttle with RAF to avoid excessive calls during rapid DOM changes
      let rafId: number | null = null;
      const throttledCheck = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          checkOverflow();
        });
      };

      const handleScroll = () => checkOverflow(); // Scroll should be immediate
      const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(throttledCheck) : null;
      const mutationObserver =
        observeMutations && typeof MutationObserver !== "undefined" ? new MutationObserver(throttledCheck) : null;

      checkOverflow();

      el.addEventListener("scroll", handleScroll, { passive: true });
      resizeObserver?.observe(el);
      mutationObserver?.observe(el, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        el.removeEventListener("scroll", handleScroll);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
      };
    }, [checkOverflow, observeMutations]);

    return (
      <Component
        {...rest}
        ref={mergeRefs(internalRef, ref)}
        className={className}
        data-orientation={orientation}
        data-scroll-shadow={dataScrollShadow ?? true}
        style={mergedStyle}
      >
        {children}
      </Component>
    );
  },
);

ScrollShadow.displayName = "ScrollShadow";

import * as React from "react"
import { RiAddLine, RiSubtractLine } from "@remixicon/react"

import { useDeviceInfo } from "@/lib/device"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import {
  consumeMobileSyntheticClick,
  normalizeNumberInputValue,
  resolveNumberInputBaseValue,
  stepNumberInputValue,
  type NumberInputDirection,
} from "./number-input-value"

export interface NumberInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value?: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  containerClassName?: string
  fallbackValue?: number
  onClear?: () => void
  emptyLabel?: string
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      onValueChange,
      min = -Infinity,
      max = Infinity,
      step = 1,
      className,
      containerClassName,
      onBlur,
      disabled,
      fallbackValue,
      onClear,
      emptyLabel = '—',
      ...props
    },
    ref
  ) => {
    const { t } = useI18n()
    const [draft, setDraft] = React.useState(() => (value === undefined ? '' : String(value)))
    const { isMobile } = useDeviceInfo()
    const ignoreNextClickRef = React.useRef(false)
    const optimisticValueRef = React.useRef<number | undefined>(value)
    const swallowNextClickCleanupRef = React.useRef<(() => void) | null>(null)

    const swallowNextClick = React.useCallback(() => {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        return
      }

      swallowNextClickCleanupRef.current?.()

      const handleCaptureClick = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(event as any).stopImmediatePropagation?.()
        swallowNextClickCleanupRef.current?.()
      }

      const timeoutId = window.setTimeout(() => {
        swallowNextClickCleanupRef.current?.()
      }, 700)

      const cleanup = () => {
        window.clearTimeout(timeoutId)
        document.removeEventListener('click', handleCaptureClick, true)
        swallowNextClickCleanupRef.current = null
      }

      swallowNextClickCleanupRef.current = cleanup
      document.addEventListener('click', handleCaptureClick, true)
    }, [])

    React.useEffect(() => {
      return () => {
        swallowNextClickCleanupRef.current?.()
      }
    }, [])

    React.useEffect(() => {
      optimisticValueRef.current = value
      setDraft(value === undefined ? '' : String(value))
    }, [value])

    const baseValue = resolveNumberInputBaseValue(optimisticValueRef.current, fallbackValue, min)

    const commitValue = React.useCallback(
      (rawValue: number, options: { syncDraft?: boolean; notifyIfUnchanged?: boolean } = {}) => {
        const normalized = normalizeNumberInputValue(rawValue, min, max, step)
        const previous = optimisticValueRef.current
        optimisticValueRef.current = normalized
        if (options.syncDraft) {
          setDraft(String(normalized))
        }
        if (options.notifyIfUnchanged !== false || !Object.is(previous, normalized)) {
          onValueChange(normalized)
        }
        return normalized
      },
      [max, min, onValueChange, step]
    )

    const commitStep = React.useCallback((direction: NumberInputDirection) => {
      const nextValue = stepNumberInputValue({
        optimisticValue: optimisticValueRef.current,
        fallbackValue,
        min,
        max,
        step,
        direction,
      })
      commitValue(nextValue, { syncDraft: true })
    }, [commitValue, fallbackValue, max, min, step])

    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const nextDraft = event.target.value
        setDraft(nextDraft)

        if (nextDraft.trim() === '') {
          optimisticValueRef.current = undefined
          onClear?.()
          return
        }

        const parsed = Number(nextDraft)
        if (!Number.isFinite(parsed)) {
          return
        }

        commitValue(parsed)
      },
      [commitValue, onClear]
    )

    const handleBlur = React.useCallback(
      (event: React.FocusEvent<HTMLInputElement>) => {
        if (draft.trim() === '') {
          if (!onClear) {
            const currentValue = optimisticValueRef.current
            setDraft(currentValue === undefined ? '' : String(currentValue))
          }
          onBlur?.(event)
          return
        }

        const parsed = Number(draft)
        if (!Number.isFinite(parsed)) {
          const currentValue = optimisticValueRef.current
          setDraft(currentValue === undefined ? '' : String(currentValue))
        } else {
          commitValue(parsed, { syncDraft: true, notifyIfUnchanged: false })
        }

        onBlur?.(event)
      },
      [commitValue, draft, onBlur, onClear]
    )

    const incrementDisabled = Boolean(disabled || baseValue >= max)
    const decrementDisabled = Boolean(disabled || baseValue <= min)

    const handleMobileDecrement = () => {
      if (!decrementDisabled) {
        commitStep(-1)
      }
    }

    const handleMobileIncrement = () => {
      if (!incrementDisabled) {
        commitStep(1)
      }
    }

    const handleMobileTouchActivate = (handler: () => void) => (event: React.TouchEvent) => {
      event.preventDefault()
      event.stopPropagation()
      // Touch on iOS often triggers a follow-up click; ignore it.
      ignoreNextClickRef.current = true
      // Also swallow the synthetic click anywhere (prevents layout-shift clicks).
      swallowNextClick()
      handler()
    }

    const handleMobileClickActivate = (handler: () => void) => (event: React.MouseEvent) => {
      if (!consumeMobileSyntheticClick(ignoreNextClickRef)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      handler()
    }

    if (isMobile) {
      return (
        <div
          className={cn(
            // NOTE: mobile.css enforces min-height:36px on buttons; match it to avoid clipping.
            "flex h-9 shrink-0 items-stretch overflow-x-hidden overflow-y-hidden rounded-lg border border-border bg-transparent select-none overscroll-contain",
            "[-webkit-user-select:none] [-webkit-touch-callout:none]",
            "disabled:pointer-events-none disabled:opacity-50",
            containerClassName
          )}
        >
          <button
            type="button"
            aria-label={t('numberInput.actions.decreaseAria')}
            disabled={decrementDisabled}
            onTouchStart={handleMobileTouchActivate(handleMobileDecrement)}
            onClick={handleMobileClickActivate(handleMobileDecrement)}
            className={cn(
              "grid h-full min-h-0 w-9 place-items-center overflow-x-hidden overflow-y-hidden border-r border-border p-0 leading-none touch-none",
              "text-muted-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              !decrementDisabled && "active:bg-interactive-hover"
            )}
          >
            <RiSubtractLine className="block h-4 w-4" />
          </button>

          <div
            className={cn(
              "flex h-full min-w-0 w-14 items-center justify-center bg-transparent px-1.5",
              "text-center text-[16px] leading-none text-foreground [font-variant-numeric:tabular-nums]",
              className
            )}
            aria-live="polite"
          >
            {value === undefined ? emptyLabel : draft}
          </div>

          <button
            type="button"
            aria-label={t('numberInput.actions.increaseAria')}
            disabled={incrementDisabled}
            onTouchStart={handleMobileTouchActivate(handleMobileIncrement)}
            onClick={handleMobileClickActivate(handleMobileIncrement)}
            className={cn(
              "grid h-full min-h-0 w-9 place-items-center overflow-x-hidden overflow-y-hidden border-l border-border p-0 leading-none touch-none",
              "text-muted-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              !incrementDisabled && "active:bg-interactive-hover"
            )}
          >
            <RiAddLine className="block h-4 w-4" />
          </button>
        </div>
      )
    }

    return (
      <div
        className={cn(
          "flex h-7 shrink-0 items-stretch overflow-x-hidden overflow-y-hidden rounded-lg border border-border bg-transparent",
          "disabled:pointer-events-none disabled:opacity-50",
          containerClassName
        )}
      >
        <button
          type="button"
          aria-label={t('numberInput.actions.decreaseAria')}
          disabled={decrementDisabled}
          onClick={() => commitStep(-1)}
          className={cn(
            "flex h-full w-7 items-center justify-center overflow-x-hidden overflow-y-hidden border-r border-border p-0 leading-none touch-manipulation",
            "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          <RiSubtractLine className="block h-3.5 w-3.5" />
        </button>
        <input
          {...props}
          ref={ref}
          type="text"
          inputMode={props.inputMode ?? 'numeric'}
          value={draft}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={cn(
            "h-full min-w-0 w-14 bg-transparent px-1.5 text-center typography-ui-label leading-none text-foreground [font-variant-numeric:tabular-nums]",
            "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
            "appearance-none outline-none [appearance:textfield] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "disabled:pointer-events-none disabled:cursor-not-allowed",
            className
          )}
        />
        <button
          type="button"
          aria-label={t('numberInput.actions.increaseAria')}
          disabled={incrementDisabled}
          onClick={() => commitStep(1)}
          className={cn(
            "flex h-full w-7 items-center justify-center overflow-x-hidden overflow-y-hidden border-l border-border p-0 leading-none touch-manipulation",
            "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          <RiAddLine className="block h-3.5 w-3.5" />
        </button>
      </div>
    )
  }
)
NumberInput.displayName = "NumberInput"

export { NumberInput }

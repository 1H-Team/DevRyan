import React from "react"
import { RiCheckLine } from "@remixicon/react"

import { cn } from "@/lib/utils"

export type QuestionOptionRowProps = {
  label: string
  description: string
  selected: boolean
  multiple: boolean
  disabled: boolean
  recommended: boolean
  recommendedLabel: string
  onSelect: () => void
}

export function QuestionOptionRow({
  label,
  description,
  selected,
  multiple,
  disabled,
  recommended,
  recommendedLabel,
  onSelect,
}: QuestionOptionRowProps): React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>> {
  return (
    <button
      type="button"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "w-full px-1.5 py-1 text-left rounded-lg transition-colors",
        "hover:bg-interactive-hover/30",
        selected ? "bg-interactive-selection/20" : null,
        disabled ? "opacity-60 cursor-not-allowed" : null,
      )}
    >
      <span className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border/70 bg-muted/40",
          )}
        >
          {selected ? <RiCheckLine className="h-2.5 w-2.5" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span
              className={cn(
                // Constant font-weight: a selection-driven weight change widens
                // the label and re-wraps the row, shifting the card height.
                "typography-meta font-medium break-words",
                selected ? "text-foreground" : "text-foreground/80",
              )}
            >
              {label}
            </span>
            {recommended ? (
              <span className="rounded-full bg-muted/60 px-2 py-0.5 typography-micro text-muted-foreground">{recommendedLabel}</span>
            ) : null}
            {description ? (
              <span className="typography-micro text-muted-foreground break-words">{description}</span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  )
}

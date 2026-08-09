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
        "w-full px-1.5 py-1 text-left rounded transition-colors",
        "hover:bg-interactive-hover/30",
        selected ? "bg-interactive-selection/20" : null,
        disabled ? "opacity-60 cursor-not-allowed" : null,
      )}
    >
      <span className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-border/70",
            multiple ? "rounded-sm" : "rounded-full",
            selected ? "border-primary text-primary" : "text-transparent",
          )}
        >
          {multiple ? (
            <RiCheckLine className="h-3 w-3" />
          ) : (
            <span className={cn("h-1.5 w-1.5 rounded-full", selected ? "bg-primary" : "bg-transparent")} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span
              className={cn(
                "typography-meta break-words",
                selected ? "text-foreground font-medium" : "text-foreground/80",
              )}
            >
              {label}
            </span>
            {recommended ? (
              <span className="typography-micro text-primary">{recommendedLabel}</span>
            ) : null}
          </span>
          {description ? (
            <span className="block typography-micro text-muted-foreground break-words">{description}</span>
          ) : null}
        </span>
      </span>
    </button>
  )
}

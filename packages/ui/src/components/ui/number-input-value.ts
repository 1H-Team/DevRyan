export type NumberInputDirection = -1 | 1

export function getNumberInputStepDecimals(step: number) {
  if (!Number.isFinite(step)) return 0
  const stepString = String(step)
  if (stepString.includes("e-")) {
    const [, exp] = stepString.split("e-")
    return Number(exp) || 0
  }
  const parts = stepString.split(".")
  return parts.length === 2 ? parts[1]!.length : 0
}

export function normalizeNumberInputValue(value: number, min: number, max: number, step: number) {
  const clamped = Math.min(max, Math.max(min, value))
  const decimals = getNumberInputStepDecimals(step)
  return decimals <= 0 ? clamped : Number(clamped.toFixed(decimals))
}

export function resolveNumberInputBaseValue(
  optimisticValue: number | undefined,
  fallbackValue: number | undefined,
  min: number,
) {
  if (optimisticValue !== undefined && Number.isFinite(optimisticValue)) return optimisticValue
  if (fallbackValue !== undefined && Number.isFinite(fallbackValue)) return fallbackValue
  if (Number.isFinite(min)) return min
  return 0
}

export function stepNumberInputValue({
  optimisticValue,
  fallbackValue,
  min,
  max,
  step,
  direction,
}: {
  optimisticValue: number | undefined
  fallbackValue: number | undefined
  min: number
  max: number
  step: number
  direction: NumberInputDirection
}) {
  const base = resolveNumberInputBaseValue(optimisticValue, fallbackValue, min)
  return normalizeNumberInputValue(base + (direction * step), min, max, step)
}

export function consumeMobileSyntheticClick(guard: { current: boolean }) {
  if (!guard.current) return true
  guard.current = false
  return false
}

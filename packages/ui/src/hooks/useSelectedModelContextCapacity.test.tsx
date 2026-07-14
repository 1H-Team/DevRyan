import { describe, expect, test } from "bun:test"
import { useConfigStore } from "@/stores/useConfigStore"
import {
  getSelectedModelContextCapacitySnapshot,
  selectSelectedModelForContextCapacity,
} from "./useSelectedModelContextCapacity"

const initialState = useConfigStore.getState()

describe("useSelectedModelContextCapacity", () => {
  test("resolves selected model and variant changes from the live store snapshot", () => {
    try {
      useConfigStore.setState({
        providers: [{
          id: "cursor-acp",
          name: "Cursor",
          models: [{
            id: "gpt-5.5",
            name: "GPT-5.5",
            limit: { context: 1_000_000 },
            variants: { fast: { limit: { context: 272_000 } } },
          }],
        }] as never,
        currentProviderId: "cursor-acp",
        currentModelId: "gpt-5.5",
        currentVariant: undefined,
      })

      expect(getSelectedModelContextCapacitySnapshot().capacityLimit).toBe(1_000_000)

      useConfigStore.setState({ currentVariant: "fast" })
      expect(getSelectedModelContextCapacitySnapshot().capacityLimit).toBe(272_000)

      useConfigStore.setState({ currentModelId: "missing", currentVariant: undefined })
      expect(getSelectedModelContextCapacitySnapshot().capacityLimit).toBeNull()
    } finally {
      useConfigStore.setState({
        providers: initialState.providers,
        currentProviderId: initialState.currentProviderId,
        currentModelId: initialState.currentModelId,
        currentVariant: initialState.currentVariant,
      })
    }
  })

  test("selects a new model entity when catalog limits refresh without changing IDs", () => {
    try {
      useConfigStore.setState({
        providers: [{
          id: "cursor-acp",
          name: "Cursor",
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
        }] as never,
        currentProviderId: "cursor-acp",
        currentModelId: "gpt-5.5",
        currentVariant: undefined,
      })
      const fallbackModel = selectSelectedModelForContextCapacity(useConfigStore.getState())

      useConfigStore.setState({
        providers: [{
          id: "cursor-acp",
          name: "Cursor",
          models: [{
            id: "gpt-5.5",
            name: "GPT-5.5",
            limit: { context: 1_000_000 },
          }],
        }] as never,
      })
      const refreshedModel = selectSelectedModelForContextCapacity(useConfigStore.getState())

      expect(refreshedModel).not.toBe(fallbackModel)
      expect(getSelectedModelContextCapacitySnapshot().capacityLimit).toBe(1_000_000)
    } finally {
      useConfigStore.setState({
        providers: initialState.providers,
        currentProviderId: initialState.currentProviderId,
        currentModelId: initialState.currentModelId,
        currentVariant: initialState.currentVariant,
      })
    }
  })
})

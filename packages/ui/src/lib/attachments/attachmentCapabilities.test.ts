import { afterEach, describe, expect, test } from "bun:test"

import {
  getPdfAttachmentValidation,
  getPdfInputSupportFromMetadata,
  hasPdfAttachment,
  type AttachmentCapabilityModelMetadata,
} from "./attachmentCapabilities"
import { useConfigApplyStore } from "@/stores/useConfigApplyStore"

const metadata = (input?: string[], attachment?: boolean): AttachmentCapabilityModelMetadata => ({
  id: "model-a",
  providerId: "provider-a",
  name: "Model A",
  attachment,
  modalities: input ? { input, output: ["text"] } : undefined,
})

afterEach(() => {
  useConfigApplyStore.setState({ status: null })
})

describe("attachment capability helpers", () => {
  test("detects PDF attachments by MIME type", () => {
    expect(hasPdfAttachment([{ mime: "application/pdf", filename: "document.bin" }])).toBe(true)
  })

  test("detects PDF attachments by filename when MIME is empty", () => {
    expect(hasPdfAttachment([{ mime: "", filename: "document.pdf" }])).toBe(true)
  })

  test("returns supported when input modalities include pdf", () => {
    expect(getPdfInputSupportFromMetadata(metadata(["text", "pdf"], false))).toBe("supported")
  })

  test("returns unsupported when explicit input modalities exclude pdf", () => {
    expect(getPdfInputSupportFromMetadata(metadata(["text", "image"], true))).toBe("unsupported")
  })

  test("returns unknown when metadata is missing", () => {
    expect(getPdfInputSupportFromMetadata(undefined)).toBe("unknown")
  })

  test("treats PDF input as supported when managed document extraction is active", () => {
    expect(getPdfAttachmentValidation({
      providerID: "provider-a",
      modelID: "model-a",
      files: [{ mime: "application/pdf", filename: "document.pdf" }],
      runtimeMode: "managed",
    })).toEqual({ hasPdf: true, status: "supported" })
  })

  test("reads managed extraction availability from the authoritative runtime status", () => {
    useConfigApplyStore.setState({
      status: {
        revision: 0,
        appliedRevision: 0,
        state: "clean",
        pending: false,
        scopes: [],
        reasonCodes: [],
        activeSessionCount: 0,
        runtimeMode: "managed",
        canApplyWhenIdle: false,
        canForceRestart: false,
      },
    })
    expect(getPdfAttachmentValidation({
      providerID: "provider-a",
      modelID: "model-a",
      files: [{ mime: "application/pdf", filename: "document.pdf" }],
    })).toEqual({ hasPdf: true, status: "supported" })
  })

  test("preserves provider-native PDF capability checks for external runtimes", () => {
    expect(getPdfAttachmentValidation({
      providerID: "provider-a",
      modelID: "model-a",
      files: [{ mime: "application/pdf", filename: "document.pdf" }],
      runtimeMode: "external",
    })).toEqual({ hasPdf: true, status: "unknown" })
  })
})

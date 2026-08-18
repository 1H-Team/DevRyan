import { useConfigStore } from "@/stores/useConfigStore"
import { useConfigApplyStore } from "@/stores/useConfigApplyStore"
import type { ModelMetadata } from "@/types"

export type AttachmentCapabilityModelMetadata = Pick<ModelMetadata, "attachment" | "modalities"> & {
  id?: string
  providerId?: string
  name?: string
}

export type PdfInputSupport = "supported" | "unsupported" | "unknown"

export type AttachmentCapabilityFile = {
  mime?: string
  mimeType?: string
  filename?: string
  name?: string
}

export type AttachmentValidationResult = {
  status: PdfInputSupport
  hasPdf: boolean
}

export type AttachmentRuntimeMode = "managed" | "external"

const normalizeMime = (value: unknown): string =>
  typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : ""

const normalizeFilename = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : ""

export const isPdfAttachment = (file: AttachmentCapabilityFile | undefined | null): boolean => {
  if (!file) return false
  const mime = normalizeMime(file.mimeType || file.mime)
  if (mime === "application/pdf") return true

  const filename = normalizeFilename(file.filename || file.name)
  return filename.endsWith(".pdf")
}

export const hasPdfAttachment = (files: Array<AttachmentCapabilityFile | undefined | null> | undefined): boolean =>
  Array.isArray(files) && files.some(isPdfAttachment)

export const getPdfInputSupportFromMetadata = (
  metadata: AttachmentCapabilityModelMetadata | undefined,
): PdfInputSupport => {
  if (!metadata) return "unknown"

  const inputModalities = metadata.modalities?.input
  if (Array.isArray(inputModalities) && inputModalities.length > 0) {
    return inputModalities.some((modality) => modality.trim().toLowerCase() === "pdf")
      ? "supported"
      : "unsupported"
  }

  if (metadata.attachment === false) return "unsupported"
  if (metadata.attachment === true) return "supported"
  return "unknown"
}

export const getPdfInputSupportForModel = (providerID: string, modelID: string): PdfInputSupport => {
  const metadata = useConfigStore.getState().getModelMetadata?.(providerID, modelID)
  return getPdfInputSupportFromMetadata(metadata)
}

export const getPdfAttachmentValidation = (params: {
  providerID: string
  modelID: string
  files?: Array<AttachmentCapabilityFile | undefined | null>
  runtimeMode?: AttachmentRuntimeMode
}): AttachmentValidationResult => {
  const hasPdf = hasPdfAttachment(params.files)
  if (!hasPdf) {
    return { hasPdf: false, status: "supported" }
  }
  const runtimeMode = params.runtimeMode ?? useConfigApplyStore.getState().status?.runtimeMode
  if (runtimeMode === "managed") {
    return { hasPdf: true, status: "supported" }
  }
  return {
    hasPdf: true,
    status: getPdfInputSupportForModel(params.providerID, params.modelID),
  }
}

export const PDF_UNSUPPORTED_MESSAGE =
  "The selected model does not support PDF input. Choose a PDF-capable model or convert the PDF to text."

export const PDF_UNKNOWN_SUPPORT_MESSAGE =
  "This model's PDF support is unknown. The PDF will be sent, but the agent may not be able to read it."

export const assertPdfAttachmentsSupported = (params: {
  providerID: string
  modelID: string
  files?: Array<AttachmentCapabilityFile | undefined | null>
}): void => {
  const validation = getPdfAttachmentValidation(params)
  if (validation.hasPdf && validation.status === "unsupported") {
    throw new Error(PDF_UNSUPPORTED_MESSAGE)
  }
}

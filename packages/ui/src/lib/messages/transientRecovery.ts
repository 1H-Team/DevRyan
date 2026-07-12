import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { hasRenderableAssistantContent } from "@/components/chat/chatMessageLayout"
import { isSyntheticPart } from "./synthetic"

export const TRANSIENT_CONTINUATION_PROMPT = "Continue where you left off. The previous step failed due to a temporary provider connection error — resume the task without repeating work that already completed."

export type TransientRecoveryAttachment = {
  mimeType: string
  dataUrl: string
  filename: string
}

export type TransientRecoveryPlan = {
  mode: "resend" | "continue"
  anchorUserMessageId: string
  erroredMessageId?: string
  content: string
  attachments: TransientRecoveryAttachment[]
  providerID?: string
  modelID?: string
}

type PlanTransientRecoveryInput = {
  messages: Message[]
  getParts: (messageId: string) => Part[]
  erroredMessageId: string
}

type PlanManualRecoveryInput = {
  messages: Message[]
  getParts: (messageId: string) => Part[]
  anchorUserMessageId: string
}

function getRestorableText(parts: Part[]): string {
  return parts
    .filter((part) => part.type === "text" && !isSyntheticPart(part))
    .map((part) => {
      const record = part as { text?: unknown; content?: unknown }
      if (typeof record.text === "string") return record.text
      return typeof record.content === "string" ? record.content : ""
    })
    .join("\n")
    .trim()
}

function getRestorableAttachments(parts: Part[]): TransientRecoveryAttachment[] {
  const attachments: TransientRecoveryAttachment[] = []
  for (const part of parts) {
    if (part.type !== "file" || isSyntheticPart(part)) continue

    const filename = typeof part.filename === "string" && part.filename.trim()
      ? part.filename.trim()
      : "attachment"
    const dataUrl = typeof part.url === "string" ? part.url.trim() : ""
    const mimeType = typeof part.mime === "string" ? part.mime.trim() : ""
    if (!dataUrl || !mimeType) continue

    attachments.push({ mimeType, dataUrl, filename })
  }
  return attachments
}

export function planTransientRecovery({
  messages,
  getParts,
  erroredMessageId,
}: PlanTransientRecoveryInput): TransientRecoveryPlan | null {
  const erroredMessage = messages.at(-1)
  if (!erroredMessage || erroredMessage.id !== erroredMessageId || erroredMessage.role !== "assistant") {
    return null
  }

  let anchorIndex = -1
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      anchorIndex = index
      break
    }
  }
  if (anchorIndex < 0) {
    return null
  }

  const anchorMessage = messages[anchorIndex]
  if (!anchorMessage || anchorMessage.role !== "user") {
    return null
  }

  const hasAssistantContent = messages
    .slice(anchorIndex + 1)
    .some((message) => message.role === "assistant" && hasRenderableAssistantContent(getParts(message.id)))

  const providerID = erroredMessage.providerID?.trim() || undefined
  const modelID = erroredMessage.modelID?.trim() || undefined
  const basePlan = {
    anchorUserMessageId: anchorMessage.id,
    erroredMessageId,
    providerID,
    modelID,
  }

  if (hasAssistantContent) {
    return {
      ...basePlan,
      mode: "continue",
      content: TRANSIENT_CONTINUATION_PROMPT,
      attachments: [],
    }
  }

  const anchorParts = getParts(anchorMessage.id)
  const content = getRestorableText(anchorParts)
  const attachments = getRestorableAttachments(anchorParts)
  if (!content && attachments.length === 0) {
    return null
  }

  return {
    ...basePlan,
    mode: "resend",
    content,
    attachments,
  }
}

export function planManualRecovery({
  messages,
  getParts,
  anchorUserMessageId,
}: PlanManualRecoveryInput): TransientRecoveryPlan | null {
  const anchorIndex = messages.findIndex((message) => (
    message.id === anchorUserMessageId && message.role === "user"
  ))
  if (anchorIndex < 0) return null
  const anchorMessage = messages[anchorIndex] as Message & {
    model?: { providerID?: string; modelID?: string }
  }
  const trailingMessages = messages.slice(anchorIndex + 1)
  if (trailingMessages.some((message) => message.role === "user")) return null
  const assistants = trailingMessages.filter((message) => message.role === "assistant")
  const latestAssistant = assistants.at(-1)
  const hasAssistantContent = assistants.some((message) => (
    hasRenderableAssistantContent(getParts(message.id))
  ))
  const basePlan = {
    anchorUserMessageId,
    ...(latestAssistant ? { erroredMessageId: latestAssistant.id } : {}),
    providerID: latestAssistant?.providerID?.trim() || anchorMessage.model?.providerID?.trim() || undefined,
    modelID: latestAssistant?.modelID?.trim() || anchorMessage.model?.modelID?.trim() || undefined,
  }
  if (hasAssistantContent) {
    return {
      ...basePlan,
      mode: "continue",
      content: TRANSIENT_CONTINUATION_PROMPT,
      attachments: [],
    }
  }
  const anchorParts = getParts(anchorMessage.id)
  const content = getRestorableText(anchorParts)
  const attachments = getRestorableAttachments(anchorParts)
  if (!content && attachments.length === 0) return null
  return {
    ...basePlan,
    mode: "resend",
    content,
    attachments,
  }
}

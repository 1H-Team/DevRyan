import type { Message } from "@opencode-ai/sdk/v2/client"

type ChronologicalMessage = Pick<Message, "id"> & {
  time?: { created?: unknown }
}

const createdAt = (message: ChronologicalMessage): number => {
  const value = message.time?.created
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

const compareIDs = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
)

export function compareMessagesChronologically(
  left: ChronologicalMessage,
  right: ChronologicalMessage,
): number {
  const timeDelta = createdAt(left) - createdAt(right)
  return timeDelta === 0 ? compareIDs(left.id, right.id) : timeDelta
}

export function sortMessagesChronologically<T extends ChronologicalMessage>(messages: readonly T[]): T[] {
  return [...messages].sort(compareMessagesChronologically)
}

export function insertMessageChronologically<T extends ChronologicalMessage>(
  messages: readonly T[],
  message: T,
): T[] {
  let low = 0
  let high = messages.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareMessagesChronologically(messages[middle], message) <= 0) low = middle + 1
    else high = middle
  }
  const next = [...messages]
  next.splice(low, 0, message)
  return next
}

export function findMessageIndex<T extends Pick<Message, "id">>(
  messages: readonly T[],
  messageID: string,
): number {
  return messages.findIndex((message) => message.id === messageID)
}

export function messagesBefore<T extends Pick<Message, "id">>(messages: T[], markerID: string): T[]
export function messagesBefore<T extends Pick<Message, "id">>(messages: readonly T[], markerID: string): readonly T[]
export function messagesBefore<T extends Pick<Message, "id">>(
  messages: readonly T[],
  markerID: string,
): readonly T[] {
  const markerIndex = findMessageIndex(messages, markerID)
  return markerIndex < 0 ? messages : messages.slice(0, markerIndex)
}

export function messagesFrom<T extends Pick<Message, "id">>(messages: T[], markerID: string): T[]
export function messagesFrom<T extends Pick<Message, "id">>(messages: readonly T[], markerID: string): readonly T[]
export function messagesFrom<T extends Pick<Message, "id">>(
  messages: readonly T[],
  markerID: string,
): readonly T[] {
  const markerIndex = findMessageIndex(messages, markerID)
  return markerIndex < 0 ? [] : messages.slice(markerIndex)
}

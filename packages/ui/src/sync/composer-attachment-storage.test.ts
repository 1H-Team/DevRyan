import { describe, expect, test } from "bun:test"
import { getStoragePrincipal, setStoragePrincipal } from "@/stores/utils/safeStorage"
import {
  deserializeComposerAttachments,
  getPersistedComposerAttachmentKey,
  serializeComposerAttachments,
} from "./composer-attachment-storage"
import type { AttachedFile } from "@/stores/types/sessionTypes"

const attachment = (id: string): AttachedFile => ({
  id,
  file: new File([id], `${id}.png`, { type: "image/png" }),
  dataUrl: `data:image/png;base64,${id}`,
  mimeType: "image/png",
  filename: `${id}.png`,
  size: id.length,
  source: "local",
})

describe("composer attachment storage", () => {
  test("round-trips normalized attachment records without serializing File objects", () => {
    const records = serializeComposerAttachments([attachment("first"), attachment("second")])

    expect(records.map((record) => Object.prototype.hasOwnProperty.call(record, "file"))).toEqual([false, false])
    expect(deserializeComposerAttachments(records).map((file) => ({
      id: file.id,
      filename: file.filename,
      dataUrl: file.dataUrl,
      source: file.source,
    }))).toEqual([
      { id: "first", filename: "first.png", dataUrl: "data:image/png;base64,first", source: "local" },
      { id: "second", filename: "second.png", dataUrl: "data:image/png;base64,second", source: "local" },
    ])
  })

  test("scopes the same composer target to the authenticated storage principal", () => {
    const originalPrincipal = getStoragePrincipal()
    try {
      setStoragePrincipal("agent-a")
      const first = getPersistedComposerAttachmentKey("draft:shared-id")
      setStoragePrincipal("agent-b")
      const second = getPersistedComposerAttachmentKey("draft:shared-id")

      expect(first).toBe("agent-a:draft:shared-id")
      expect(second).toBe("agent-b:draft:shared-id")
      expect(first).not.toBe(second)
    } finally {
      setStoragePrincipal(originalPrincipal)
    }
  })
})

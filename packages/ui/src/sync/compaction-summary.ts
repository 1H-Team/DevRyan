/** The native summary assistant produced by a compaction request. It is
 * maintenance output, never a turn's answer or a stalled inference. */
export const isCompactionSummaryInfo = (info: unknown): boolean => {
  if (typeof info !== "object" || info === null) return false
  return ("summary" in info && info.summary === true)
    || ("mode" in info && info.mode === "compaction")
    || ("agent" in info && info.agent === "compaction")
}

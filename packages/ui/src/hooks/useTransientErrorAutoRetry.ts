import React from "react"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { toast } from "@/components/ui"
import { useI18n } from "@/lib/i18n"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { isQueuedMessageFlushInFlight } from "@/components/chat/queuedSend"
import { executeTransientRetry } from "@/sync/transient-retry"
import {
  getSyncBlockingRequestCountAnyDirectory,
  getSyncMessages,
  getSyncSessionDirectoryAnyDirectory,
} from "@/sync/sync-refs"
import { useSyncChildStores } from "@/sync/sync-context"
import { aggregateLiveSessionStatuses } from "@/sync/live-aggregate"
import {
  decideTransientAutoRetry,
  didLiveSessionBecomeIdle,
  getLatestUserMessageId,
  type TransientAutoRetryAttemptRecord,
} from "./transientAutoRetryDecision"

const autoRetryAttemptsBySession = new Map<string, TransientAutoRetryAttemptRecord>()
const MAX_AUTO_RETRY_ATTEMPT_SESSIONS = 500

export function useTransientErrorAutoRetry(enabled = true): void {
  const { t } = useI18n()
  const childStores = useSyncChildStores()
  const previousStatusesRef = React.useRef<Map<string, SessionStatus["type"]>>(new Map())
  const activeUserMessageIdsRef = React.useRef<Map<string, string>>(new Map())
  const inFlightSessionsRef = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    if (!enabled) {
      previousStatusesRef.current.clear()
      activeUserMessageIdsRef.current.clear()
      return
    }

    const processStatusSnapshot = () => {
      const sessionStatuses = aggregateLiveSessionStatuses(
        Array.from(childStores.children.values(), (store) => store.getState()),
      )
      const previousStatuses = previousStatusesRef.current
      const nextStatuses = new Map<string, SessionStatus["type"]>()

      for (const [sessionId, status] of Object.entries(sessionStatuses)) {
        nextStatuses.set(sessionId, status.type)
        const directory = getSyncSessionDirectoryAnyDirectory(sessionId)
        if (status.type === "busy" || status.type === "retry") {
          if (directory) {
            const activeUserMessageId = getLatestUserMessageId(getSyncMessages(sessionId, directory))
            if (activeUserMessageId) {
              activeUserMessageIdsRef.current.set(sessionId, activeUserMessageId)
            }
          }
          continue
        }
        if (!didLiveSessionBecomeIdle(previousStatuses.get(sessionId), status.type)) {
          continue
        }
        if (inFlightSessionsRef.current.has(sessionId)) {
          continue
        }

        const observedActiveUserMessageId = activeUserMessageIdsRef.current.get(sessionId)
        activeUserMessageIdsRef.current.delete(sessionId)
        if (!directory) {
          continue
        }
        const messages = getSyncMessages(sessionId, directory)
        const decision = decideTransientAutoRetry({
          messages,
          queuedMessageCount: useMessageQueueStore.getState().getQueueForSession(sessionId).length
            + (isQueuedMessageFlushInFlight(sessionId) ? 1 : 0),
          blockingRequestCount: getSyncBlockingRequestCountAnyDirectory(sessionId),
          observedActiveUserMessageId,
          attemptRecord: autoRetryAttemptsBySession.get(sessionId),
        })
        if (!decision) {
          continue
        }

        const previousAttempt = autoRetryAttemptsBySession.get(sessionId)
        const attemptedErroredMessageIds = previousAttempt?.anchorUserMessageId === decision.anchorUserMessageId
          ? new Set(previousAttempt.attemptedErroredMessageIds)
          : new Set<string>()
        attemptedErroredMessageIds.add(decision.erroredMessageId)
        if (
          autoRetryAttemptsBySession.size >= MAX_AUTO_RETRY_ATTEMPT_SESSIONS
          && !autoRetryAttemptsBySession.has(sessionId)
        ) {
          const oldestSessionId = autoRetryAttemptsBySession.keys().next().value
          if (typeof oldestSessionId === "string") {
            autoRetryAttemptsBySession.delete(oldestSessionId)
          }
        }
        autoRetryAttemptsBySession.set(sessionId, {
          anchorUserMessageId: decision.anchorUserMessageId,
          attempts: previousAttempt?.anchorUserMessageId === decision.anchorUserMessageId
            ? previousAttempt.attempts + 1
            : 1,
          attemptedErroredMessageIds,
          recoveryUserMessageIds: previousAttempt?.anchorUserMessageId === decision.anchorUserMessageId
            ? new Set(previousAttempt.recoveryUserMessageIds)
            : new Set<string>(),
        })

        inFlightSessionsRef.current.add(sessionId)
        toast.info(t("chat.transientRetry.toast"))
        void executeTransientRetry(sessionId, {
          onRecoveryUserMessageId: (messageId) => {
            const attempt = autoRetryAttemptsBySession.get(sessionId)
            if (!attempt || attempt.anchorUserMessageId !== decision.anchorUserMessageId) {
              return
            }
            const recoveryUserMessageIds = new Set(attempt.recoveryUserMessageIds)
            recoveryUserMessageIds.add(messageId)
            autoRetryAttemptsBySession.set(sessionId, {
              ...attempt,
              recoveryUserMessageIds,
            })
          },
        })
          .catch((error) => {
            console.warn("[transient-retry] automatic retry failed:", error)
          })
          .finally(() => {
            inFlightSessionsRef.current.delete(sessionId)
          })
      }

      for (const sessionId of previousStatuses.keys()) {
        if (!nextStatuses.has(sessionId)) {
          activeUserMessageIdsRef.current.delete(sessionId)
        }
      }

      previousStatusesRef.current = nextStatuses
    }

    processStatusSnapshot()
    return childStores.subscribeSessionStatuses(processStatusSnapshot)
  }, [childStores, enabled, t])
}

import type { Session } from "@opencode-ai/sdk/v2/client";
import { resolveSessionLineage } from "@/lib/sessionLineage";

export type PermissionAutoAcceptMap = Record<string, boolean>;

export const autoRespondsPermission = (input: {
  autoAccept: PermissionAutoAcceptMap;
  sessions: Session[];
  sessionID: string;
}): boolean => {
  const { autoAccept, sessions, sessionID } = input;
  const lineage = resolveSessionLineage(sessionID, sessions);

  for (const id of lineage) {
    if (!Object.prototype.hasOwnProperty.call(autoAccept, id)) {
      continue;
    }
    return autoAccept[id] === true;
  }

  return false;
};

import { getToolMetadata } from "@/lib/toolHelpers";
import { normalizeToolName } from "@/components/chat/message/parts/toolRenderUtils";

const TOOL_STATUS_PHRASES: Record<string, string> = {
    read: "reading file",
    write: "writing file",
    edit: "editing file",
    multiedit: "editing files",
    apply_patch: "applying patch",
    bash: "running command",
    grep: "searching content",
    glob: "finding files",
    list: "listing directory",
    task: "delegating task",
    webfetch: "fetching URL",
    websearch: "searching web",
    codesearch: "web code search",
    todowrite: "updating todos",
    todoread: "reading todos",
    skill: "learning skill",
    question: "asking question",
    devryan_task: "waiting for subagent output",
    plan_enter: "switching to planning",
    plan_exit: "switching to building",
};

export function getAssistantToolStatusPhrase(toolName: string): string {
    const rawToolName = toolName.trim();
    const normalizedToolName = normalizeToolName(rawToolName);

    if (TOOL_STATUS_PHRASES[normalizedToolName]) {
        return TOOL_STATUS_PHRASES[normalizedToolName];
    }

    const displayName = getToolMetadata(rawToolName || "tool").displayName;
    return `using ${displayName}`;
}

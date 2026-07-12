const CURSOR_ACP_ERROR_TITLE_PATTERN = /^cursor-acp\s+error\s*:/i
const GENERATED_NEW_SESSION_TITLE_PATTERN = /^new session\s*-\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i
const DEFAULT_SESSION_TITLE = "Untitled Session"
const MAX_DERIVED_TITLE_LENGTH = 80
const ROUTE_CONTEXT_PATTERN = /^(?:in|on|for)\s+((?:\/|\.{1,2}\/)[^,\s]+)\s*,?\s*(.+)$/i
const REQUEST_VERB_PATTERN = /^(add|build|change|create|delete|diagnose|find|fix|hide|implement|investigate|make|move|refactor|remove|rename|replace|start|summarize|test|update)\b\s*(.*)$/i
const TRAILING_FIX_REFERENCE_PATTERN = /\b(fix|repair|resolve|debug|diagnose)\s+(?:this|it|that|issue|bug)\.?$/i

const normalizeTitleWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim()

const normalizeTitleQuotes = (value: string): string => value
  .replace(/[“”]/g, "\"")
  .replace(/[‘’]/g, "'")
  .replace(/[`"]/g, "")

const normalizeKnownTitleTerms = (value: string): string => value
  .replace(/\bapi\b/gi, "API")
  .replace(/\bpdf\b/gi, "PDF")
  .replace(/\bpr\b/gi, "PR")
  .replace(/\bui\b/gi, "UI")
  .replace(/\burl\b/gi, "URL")

const capitalizeFirst = (value: string): string => (
  value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value
)

const stripLeadingArticle = (value: string): string => (
  value.replace(/^(?:a|an|the)\s+/i, "").trim()
)

const routeContextFromPath = (value: string): string => {
  const segments = value
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const last = segments[segments.length - 1] ?? ""
  return normalizeTitleWhitespace(last.replace(/[-_]+/g, " "))
}

const appendContext = (object: string, context: string): string => {
  if (!context) return object
  const normalizedObject = object.toLowerCase()
  const normalizedContext = context.toLowerCase()
  if (!object || normalizedObject.includes(normalizedContext)) {
    return object
  }
  return `${context} ${object}`
}

const normalizeRequestObject = (verb: string, value: string): string => {
  let object = stripLeadingArticle(value)
  if (verb === "find") {
    return object
  }

  if ((verb === "remove" || verb === "delete" || verb === "hide") && /^button\s+to\s+/i.test(object)) {
    object = `${object.replace(/^button\s+to\s+/i, "").trim()} button`
  }

  return stripLeadingArticle(object)
}

const deriveSmartTitleFromUserText = (text: string): string | null => {
  let request = normalizeTitleQuotes(text)
  let routeContext = ""

  const routeMatch = request.match(ROUTE_CONTEXT_PATTERN)
  if (routeMatch) {
    routeContext = routeContextFromPath(routeMatch[1] ?? "")
    request = routeMatch[2] ?? request
  }

  request = normalizeTitleWhitespace(request)
    .replace(/^(?:please|can you|could you|would you|i want you to)\s+/i, "")
    .trim()

  const trailingFixReferenceMatch = request.match(TRAILING_FIX_REFERENCE_PATTERN)
  if (routeContext && trailingFixReferenceMatch) {
    const verb = (trailingFixReferenceMatch[1] ?? "fix").toLowerCase()
    const normalized = normalizeKnownTitleTerms(normalizeTitleWhitespace(`${verb} ${routeContext}`))
    return normalized ? capitalizeFirst(normalized) : null
  }

  const verbMatch = request.match(REQUEST_VERB_PATTERN)
  if (!verbMatch) {
    return null
  }

  const verb = (verbMatch[1] ?? "").toLowerCase()
  const object = normalizeRequestObject(verb, verbMatch[2] ?? "")
  const withContext = appendContext(object, routeContext)
  const normalized = normalizeKnownTitleTerms(normalizeTitleWhitespace(`${verb} ${withContext}`))
  return normalized ? capitalizeFirst(normalized) : null
}

export const isCursorAcpErrorTitle = (title?: string | null): boolean => {
  if (typeof title !== "string") {
    return false
  }
  return CURSOR_ACP_ERROR_TITLE_PATTERN.test(title.trim())
}

export const isGeneratedNewSessionTitle = (title?: string | null): boolean => {
  if (typeof title !== "string") {
    return false
  }
  return GENERATED_NEW_SESSION_TITLE_PATTERN.test(title.trim())
}

export const deriveSessionTitleFromUserText = (
  text?: string | null,
  fallback = DEFAULT_SESSION_TITLE,
): string => {
  const raw = typeof text === "string" ? text.trim() : ""
  const markdownHeading = raw
    .split(/\r?\n/)
    .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim() ?? "")
    .find(Boolean)
  if (markdownHeading) {
    const normalizedHeading = normalizeKnownTitleTerms(normalizeTitleQuotes(markdownHeading))
    return normalizedHeading.length <= MAX_DERIVED_TITLE_LENGTH
      ? normalizedHeading
      : `${normalizedHeading.slice(0, MAX_DERIVED_TITLE_LENGTH - 3).trimEnd()}...`
  }
  const normalized = raw.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return fallback
  }
  const smartTitle = deriveSmartTitleFromUserText(normalized)
  if (smartTitle) {
    return smartTitle.length <= MAX_DERIVED_TITLE_LENGTH
      ? smartTitle
      : `${smartTitle.slice(0, MAX_DERIVED_TITLE_LENGTH - 3).trimEnd()}...`
  }
  if (normalized.length <= MAX_DERIVED_TITLE_LENGTH) {
    return normalized
  }
  return `${normalized.slice(0, MAX_DERIVED_TITLE_LENGTH - 3).trimEnd()}...`
}

export const resolveDisplaySessionTitle = ({
  title,
  latestUserText,
  fallback = DEFAULT_SESSION_TITLE,
}: {
  title?: string | null
  latestUserText?: string | null
  fallback?: string
}): string => {
  const normalizedTitle = typeof title === "string" ? title.trim() : ""
  if (!normalizedTitle || isCursorAcpErrorTitle(normalizedTitle) || isGeneratedNewSessionTitle(normalizedTitle)) {
    return deriveSessionTitleFromUserText(latestUserText, fallback)
  }
  const smartTitle = deriveSmartTitleFromUserText(normalizedTitle)
  if (smartTitle && smartTitle !== normalizedTitle) {
    return smartTitle
  }
  return normalizedTitle
}

export function countMarkers(command: string): number {
  return command.split("run-once.ts").length - 1
}

export interface ParsedBashCall {
  sessionID: string
  command: string
}

export function parseBashPostToolUse(raw: string): ParsedBashCall | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>

  const sessionID = record.session_id
  if (typeof sessionID !== "string" || !sessionID) return undefined
  if (record.tool_name !== "Bash") return undefined

  const toolInput = record.tool_input
  const command =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>).command
      : undefined
  if (typeof command !== "string") return undefined

  return { sessionID, command }
}

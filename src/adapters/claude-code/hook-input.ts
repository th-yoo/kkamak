import type { GateEvent } from "../../kernel/ports.ts"

/**
 * Claude Code tool names that count as editing a file, matched exactly.
 *
 * Not `as const`: bun-types' `test.each` overloads require a mutable array
 * (see `Test<[T]>`'s `table: T[]`), and `test/claude-code-adapter.test.ts`
 * calls `test.each(EDIT_TOOLS)` directly. A readonly tuple fails every
 * overload under `noUncheckedIndexedAccess` + `strict`. The exported type is
 * still the `readonly string[]` the interface calls for — only the literal
 * tuple type is given up, not the runtime values.
 */
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"]

export const HOOK_EVENTS = ["PostToolUse", "UserPromptSubmit", "Stop"] as const

export interface ParsedHookInput {
  event: GateEvent
  root: string
}

/**
 * Returns undefined for anything unrecognised, which the CLI treats as "do
 * nothing, exit 0". An unparseable payload is not worth failing a session over.
 */
export function parseHookInput(raw: string, eventName: string): ParsedHookInput | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined

  const record = parsed as Record<string, unknown>
  const sessionId = record.session_id
  const root = record.cwd
  if (typeof sessionId !== "string" || !sessionId) return undefined
  if (typeof root !== "string" || !root) return undefined

  switch (eventName) {
    case "Stop":
      return { event: { kind: "stop-requested", sessionId }, root }
    case "UserPromptSubmit":
      return { event: { kind: "new-user-prompt", sessionId }, root }
    case "PostToolUse": {
      const tool = record.tool_name
      if (typeof tool !== "string") return undefined
      if (!EDIT_TOOLS.includes(tool)) return undefined
      return { event: { kind: "file-edited", sessionId }, root }
    }
    default:
      return undefined
  }
}

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

/**
 * Claude Code's kill ceiling on the Stop hook, in ms: hooks/hooks.json sets
 * `"timeout": 600` (seconds) on the Stop entry, after which the hook process
 * is SIGKILLed. Reported to the kernel as `HostInfo.stopTimeoutMs` so it can
 * clamp `checkTimeoutMs` under it. Tied to the manifest literal by
 * test/packaging.test.ts so the two cannot drift. Defined here rather than
 * in hook-cli.ts because importing hook-cli runs its main().
 */
export const STOP_HOOK_TIMEOUT_MS = 600_000

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
  const sessionID = record.session_id
  const root = record.cwd
  if (typeof sessionID !== "string" || !sessionID) return undefined
  if (typeof root !== "string" || !root) return undefined

  switch (eventName) {
    case "Stop":
      return { event: { kind: "stop-requested", sessionID }, root }
    case "UserPromptSubmit":
      return { event: { kind: "new-user-prompt", sessionID }, root }
    case "PostToolUse": {
      const tool = record.tool_name
      if (typeof tool !== "string") return undefined
      if (!EDIT_TOOLS.includes(tool)) return undefined
      return { event: { kind: "file-edited", sessionID }, root }
    }
    default:
      return undefined
  }
}

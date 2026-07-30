// opencode adapter.
//
// opencode has no blocking stop hook: `session.idle` is fire-and-forget. So a
// kernel "block" is delivered by CONTINUING the session — injecting a user
// message that carries the evidence — rather than by refusing anything.
//
// That injected message fires `chat.message`, which this adapter maps to
// new-user-prompt, the event that preempts an open cycle. It therefore carries
// INJECTED_MARKER so we can tell our own text from a human's and leave the
// cycle alone.
import { createGate } from "../../kernel/index.ts"
import { createNodeHost } from "../../runtime/index.ts"
import { composeBlockMessage } from "../shared/framing.ts"
import type {
  KkamakHooks,
  OpencodeClient,
  OpencodePluginInput,
  PromptPart,
} from "./opencode-types.ts"

const APP = "opencode"

/**
 * opencode tool ids that count as editing a file, matched case-insensitively.
 *
 * Verified against the local checkout at
 * `/home/th-yoo/z2/opencode/packages/opencode/src/tool/registry.ts` and
 * `tool.ts`: the id opencode actually reports on `tool.execute.after` is the
 * `Tool.define(id, ...)` id, not the registry's object key. `edit` and
 * `write` match; the patch tool's real id is `apply_patch` (its registry key
 * "patch" is only an internal binding name), and no `multiedit` tool exists
 * in this checkout at all. Per the task's "widen, don't loosen" rule this
 * list keeps the brief's original four values verbatim and adds the real
 * observed id rather than dropping or renaming anything.
 */
export const EDIT_TOOLS: string[] = ["edit", "write", "patch", "multiedit", "apply_patch"]

/** Lets the adapter recognise its own injected prompt. */
export const INJECTED_MARKER = "[kkamak-gate]"

export function isInjectedMessage(text: string): boolean {
  return text.trimStart().startsWith(INJECTED_MARKER)
}

export interface PluginDeps {
  client: OpencodeClient
  worktree: string
  /** Where fail-open diagnostics go. Defaults to real stderr; tests capture this instead. */
  log?: (line: string) => void
}

function defaultLog(line: string): void {
  try {
    process.stderr.write(line)
  } catch {
    // Nothing left to report with.
  }
}

function textOf(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? record.text : ""
    })
    .join("")
}

/** Every hook body funnels through here: a thrown error must never escape. */
async function guarded(label: string, log: (line: string) => void, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (err) {
    log(`kkamak: ${label} failed, allowing the session through: ${String(err)}\n`)
  }
}

export async function createKkamakPlugin(deps: PluginDeps): Promise<KkamakHooks> {
  const gate = createGate(createNodeHost({ root: deps.worktree, app: APP }))
  const log = deps.log ?? defaultLog

  return {
    "tool.execute.after": (input) =>
      guarded("tool.execute.after", log, async () => {
        if (!EDIT_TOOLS.includes(input.tool.toLowerCase())) return
        await gate.handle({ kind: "file-edited", sessionID: input.sessionID })
      }),

    "chat.message": (input, output) =>
      guarded("chat.message", log, async () => {
        // Our own continuation prompt must not preempt the cycle it opened.
        if (isInjectedMessage(textOf(output.parts))) return
        await gate.handle({ kind: "new-user-prompt", sessionID: input.sessionID })
      }),

    event: ({ event }) =>
      guarded("session.idle", log, async () => {
        if (event?.type !== "session.idle") return
        const sessionID = event.properties?.sessionID
        if (typeof sessionID !== "string" || !sessionID) return

        const decision = await gate.handle({ kind: "stop-requested", sessionID })
        if (decision.kind !== "block") {
          if (decision.notice) log(`kkamak: ${decision.notice}\n`)
          return
        }

        const parts: PromptPart[] = [
          { type: "text", text: `${INJECTED_MARKER} ${composeBlockMessage(decision)}` },
        ]
        // promptAsync, not prompt: prompt waits for the assistant to finish and
        // we are inside an event handler, which would deadlock.
        await deps.client.session.promptAsync({ path: { id: sessionID }, body: { parts } })
      }),
  }
}

/** The shape opencode loads. */
export default async function KkamakPlugin(input: OpencodePluginInput): Promise<KkamakHooks> {
  return createKkamakPlugin({ client: input.client, worktree: input.worktree ?? input.directory ?? process.cwd() })
}

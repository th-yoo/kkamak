#!/usr/bin/env bun
/**
 * `bun hook-cli.ts <EventName>` — reads the Claude Code hook payload on stdin,
 * drives the kernel, and emits the decision.
 *
 * PRIME DIRECTIVE: a broken hook must never break a user's session. Every path
 * either stays silent and exits 0, or emits a decision the kernel asked for.
 */
import { createGate } from "../../kernel/index.ts"
import { createNodeHost } from "../../runtime/index.ts"
import { loadActiveExtensions } from "../../extensions/registry.ts"
import { planEmit } from "./emit.ts"
import { parseHookInput, STOP_HOOK_TIMEOUT_MS } from "./hook-input.ts"

const APP = "claude-code"

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const eventName = process.argv[2] ?? ""
  const parsed = parseHookInput(await readStdin(), eventName)
  if (!parsed) return

  // Note: Claude Code sets `stop_hook_active: true` on a Stop payload when the
  // turn is already continuing because of a previous block. We deliberately
  // ignore it — the kernel's own rounds budget is what guarantees
  // termination, and honouring the flag would cap the gate at a single block
  // regardless of the configured `rounds`.
  const host = createNodeHost({ root: parsed.root, app: APP, stopTimeoutMs: STOP_HOOK_TIMEOUT_MS })
  const ext = await loadActiveExtensions(host, {
    root: parsed.root,
    ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
  })
  const gate = createGate(ext.wrapHost(host))
  const decision = await gate.handle(parsed.event)
  await ext.afterDecision(parsed.event, decision)
  const plan = planEmit(decision)

  if (plan.stdout) process.stdout.write(`${JSON.stringify(plan.stdout)}\n`)
  if (plan.stderr) process.stderr.write(plan.stderr)
  if (plan.exitCode !== 0) process.exit(plan.exitCode)
}

main().catch((err) => {
  // Silent on stdout: anything printed there is protocol. Exit 0 so a crash in
  // the gate is never mistaken for an intentional block.
  try {
    process.stderr.write(`kkamak: hook failed, allowing the session through: ${String(err)}\n`)
  } catch {
    // Nothing left to report with.
  }
  process.exit(0)
})

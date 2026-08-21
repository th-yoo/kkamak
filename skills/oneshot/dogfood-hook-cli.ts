#!/usr/bin/env bun
// PostToolUse/Bash observer (Source 2).
// PRIME DIRECTIVE, same as the gate's own hook-cli.ts: a broken hook must
// never break a session. Every path stays silent and exits 0.
import path from "node:path"
import { appendNdjsonLine } from "./ndjson-append.ts"
import { countMarkers, parseBashPostToolUse } from "./dogfood-hook-input.ts"

const CALLS_LOG = ".km/oneshot-dogfood-calls.ndjson"

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const raw = await readStdin()
  const parsed = parseBashPostToolUse(raw)
  if (!parsed) return
  const markerCount = countMarkers(parsed.command)
  if (markerCount === 0) return
  const root = (JSON.parse(raw) as { cwd?: string }).cwd
  if (typeof root !== "string" || !root) return
  appendNdjsonLine(path.join(root, CALLS_LOG), { ts: Date.now(), sessionID: parsed.sessionID, markerCount })
}

main().catch(() => {
  // Silent: a broken observer must never surface as a broken session.
})

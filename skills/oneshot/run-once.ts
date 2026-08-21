#!/usr/bin/env bun
import path from "node:path"
import { SpawnCheckRunner } from "../../src/runtime/check-runner.ts"
import { FileConfigSource } from "../../src/runtime/config-source.ts"
import { parseGateConfig } from "../../src/kernel/config.ts"
import { appendNdjsonLine } from "./ndjson-append.ts"

const TAIL_CHARS = 4000
const DOGFOOD_LOG = ".km/oneshot-dogfood.ndjson"

export function truncateTail(output: string, maxChars = TAIL_CHARS): string {
  if (output.length <= maxChars) return output
  const tail = output.slice(output.length - maxChars)
  return `...[truncated ${maxChars} of ${output.length} chars]...${tail}`
}

export interface RunOnceResult {
  ok: boolean
  output: string
}

/** `undefined` means no gate.json / no usable check — nothing ran. */
export async function runOnce(root: string): Promise<RunOnceResult | undefined> {
  const config = parseGateConfig(new FileConfigSource(root).read())
  if (!config) return undefined
  const result = await new SpawnCheckRunner(root).run(config.check, config.checkTimeoutMs)
  return { ok: result.code === 0, output: truncateTail(result.output) }
}

/**
 * A successful attempt always ends the retry loop, so it always gets a
 * full log entry. A failing attempt only gets one when the caller has
 * marked it final (ONESHOT_FINAL_ATTEMPT=1, set by template.sh on its
 * last allowed attempt) — earlier failing attempts log only ok +
 * outputLength, so a chatty check's full output isn't written once per
 * retry (known-issues.md #12.2).
 */
export function shouldLogFull(result: RunOnceResult): boolean {
  return result.ok || process.env.ONESHOT_FINAL_ATTEMPT === "1"
}

async function main(): Promise<void> {
  const root = process.cwd()
  const result = await runOnce(root)
  if (!result) {
    process.stderr.write("oneshot: no gate.json with a usable check found in the current directory\n")
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  const logLine = shouldLogFull(result)
    ? { ts: Date.now(), ok: result.ok, output: result.output }
    : { ts: Date.now(), ok: result.ok, outputLength: result.output.length }
  appendNdjsonLine(path.join(root, DOGFOOD_LOG), logLine)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) main()

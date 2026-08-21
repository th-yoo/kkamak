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

async function main(): Promise<void> {
  const root = process.cwd()
  const result = await runOnce(root)
  if (!result) {
    process.stderr.write("oneshot: no gate.json with a usable check found in the current directory\n")
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  appendNdjsonLine(path.join(root, DOGFOOD_LOG), { ts: Date.now(), ...result })
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) main()

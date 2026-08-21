#!/usr/bin/env bun
/**
 * refiner-cli.ts — the detached km-gauge derivation child:
 * `bun refiner-cli.ts <cwd> <sessionID> <n>`. Reads the .req.json written by
 * maybeSpawnGauge, makes ONE model call, writes the pending gauge file
 * atomically, deletes the req. Any failure = silent exit 0 with the req
 * cleaned up — a missing gauge file is a recorded coverage miss, never a
 * session problem.
 *
 * K4 port note (ruling R14 fix round): this is NOT a verbatim port of the
 * lab's refiner-cli.ts. The lab calls `callModelSdk` from transport.ts
 * (@anthropic-ai/sdk) — explicitly excluded from this port (K3 ruling:
 * transport.ts stays lab-side). This file reproduces the same shape (read
 * req -> call model -> parse -> validate -> persist -> clean up req,
 * fail-open throughout) using kkamak's own transport layer instead:
 * send-prompt.ts's sendPrompt(), dispatched to cli-spawn.ts's
 * CLI_SPAWN_PROVIDER_ID — the provider gauge/index.ts already registers as
 * the default at extension load (K3/K4). The lab's §6d transport-pin
 * machinery (KKAMAK_GAUGE_TRANSPORT, multiple providers, the
 * sdk/agent-sdk/agent-sdk-daemon distinction) has no kkamak counterpart:
 * cli-spawn is the only provider that exists here, so there is nothing to
 * pin against yet.
 */
import fs from "node:fs"
import path from "node:path"
import { buildRefinerPrompt, parseRefinerOutput } from "./refiner.ts"
import { validateDerivation } from "./validate.ts"
import { gaugeDir, writeGaugeFile } from "./files.ts"
import { sendPrompt, GAUGE_ISOLATION } from "./send-prompt.ts"
import { CLI_SPAWN_PROVIDER_ID } from "./providers/cli-spawn.ts"

const DEFAULT_MODEL = "claude-haiku-4-5"

/** Core logic, exported for direct testing (a fake provider registered
 * under CLI_SPAWN_PROVIDER_ID stands in for a real model call — matching
 * gauge-send-prompt.test.ts's own testing style — rather than PATH
 * manipulation for a subprocess whose send-prompt registry lives in a
 * different process anyway). */
export async function runRefinerOnce(cwd: string, sessionID: string, n: number): Promise<void> {
  if (!cwd || !sessionID || !Number.isInteger(n) || n < 1) return

  const dir = gaugeDir(cwd)
  const reqPath = path.join(dir, `${sessionID}-${n}.req.json`)

  let prompt: string
  let floorCheck: string
  try {
    const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"))
    if (typeof req?.prompt !== "string" || !req.prompt) throw new Error("bad req")
    prompt = req.prompt
    // Stale v1 req tolerance: no floorCheck key at all → treat as unarmed.
    floorCheck = typeof req?.floorCheck === "string" ? req.floorCheck : ""
  } catch {
    return
  }

  try {
    const started = Date.now()
    const model = process.env.KKAMAK_GAUGE_MODEL ?? DEFAULT_MODEL
    const refinerPrompt = buildRefinerPrompt(prompt, floorCheck)
    const outcome = await sendPrompt(refinerPrompt, {
      model,
      isolation: GAUGE_ISOLATION,
      provider: CLI_SPAWN_PROVIDER_ID,
    })
    if (!outcome.ok) return

    const derivation = parseRefinerOutput(outcome.text)
    if (!derivation) return

    // The persisted pending file is the VALIDATED result — validation runs
    // pre-persist so shadow.ts can trust a pending file as-is (no re-checking).
    const validated = validateDerivation({ derivation, prompt, floorCheck, repoRoot: cwd })

    writeGaugeFile(dir, {
      goalSummary: derivation.goalSummary,
      criteria: derivation.criteria,
      confidence: derivation.confidence,
      class: validated.class,
      reason: validated.reason,
      horizon: validated.horizon,
      check: validated.check,
      ...(validated.downgraded ? { downgraded: validated.downgraded } : {}),
      v: 2,
      sessionID,
      n,
      ts: Date.now(),
      model: outcome.canonicalModel,
      derivationMs: Date.now() - started,
      // transport left absent: cli-spawn IS "cli" — files.ts's own
      // convention is that absent means cli, never fabricated otherwise.
    })
  } finally {
    try {
      fs.unlinkSync(reqPath)
    } catch {
      // already gone / unreadable — nothing to clean
    }
  }
}

async function main(): Promise<void> {
  const [cwd, sessionID, nStr] = process.argv.slice(2)
  await runRefinerOnce(cwd ?? "", sessionID ?? "", Number(nStr))
}

if (import.meta.main) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}

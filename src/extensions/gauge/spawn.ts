// km-gauge spawn seam (pre-reg §2.2, §4) — decides whether this prompt earns
// a refiner call, persists the request, and fires the detached refiner-cli.
// Every failure is swallowed: gauge problems must NEVER touch a session
// (same prime directive as hook-cli).
//
// K4 wiring: fired from gauge/index.ts's afterDecision on new-user-prompt
// events. It needs the real prompt TEXT (isTaskShaped(prompt)), which
// kkamak's kernel GateEvent never carries on any variant, by deliberate
// kernel design — resolved via ExtensionContext (ruling R12, registry.ts),
// sourced from the adapter layer (hook-input.ts's prompt extraction), never
// from the kernel.
import path from "node:path"
import fs from "node:fs"
import type { GaugeSpawnConfig } from "./types.ts"
import { isTaskShaped } from "./classifier.ts"
import { bumpDailyCount, gaugeDir, nextN, underDailyCap } from "./files.ts"

export const DAILY_CAP = 30
const REFINER_CLI = path.join(import.meta.dir, "refiner-cli.ts")

export interface SpawnGaugeInput {
  cwd: string
  sessionID: string
  prompt: unknown
  cfg: GaugeSpawnConfig | undefined
  env: Record<string, string | undefined>
  now: number
  /** Injected process launcher; production passes a detached Bun.spawn. */
  spawn: (cmd: string[]) => void
}

function localDate(nowMs: number): string {
  const d = new Date(nowMs)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Returns the allocated n when a refiner was launched, undefined otherwise. */
export function maybeSpawnGauge(input: SpawnGaugeInput): number | undefined {
  try {
    const { cwd, sessionID, prompt, cfg, env, now } = input
    if (!cfg?.gauge) return undefined
    if (env.KKAMAK_GAUGE === "off") return undefined
    if (typeof prompt !== "string" || !isTaskShaped(prompt)) return undefined

    const dir = gaugeDir(cwd)
    const date = localDate(now)
    if (!underDailyCap(dir, date, DAILY_CAP)) return undefined

    const n = nextN(dir, sessionID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${sessionID}-${n}.req.json`),
      JSON.stringify({ v: 2, sessionID, n, ts: now, prompt, floorCheck: cfg.check }),
    )
    bumpDailyCount(dir, date)

    input.spawn(["bun", REFINER_CLI, cwd, sessionID, String(n)])
    return n
  } catch {
    return undefined
  }
}

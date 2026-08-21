// km-gauge file store (pre-reg §2.2/§4) — everything under <cwd>/.km/gauge/.
// PoC layout (user reservation on record: revisit before any blocking pilot):
//   <sessionID>-<n>.req.json   refiner request (prompt payload), deleted by refiner-cli
//   <sessionID>-<n>.json       pending derivation, written atomically by refiner-cli
//   <sessionID>-<n>.done.json  evaluated derivation + eval record (audit trail)
//   daily-count                {date, count} refiner-call cap (fail-closed on corruption)
import fs from "node:fs"
import path from "node:path"
import type { GaugeHorizon, GaugePromptClass, GaugeTransport } from "./types.ts"
import type { Downgrade } from "./validate.ts"

/** Persisted gauge file payload — derivation + provenance.
 *
 * v2-extractor note (2026-07-29, Task 1): deliberately NOT `extends
 * GaugeDerivation` — GaugeDerivation gained required class/reason/horizon
 * fields for the v2 refiner+validate pipeline, but this GaugeFile shape
 * keeps those fields OPTIONAL so v1 literals (and every fixture that still
 * constructs one) keep typechecking unmodified.
 *
 * Task 2: `v` widens to 1|2 and gains the validated-extraction fields
 * (class/reason/horizon/downgraded/strike) — all optional, all additive.
 * A v2 pending file is the refiner-cli.ts output of validateDerivation
 * (validate.ts) already run: shadow.ts trusts it as-is. `strike` is
 * Task 3's two-strike policy state on a multi-turn class-C pending. */
export interface GaugeFile {
  v: 1 | 2
  sessionID: string
  n: number
  ts: number
  model: string
  derivationMs: number
  goalSummary: string
  criteria: string[]
  check: string | null
  confidence: number
  class?: GaugePromptClass
  reason?: string | null
  horizon?: GaugeHorizon | null
  downgraded?: Downgrade
  strike?: 1
  /** §6c derive-transport provenance, written at derive time. ABSENT means
   * "cli" — the 586 pre-boundary records carry no field and are never
   * rewritten. Deliberately a NEW key (not a widened `model`/`v`): the
   * transport demonstrably changes classifications, and a field doing
   * double duty is how pluginVersion lost producer identity. */
  transport?: GaugeTransport
}

export function gaugeDir(cwd: string): string {
  return path.join(cwd, ".km", "gauge")
}

function listSession(dir: string, sessionID: string): { n: number; name: string }[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const re = new RegExp(`^${sessionID}-(\\d+)(?:\\.done|\\.req)?\\.json$`)
  const out: { n: number; name: string }[] = []
  for (const name of names) {
    const m = name.match(re)
    if (m) out.push({ n: Number(m[1]), name })
  }
  return out
}

/** 1 + highest n across req/pending/done for this session (1 when none). */
export function nextN(dir: string, sessionID: string): number {
  const ns = listSession(dir, sessionID).map((f) => f.n)
  return ns.length ? Math.max(...ns) + 1 : 1
}

/** Atomic write (tmp + rename) of a pending derivation. */
export function writeGaugeFile(dir: string, gauge: GaugeFile): void {
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `${gauge.sessionID}-${gauge.n}.json`)
  const tmp = dest + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(gauge))
  fs.renameSync(tmp, dest)
}

/** Highest-n PENDING derivation for the session; undefined if none/corrupt. */
export function pickPending(dir: string, sessionID: string): GaugeFile | undefined {
  const pending = listSession(dir, sessionID).filter((f) => /-\d+\.json$/.test(f.name))
  if (!pending.length) return undefined
  const top = pending.reduce((a, b) => (b.n > a.n ? b : a))
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, top.name), "utf-8"))
    if (typeof j !== "object" || j === null) return undefined
    return j as GaugeFile
  } catch {
    return undefined
  }
}

/** Rename pending → done, merging the shadow-eval record for the audit trail. */
export function consumePending(
  dir: string,
  sessionID: string,
  n: number,
  evalRecord: Record<string, unknown>,
): void {
  const src = path.join(dir, `${sessionID}-${n}.json`)
  const dest = path.join(dir, `${sessionID}-${n}.done.json`)
  try {
    const j = JSON.parse(fs.readFileSync(src, "utf-8"))
    fs.writeFileSync(dest, JSON.stringify({ ...j, eval: evalRecord }))
    fs.unlinkSync(src)
  } catch {
    // Audit trail is best-effort; never let it break the hook.
  }
}

const COUNT_FILE = "daily-count"

function readCount(dir: string): { date: string; count: number } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, COUNT_FILE), "utf-8"))
    if (typeof j?.date === "string" && typeof j?.count === "number") return j
    return undefined
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { date: "", count: 0 }
    return undefined // corrupt → fail closed
  }
}

/** date = "YYYY-MM-DD". Corrupt counter fails CLOSED (spend guard, pre-reg §4). */
export function underDailyCap(dir: string, date: string, cap: number): boolean {
  const c = readCount(dir)
  if (c === undefined) return false
  return c.date === date ? c.count < cap : true
}

export function bumpDailyCount(dir: string, date: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const c = readCount(dir)
  const count = c !== undefined && c.date === date ? c.count + 1 : 1
  fs.writeFileSync(path.join(dir, COUNT_FILE), JSON.stringify({ date, count }))
}

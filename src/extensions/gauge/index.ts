// gauge extension (K4) — registers "gauge" against the K1 extension seam.
// Wires shadow.ts/spawn.ts (K2/K4 ports, verbatim) and cli-spawn.ts (K3) into
// the real Stop/UserPromptSubmit path, config-gated by gate.json's
// "extensions": {"gauge": true} — the K1 registry only ever calls into this
// module when that's on, so every offReason branch that depends on gauge
// being OFF ("disabled", "env-off" per the lab's hook-cli.ts:340-363
// vocabulary) is structurally unreachable from in here; the only reachable
// in-extension value is "no-record" (armed, nothing to attach).
//
// R13 (hold-and-flush): SensorSink.append (kernel/ports.ts) is synchronous
// — (line, relativePath): void — but shadow eval is async (it may spawn a
// real check subprocess). The lab reproduces the same ordering constraint
// by composing the line in memory, awaiting shadowEvaluateAtStop, THEN
// calling appendSensor once (cc-gate-plugin/src/hook-cli.ts:349-381) — it
// never annotates inside an append call either. This wrapHost does the
// same: its decorated sensor.append does not forward lines, it HOLDS them;
// afterDecision (already awaited by hook-cli.ts before the plan is emitted)
// is the flush point, where async shadow eval is safe to run before the
// real write happens.
//
// Crash-window honesty (R13): if the process dies between gate.handle()
// returning and afterDecision running, a held line is lost. The lab has the
// IDENTICAL window — it composes the line, evaluates, then appends, all in
// the same synchronous stretch of one hook invocation. This is parity, not
// a regression this port introduces.
import type { GateDecision, GateEvent, GateHost, SensorLine } from "../../kernel/ports.ts"
import { parseGateConfig } from "../../kernel/config.ts"
import type { Extension, ExtensionContext } from "../registry.ts"
import { shadowEvaluateAtStop } from "./shadow.ts"
import { maybeSpawnGauge } from "./spawn.ts"
import type { GaugedSensorLine } from "./types.ts"
import { registerProvider } from "./send-prompt.ts"
import { cliSpawnProvider, CLI_SPAWN_PROVIDER_ID } from "./providers/cli-spawn.ts"

// kkamak's default send-prompt provider, registered once at extension load.
// No real call happens until something in a later task actually resolves
// and calls this provider id — send-prompt.ts's own registry is otherwise
// untouched (K3).
registerProvider(CLI_SPAWN_PROVIDER_ID, cliSpawnProvider)

interface HeldLine {
  line: SensorLine
  relativePath: string
}

// Per-cycle state: reset at the start of each wrapHost call, drained by the
// following afterDecision call. Safe under the real hook-cli.ts lifecycle
// (one process per hook invocation, wrapHost always called before
// afterDecision — K1's own wiring) and under repeated test calls in one
// process (wrapHost always resets before use).
let held: HeldLine[] = []

/** Runs shadow eval for one held line and returns the line to actually
 * write — real gauge field on success, {present:false, offReason:
 * "no-record"} fallback on anything else. NEVER throws: shadowEvaluateAtStop
 * already swallows its own internal errors (returns the line unchanged),
 * and everything else here (config parse, the runCheck adapter, dep
 * construction) is wrapped again as defense-in-depth per R13 — a bug in
 * this glue code must not be able to eat a line either. */
async function annotateLine(line: SensorLine, ctx: ExtensionContext, host: GateHost): Promise<SensorLine> {
  try {
    const cfg = parseGateConfig(host.config.read())
    if (!cfg) return { ...line, gauge: { present: false, offReason: "no-record" } } as SensorLine

    const runCheck = async (cmd: string): Promise<{ code: number; out: string }> => {
      const r = await host.check.run(cmd, cfg.checkTimeoutMs)
      return { code: r.code, out: r.output }
    }
    const deps = {
      now: () => host.clock.now(),
      hostname: () => host.info.host,
      log: (msg: string) => host.logger.log(msg),
    }

    const gauged = await shadowEvaluateAtStop(ctx.root, line.sessionID, cfg, line as GaugedSensorLine, runCheck, deps)
    const result: GaugedSensorLine = gauged ?? (line as GaugedSensorLine)
    if (!result.gauge) {
      return { ...result, gauge: { present: false, offReason: "no-record" } } as SensorLine
    }
    return result as SensorLine
  } catch {
    return { ...line, gauge: { present: false, offReason: "no-record" } } as SensorLine
  }
}

/** Detached, best-effort launch — mirrors the lab's own
 * Bun.spawn+unref() pattern (cc-gate-plugin/src/hook-cli.ts), simplified:
 * Bun's own unref() achieves detachment without the lab's extra
 * `bash -c "nohup ... &"` shell wrapping. The target script
 * (refiner-cli.ts) is not ported in kkamak yet (spawn.ts's own module doc
 * comment) — this wires the mechanism; a later task supplies a real
 * target. */
function detachedSpawn(cmd: string[]): void {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  proc.unref()
}

function wrapHost(host: GateHost, _ctx: ExtensionContext): GateHost {
  held = []
  return {
    ...host,
    sensor: {
      append(line: SensorLine, relativePath: string): void {
        held.push({ line, relativePath })
      },
    },
  }
}

async function afterDecision(
  event: GateEvent,
  _decision: GateDecision,
  host: GateHost,
  ctx: ExtensionContext,
): Promise<void> {
  const pending = held
  held = []
  try {
    while (pending.length > 0) {
      const item = pending.shift()!
      const annotated = await annotateLine(item.line, ctx, host)
      host.sensor.append(annotated, item.relativePath)
    }
  } finally {
    // R13: whatever's still in `pending` never got a real gauge attempt
    // (only reachable if the loop above threw despite annotateLine's own
    // catch-all — e.g. host.sensor.append itself throwing) — flush it now,
    // stamped no-record, so silence-forbidden holds even against a bug in
    // this wrapper, not just inside the ported gauge internals.
    for (const item of pending) {
      host.sensor.append(
        { ...item.line, gauge: { present: false, offReason: "no-record" } } as SensorLine,
        item.relativePath,
      )
    }
  }

  // Spawn seam (K4 ruling R12): fires only on new-user-prompt, only when
  // the adapter actually had prompt text to give us. maybeSpawnGauge
  // already swallows every internal failure (its own try/catch); this
  // call itself cannot throw given that.
  if (event.kind === "new-user-prompt" && ctx.prompt) {
    const cfg = parseGateConfig(host.config.read())
    if (cfg) {
      maybeSpawnGauge({
        cwd: ctx.root,
        sessionID: event.sessionID,
        prompt: ctx.prompt,
        // gauge:true is safe to assert unconditionally here: the K1
        // registry only ever calls into this extension when it is already
        // enabled — see this file's own header comment.
        cfg: { check: cfg.check, gauge: true },
        env: process.env as Record<string, string | undefined>,
        now: host.clock.now(),
        spawn: detachedSpawn,
      })
    }
  }
}

export const gaugeExtension: Extension = {
  name: "gauge",
  wrapHost,
  afterDecision,
}

// gauge extension (K4) — registers "gauge" against the K1 extension seam.
// Wires shadow.ts/spawn.ts/refiner.ts/refiner-cli.ts (ported) and
// cli-spawn.ts (K3) into the real Stop/UserPromptSubmit path, config-gated
// by gate.json's "extensions": {"gauge": true} — the K1 registry only ever
// calls into this module when that's on, so every offReason branch that
// depends on gauge being OFF ("disabled", "env-off" per the lab's
// hook-cli.ts:340-363 vocabulary) is structurally unreachable from in here;
// the reachable in-extension values are "no-record" (armed, nothing pending
// at all) and "error" (armed, something broke — glue exception, unreadable
// config, or a post-throw salvage; K4 review R15, deliberately distinct
// from "no-record" — see types.ts's GaugeOffReason doc comment).
//
// R13 (hold-and-flush): SensorSink.append (kernel/ports.ts) is synchronous
// — (line, relativePath): void — but shadow eval is async (it may spawn a
// real check subprocess). The lab reproduces the same ordering constraint
// by composing the line in memory, awaiting shadowEvaluateAtStop, THEN
// calling appendSensor once (cc-gate-plugin/src/hook-cli.ts:349-381) — it
// never annotates inside an append call either. This wrapHost does the
// same: its decorated sensor.append does not forward lines, it HOLDS them;
// afterDecision (already awaited by hook-cli.ts before the plan is emitted,
// per K1's own wiring) is the flush point, where async shadow eval is safe
// to run before the real write happens.
//
// R16 (K4 review Q1, Critical): held-line state is keyed per ORIGINAL
// (pre-wrap) GateHost via a WeakMap, not a module-global — two loads in one
// process (a real risk: bun:test shares a module cache across every test
// file) would otherwise misroute one host's held lines into another's
// flush. Correctness depends on the SAME host object reaching both
// Extension.wrapHost (via ActiveExtensions.wrapHost's own host argument)
// and Extension.afterDecision (registry.ts's closure-captured host) — true
// under the real hook-cli.ts lifecycle and under loadActiveExtensions's own
// design, but only guaranteed when gauge is the sole (or first-applied)
// active extension; a later multi-extension composition where gauge is NOT
// first in the reduce chain would receive an already-wrapped host in
// wrapHost, breaking this correlation. Not a concern today (gauge is the
// only registered extension) — flagged for whoever adds a second one.
//
// Q3 (K4 review, High): the kernel returns ALLOW on a no-edit Stop WITHOUT
// ever calling sensor.append (kernel/gate.ts:289, `if (!state.edited &&
// !state.gating) return ALLOW`) — so a "gauge-only" Stop (no file edits,
// but a pending derivation exists) held nothing at all, and shadow eval
// never ran, so a pending derivation could NEVER be consumed. The lab runs
// shadow eval UNCONDITIONALLY on every Stop regardless of whether a floor
// line exists (hook-cli.ts:349-357) and fabricates a gauge-only line via
// shadowEvaluateAtStop's own fabricateLine path when nothing else would be
// logged. afterDecision below reproduces that: on every stop-requested
// event where nothing was held, it still runs shadow eval with sensor =
// undefined and appends the result directly when one comes back (shadow.ts
// itself already returns undefined when there is genuinely nothing pending
// — no line is fabricated out of nothing).
//
// Crash-window honesty (R13): if the process dies between gate.handle()
// returning and afterDecision running, a held line is lost. The lab has the
// IDENTICAL window — it composes the line, evaluates, then appends, all in
// the same synchronous stretch of one hook invocation. This is parity, not
// a regression this port introduces.
import type { GateConfig, GateDecision, GateEvent, GateHost, SensorLine } from "../../kernel/ports.ts"
import { parseGateConfig } from "../../kernel/config.ts"
import type { Extension, ExtensionContext } from "../registry.ts"
import { shadowEvaluateAtStop } from "./shadow.ts"
import { maybeSpawnGauge } from "./spawn.ts"
import { gaugeDir, pickPending } from "./files.ts"
import type { GaugedSensorLine } from "./types.ts"
// Round-3 review (S1 Critical): this file used to register cli-spawn's
// provider itself, but the ONLY process that ever calls sendPrompt() is
// refiner-cli.ts, spawned detached (spawn.ts) as its own process with its
// own send-prompt.ts registry — a registration made HERE never reached it.
// providers/cli-spawn.ts now self-registers on import instead, so nothing
// in this file needs to import it just for that side effect.

interface HeldLine {
  line: SensorLine
  relativePath: string
}

// R16: keyed on the ORIGINAL (pre-wrap) GateHost, not a module-global — see
// this file's header comment for the correctness argument and its one
// known limitation (multi-extension ordering).
const heldByHost = new WeakMap<GateHost, HeldLine[]>()

function stampGauge(line: SensorLine, offReason: "no-record" | "error"): SensorLine {
  return { ...line, gauge: { present: false, offReason } } as SensorLine
}

function safeAppend(host: GateHost, line: SensorLine, relativePath: string): void {
  // Q2 (K4 review, High): the real sink itself can throw (ENOSPC etc) —
  // confirmed by the review's own probe, which lost 2 of 3 lines and
  // rejected afterDecision entirely before this guard existed. Every
  // append (flush-loop, finally-salvage, and the fabricated-line path
  // alike) goes through here: log via host.logger (restores the kind of
  // could-not-append diagnostic the kernel itself would otherwise lose)
  // and move on rather than losing the rest of the batch or throwing out
  // of afterDecision.
  try {
    host.sensor.append(line, relativePath)
  } catch (err) {
    try {
      host.logger.log(`kkamak: gauge sensor append failed (line dropped): ${String(err)}`)
    } catch {
      // nothing more to do
    }
  }
}

/** Runs shadow eval for one held line and returns the line to actually
 * write — a real gauge field on success, or a stamped fallback. Q5 (K4
 * review): "no-record" only when there was genuinely nothing pending to
 * evaluate (checked independently via pickPending, since shadow.ts's own
 * return value is structurally identical — the line/sensor unchanged —
 * whether NOTHING was pending or something threw internally and its own
 * catch swallowed it); "error" for everything else that leaves a line
 * without a gauge field. NEVER throws itself: defense-in-depth, on top of
 * shadowEvaluateAtStop's own internal swallow.
 *
 * N1 (round-2 review, Medium): an interrupted line (`line.interrupted`)
 * is shadow.ts's OWN deliberate no-op branch (`if (sensor?.interrupted)
 * return sensor`) — the user preempted the cycle and the pending gauge is
 * kept for the next one on purpose. That is routine, the single most
 * common benign no-gauge case, never "something broke" — even though a
 * pending derivation existed beforehand. Checked before hadPendingBefore
 * so it can't be misread as "error". */
async function annotateLine(line: SensorLine, ctx: ExtensionContext, host: GateHost): Promise<SensorLine> {
  let hadPendingBefore: boolean
  try {
    const cfg = parseGateConfig(host.config.read())
    if (!cfg) return stampGauge(line, "error")

    hadPendingBefore = pickPending(gaugeDir(ctx.root), line.sessionID) !== undefined

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
      const wasInterrupted = (result as SensorLine).interrupted === true
      return stampGauge(result as SensorLine, !wasInterrupted && hadPendingBefore ? "error" : "no-record")
    }
    return result as SensorLine
  } catch {
    return stampGauge(line, "error")
  }
}

/** Q3: the fabricated-line counterpart to annotateLine, for a stop-requested
 * event where nothing was held at all. Returns undefined when
 * shadowEvaluateAtStop itself returns undefined (genuinely nothing
 * pending — no line fabricated out of nothing, matching shadow.ts's own
 * documented behavior). */
async function fabricateIfPending(
  sessionID: string,
  ctx: ExtensionContext,
  host: GateHost,
): Promise<{ line: SensorLine; relativePath: string } | undefined> {
  try {
    const cfg: GateConfig | undefined = parseGateConfig(host.config.read())
    if (!cfg) return undefined

    const runCheck = async (cmd: string): Promise<{ code: number; out: string }> => {
      const r = await host.check.run(cmd, cfg.checkTimeoutMs)
      return { code: r.code, out: r.output }
    }
    const deps = {
      now: () => host.clock.now(),
      hostname: () => host.info.host,
      log: (msg: string) => host.logger.log(msg),
    }

    const fabricated = await shadowEvaluateAtStop(ctx.root, sessionID, cfg, undefined, runCheck, deps)
    if (!fabricated) return undefined
    return { line: fabricated as SensorLine, relativePath: cfg.sensor }
  } catch {
    return undefined
  }
}

/** Detached, best-effort launch — mirrors the lab's own
 * Bun.spawn+unref() pattern (cc-gate-plugin/src/hook-cli.ts), simplified:
 * Bun's own unref() achieves detachment without the lab's extra
 * `bash -c "nohup ... &"` shell wrapping. */
function detachedSpawn(cmd: string[]): void {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  proc.unref()
}

function wrapHost(host: GateHost, _ctx: ExtensionContext): GateHost {
  const list: HeldLine[] = []
  heldByHost.set(host, list)
  return {
    ...host,
    sensor: {
      append(line: SensorLine, relativePath: string): void {
        list.push({ line, relativePath })
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
  // N2 (round-2 review, Low): captured BEFORE the delete below, so a
  // SECOND afterDecision call on the same host (no intervening wrapHost —
  // shouldn't happen under the real hook-cli.ts lifecycle, but must not
  // misbehave if it does) can tell "this cycle's extension never ran"
  // apart from "already ran and flushed." pending.length === 0 alone
  // can't make that distinction: a multi-turn-C pending that shadow.ts
  // deliberately leaves byte-untouched (M6' fix, shadow.ts) would
  // otherwise be re-fabricated on every extra call.
  const hadHeldEntry = heldByHost.has(host)
  const pending = heldByHost.get(host) ?? []
  heldByHost.delete(host)
  const remaining = [...pending]

  try {
    while (remaining.length > 0) {
      const item = remaining.shift()!
      try {
        const annotated = await annotateLine(item.line, ctx, host)
        safeAppend(host, annotated, item.relativePath)
      } catch (err) {
        // annotateLine itself has its own catch-all and should not reach
        // here — defense-in-depth against a bug in this wrapper's own
        // control flow, same reasoning as the finally block below.
        try {
          host.logger.log(`kkamak: gauge line annotation failed (dropped): ${String(err)}`)
        } catch {
          // nothing more to do
        }
      }
    }
  } finally {
    // R13/Q2: whatever's still in `remaining` never got a real attempt —
    // only reachable if the per-item try/catch above somehow didn't run.
    // Flush it now stamped "error" (something broke, not "nothing was
    // pending"), so silence-forbidden holds even against a bug in this
    // wrapper's own control flow, not just inside the already-swallowing
    // ported gauge internals.
    for (const item of remaining) {
      safeAppend(host, stampGauge(item.line, "error"), item.relativePath)
    }
  }

  // Q3: nothing was held for this Stop (the kernel never called append at
  // all — a no-edit "gauge-only" Stop) — still run shadow eval, still give
  // a pending derivation a chance to be consumed and measured. hadHeldEntry
  // gates this too (N2): a repeat afterDecision call on the same host,
  // with no held-line entry left to find, does not re-run it.
  if (event.kind === "stop-requested" && hadHeldEntry && pending.length === 0) {
    const fabricated = await fabricateIfPending(event.sessionID, ctx, host)
    if (fabricated) safeAppend(host, fabricated.line, fabricated.relativePath)
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

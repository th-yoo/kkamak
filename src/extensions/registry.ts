import type { GateDecision, GateEvent, GateHost } from "../kernel/ports.ts"
import { parseEnabledExtensions } from "./config.ts"

/**
 * Adapter-supplied context an extension needs but GateHost doesn't carry
 * (K4 ruling R12) — GateHost bakes each port's own root in internally at
 * construction time, invisible to callers, and the kernel's GateEvent never
 * carries prompt text on any variant, both by deliberate kernel design.
 * Sourced from the adapter layer (hook-input.ts/hook-cli.ts for Claude
 * Code), never from kernel/ports.ts or ambient process state.
 */
export interface ExtensionContext {
  /** Host project root (the hook payload's cwd for Claude Code). Extensions
   * locate their own stores (e.g. <root>/.km/gauge) with this, never
   * process.cwd(). */
  root: string
  /** Prompt text, when the event is a user prompt and the adapter has it. */
  prompt?: string
}

export interface Extension {
  name: string
  /**
   * Decorate the host (e.g. wrap host.sensor to annotate lines). MUST
   * return a host that behaves identically except for additive
   * annotation. The one sanctioned exception (K4 ruling R13,
   * hold-and-flush): a decorated host.sensor.append MAY withhold a line
   * instead of forwarding it immediately, PROVIDED the implementor's own
   * afterDecision flushes every withheld line to the real sink by the end
   * of the SAME afterDecision call that follows this wrapHost's use, in
   * the same process invocation — see ActiveExtensions.wrapHost's doc
   * comment for the caller-facing guarantee this produces.
   */
  wrapHost(host: GateHost, ctx: ExtensionContext): GateHost
  /**
   * Detached side-effects after the kernel decided. MUST NOT change the
   * emitted decision. Errors are swallowed by the registry, logged to
   * host.logger.
   */
  afterDecision(event: GateEvent, decision: GateDecision, host: GateHost, ctx: ExtensionContext): Promise<void>
}

export interface ActiveExtensions {
  /**
   * The R13 hold-and-flush shape (K4 review): wrapHost's decorated
   * sensor.append does not necessarily forward a line immediately — an
   * extension MAY withhold it and flush later, from within its own
   * afterDecision call, once async work (e.g. shadow eval) has run. Every
   * line an active extension's wrapHost intercepts is guaranteed to be
   * flushed to the real sink by the end of the SAME afterDecision call
   * that follows it, in the same process invocation — never silently
   * dropped, never deferred past that point. Identity when no extension is
   * enabled. ctx is bound at load time.
   */
  wrapHost(host: GateHost): GateHost
  /** Noop when no extension is enabled. ctx is bound at load time. */
  afterDecision(event: GateEvent, decision: GateDecision): Promise<void>
}

/**
 * K6 review (Q6, Medium): a static `Record<string, Extension>` meant a
 * static top-level import of every registered extension's module — gauge's
 * own registerProvider side effect ran on EVERY hook invocation, even with
 * gauge disabled, adding ~11ms per event regardless of enablement. Lazy
 * instead: each entry is a loader, dynamic-imported ONLY for names
 * gate.json's own "extensions" block actually enables.
 *
 * Specifiers here MUST be static string literals, never built at runtime
 * from a variable or template — test/imports.test.ts's "no dynamic import
 * uses a computed specifier" guard exists specifically to catch that
 * class, and a runtime-built specifier here would defeat both that guard
 * and the package-containment scan's ability to verify every relative
 * import resolves to a real file.
 */
export const EXTENSIONS: Record<string, () => Promise<Extension>> = {
  gauge: () => import("./gauge/index.ts").then((m) => m.gaugeExtension),
}

/**
 * Testable core: builds ActiveExtensions against an explicit registry, so
 * tests can inject fakes without touching the real EXTENSIONS map.
 * loadActiveExtensions (below) is the adapter-facing entry point, always
 * bound to the real registry.
 */
export async function loadActiveExtensionsFrom(
  host: GateHost,
  registry: Record<string, () => Promise<Extension>>,
  ctx: ExtensionContext,
): Promise<ActiveExtensions> {
  const enabledNames = parseEnabledExtensions(host.config.read())
  const active: Extension[] = []
  for (const name of enabledNames) {
    const load = registry[name]
    if (!load) {
      host.logger.log(
        `kkamak: extensions.${name} is enabled in gate.json but no such extension is registered — ignoring`,
      )
      continue
    }
    try {
      active.push(await load())
    } catch (err) {
      host.logger.log(`kkamak: extensions.${name} failed to load: ${String(err)}`)
    }
  }
  // active is already in sorted-name order: enabledNames is sorted by
  // parseEnabledExtensions, and this loop preserves that order.

  return {
    wrapHost(host: GateHost): GateHost {
      return active.reduce((h, ext) => ext.wrapHost(h, ctx), host)
    },
    async afterDecision(event: GateEvent, decision: GateDecision): Promise<void> {
      for (const ext of active) {
        try {
          await ext.afterDecision(event, decision, host, ctx)
        } catch (err) {
          host.logger.log(`kkamak: extensions.${ext.name}.afterDecision threw: ${String(err)}`)
        }
      }
    },
  }
}

export async function loadActiveExtensions(host: GateHost, ctx: ExtensionContext): Promise<ActiveExtensions> {
  return loadActiveExtensionsFrom(host, EXTENSIONS, ctx)
}

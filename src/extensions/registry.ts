import type { GateDecision, GateEvent, GateHost } from "../kernel/ports.ts"
import { parseEnabledExtensions } from "./config.ts"
import { gaugeExtension } from "./gauge/index.ts"

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
   * annotation.
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
  /** Identity when no extension is enabled. ctx is bound at load time. */
  wrapHost(host: GateHost): GateHost
  /** Noop when no extension is enabled. ctx is bound at load time. */
  afterDecision(event: GateEvent, decision: GateDecision): Promise<void>
}

/** K4 flips this from empty to real: "gauge" is registered, still
 * inert-by-default (config-gated — see gaugeExtension's own header comment
 * for the "extensions":{"gauge":true} activation path). */
export const EXTENSIONS: Record<string, Extension> = {
  gauge: gaugeExtension,
}

/**
 * Testable core: builds ActiveExtensions against an explicit registry, so
 * tests can inject fakes without touching the real EXTENSIONS map.
 * loadActiveExtensions (below) is the adapter-facing entry point, always
 * bound to the real registry.
 */
export async function loadActiveExtensionsFrom(
  host: GateHost,
  registry: Record<string, Extension>,
  ctx: ExtensionContext,
): Promise<ActiveExtensions> {
  const enabledNames = parseEnabledExtensions(host.config.read())
  const active: Extension[] = []
  for (const name of enabledNames) {
    const ext = registry[name]
    if (!ext) {
      host.logger.log(
        `kkamak: extensions.${name} is enabled in gate.json but no such extension is registered — ignoring`,
      )
      continue
    }
    active.push(ext)
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

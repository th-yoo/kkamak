import type { GateDecision, GateEvent, GateHost } from "../kernel/ports.ts"
import { parseEnabledExtensions } from "./config.ts"

export interface Extension {
  name: string
  /**
   * Decorate the host (e.g. wrap host.sensor to annotate lines). MUST
   * return a host that behaves identically except for additive
   * annotation.
   */
  wrapHost(host: GateHost): GateHost
  /**
   * Detached side-effects after the kernel decided. MUST NOT change the
   * emitted decision. Errors are swallowed by the registry, logged to
   * host.logger.
   */
  afterDecision(event: GateEvent, decision: GateDecision, host: GateHost): Promise<void>
}

export interface ActiveExtensions {
  /** Identity when no extension is enabled. */
  wrapHost(host: GateHost): GateHost
  /** Noop when no extension is enabled. */
  afterDecision(event: GateEvent, decision: GateDecision): Promise<void>
}

/** K1 ships this empty. Later tasks register real extensions here. */
export const EXTENSIONS: Record<string, Extension> = {}

/**
 * Testable core: builds ActiveExtensions against an explicit registry, so
 * tests can inject fakes without touching the real EXTENSIONS map.
 * loadActiveExtensions (below) is the adapter-facing entry point, always
 * bound to the real registry — it never gains a second parameter, so later
 * tasks' calls to it stay unaffected by how it's implemented here.
 */
export async function loadActiveExtensionsFrom(
  host: GateHost,
  registry: Record<string, Extension>,
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
      return active.reduce((h, ext) => ext.wrapHost(h), host)
    },
    async afterDecision(event: GateEvent, decision: GateDecision): Promise<void> {
      for (const ext of active) {
        try {
          await ext.afterDecision(event, decision, host)
        } catch (err) {
          host.logger.log(`kkamak: extensions.${ext.name}.afterDecision threw: ${String(err)}`)
        }
      }
    },
  }
}

export async function loadActiveExtensions(host: GateHost): Promise<ActiveExtensions> {
  return loadActiveExtensionsFrom(host, EXTENSIONS)
}

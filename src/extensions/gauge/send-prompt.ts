// send-prompt.ts — N1 of docs/superpowers/specs/2026-08-04-send-prompt-interface.md.
//
// The interface every one-shot LLM caller in this repo actually wants: one
// call, model per call, text out — the shape the OpenAI SDK exposes. A
// previous design modelled these callers (gauge classifier, proposer,
// reviewer, judge) as ACP *sessions*; the user ruled that a session here
// "is just keep-alive", so no caller sees one. Keep-alive, connection
// pooling and warm subprocesses are provider-internal from here down.
//
// THIS MODULE SHIPS NO PROVIDER. `anthropic-api` / `anthropic-cli-warm` /
// `openai` are N2/N3/N4. It must not import any provider module, the
// package's warm-session or acp-client internals, or `@anthropic-ai/sdk`,
// and must not spawn anything — its tests register FAKE providers. That
// isolation is the point: N2 proves this interface against a transport that
// already works, so when N3's warm path misbehaves the interface is not
// also on trial.
//
// K3 port note: the lab's `WarmIsolation` import pulled `import type` from
// `@th-yoo/cc-api-daemon` — erased at runtime, no daemon package ever in
// this module's graph. This port carries that same property differently:
// `WarmIsolation` is copied verbatim into this gauge extension's own
// types.ts (origin comment there), so there is no daemon package import at
// all here, type or value — package.json stays at zero runtime deps.
//
// `sendPrompt` NEVER throws. Every failure — including a provider that
// itself throws — comes back as a `SendOutcome`. A caller that prefers
// exceptions wraps this.
import type { WarmIsolation } from "./types.ts"

/** No registry, no lookup: the caller passes an explicit provider id string.
 * Left as `string` (not a closed union) because this module does not know
 * the set of providers that will ever be registered against it — N2/N3/N4
 * each register their own id at runtime; baking their names in here would
 * be exactly the cross-module coupling this node is built to avoid. */
export type ProviderId = string

/** §6e's wire-send boundary law (acp-wire.ts's L1 vs L2), surfaced at the
 * top of the interface rather than buried inside a provider. `no-call`:
 * the prompt bytes never reached the model — a caller MAY retry or fall
 * back. `call-consumed`: they did, and a caller MUST NOT. Burying this
 * distinction inside providers is exactly what would let one record cost
 * two model calls. */
export type SendOutcome =
  | { ok: true; text: string; model: string; canonicalModel: string }
  | { ok: false; kind: "no-call" | "call-consumed" }

export interface SendPromptOptions {
  model: string
  /** A WarmIsolation VALUE (acp-wire.ts), not an id — there is nothing to
   * look up on a wire. Two shipped values: GAUGE_ISOLATION (empty system
   * prompt) and REASONING_ISOLATION (below). */
  isolation: WarmIsolation
  /** EXPLICIT, never inferred from the model string. Silent inference is
   * how a haiku call becomes an OpenAI call. */
  provider: ProviderId
  timeoutMs?: number
  /** Amendment, 2026-08-05, pre-consumption (see the spec's §2 note): request
   * max_tokens. Absent -> the provider's own default (N2's transport default
   * is 2048, unchanged); present -> threaded through verbatim. Added ahead
   * of N5's design-time-seat migration, whose multi-KB replies would be
   * silently truncated at the 2048 default. */
  maxTokens?: number
  schema?: Record<string, unknown>
}

/** A provider is a function from (prompt, opts) to an outcome — the same
 * shape `sendPrompt` itself exposes, so dispatch is a direct call, not an
 * adapter. Providers are free to throw; `sendPrompt` is the only place
 * that catches. */
export type SendPromptProvider = (prompt: string, opts: SendPromptOptions) => Promise<SendOutcome>

// Registration mechanism: a module-level Map keyed by ProviderId. Nothing
// richer is needed — N2/N3/N4 each call `registerProvider` once at import
// time (or a test calls it per-case with a throwaway id), and `sendPrompt`
// does one `Map.get`. A class/DI-container registry would add ceremony
// with no caller that needs it: nothing here is swapped at runtime except
// in tests, and tests are happy to register directly.
const registry = new Map<ProviderId, SendPromptProvider>()

export function registerProvider(id: ProviderId, provider: SendPromptProvider): void {
  registry.set(id, provider)
}

export function resolveProvider(id: ProviderId): SendPromptProvider | undefined {
  return registry.get(id)
}

/** ONE model call. Keep-alive, connection reuse, warm subprocesses and
 * session lifecycles are provider-internal and invisible here. Never
 * throws — see the module doc. */
export async function sendPrompt(prompt: string, opts: SendPromptOptions): Promise<SendOutcome> {
  const provider = registry.get(opts.provider)
  // Unknown provider: nothing was sent, so this is `no-call` by
  // construction, not a guess — and it must not throw, the same "never
  // throws" rule that governs every other branch of this function.
  if (!provider) return { ok: false, kind: "no-call" }
  try {
    return await provider(prompt, opts)
  } catch {
    // A provider that throws has already been ENTERED — bytes may or may
    // not have reached the model, and from out here that is unprovable.
    // §6e resolves exactly this ambiguity (a post-send unknown) toward the
    // conservative side, "consumed", so a caller never double-spends a
    // record on a retry it should not have taken. Same reasoning, applied
    // at the interface boundary instead of the wire boundary.
    return { ok: false, kind: "call-consumed" }
  }
}

/** The §6d/§6e gauge isolation set — byte-identical to the option literal
 * inlined in agent-transport.ts's agentSdkCall (see :119-132 there for the
 * authority; a lock test proves that equality). Formerly declared in
 * `src/acp/acp-wire.ts`; moved here because the `@th-yoo/cc-api-daemon`
 * package's acp-wire.ts doc comment forbids the package from exporting
 * GAUGE_ISOLATION — it stays a caller-side constant. */
export const GAUGE_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-gauge",
  thinking: { type: "disabled" },
}

/** Same isolation shell as GAUGE_ISOLATION (no tools, no setting sources,
 * no auto-memory) but with a real system prompt for callers that want a
 * reasoning assistant rather than the gauge's bare-model probe. The prompt
 * text is copied VERBATIM from minimal/llm.ts's opencode driver (the
 * `agent.build.prompt` literal there) — that exact wording is what is
 * proven out in production; paraphrasing it would be new, unproven
 * behaviour wearing the old name. `title` is distinct from
 * GAUGE_ISOLATION's `"kkamak-gauge"` so the two are never confused in a
 * transcript or a log line. */
export const REASONING_ISOLATION: WarmIsolation = {
  systemPrompt:
    "You are a careful reasoning assistant. Answer directly in plain text in this conversation. Do not use tools, read or modify files, or run commands.",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-reasoning",
  thinking: { type: "disabled" },
}

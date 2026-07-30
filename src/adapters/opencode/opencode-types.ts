// Minimal structural types for the slice of opencode's plugin surface this
// adapter uses. Deliberately NOT imported from @opencode-ai/plugin: that
// package is not a dependency of this one, and installation copies this
// directory out of the repo.

export interface OpencodeEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface PromptPart {
  type: "text"
  text: string
}

export interface OpencodeClient {
  session: {
    promptAsync(options: {
      path: { id: string }
      body: { parts: PromptPart[] }
    }): Promise<unknown>
  }
}

export interface OpencodePluginInput {
  client: OpencodeClient
  /** Repo root for this session. gate.json and .km/ hang off it. */
  worktree: string
  directory?: string
}

export interface KkamakHooks {
  event?: (input: { event: OpencodeEvent }) => Promise<void>
  "chat.message"?: (
    input: { sessionID: string },
    output: { message: unknown; parts: unknown[] },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
}

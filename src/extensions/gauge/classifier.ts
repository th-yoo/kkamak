// km-gauge classifier (pre-reg §2.1) — deterministic, no LLM, pure.
// task-shaped iff (imperative action verb OR file-path mention) AND not
// question-only. Under-trigger preferred: every miss is only a lost shadow
// data point, every false hit is a wasted refiner call.

const ACTION_VERBS =
  /\b(add|fix|implement|create|refactor|write|build|update|remove|delete|rename|move|convert|migrate|install|configure|change)\b/i

// Bare-filename extensions that count as a path mention on their own (no
// directory separator required). Single source of truth — also consumed by
// validate.ts's extractPathTokens (km-gauge v2 extractor).
export const PATH_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "json", "md", "txt", "py", "sh", "rs", "go", "c",
  "h", "cpp", "hpp", "java", "yml", "yaml", "toml", "css", "html", "sql",
  "csv", "ndjson", "lock", "cfg", "conf", "ini", "env",
] as const

// A token with a directory separator, or a bare filename with a known code/
// config extension. Whitelisting extensions keeps "e.g." / "i.e." out.
const PATH_LIKE = new RegExp(
  '(^|[\\s"\'`(])[\\w.@~-]*\\/[\\w.@/~-]+|\\b[\\w-]+\\.(' + PATH_EXTENSIONS.join("|") + ')\\b',
  "i",
)

export function isTaskShaped(prompt: string): boolean {
  const p = prompt.trim()
  if (!p) return false
  if (p.startsWith("/")) return false // slash command / skill invocation

  const hasVerb = ACTION_VERBS.test(p)
  // Question-only guard: a trailing "?" needs an imperative verb to count —
  // a path mention alone inside a question is discussion, not a task.
  if (p.endsWith("?")) return hasVerb

  return hasVerb || PATH_LIKE.test(p)
}

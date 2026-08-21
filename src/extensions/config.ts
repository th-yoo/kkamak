/**
 * Names under gate.json's "extensions" whose value is the literal `true`.
 * Missing key, malformed JSON, non-object, or any other value shape → [].
 * Never throws — same discipline as kernel/config.ts's parseGateConfig.
 */
export function parseEnabledExtensions(raw: string | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return []
  const ext = (parsed as Record<string, unknown>).extensions
  if (typeof ext !== "object" || ext === null || Array.isArray(ext)) return []
  return Object.entries(ext as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
}

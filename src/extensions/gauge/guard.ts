// km-gauge safety guard — a derived check is MODEL-GENERATED SHELL executed
// with the user's permissions in a real repo. Shadow mode means the check
// cannot change a GATE DECISION; it does not make the command read-only.
//
// Policy: allow only obviously-inspecting commands. Refusing a legitimate
// check costs one M1 data point; running a destructive one costs the repo,
// so every ambiguous case must fail toward refusal.
//
// Word-anchored patterns only: "formula" must not trip `rm`, "sudoku" must
// not trip `sudo`.

const RULES: { reason: string; re: RegExp }[] = [
  // Backtick substitution defeats every word-anchored rule below: a verb
  // immediately after an unspaced backtick has no separator-class char
  // before it, so `rm f` inside backticks is invisible. $() is fine — "("
  // IS in the separator class, so interiors are scanned. Refuse backticks
  // outright (a3 rule-routing T3 review find, 2026-08-13). Known trade:
  // this also refuses literal-backtick-as-data (e.g. grepping for markdown
  // code fences) — accepted per this file's fail-toward-refusal policy;
  // shadow-only blast radius (one M1 data point per refusal).
  { reason: "backtick-substitution", re: /`/ },
  { reason: "privilege-escalation", re: /(^|[\s;&|(])(sudo|doas|su)\b/ },
  { reason: "network-access", re: /(^|[\s;&|(])(curl|wget|nc|netcat|ssh|scp|rsync|ftp|telnet)\b/ },
  {
    reason: "destructive-command",
    re: /(^|[\s;&|(])(rm|rmdir|unlink|shred|mv|cp|chmod|chown|chgrp|truncate|dd|mkfs|ln)\b/,
  },
  { reason: "in-place-edit", re: /(^|[\s;&|(])(sed|perl|ruby|python3?)\b[^;&|]*\s-i\b/ },
  {
    reason: "state-changing-command",
    re: /(^|[\s;&|(])(git\s+(push|commit|add|reset|checkout|switch|merge|rebase|clean|stash|rm|mv|tag|fetch|pull|apply|restore|cherry-pick|revert|init|remote|config)|npm\s+(install|i|ci|publish|update|uninstall|link)|bun\s+(add|install|remove|link|publish|upgrade)|pnpm\s+(add|install|remove)|yarn\s+(add|install|remove)|pip3?\s+(install|uninstall)|cargo\s+(install|publish|add)|go\s+(install|get)|docker|podman|systemctl|launchctl|crontab|make\s+(install|clean))\b/,
  },
  { reason: "process-control", re: /(^|[\s;&|(])(kill|pkill|killall|xargs)\b/ },
  {
    reason: "shell-escape",
    re: /(^|[\s;&|(])(eval|exec|source|sh|bash|zsh|dash|env|nohup|setsid|at|batch)\b/,
  },
  // Writing redirections: `>` / `>>` / `2>` to anything but /dev/null.
  // `<` (input), `<(` (process substitution) and `2>&1` (fd dup) stay legal.
  { reason: "output-redirection", re: />>?\s*(?!\/dev\/null)(?!&\d)\S/ },
]

/** Reason string when the check must NOT be run, undefined when it is safe. */
export function unsafeReason(check: string): string | undefined {
  const c = check.trim()
  if (!c) return undefined
  for (const { reason, re } of RULES) {
    if (re.test(c)) return reason
  }
  return undefined
}

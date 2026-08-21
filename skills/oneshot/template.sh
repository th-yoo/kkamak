#!/usr/bin/env bash
# oneshot script template. Copy this whole script into one Bash tool call,
# fill in the two arguments below, and replace the EDITS block with real
# edit commands. See SKILL.md for the full instructions.
#
# $1 = PLUGIN_ROOT   — the absolute path from "Base directory for this
#                       skill: ..." reported when the oneshot skill loaded.
#                       Never write the literal token ${CLAUDE_PLUGIN_ROOT}
#                       here — it does not resolve in a plain shell.
# $2 = MAX_ATTEMPTS   — gate.json's "rounds" value PLUS ONE (the gate's own
#                       semantics: rounds=2 means up to 3 total checks
#                       before giving up — match that exactly here).
set -uo pipefail

PLUGIN_ROOT="$1"
MAX_ATTEMPTS="$2"

attempt=0
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))

  # --- EDITS: replace this block with real edit commands ---
  :
  # --- end EDITS ---

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    export ONESHOT_FINAL_ATTEMPT=1
  else
    unset ONESHOT_FINAL_ATTEMPT
  fi

  if bun "$PLUGIN_ROOT/run-once.ts"; then
    exit 0
  fi
done
exit 1

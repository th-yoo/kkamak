# Known issues

These came out of the 0.4.0 pre-release review. All were judged Minor: none
of them block using kkamak, and none were fixed as part of that review —
they are recorded here so the judgement is visible, not silently acted on.

## 1. `.claude-plugin/marketplace.json` has no `$schema` or top-level `description` — RESOLVED

Judged minor because the marketplace still works without either — `claude
plugin marketplace add` doesn't require them. Worth having anyway: `$schema`
buys editor and CI validation for free, and other working marketplaces on
the maintainer's own machine carry both fields.

Resolved: both fields added. `$schema` is
`https://anthropic.com/claude-code/marketplace.schema.json`, confirmed
against the official `claude-plugins-official` and third-party `caveman`
marketplaces installed on the maintainer's machine, which both point at the
same URL. `description` mirrors `plugin.json`'s. Pinned by
`test/packaging.test.ts`'s "marketplace.json carries a $schema and a
top-level description" test.

## 2. `CHANGELOG.md` files every 0.4.0 entry under `### Added`

Entries like "Bump version to 0.4.0…" and "Rewrite the README…" (lines 8-19)
are changes to existing things, which [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) files under `### Changed`,
not `### Added`. Separately, the file's header claims "All notable changes to
this project are documented in this file" while the recorded history starts
at 0.4.0 with no explanation of the gap. Judged minor because the content
under each entry is accurate regardless of which heading it sits under, and
the gap has an obvious one-line explanation that just hasn't been written
yet: 0.4.0 is the first public release; 0.1-0.3 were never released.

## 3. `package.json`'s description uses "an agent" instead of "Claude Code"

`package.json:5` reads "an agent cannot say done…" where `.claude-plugin/
plugin.json` and `.claude-plugin/marketplace.json` both say "Claude Code
cannot say done…". Judged minor because `package.json` is `"private": true`
and never published to npm, so this description is not user-facing in
practice — but it's the one place the CC-first framing slips.

## 4. README's gate.json placement instructions describe the wrong directory

`README.md`'s "Set up `gate.json`" section says to put the file "at the repo
root, next to `.git/`." In fact `gate.json` is read from the Claude Code
hook payload's `cwd` (`src/adapters/claude-code/hook-input.ts:37` →
`src/runtime/config-source.ts:17`), not resolved relative to the repo root.
Launch Claude Code from a subdirectory and the gate silently no-ops — which
is exactly the failure mode the README's own "Confirm it loaded" paragraph
warns is indistinguishable from a passing check. Judged minor rather than
blocking because the common case (launching from the repo root) happens to
put `cwd` and repo root in the same place, so most readers never hit the
discrepancy; a clearer clause would read "…at the directory you launch
Claude Code from (normally the repo root)."

## 5. README's Docs section doesn't link `docs/install-verification.md`

`README.md`'s Docs section links `docs/opencode.md` and `CHANGELOG.md` but
not the install-verification runbook. Judged minor because omitting it may
be intentional — the runbook is maintainer-only in the sense that a maintainer,
not an end user, runs it after cutting a release — but that intent isn't
stated anywhere, so a reader can't tell the omission from an oversight.

## 6. `docs/dogfood-log.md` is opaque to readers outside the private meta-harness repo

`CHANGELOG.md` sends public readers to `docs/dogfood-log.md` for entry
details, and that file references the private `meta-harness` repo 13 times
(round numbers, ledger files, evidence paths) that a stranger has no way to
resolve. Judged minor because nothing in the file is incorrect — it's an
honest log of what happened — it's just written for an audience with access
this repo's public readers don't have.

## 7. A stray `hello` line leaks to stderr during the test run

`test/runtime.test.ts:283` calls `host.logger.log("hello")` to assert a
logger failure doesn't throw, and that call's own output (`hello`) leaks to
stderr rather than being captured — so every `bun test` run, including CI,
prints a bare `hello` line above the pass/fail summary. Judged minor because
it's purely cosmetic: the line carries no information and doesn't affect the
test's pass/fail result.

## Regression: `gate.json`'s `gauge` field was wrongly removed, then restored

This repo's own tracked `gate.json` carries `"gauge": true`. The public
kernel's `parseGateConfig` (`src/kernel/config.ts`) ignores unknown fields
entirely, so in a plain kkamak install `gauge` does nothing — which made it
look, correctly for any other install, like dead config. A later review
finding removed it from this file on exactly that basis.

But on the maintainer's own machine this repo's `gate.json` is also read by
an installed research build, `cc-gate-plugin` (a separate, private plugin
layered on top of kkamak for dogfooding measurement), whose
`src/config.ts:18` reads `gauge: j.gauge === true` and whose
`src/gauge/spawn.ts:36` returns early — arming no measurement — unless that
field is `true`. Removing the field from this repo's `gate.json` silently
disabled that instrument's corpus collection here; every gate cycle between
the removal and its discovery recorded no gauge data, and that gap is not
recoverable after the fact.

**Do not remove `gauge` from this repo's `gate.json` again** on the grounds
that the public kernel doesn't read it. It is intentionally present for a
consumer outside this repo's own kernel. If the public-facing sample gate.json
shown in README.md or elsewhere needs to omit it for clarity, that's a
different file than this repo's own root `gate.json` — don't conflate the two.

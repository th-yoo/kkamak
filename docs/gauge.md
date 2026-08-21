# gauge

`gauge` is a shadow instrument built on kkamak's extension seam
(`src/extensions/`). It never affects a gate decision — it exists to measure
whether a task-shaped prompt *could* have earned a derived completion check,
alongside whatever `check` your `gate.json` already runs. Off by default;
enable it with:

```json
{ "check": "bun test", "extensions": { "gauge": true } }
```

## What it does

On a `UserPromptSubmit` event whose prompt looks task-shaped
(`isTaskShaped`, `src/extensions/gauge/classifier.ts`), gauge writes a
request file under `.km/gauge/` and launches a detached child process,
`refiner-cli.ts`, which makes **one** model call asking it to propose a
`goalSummary`, a classification, and — for the classes where one makes
sense — a derived shell check. The result is validated (`validate.ts`) and
persisted as a pending derivation.

At the next `Stop`, gauge picks up that pending derivation and shadow-
evaluates it (`shadow.ts`): if a derived check exists, it runs the check
(read-only — see "Shadow-only guarantee" below), compares the result
against the real gate's own floor outcome, and attaches a `gauge` field to
that cycle's sensor line. None of this can flip `block` to `allow` or back
— the kernel's own decision is already final by the time gauge's
`afterDecision` hook runs (`src/kernel/ports.ts`'s `Extension.afterDecision`
contract).

## Cost

Enabling gauge means kkamak makes real model calls:

- Transport: the `claude` CLI, cold-spawned per call (`claude -p ...`,
  `--output-format json`) — no daemon, no keep-alive session.
- Model: `claude-haiku-4-5` by default. Override with the
  `KKAMAK_GAUGE_MODEL` environment variable.
- Frequency: at most one call per task-shaped user prompt.
- Cap: 30 calls per repo per calendar day (`DAILY_CAP`,
  `src/extensions/gauge/spawn.ts`). The cap resets at local midnight and is
  tracked per `.km/gauge/` directory, so it is per-repo, not global.
- Requires `claude` on `PATH`. If it is missing, `Bun.spawn` fails
  synchronously and the call resolves as "never sent" — no gauge data for
  that prompt, no effect on the session.

## Kill switch

Set `KKAMAK_GAUGE=off` in the environment kkamak's hook process inherits.
Gauge checks this before writing a request file or spawning anything
(`maybeSpawnGauge`, `src/extensions/gauge/spawn.ts`) — no `gate.json` edit
needed, and it takes effect on the very next prompt, the same way any other
`gate.json` change does for the core gate.

## Artifacts

- `.km/gauge/` — pending derivations (`<sessionID>-<n>.json`), in-flight
  requests (`<sessionID>-<n>.req.json`), and consumed records
  (`<sessionID>-<n>.done.json`). Covered by the same `.km/` line kkamak's
  own `.gitignore` setup already adds.
- The sensor file (`.km/gate-outcomes.ndjson` by default) gains an optional
  `gauge` field on lines where a derivation was evaluated. `{"present":
  false, "offReason": "..."}` when nothing could be measured (see
  `src/extensions/gauge/types.ts`'s `GaugeOffReason` for the full set of
  reasons); a populated object with `pass`/`wouldBlock`/`confidence`/etc.
  when a derivation was actually evaluated.

## Shadow-only guarantee

Gauge's `wrapHost` only ever *holds* sensor lines the kernel would have
written anyway, so it can annotate them with async shadow-eval results
before they reach the real sink — it never fabricates a decision, and a
`gauge`-only Stop (no file edits) never blocks or allows anything gauge
didn't already have kkamak's own kernel decide. Any check a derivation
proposes is model-generated text, run only behind `guard.ts`'s read-only
refusal screen — the same defense-in-depth the core gate would want for
any check text it didn't write itself — and its result is recorded, never
enforced.

## Known limitation: only one extension exists today

Held-line state (`src/extensions/gauge/index.ts`'s `heldByHost`) is keyed
per `GateHost`, correct under the current `registry.ts` reduce chain because
gauge is the sole active extension. A second extension added to
`EXTENSIONS` in the future needs to confirm this still holds under
composition — see `docs/known-issues.md` #14 before adding one.

## Live-call verification (0.8.0 release, S2)

Before shipping, the full enabled-gauge path was driven with a **real**
`claude` CLI call (not a stub), through `refiner-cli.ts`'s actual entry
point, to confirm the CLI flags `cli-spawn.ts` builds are accepted live and
a real model response parses and persists correctly.

**Setup.** A fixture repo with a real `.req.json`:

```json
{"v":2,"sessionID":"live-s1","n":1,"ts":1,"prompt":"Fix the null pointer bug in src/parser.ts and add a regression test for it.","floorCheck":"bun test"}
```

**Invocation.** `bun src/extensions/gauge/refiner-cli.ts <repo> live-s1 1`,
with the real `claude` binary on `PATH` (`claude 2.1.238`), no stub, no
pre-registration — the same entry point `maybeSpawnGauge` launches in
production.

**Argv actually sent to the `claude` CLI** (as built by
`cli-spawn.ts`'s `buildArgs` for gauge's isolation profile,
`GAUGE_ISOLATION`):

```
claude -p "<refiner prompt>" --output-format json --model claude-haiku-4-5 --strict-mcp-config --tools ""
```

`--append-system-prompt` was **not** sent: `GAUGE_ISOLATION.systemPrompt`
is `""` (empty), and `buildArgs` only adds that flag when the isolation
profile carries a real system prompt (`REASONING_ISOLATION`, the other
shipped isolation, does). This is documented, intended behavior for gauge's
own bare-model probe — not a gap this verification skipped.

**Outcome.** Exit code `0`. Wall time ~34s (`derivationMs: 34054` in the
written record — consistent with a real one-shot model call, not a stub).
The written pending file:

```json
{"goalSummary":"Fix a null pointer bug in src/parser.ts and add a regression test for it","criteria":["Null pointer bug in src/parser.ts is identified and fixed","A regression test is written that would fail before the fix and pass after","The fix does not introduce new regressions"],"confidence":0.2,"class":"D","reason":"not-extractable","horizon":null,"check":null,"v":2,"sessionID":"live-s1","n":1,"ts":1787318385331,"model":"claude-haiku-4-5","derivationMs":34054}
```

The request file (`.req.json`) was gone afterward — cleaned up as designed.

**What this proves.** `--tools ""` and `--strict-mcp-config` are accepted
by a real, installed `claude` CLI (the call did not fail on flag syntax);
`parseRefinerOutput` correctly parsed a genuine model response, not just
the fixture JSON strings used in `test/gauge-refiner-cli.test.ts`'s
in-process tests; `validateDerivation` ran end to end on a live model
judgment (here, the model itself judged the task not reducible to a single
derived check — `class: "D"`, `reason: "not-extractable"`, `check: null` —
a legitimate real answer, not a validator downgrade: no `downgraded` key is
present, since there was nothing proposed to downgrade); and the full
write-then-clean-up sequence (`writeGaugeFile`, `fs.unlinkSync` on the req)
completed correctly against real model latency, not a synchronous stub.

This was a deliberate single real model call, run once, as part of the
0.8.0 release process — not something the automated suite repeats. The
automated tests (`test/gauge-refiner-cli.test.ts`,
`test/gauge-refiner-cli-subprocess.test.ts`) cover the same code paths
against fakes/stubs on every run, at zero cost.

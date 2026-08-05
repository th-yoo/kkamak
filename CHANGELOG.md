# Changelog

All notable changes to this project are documented in this file, starting at 0.4.0 — the first public release. Versions 0.1 through 0.3 existed only as local development builds and were never released, so they have no entries here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Details for each entry live in [`docs/dogfood-log.md`](docs/dogfood-log.md), linked per entry below.

## [0.4.1] - 2026-08-05

Review-debt paydown: the five findings the 0.4.0 pre-release review recorded
as Minor and did not fix (`docs/known-issues.md` #2, #4, #5, #6, #7). No
behavior changes.

### Changed

- `CHANGELOG.md` files change-shaped 0.4.0 entries under `### Changed`, and states that 0.4.0 is the first public release (`a9c5661`)
- `README.md`'s Docs section lists `docs/install-verification.md` and says it is for maintainers cutting a release (`bcd6a69`)
- `docs/dogfood-log.md` opens with a preamble naming its audience and stating that its `meta-harness` citations resolve only in a private repo (`44c0a4d`)
- Version bumped to 0.4.1 across the four version sites

### Fixed

- `gate.json` placement: the README told readers to put the file at the repo root, but the gate reads it from the working directory Claude Code reports in its hook payload and never searches upward. Corrected in the README, in `commands/init.md`, and in doc comments on `FileConfigSource`, `NodeHostOptions.root`, `STATE_DIR` and `GateConfig.sensor`; pinned by tests (`0fefd80`)
- The test suite no longer leaks a bare `hello` line to stderr; the logger test captures the write and asserts what was delivered (`f4311e0`)

## [0.4.0] - 2026-08-01

### Added

- Adopt `pluginVersion`/`forced` sensor fields, closing D1. [dogfood log](docs/dogfood-log.md#2026-07-31--d1-closure-pluginversionforced-adopted-yoo-dev) — (`ad63d3b`)
- Implement real `gate.json` `marker` (hygiene notice), correcting an earlier misreading. [dogfood log](docs/dogfood-log.md#2026-07-31--real-marker-mechanism-implemented-correcting-an-earlier-misreading-yoo-dev) — (`65c9546`)
- Deliver `GateDecision.marker` in the Claude Code adapter. [dogfood log](docs/dogfood-log.md#2026-07-31--cc-adapter-wired-to-deliver-the-hygiene-marker-yoo-dev) — (`8e23103`)
- Deliver `GateDecision.marker` in the opencode adapter. [dogfood log](docs/dogfood-log.md#2026-07-31--opencode-adapter-wired-to-deliver-the-hygiene-marker-yoo-dev) — (`9d2f6f6`)
- Add `.claude-plugin/marketplace.json` so the plugin is installable via `claude plugin install` (`bd27e79`)
- Port `/kkamak:init` and its token-free CLI (`8634216`)

### Changed

- Bump version to 0.4.0 across the four version sites, add publisher metadata to the manifest (`aec2886`)
- Rewrite the README CC-first with a real install path and a write-surface statement; split the opencode adapter docs into `docs/opencode.md` (`afbd9f2`)

### Fixed

- Sensor contract conformance per the frozen `SensorLine` contract (phase 0). [dogfood log](docs/dogfood-log.md#2026-07-30--sensor-contract-conformance-fix-phase-0-meta-harness-43-build) — (`ead09d5`)

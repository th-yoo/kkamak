# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Details for each entry live in [`docs/dogfood-log.md`](docs/dogfood-log.md), linked per entry below.

## [0.4.0] - 2026-08-01

### Added

- Adopt `pluginVersion`/`forced` sensor fields, closing D1. [dogfood log](docs/dogfood-log.md#2026-07-31--d1-closure-pluginversionforced-adopted-yoo-dev) — (`ad63d3b`)
- Implement real `gate.json` `marker` (hygiene notice), correcting an earlier misreading. [dogfood log](docs/dogfood-log.md#2026-07-31--real-marker-mechanism-implemented-correcting-an-earlier-misreading-yoo-dev) — (`65c9546`)
- Deliver `GateDecision.marker` in the Claude Code adapter. [dogfood log](docs/dogfood-log.md#2026-07-31--cc-adapter-wired-to-deliver-the-hygiene-marker-yoo-dev) — (`8e23103`)
- Deliver `GateDecision.marker` in the opencode adapter. [dogfood log](docs/dogfood-log.md#2026-07-31--opencode-adapter-wired-to-deliver-the-hygiene-marker-yoo-dev) — (`9d2f6f6`)
- Add `.claude-plugin/marketplace.json` so the plugin is installable via `claude plugin install` (`bd27e79`)
- Port `/kkamak:init` and its token-free CLI (`8634216`)
- Bump version to 0.4.0 across the four version sites, add publisher metadata to the manifest (`aec2886`)
- Rewrite the README CC-first with a real install path and a write-surface statement; split the opencode adapter docs into `docs/opencode.md` (`afbd9f2`)

### Fixed

- Sensor contract conformance per the frozen `SensorLine` contract (phase 0). [dogfood log](docs/dogfood-log.md#2026-07-30--sensor-contract-conformance-fix-phase-0-meta-harness-43-build) — (`ead09d5`)

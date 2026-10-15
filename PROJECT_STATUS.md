# Qbexel Capture Studio — project status

Working name: **Qbexel Capture Studio**, built on the MIT-licensed OpenScreen
codebase (continuation maintained at github.com/getopenscreen/openscreen).
Branch: `qbexel/main`, forked from upstream `main` at commit `b149c55`
(2026-10-15, v2.1.0-rc.1 era).

This file is the single place that says what is done, what is verified, what
is known to be broken or missing, and what comes next. It is updated at the end
of every milestone.

## Environment this work was done in

- Linux x86_64 container, 4 CPU, 15 GB RAM, no GPU, no display (Xvfb available),
  no audio devices, no webcam. Root user.
- Node 22.22.0, npm 10.9.4, Rust 1.97, FFmpeg 6.1.1, Python 3.13.
- **Native binaries are absent** (`electron/native/bin/` is gitignored and not
  built here): no compositor addon, no capture helpers, no Whisper server. So
  nothing that renders a frame, records a screen or transcribes audio can be
  run in this environment. Those paths are verified by unit tests and code
  reading only, and every claim below says which.
- The Electron CLI does run headlessly here: `xvfb-run -a npx electron . --no-sandbox <cmd>`.

## Baseline of the upstream code (verified 2026-10-15, before any change)

| Check | Command | Result |
|---|---|---|
| App typecheck | `npx tsc --noEmit` | pass |
| Test typecheck | `npx tsc -p tsconfig.test.json --noEmit` | pass |
| Lint | `npm run lint` | pass, 26 pre-existing warnings, 0 errors |
| Unit tests | `npm run test` | 349 files, 4894 passed, 2 skipped, 202 s |
| Renderer + main bundle | `npx vite build` | pass (main bundle 4.25 MB) |
| Headless CLI | `electron . --no-sandbox info <v8 project> --json` under Xvfb | pass, exit 0 |
| Rust compositor | `cargo check -p openscreen-compositor` | fails against distro FFmpeg 6.1 (two `swr_convert` signature changes vs the pinned 8.1 tree); not a code defect, see ARCHITECTURE.md §5 |

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Inspect codebase, verify licence, architecture report | **done** — `ARCHITECTURE.md`, `docs/qbexel/design-notes.md` |
| 2 | Recording workflow, safe persistence, recovery | in progress |
| 3 | Editing timeline and export pipeline | pending |
| 4 | Creative presets, cursor effects, editable zooms | pending |
| 5 | Transcription and AI Tutorial Director | pending |
| 6 | Privacy Guardian and redaction workflow | pending |
| 7 | Multi-format compositions and publishing presets | pending |
| 8 | CLI and MCP interfaces | pending |
| 9 | Adversarial review, benchmarks, packaging | pending |

## Backlog (needs a Windows/macOS device, native binaries or compositor work)

- Scroll-wheel and right/middle-click telemetry in the three capture helpers.
- Selectable capture frame rate and resolution exposed in the HUD and CLI.
- System-audio level meter (helpers emit no level events today).
- Freeze frames, true scene transitions, animated arrows (compositor shader modes).
- A second video lane / overlay track (compositor timeline walk).
- Fragmented MP4 on Linux (crash-safe recording parity).
- Windows and macOS end-to-end passes and export benchmarks (`technical-documentation/testing/manual-e2e-checklist.md`).
- Licence notice gaps found in M1: Linux/macOS FFmpeg libraries and the symbol
  rename, `cpp-httplib` and `nlohmann/json` in the Whisper helper, the PipeWire
  helper's crates, wallpaper provenance.

## Next steps

1. M2: branding module and i18n interpolation; neutralise upstream telemetry
   token and update feed; recording shortcuts; session event markers; orphan
   take recovery; mid-take disk watch; permission guidance; countdown setting.

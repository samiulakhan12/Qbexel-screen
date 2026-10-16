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
| 2 | Recording workflow, safe persistence, recovery | **done** (see below) |
| 3 | Editing timeline and export pipeline | in progress |
| 4 | Creative presets, cursor effects, editable zooms | pending |
| 5 | Transcription and AI Tutorial Director | pending |
| 6 | Privacy Guardian and redaction workflow | pending |
| 7 | Multi-format compositions and publishing presets | pending |
| 8 | CLI and MCP interfaces | pending |
| 9 | Adversarial review, benchmarks, packaging | pending |

## Milestone 2 — what was built and how it was verified

All verification here is unit tests, typecheck, lint, locale parity and a
Vite bundle build; nothing in this milestone could be exercised against a real
capture on this machine (see the environment note above).

| Change | Where | Verified by |
|---|---|---|
| Branding from one file: product name, app id, executable, copyright, website, update feed, telemetry token | `branding.json`, `src/lib/branding.ts`, `electron-builder.json5`, `package.json` | `src/lib/branding.test.ts` checks the builder and package config agree with `branding.json`; locale strings interpolate `{{product}}` (i18next default variables) and a test asserts no locale value hard-codes the upstream name |
| Upstream PostHog token, GitHub release feed and star prompt neutralised while `branding.json` names none | `electron/usage-ping.ts`, `update-checker.ts`, `star-prompt.ts`, `main.ts` | existing tests parameterised; menu entries hidden when no repository |
| Global hotkeys: start/stop (Ctrl/Cmd+Shift+R), pause/resume (Ctrl/Cmd+Shift+P), configurable | `electron/globalShortcut.ts`, `src/lib/shortcuts.ts`, HUD hook | `electron/globalShortcut.test.ts` (registration, refusal keeps old binding, duplicate accelerator refused) |
| Take journal: in-progress marker + start/pause/resume/stop events in `.session.json` | `electron/recording/takeJournal.ts`, wired in `electron/ipc/handlers.ts` for Windows, macOS, Linux native capture | `takeJournal.test.ts` (13 tests: two clocks, pauses, discard, scan, recover, forget) |
| Interrupted-take recovery offered by the HUD at launch | `useInterruptedTakesNotice.ts`, IPC `scan/recover/forget-interrupted-take` | unit tests on the scan/recover logic; path validation against the recordings folder |
| Countdown length preference (off/3/5/10 s) | `src/lib/countdown.ts`, `electron/app-settings.ts`, `RecStage.tsx`, `useScreenRecorder.ts` | `countdown.test.ts`, settings store tests, RecStage tests |
| Disk-space watch during a take: warn at 500 MB, stop at 100 MB | `electron/recording/diskSpaceWatch.ts`, `electron/main.ts` | `diskSpaceWatch.test.ts` (fake timers) |

Known limitations of M2: the browser-capture fallback (Linux without the
PipeWire helper) is not journaled; translations of the new strings are English
in all 15 locales pending translation; recovery of a macOS take whose
fragmented file needs the salvage pass goes through the plain manifest path
(the editor's open then reports an unreadable file rather than salvaging).

## Backlog (needs a Windows/macOS device, native binaries or compositor work)


- Scroll-wheel and right/middle-click telemetry in the three capture helpers.
- Permission guidance window for Windows and Linux (today only macOS has one).
- Microphone level meter while recording (today only before), and a system-audio meter.
- Mute ranges on recorded audio: the schema field exists, but muting in preview and export needs a gain envelope in the compositor.
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

1. M3: split clip at the playhead; fps-aware frame step; SRT/WebVTT export in
   the dialog, the CLI and MCP; rolling project backups.

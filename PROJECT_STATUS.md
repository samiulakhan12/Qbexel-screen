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
| 3 | Editing timeline and export pipeline | **done** (see below) |
| 4 | Creative presets, cursor effects, editable zooms | **done** (see below) |
| 5 | Transcription and AI Tutorial Director | **done** (see below) |
| 6 | Privacy Guardian and redaction workflow | in progress |
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

## Milestone 3 — what was built and how it was verified

Same verification channel as M2 (unit tests, `tsc`, Biome, locale parity,
Vite build) plus the headless CLI under `xvfb-run -a npx electron . --no-sandbox`.
Rendering and export themselves need the Rust compositor binaries, which are
absent here; the Rust sources were not changed.

| Change | Where | Verified by |
|---|---|---|
| Split clip at the playhead (Ctrl/Cmd+B, chat/MCP tool `splitClip`). The right half carries a `cut` marker so the timeline does not fold the halves back together; moving a half clears the marker | `src/lib/ai-edition/document/timeline.ts` (`splitClipAt`, `clipAtRawSec`), `useTimeline.ts`, `electron/ai-edition/agent-tools.ts`, `deep-agent/service.ts` | `document/splitClip.test.ts` (7 tests: both halves keep source ranges, trims clamp per half, 40 ms minimum piece refused, moved halves fold again), tool parity tests |
| Frame step follows the project frame rate instead of a fixed 30 fps | `src/lib/frameStep.ts`, `NewEditorShell.tsx` | `frameStep.test.ts` |
| Subtitle sidecar on export (SRT, programme time after trims and speed regions) and the CLI command `qbexel subtitles <project> --format srt\|vtt` | `src/lib/ai-edition/captions/subtitles.ts`, `ExportDialog.tsx`, IPC `write-export-sidecar`, `electron/cli/args.ts`, `projectCommands.ts` | `subtitles.test.ts` (8 tests), CLI arg/command tests; end-to-end run of the CLI on a fixture project produced valid SRT and WebVTT, a bad `--out` extension exits 2 |
| Rolling project backups (10 kept, at most one per minute) written beside the project before every save | `electron/ai-edition/project-backups.ts`, `document-service.ts` | `project-backups.test.ts` |

Known limitations of M3: the `.srt` sidecar in the dialog is written after the
compositor reports the export done, so a failed export writes no sidecar (by
design) but a successful export whose sidecar write fails only shows a toast;
WebVTT in the dialog is CLI-only for now; the export itself was not run here.

## Milestone 4 — what was built and how it was verified

| Change | Where | Verified by |
|---|---|---|
| Five bundled, read-only style themes (Clean documentation, Modern SaaS, Cinematic dark, Editorial, Playful creative) merged into the presets menu; may be set as default for new projects, cannot be renamed or deleted | `src/lib/ai-edition/bundledStylePresets.ts`, `electron/ai-edition/style-preset-service.ts`, `StylePresetsMenu.tsx` | `bundledStylePresets.test.ts` validates every theme through the preset file parser; service tests (`BUILT_IN` refusal); `EditorTopBar.stylePresets.test.tsx` |
| Intro and outro title cards added from the Effects pane at the playhead (text annotation on a dark plate, intro rises, outro fades) | `src/lib/ai-edition/titleCards.ts`, `useTimeline.addTitleCard`, `RightPanes.tsx` | `titleCards.test.ts`; `documentWriteAudit.test.ts` lists the new writes |
| Bundled shader effects: Spotlight (follows the cursor) and Focus vignette, added as time ranges at the playhead | `src/lib/ai-edition/bundledEffects.ts`, `useTimeline.addBundledEffectAtPlayhead` | `bundledEffects.test.ts` validates against the shader-effect schema and refuses overlapping ranges |

Known limitations of M4: the WGSL of the two bundled effects is validated by
schema only, it was not compiled by the compositor on this machine (no GPU, no
binaries); title cards are text annotations rather than full-frame scene clips,
so they overlay the recording rather than replacing it; the "editable zooms"
part of this milestone relies on the upstream zoom regions and auto-zoom
suggestions, which were inspected but not changed. Translations of new strings
are English in all 15 locales pending translation.

## Milestone 5 — what was built and how it was verified

Transcription itself is upstream's whisper.cpp pipeline and was not changed; its
unit tests pass here, but no transcription ran on this machine (no helper
binary, no model). Everything below is verified by unit and jsdom tests, `tsc`,
Biome, locale parity and a Vite build; no model was called (the LLM pass is
exercised through an injected stand-in).

| Change | Where | Verified by |
|---|---|---|
| `storyboard` on the document: scenes (observed events and inferences kept apart), typed suggestions with review status | `src/lib/ai-edition/schema/index.ts` | schema parse in `director/analyze.test.ts` and `apply.test.ts` |
| Deterministic Director analysis: scenes from speech pauses / click gaps, silence, lead-in, tail and retake cuts, zooms from the upstream click planner, callouts, intro/outro cards; review decisions carried over by fingerprint | `src/lib/ai-edition/director/{analyze,storyboard,toolCalls}.ts` | `analyze.test.ts` (19 tests), `storyboard.test.ts` (10) |
| Optional model pass: strict Zod reply, unknown ids dropped, 60 s timeout, abort, token usage; only titles and summaries, never times or events | `electron/ai-edition/director/enrich.ts` | `enrich.test.ts` (8 tests, injected model) |
| Apply through the agent tools (`addTrim`, `addZoom`, `addAnnotation`, new `addTitleCard`), refusals recorded per suggestion | `electron/ai-edition/director/apply.ts`, `agent-tools.ts` | `apply.test.ts` (4), tool parity tests, MCP server tests |
| Bridge actions `director.analyze` / `director.apply`, telemetry read from the cursor sidecar, payload validation | `contracts.ts`, `client.ts`, `browserShim.ts`, `aiEditionService.ts`, `nativeBridge.ts` | bridge tests; `tsc` on the contract union |
| Director facet: analyse with per-run consent toggle, stale banner, approve/reject/apply, approve all, Remove silences, clear with confirmation, seek from scenes and events | `StoryboardPane.tsx`, `useStoryboard.ts`, `FloatingInspector.tsx` | `StoryboardPane.test.tsx` (7 jsdom tests), `documentWriteAudit.test.ts` rows |
| Chat Stop button and 120 s stall watchdog; turns resolve as `cancelled` | `chat-service.ts` (`cancelChat`), `deep-agent/service.ts` (AbortSignal into `streamEvents`), `LeftPanel.tsx`, `chat.cancel` bridge action | `chat-service.cancel.test.ts` (5 tests) |

Known limitations of M5: the Director's scene titles and inference texts from
the heuristics are English; the LLM pass writes in the narration's language.
No end-to-end run with a real recording, telemetry file or model happened here.
The chat's approve-before-apply is upstream's `allowAgentEdits` switch (the
agent must ask; writes are refused in the executor) — there is no per-edit
confirmation dialog in the chat panel. Per-task model selection is not built:
the Director's model pass uses the chat's configured provider and model. Token
usage of the Director pass is returned over the bridge but not yet shown in the
pane (only the model name is).

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

1. M6 Privacy Guardian: `privacy` field, pattern + OCR (tesseract.js) scan of
   sampled frames in the main process, findings → blur annotations through
   `addAnnotation`, export gate ("review findings before export"), post-export
   re-scan report.
2. M7 compositions and export presets; M8 CLI `qbexel storyboard` / `privacy
   scan` and MCP `director.*` / `privacy.*` tools with strict schemas; M9 review.

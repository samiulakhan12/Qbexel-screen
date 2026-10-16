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
| 6 | Privacy Guardian and redaction workflow | **done** (see below) |
| 7 | Multi-format compositions and publishing presets | **done** (see below) |
| 8 | CLI and MCP interfaces | **done** (see below) |
| 9 | Adversarial review, benchmarks, packaging | **done** (see below) |

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

## Milestone 6 — what was built and how it was verified

| Change | Where | Verified by |
|---|---|---|
| `privacy` review on the document: one scan, masked findings with boxes or spoken times, decisions, a "reviewed" mark bound to the timeline | `src/lib/ai-edition/schema/index.ts` | schema parse in the scan and apply tests |
| Detectors with masked previews: key prefixes, JWT, bearer, secret assignments, credential URLs, private keys, emails, Luhn cards, IBAN checksums, phones, IPs, high-entropy runs | `src/lib/ai-edition/privacy/patterns.ts` | `patterns.test.ts` (11 tests incl. false-positive cases) |
| OCR words → findings with frame-relative boxes; merge across frames; transcript findings; decision carry-over | `findings.ts` | `findings.test.ts` (8) |
| Export gate state and review helpers; blur placement per run and per clip | `review.ts`, `blur.ts` | `review.test.ts` (10) |
| Frame sampling with ffmpeg (bounded, timeout, abort), tesseract.js engine (local, cached model), scan orchestration with partial results, post-export file check | `electron/privacy/{frames,ocr,scan}.ts` | `scan.test.ts` (7, injected sampler/engine); **end-to-end** `privacy.e2e.test.ts` with real ffmpeg + tesseract on a synthetic recording: email and `sk-live-…` key found, masked, boxed, blurred (run here, 2 tests passed) |
| Accepted findings → mosaic blur annotations through `addAnnotation`/`executeAgentTool` | `electron/privacy/apply.ts` | `apply.test.ts` (4) |
| Bridge domain `privacy` (status, scan + progress channel, cancel, apply, scanFile with path validation) | `contracts.ts`, `client.ts`, `browserShim.ts`, `privacyService.ts`, `nativeBridge.ts`, `preload.ts` | bridge tests, `tsc` |
| Privacy facet: scan/stop/progress, machine status, masked findings, Blur/Dismiss/jump, Blur all, Mark as reviewed | `PrivacyPane.tsx`, `usePrivacy.ts`, `FloatingInspector.tsx` | `PrivacyPane.test.tsx` (4 jsdom tests); audit rows |
| Export gate: state line, first click stopped on undecided or stale findings, Review findings / Export anyway, optional check of the exported file with a report | `ExportDialog.tsx`, `NewEditorShell.tsx` | `ExportDialog.privacyGate.test.tsx` (3) |

Known limitations of M6: English OCR only; the OCR model (5 MB) is downloaded once on
first scan unless `resources/ocr/eng.traineddata` is shipped with the build (not
committed to the repository); a scan samples the recording (every 2 s, sparser past 120
frames), so text shown briefly between samples can be missed — the pane says so; the
password-field heuristic from the design (detecting masked input fields) is not built,
and keyboard input is never recorded by the capture helpers in the first place. The
transcript scan flags spoken values but cannot blur them; the user cuts them in the
transcript pane.

## Milestone 7 — what was built and how it was verified

| Change | Where | Verified by |
|---|---|---|
| `compositions` on the document: frame, fill, padding, caption placement, safe area and export settings per deliverable | `src/lib/ai-edition/schema/index.ts` | schema parse of every preset in `compositions.test.ts` |
| Presets (YouTube, Shorts/Reels, Square, Docs GIF, LinkedIn), the one transform `documentForComposition`, export plan and file naming, safe-area helpers | `src/lib/ai-edition/compositions/{presets,apply,exportPlan,safeArea}.ts` | `compositions.test.ts` (9 tests: presets validate and copy, transform touches only what it names, lookups, plan defaults, names, captions clear safe areas) |
| Compositions facet with per-row editing, guides, preview-in-project, export, export all, remove | `CompositionsPane.tsx`, `useCompositions.ts`, `safeAreaGuide.ts`, `SafeAreaGuides.tsx` (over the preview frame), `FloatingInspector.tsx` | `CompositionsPane.test.tsx` (5 jsdom tests); audit rows |
| Export dialog: a composition presets the controls and the file name; a batch writes one file per composition beside the chosen one, each with its own frame and container | `ExportDialog.tsx`, `NewEditorShell.tsx` | `ExportDialog.compositions.test.tsx` (2 tests: single GIF composition; batch of three with 16:9/9:16 frames and sibling paths); the existing dialog tests still pass |
| CLI `export --composition <id|name>` | `electron/cli/args.ts`, `src/cli/CliExportRunner.tsx`, `src/lib/cliContracts.ts` | `args.test.ts`; the runner itself needs the compositor (not runnable here) |

Known limitations of M7: a composition changes placement, not caption style; the batch
stops at the first failure and reports which composition failed; safe-area guides are
drawn by the preview only (never exported) and nothing warns when a zoom or annotation
crosses them; the export itself was not run here (no compositor binaries).

## Milestone 8 — what was built and how it was verified

| Change | Where | Verified by |
|---|---|---|
| CLI `storyboard`, `privacy scan`, `validate` (plus M7's `export --composition`) with usage, exit codes 0/1/2/3, `--dry-run` and `--json` | `electron/cli/args.ts`, `projectCommands.ts`, `cliMain.ts` | `args.test.ts`; `projectCommands.test.ts` (storyboard analyse + apply cut, dry run, privacy transcript scan masked + exit 3, validate healthy/broken); **headless runs** here under Xvfb: `validate` (exit 0, `ok: true`), `storyboard --dry-run` (scenes and suggestions printed), `privacy scan --no-ocr` (card number masked, exit 3 with `--fail-on-findings`); `privacy scan` with real OCR on the synthetic recording (6 frames read; email, `sk-live…` key and the spoken card number found, all masked). That run first failed — tesseract.js inlined into the ESM main bundle has no `__dirname` — and passed once the package was left external to the bundle (`vite.config.ts`) |
| Privacy scan decoupled from Electron: the ffmpeg path is passed in, so `electron/privacy/*` and the CLI commands import no Electron module | `frames.ts`, `scan.ts`, `privacyService.ts`, `nativeBridge.ts`, `handlers.ts` | tsc; the CLI tests run in plain Node |
| MCP tools `getStoryboard`, `analyzeStoryboard`, `applyStoryboard`, `getPrivacyFindings`, `scanPrivacy`, `applyPrivacyFindings`, `listCompositions`, `addComposition`, `exportSubtitles`, `validateProject`, under the edit switch, checkpoint rule and revision guard | `electron/mcp/qbexel-tools.ts`, `openscreen-mcp-server.ts`, deps in `handlers.ts` | `qbexel-tools.test.ts` (10 tests incl. path policy: outside dir refused, `..` escape refused, unconfirmed refused, existing file refused unless overwrite); `openscreen-mcp-server.test.ts` roster |
| Shared project validator | `src/lib/ai-edition/document/validate.ts` | CLI and MCP tests |

Known limitations of M8: `scanPrivacy` over MCP sends no progress notifications and
can take a minute on a long recording; the CLI exports one composition per run;
`qbexel mcp` (stdio, beside the app) has no OCR setup unless the app runs — it scans the
transcript only and says so in the result.

## Milestone 9 — review, benchmarks, packaging, documentation

| Change | Where | Verified by |
|---|---|---|
| Adversarial review of every new input path (bridge payloads, MCP arguments, CLI flags, file paths) with findings and fixes | `docs/qbexel/security-review.md` | the `chat.cancel` payload guard it added is covered by the bridge tests; the other two findings were fixed in M8 |
| Security model of the AI features | `SECURITY.md` (new section; upstream's reporting policy kept, marked as upstream's) | — |
| How the project is verified, what was verified here, benchmarks, what cannot be verified here | `TESTING.md` | numbers from `npx vitest bench --run` on the two `*.bench.ts` files |
| Benchmarks | `src/lib/ai-edition/director/analyze.bench.ts`, `privacy/patterns.bench.ts` | Director 2 ms (5 min) / 37 ms (30 min); detectors 4 µs per line, 3.5 ms for a full scan's text; OCR ~0.3 s per 1280×720 frame |
| Packaging: tesseract.js external to the main bundle and shipped unpacked; OCR model location; ffmpeg requirement | `vite.config.ts`, `electron-builder.json5`, `technical-documentation/engineering/build-and-packaging.md` | the headless CLI OCR run passes with the externalised package; the Windows installer below packaged it without complaint |
| Windows x64 installer built and published from this repository: a workflow that compiles the whisper helper and the installer in one run on `windows-latest` and publishes installer, blockmap, checksum and build log to a prerelease | `.github/workflows/qbexel-windows-installer.yml`, README "Installing Qbexel Capture Studio", packaging guide | run 1 (2026-10-16) succeeded end to end: `Qbexel Capture Studio.Setup.2.0.0-x64.exe`, 192.8 MB, prerelease `build-2.0.0-1`; electron-builder's `before-pack` guards passed on the real payload. Not installed or run on a Windows machine here |
| Notices for Tesseract (engine, WebAssembly core, language data) | `THIRD-PARTY-NOTICES.md` | — |
| README for Qbexel Capture Studio with the OpenScreen attribution kept; CLI reference; architecture addendum | `README.md`, `docs/cli.md`, `ARCHITECTURE.md` §10 | — |

## Where things stand

All nine milestones are implemented and documented. The branch `qbexel/main` holds one
commit per milestone (plus documentation commits); every commit passed the full unit
suite, both typechecks, Biome and the locale check at the time it was made. Nothing in
this environment could record, render, export or transcribe, so those paths are verified
by unit tests and headless CLI runs only — `TESTING.md` says exactly which, and how to
verify the rest on a real machine.

## How to continue

1. On a Windows or macOS machine with the native binaries: run
   `technical-documentation/testing/manual-e2e-checklist.md`, plus the Qbexel items in
   `TESTING.md` ("What cannot be verified here").
2. Install the published Windows x64 installer (prerelease `build-2.0.0-1`, or a newer run
   of the "Qbexel Windows installer" workflow) on a Windows machine: first launch, a
   recording, the compositor preview, transcription, and `privacy scan` from the installed
   executable to confirm the unpacked tesseract.js loads; optionally ship
   `resources/ocr/eng.traineddata`. Build macOS and Linux installers (`npm run build:mac`,
   `npm run build:linux`) on those platforms.
3. Point `branding.json` at the vendor's repository and update feed, and `SECURITY.md`'s
   reporting link at the vendor's channel.
4. Work the backlog below, highest value first: translations of the new strings, a Stop
   for the Director's model pass, per-composition caption style, CLI batch export.

## Backlog

Needs a Windows/macOS device, native binaries or compositor work unless noted.


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
- Upstream's `build.yml` still names installers `Openscreen.Setup.*` / `Openscreen-Mac-*` / `Openscreen-Linux-*` and stages the whisper helper from this repository's own `build-whisper-stt.yml` runs, so its full matrix (Windows arm64, the Store package, macOS, Linux) does not run here yet; the Qbexel workflow covers Windows x64 only. Teach `build.yml` the branding's product name, or extend the Qbexel workflow to the other targets (no device needed).
- Code-sign the Windows installer (SmartScreen warns about the unsigned `.exe` today) and set `branding.json`'s `repository`/`updates` so the in-app updater reads this repository's releases (no device needed).
- Ship the OCR model (`resources/ocr/eng.traineddata`) in the installer and add more OCR languages.
- Translations: every string added in M2–M8 is English in all 15 locales (no device needed).
- A Stop button for the Director's model pass (bounded by its 60 s timeout today); MCP progress notifications for `scanPrivacy` (no device needed).
- Per-composition caption style, a thumbnail per composition, CLI batch export of all compositions (no device needed).
- Per-task model selection for the Director's model pass (uses the chat's provider today).
- Token usage of the Director's model pass shown in the pane (returned over the bridge already).
- Detect masked password fields visually (the design's `password-field` kind).
- Licence notice gaps found in M1: Linux/macOS FFmpeg libraries and the symbol
  rename, `cpp-httplib` and `nlohmann/json` in the Whisper helper, the PipeWire
  helper's crates, wallpaper provenance.

## Next steps

See "How to continue" above. There is no unfinished code path: every feature listed is
either verified as stated or recorded as not verifiable here.

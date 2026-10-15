# Qbexel Capture Studio — architecture report

Milestone 1 deliverable. Written against the OpenScreen codebase at commit
`b149c55` (2026-10-15), read in full before any application code was changed.
Where this report and the code disagree, the code wins; the upstream reference
documentation under [`technical-documentation/`](technical-documentation/README.md)
remains the authoritative description of the subsystems that were inherited,
and this report links into it rather than restating it.

Sections:

1. [Verdict: build on OpenScreen](#1-verdict)
2. [Codebase architecture](#2-codebase-architecture)
3. [Feature inventory against the product brief](#3-feature-inventory)
4. [Dependency and licence report](#4-dependency-and-licence-report)
5. [Platform capability matrix](#5-platform-capability-matrix)
6. [Reusable components and extension points](#6-reusable-components-and-extension-points)
7. [Feasibility of every proposed feature](#7-feasibility-assessment)
8. [Prioritised implementation plan](#8-prioritised-implementation-plan)
9. [What this environment can and cannot verify](#9-verification-limits-of-this-environment)

---

## 1. Verdict

**Extend OpenScreen; do not rewrite.** The repository is not the small
Electron/React recorder the brief assumes. At v2.0.0 (with v2.1.0-rc.1 under
test) it already contains:

- native capture on all three platforms (ScreenCaptureKit in Swift, Windows
  Graphics Capture in C++, PipeWire in Rust), with fragmented-MP4 crash safety,
  pause/resume, webcam, system audio and microphone mixing, and cursor telemetry
  written as a sidecar;
- a Rust compositor (57 k lines) that renders both the live preview and every
  export on Direct3D 11, Metal or wgpu/Vulkan with a CPU fallback, so preview
  and export are the same code path by construction;
- a single versioned Zod document (`AxcutDocument`, schema v8) with forward-only
  migrations, atomic writes, a bounded undo stack and clip-anchored modifiers;
- on-device Whisper transcription with word-level DTW timestamps, captions
  derived from the transcript, and caption translation;
- an LLM editing agent with 41 validated tools, served identically to the in-app
  chat, an HTTP MCP server and a stdio MCP server;
- a headless CLI (record, export, captions, info, pack, sources, mcp);
- 349 unit-test files (4894 tests), Playwright e2e specs, an LLM workbench, Rust
  tests and Swift tests, plus 27 architecture/engineering/testing documents.

The licence is MIT (copyright Siddharth Vaddem 2025 and OpenScreen contributors
2025-2026), with every bundled third-party component already inventoried in
`THIRD-PARTY-NOTICES.md`. Rewriting any of the native capture, rendering or
encoding would discard years of platform-specific bug fixes recorded in the
decision ledger, for no gain the brief asks for. The work is therefore to add
the product layer the brief describes on top of this foundation and to close
the specific gaps listed in section 3.

## 2. Codebase architecture

### 2.1 Process model

| Process | Code | Role |
|---|---|---|
| Electron main | `electron/` (97 k lines) | Window lifecycle, recording orchestration, document persistence (`ai-edition/document-service.ts`), STT server lifecycle, LLM agent runtime, MCP servers, CLI boot, IPC |
| Renderer (one SPA, five window types) | `src/` (130 k lines) | `editor`, `hud-overlay`, `source-selector`, `countdown-overlay`, notes; CLI runner pages (`cli-export`, `cli-record`, `cli-sources`, `cli-captions`) |
| Native capture helpers (child processes) | `electron/native/{wgc-capture,screencapturekit,pipewire-capture}` | Own capture, timing and encoding; speak NDJSON over stdio |
| Compositor addon (in-process napi) | `crates/compositor`, `crates/compositor-view-napi` | Preview frames and MP4/GIF export; `compositor_view.node` |
| Whisper helper (child process) | `electron/native/whisper-stt` | `whisper-stt-server`, HTTP on localhost, GPU via Metal/Vulkan |

Renderer and main talk through one typed channel, `native-bridge:invoke`
(`src/native/contracts.ts`, `electron/ipc/nativeBridge.ts`), plus a legacy
`window.electronAPI` surface retained for recording and file operations. A
browser shim lets the renderer boot in a plain browser for UI work.

### 2.2 The eleven subsystems the brief requires, mapped to the code

| Brief subsystem | Where it lives today | State |
|---|---|---|
| 1. Capture engine | `electron/native/*`, `electron/native-bridge/capture/`, `electron/windows.ts`, `src/hooks/useScreenRecorder.ts` | Complete, native on all platforms |
| 2. Audio and device management | helpers' mixers, `electron/recording/deviceNameMatching.ts`, `src/lib/{microphone,camera}Availability.ts` | Complete |
| 3. Cursor and interaction telemetry | `electron/native-bridge/cursor/`, `src/lib/cursorTelemetryBuffer.ts`, `<video>.cursor.json` sidecar | Complete for cursor, clicks, shapes; see §3.B for scroll/keyboard |
| 4. Media asset manager | `document.assets[]`, `electron/media/` (relinker, extension clips), `MediaStage` | Complete |
| 5. Project model and timeline | `src/lib/ai-edition/schema/index.ts`, `document/*.ts`, `timeline/timelineMap.ts` | Complete, versioned, migrated |
| 6. Editing engine | `document/timeline.ts`, `store/useTimeline.ts`, `store/undo.ts` | Complete |
| 7. Visual effects and scene composition | `src/native/sceneDescription.ts` → `crates/compositor` | Complete; themes are one factory preset plus user files |
| 8. Transcription and AI orchestration | `electron/stt/`, `electron/ai-edition/` | Complete for chat agent; no storyboard/director |
| 9. Export and encoding | `src/lib/exporter/`, `crates/compositor/src/{pipeline_*,gif_export,remux}.rs` | Complete; no subtitle files, no per-format compositions |
| 10. CLI and MCP server | `electron/cli/`, `src/cli/`, `electron/mcp/` | Complete for record/export; no project-editing CLI, no allowed-directory policy |
| 11. Preferences, permissions, security | `electron/permissions/`, `electron/app-settings.ts`, `llm-config-store.ts` (safeStorage), `mcp-settings-store.ts` | Complete |

### 2.3 The document model (what every feature hangs off)

`AxcutDocument` (`src/lib/ai-edition/schema/index.ts`, 1479 lines) is the single
source of truth. Its top-level fields: `project`, `assets[]`, `transcripts[]`,
`timeline {clips, trimRanges, …}`, `annotations[]` (text / image / arrow /
blur), `zoomRanges[]`, `shaderEffects[]`, `shaderEffectRanges[]`, `audioTracks[]`
and `legacyEditor` (the appearance envelope: wallpaper, frame, padding, cursor,
webcam layout, captions, speed regions, camera-fullscreen regions).

Rules that every addition must keep (from
[`decisions.md`](technical-documentation/architecture/decisions.md) and
[`timeline-model.md`](technical-documentation/architecture/timeline-model.md)):

- Modifiers are anchored to a clip in that clip's source time;
  `startMs`/`endMs` is a derived cache of the ruler span. `timelineMap.ts` is the
  only translator between the RAW ruler, SOURCE and COMPRESSED frames.
- Clips are contiguous. Migrations are forward-only. A field added as optional
  needs no schema bump; older builds drop it on save.
- The model never free-writes the document. Every machine edit is a validated
  tool call in `electron/ai-edition/agent-tools.ts` (`executeAgentTool`).
- Persistence is temp-file + fsync + rename, serialised per project
  (`document-service.ts`). A truncated file is rejected, never salvaged.
- Undo is a 50-deep in-memory snapshot stack; an agent turn is one undo step;
  MCP calls on the open project are one undo step each.

### 2.4 Rendering and export

`buildSceneDescription(document)` (`src/native/sceneDescription.ts`) projects
the document into a `SceneDescription` consumed by the compositor for the
preview (`NativeCompositorOverlay`) and for export (`exportMulti` in
`compositorViewService.ts`). The walk itself is `walk_composited_timeline`
(`crates/compositor/src/timeline_walk.rs`), shared by MP4, GIF and the
`renderFrames` call that MCP `getFrames` uses. Encoders: AMF/NVENC/QSV through
Media Foundation on Windows, VideoToolbox on macOS, VA-API or libopenh264 on
Linux, selected at runtime with a software fallback. H.264 only is offered;
H.265 is encodable but hidden. See
[`export-pipeline.md`](technical-documentation/architecture/export-pipeline.md)
and [`native-compositor.md`](technical-documentation/architecture/native-compositor.md).

### 2.5 Transcription

`SttManager` (`electron/stt/index.ts`) decodes with FFmpeg to 16 kHz mono,
chunks at ~90 s, posts to `whisper-stt-server`, and maps the result onto
`document.transcripts[]` with word-level timestamps (whisper.cpp DTW rewritten
to character granularity, then a CTC re-timing pass for English and French).
The model (`ggml-small-q8_0`, ~264 MB) is downloaded on first use, SHA-256
checked. Silence segments are part of the transcript (`kind: "silence"`), which
is what pause detection and "smart cuts" already read.

### 2.6 AI agent, MCP and CLI (from the dedicated survey)

- **Agent runtime**: LangChain `createAgent` (ReAct loop, `recursionLimit`
  1000), one agent per turn, no checkpointer. 41 tools in
  `OPENSCREEN_TOOL_NAMES`; arguments are validated twice (LangChain `tool()`
  zod schema, then `safeParse` inside `executeAgentTool`); the executor is
  synchronous and pure; async inputs (cursor track, auto-zoom plan, WGSL check)
  are prepared beforehand by `runDocumentTool` (`deep-agent/service.ts`).
- **Approval**: a pre-turn checkpoint per user message (in memory), the whole
  turn applied as one revision-guarded save (`applyAgentDocumentIfCurrent`),
  per-message rewind. There is **no approve-before-apply** step and no abort.
- **Providers**: `provider-registry.ts` lists anthropic, openai, google,
  mistral, openrouter, minimax, minimax-token-plan and openai-compatible (base
  URL; this is how Ollama/LM Studio are reached). Keys live in
  `llm-credentials.enc` (safeStorage; write fails rather than falling back to
  plaintext). The renderer sees only `{connected, authKind, credentialKind}`.
  **Missing**: cancellation/timeouts on the agent path, usage reporting,
  per-task model selection, structured-output validation for caption
  translation.
- **MCP**: one tool surface over three channels (in-app HTTP with bearer token,
  Host/Origin check and an **MCP edits** switch; `openscreen mcp` on stdio;
  an app channel over a Unix socket / named pipe that forwards stdio calls to
  the running app). Checkpoints (20, in memory) are required before editing a
  closed project; writes are refused if the file changed since the read.
  **Missing**: strict schemas (only `setEditorSettings` is `.strict()`), an
  allowed-directory list (`exportVideo` writes and `getFrames` reads any
  absolute path), per-action confirmation on stdio, `.max()` on array inputs
  (`setPointerTrack` events, `addTrims`, `addZooms`, `removeWords`).
- **CLI**: `export`, `record`, `sources`, `captions`, `info`, `pack`, `mcp`,
  NDJSON with `--json`, exit codes 0/1/2. File-only commands
  (`electron/cli/projectCommands.ts`) import no `electron` and are
  unit-testable. **Missing**: every project-editing command the brief lists
  (zooms, annotations, trims, presets, validate, storyboard, privacy).

The survey also found three places where the upstream docs lag the code
(`ai-agent.md` describes an older cap, automatic compaction and 25 tools;
`document-model.md` says per-turn undo is not implemented). They are noted so
nobody designs against the stale text.

## 3. Feature inventory

Status against the product brief, verified in source (not README prose).
Legend: **done** = implemented upstream, **partial** = exists with a named gap,
**gap** = absent. The "Plan" column names the milestone that closes a gap, or
"backlog" when it needs hardware this environment lacks (see §9).

### 3.A Recording studio

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Full display capture | done | `wgc_session.cpp`, `ScreenCaptureRecorder.swift`, `pipewire-capture/src/capture.rs` | — |
| Selected-window capture | done | `SourceSelector.tsx`, `windowHandle`/`windowId`; Linux uses the portal picker | — |
| Microphone selection | done | `HudDeviceSettings.tsx`, `deviceNameMatching.ts`; no native mic on macOS 13/14 | — |
| System audio | done | WASAPI loopback, SCK audio tap, PipeWire sink monitor; mixed into one AAC track | — |
| Webcam + PiP | done | native MF/DirectShow on Windows, Electron sidecar elsewhere | — |
| Level meters | partial | mic-only, before recording (`useAudioLevelMeter.ts`); no system-audio meter, none while recording | M2 (mic meter during recording is renderer-only) |
| Countdown, elapsed time | done | `countdownOverlay.ts`, `HudControls.tsx`; countdown fixed at 3 s | M2 (configurable) |
| Pause / resume / stop | done | `useScreenRecorder.ts`, helper stdin commands, tray Stop | — |
| Recovery of interrupted sessions | partial | fragmented MP4 salvage when the helper wedges at stop (`nativeMacCaptureSalvage.ts`, `nativeWindowsCaptureStop.ts`); no orphan scan after an app crash; Linux MP4 not fragmented | M2 |
| Permission guidance | partial | macOS permissions window; Windows/Linux only toasts | M2 (guidance copy) |
| Keyboard shortcuts while recording | gap | `globalShortcut.ts` registers only "bring app forward" | M2 |
| Selectable frame rate / resolution | gap | 60 fps and a 3840×2160 ceiling hardcoded in `useScreenRecorder.ts:36-52` | backlog (helper contracts accept fps; needs a real capture to verify) |
| Floating HUD | done | `LaunchWindow.tsx`, click-through poll, content protection | — |
| Notes and teleprompter | done | `NotesWindow.tsx`, `notesTeleprompter.ts` | — |
| Configurable save location | done | `recordingsDirManager.ts`, `recordingsLocationStore.ts`, UI in `RecStage.tsx` | — |
| Disk exhaustion / failure handling | partial | 500 MB pre-flight check (`diskSpaceCheck.ts`), stop watchdogs; nothing monitors space mid-take | M2 |
| "Saved only once persisted" | partial | helpers write to disk, manifest + sidecar written at stop; no explicit verification before the editor opens | M2 |

### 3.B Action-aware capture

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Cursor position | done | `CursorRecordingSample` (`src/native/contracts.ts:33`), `<video>.cursor.json` v2 | — |
| Clicks with button type | partial | contract allows right/middle/double; all three samplers record the **left** button only | backlog (native) |
| Scroll events | gap | no code | backlog (native) |
| Keyboard events (opt-in) | gap, by design | `input.rs` deliberately never reads keys; no keystroke overlay | not planned by default; see §7 |
| Start / pause / resume / stop markers | gap as stored data | pause ranges used to compact telemetry then discarded (`handlers.ts:1428`) | M2 (store in `.session.json`) |
| Audio / webcam sync metadata | partial | `webcamOffsetMs` → `asset.cameraTrack.offsetMs`; audio clock-anchored in the helper | — |
| Timestamps correct after pauses, trims, edits | done | telemetry stays in source time; `timelineMap.ts` maps RAW/SOURCE/COMPRESSED | — |
| Telemetry editable, not burned in | done | sidecar + editable cursor mode; `setPointerTrack` over MCP | — |

### 3.C Video editing studio

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Multiple video / audio tracks | partial | one sequential video lane + derived camera track; audio lane with stacking voiceover/music rows; no second video lane | backlog (compositor) |
| Import, trim, reorder, delete | done | `MediaStage.tsx`, `setClipSourceRange`, `moveClip`, `removeClip` | — |
| Split at playhead | gap | no op in `document/timeline.ts` | M3 (pure op: duplicate + two range sets) |
| Non-destructive | done | source never rewritten | — |
| Timeline zoom / scroll, undo / redo, shortcuts, waveforms | done | `V4Timeline.tsx`, `undoStack.ts` (50), `shortcuts.ts`, `audioPeaks.ts` | — |
| Frame-accurate seek | partial | step fixed at 1/60 s regardless of source fps (`frameStep.ts`) | M3 |
| Clip-level audio | partial | imported tracks: gain, mute, fades, loop; recorded clips: project gain only; `muteRanges` declared but unread | M3 (mute ranges on recorded audio) |
| Crop, aspect ratio | done | `clip.cropRegion`, 7 ratio presets + Original + Auto | — |
| Variable speed | done | 0.25–16×, atempo audio | — |
| Freeze frame | gap | — | backlog (compositor) |
| Transitions | gap | butt joins + 240-sample audio fade | backlog (compositor); M4 adds a document-level "fade through colour" via annotations where feasible |
| Text and image overlays | done | annotation text/image, 5 bundled OFL fonts + custom fonts | — |
| Arrows, shapes, callouts | partial | arrow (8 directions), blur/mosaic, text plate as callout; no rect/circle/highlight shape | M4 |
| Project resolution / fps | gap | derived at export from quality tier + clips | M7 (per composition) |
| Autosave, crash recovery | done / partial | write-through saves, atomic file; no backup copies, undo not persisted | M2 (rolling backups) |

### 3.D Creative visual engine

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Animated zoom / pan, cursor-follow camera | done | `zoomRanges`, `focusMode: "auto"`, 3D `rotationPreset`, `formatFollowCursor` | — |
| Cursor size / smoothing / click effects | done | `CursorVisualSettings`, 6 themed packs + default | — |
| Rounded frame, shadow, padding | done | `legacyEditor.{borderRadius,shadowIntensity,padding}` | — |
| Backgrounds | done | solid, gradient (+motion), 18 wallpapers, custom image, blur | — |
| Webcam layouts, device frames | done | PiP / stack / dual / none; window, laptop, phone, monitor in 3D | — |
| Text animations | done | 6 presets in `text_anim.rs` | — |
| Animated arrows / callouts | gap | figures drawn static | backlog (compositor) |
| Focus highlights / spotlight | gap as built-in | reachable through agent WGSL effects only | M4 (bundled WGSL "spotlight" effect, data not code) |
| Motion blur | done | velocity blur + cursor blur + depth of field | — |
| Scene transitions, intro / outro | gap | — | M4 (title cards via frame-space annotations); true transitions backlog |
| Reusable style presets | partial | `.openscreenpreset` files; **zero bundled** | M4 (five bundled themes) |
| Themes data-driven | partial | appearance is data; effect algorithms are fixed shader modes | — |

### 3.E Narration and transcription

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Transcription with word timestamps | done | whisper.cpp + character DTW + CTC re-timing | — |
| Editable captions, styling, position | done | transcript edits; `CaptionSettings` | — |
| Subtitle export | gap | no SRT/VTT writer | M3 |
| Transcript navigation, range cut | done | click-to-seek, Backspace cuts with `breatheCut` | — |
| Range mute | gap | `muteRanges` unread | M3 |
| Pause detection / silence removal | partial | `[silence]` tokens deletable; agent can cut; no one-click deterministic pass | M5 (deterministic, no LLM) |
| Voice-over recording | done | `AddAudioLayerDialog.tsx` | — |
| Retake narration | partial | new take per recording; no punch-in | M5 (storyboard scene retake = replace track span) |
| Fades, gain, music | done / partial | tracks yes; recorded clips have no fades | — |

### 3.F Privacy

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Blur / mosaic regions | done | annotation `blur`; follows zoom and 3D (`privacy_mask`) | — |
| Secret / PII detection | gap | — | M6 |
| OCR | gap | — | M6 (tesseract.js, offline) |
| Mask tracking / keyframes | gap | constant box per region | M6 (consecutive regions) |
| Pre-export privacy review | gap | dialog warns only about upscaling | M6 |
| Capture-time safeguards | done | HUD content protection, SCK window exclusion, hide desktop icons, no keystrokes | — |

### 3.G Multi-format publishing

| Brief item | Status | Evidence | Plan |
|---|---|---|---|
| Per-ratio compositions | gap | one `aspectRatio` per project | M7 |
| MP4 / GIF, hardware encode, CPU fallback | done | AMF/NVENC/QSV/MF, VideoToolbox, VA-API; libopenh264 fallback (none in practice on macOS) | — |
| Progress, cancel, staged output | done | `export_control.rs`, staged rename | — |
| Export presets | partial | fixed quality/fps choices, nothing named | M7 |
| Safe areas | partial | caption wrap column only | M7 |
| Independent framing / captions per format | gap | vertical defaults frozen on first write | M7 |
| No stretching | done | crop / scale / pad in `pickOutputDims` + `compositeLayout.ts` | — |

### 3.H Agent control (brief §8, §12, §13)

| Brief item | Status | Plan |
|---|---|---|
| Structured, validated AI edits | done (41 tools, Zod twice) | — |
| Approve-before-apply | gap | M5 (storyboard approval; per-turn approval toggle) |
| Storyboard / Tutorial Director | gap | M5 |
| Observed vs inferred separation | gap | M5 |
| Provider abstraction, user keys, local models | done (openai-compatible base URL) | — |
| Cancellation, timeouts, retries with limits | gap on the agent path | M5 |
| Usage visibility | gap | M5 (read `usage_metadata`) |
| Model per task | gap | M5 (director vs chat vs translation) |
| CLI project editing, validate, presets, privacy, storyboard | gap | M8 |
| MCP strict schemas, allowed dirs, bounded inputs | gap | M8 |
| Branding configurable | gap (hardcoded in ~15 config sites + 497 locale strings) | M2 |

## 4. Dependency and licence report

**Project licence.** MIT, two copyright holders (Siddharth Vaddem 2025;
OpenScreen contributors 2025-2026). `package.json` declares MIT; author Etienne
Lescot, contributor Siddharth Vaddem.

**npm (41 direct, 380 production packages in the lockfile).** Tally: MIT 346,
ISC 17, Apache-2.0 5 (`class-variance-authority`, `openai`, `@mistralai/mistralai`
and two more), BSD-3 4, BSD-2 1, 0BSD 2, MPL-2.0 1 (**`mediabunny`**, file-level
copyleft: unmodified, so the only obligation is to point at its source), Python-2.0
1 (`argparse`), Unlicense 1, BlueOak-1.0.0 1 (`sax`), undeclared 1
(**`web-demuxer`**: its LICENSE is MIT, but its WASM embeds FFmpeg under
LGPL-2.1+, already covered in the notices). `react-icons/fa6` brings Font
Awesome icons under CC BY 4.0 (one icon used); the attribution travels in the
generated `THIRD-PARTY-LICENSES.txt`. No GPL, AGPL, CC-BY-NC or proprietary
package anywhere in the production graph.

**Rust (213 crates in the addon).** 155 MIT-or-Apache, 26 MIT, 9 MIT/Apache/Zlib,
7 Apache-2.0, 5 Unlicense-or-MIT, and singletons listed in
`THIRD-PARTY-NOTICES.md`; `self_cell` is Apache-2.0 OR GPL-2.0 and is used under
Apache. **Gap**: the PipeWire helper is a second Cargo workspace (`ashpd`, `zbus`,
`evdev`, …) that the licence generator does not walk, so its crates appear in
neither notices file.

**Native third-party components and their obligations.**

| Component | Licence | Obligation kept by | Gap found |
|---|---|---|---|
| FFmpeg n8.1.2 (`9b6c8969e0`) | LGPL-2.1+ | dynamic linking, source offer, relink note, `assertLgpl()` fails closed | notices say "Windows only"; Linux ships **symbol-renamed** (`osff_*`) libraries and macOS ships a from-source build, neither described |
| web-demuxer WASM | MIT + LGPL (FFmpeg inside) | notices | — |
| whisper.cpp 1.9.1, ggml | MIT | notices | `cpp-httplib` and `nlohmann/json` (both MIT) pulled by CMake are not listed |
| ONNX Runtime 1.27.1 | MIT | SHA-256 + LICENSE check | notices say "not on Linux"; `build:linux` now fetches it |
| MediaPipe selfie segmentation weights | Apache-2.0 | notices (only copy users get) | the `.onnx` is a derived work; say so |
| Fonts Inter, Lora, Oswald, Caveat, IBM Plex Mono | SIL OFL 1.1 | `*-OFL.txt` beside each file | — |
| PipeWire 1.0.5 headers | MIT | `COPYING` vendored | — |
| Recordly snippets | MIT © 2026 webadderall | notices section | no file-level markers (acceptable) |
| Kenney UI Audio | CC0 | notices | — |
| MSVC runtime DLLs | VC Redist terms | notices | — |
| Wallpapers (18 JPEG) | **unknown** | — | no provenance recorded anywhere |

**What a rebrand to Qbexel Capture Studio must preserve.** `LICENSE` unchanged
(a Qbexel line may be appended, not substituted); `electron/about.ts`
`COPYRIGHT` and `electron-builder.json5` `copyright` kept byte-identical (a test
enforces it) and still naming OpenScreen contributors; the Recordly, FFmpeg
(extended to Linux/macOS), OFL, Apache and MPL notices; the `licenses:generate`
step and the `before-pack` gate that refuses to package without the generated
licence file. The source-request contact at the end of the notices becomes the
new distributor's. The upstream PostHog token in `electron/usage-ping.ts` and
the GitHub update feed in `electron-builder.json5` must be replaced or disabled;
shipping either under a new name would send another project's telemetry and
updates. Product-name sites: 15 configuration identifiers (app id, product name,
AppX identity, Flatpak id, Nix pname, MCP server name, CLI usage text, env
prefix `OPENSCREEN_`, settings keys) and 497 locale strings; `.openscreen` and
`.openscreenpreset` stay as file extensions for compatibility.

## 5. Platform capability matrix

Status words: **native** (implemented and exercised upstream), **fallback**,
**gap**, **untested** (upstream says so). File references are in the survey;
the authoritative per-platform text is
[`recording.md`](technical-documentation/architecture/recording.md) and
[`native-compositor.md`](technical-documentation/architecture/native-compositor.md).

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Display capture | native WGC (build ≥19041); `getDisplayMedia` fallback | native ScreenCaptureKit 13+; **no fallback** | native PipeWire portal; `getDisplayMedia` fallback (may yield no frames on Wayland) |
| Window capture | native | native (cursor-offset gap) | portal picker only; CSD shadow border; no cursor if pointer never enters |
| System audio | WASAPI loopback | SCK audio tap (14.2+ prompt) | PipeWire sink monitor |
| Microphone | WASAPI by name | **15+ only** | PipeWire by `node.description` |
| Webcam | native MF, DirectShow fallback, muxed | Electron sidecar | Electron sidecar |
| Cursor shape + position | native | native (+Accessibility) | portal `SPA_META_Cursor` |
| Clicks | left only | left only | left only, evdev (udev rule) |
| Scroll / keyboard | gap | gap | gap |
| Preview backend | D3D11; CPU = WARP | Metal; **no CPU fallback** | wgpu/Vulkan; CPU = lavapipe |
| Export encoder | AMF → NVENC → QSV (**untested on Intel**) → MF | VideoToolbox | VA-API; no NVENC |
| CPU encoder | libopenh264 | none in practice (ffmpeg built without it) | libopenh264 |
| Recording encoder | MF sink writer, hardware MFT; DXGI input opt-in | AVAssetWriter / VideoToolbox | VA-API → h264_vulkan → libopenh264 |
| GIF export | native | native | native |
| Whisper STT | x64 Vulkan (**untested since detection fix**), arm64 CPU | arm64 Metal, x64 CPU | x64 Vulkan (**untested**) |
| Webcam segmentation | x64 + arm64 | arm64 only | shipped; packaging untested |
| HUD content protection | 11 22H2+; older builds show the HUD in recordings | <26 via API; 26+ via SCK exclusion | not available |
| Auto-update | NSIS yes; Store no | DMG in /Applications | AppImage/deb/rpm/pacman; not Flatpak/Snap/Nix |
| Release architectures | x64, arm64 | arm64, x64 | x64 |
| Crash-safe recording | fragmented MP4 | fragmented MP4 | plain MP4 (not salvageable) |

**This machine** (Ubuntu 24.04, no GPU, no display, no audio): every TypeScript
check and the whole Vitest suite run; `vite build` runs; the Electron CLI runs
under Xvfb with `--no-sandbox`; the Rust compositor type-checks only against the
pinned FFmpeg 8.1 shared tree (against the distro's 6.1 it fails on two
`swr_convert` signature changes, which is an API-version mismatch, not a defect);
no capture, render, export or transcription can run.

## 6. Reusable components and extension points

Everything new is built on these, in this order of preference.

| Need | Reuse | Where to extend |
|---|---|---|
| A new document field | optional key on `documentSchemaShape` (no version bump; older builds drop it) | `src/lib/ai-edition/schema/index.ts`; `createEmptyDocument` untouched |
| A new region kind | the 11-step checklist in [`editor-shell.md`](technical-documentation/architecture/editor-shell.md#adding-a-region-kind) | `RegionKind` in `document/timeline.ts:47`, `removeRegion` `:1173`, `timelineMap`, `useTimeline`, `V4Timeline`, `FloatingInspector`, `sceneDescription`, `agent-tools` |
| A machine edit (AI, CLI, MCP) | `executeAgentTool` / `runDocumentTool` with the existing tools (`addZooms`, `addTrims`, `addAnnotation`, `setEditorSettings`, `setCaptionSettings`, …) | add a tool: `*Args` schema + `OPENSCREEN_TOOL_NAMES` + `MUTATING_TOOL_NAMES` + `case` in `agent-tools.ts`; `TOOL_ARG_SCHEMAS` + `TOOL_DESCRIPTIONS` in `deep-agent/service.ts`; it then appears over MCP and in the chat agent automatically, and `service.test.ts` / `openscreen-mcp-server.test.ts` pin the parity |
| Apply a machine-produced document in the editor | `applyAgentDocumentIfCurrent` (revision-guarded, one undo step) | `src/lib/ai-edition/store/agentDocumentApply.ts` |
| An inspector pane | `FACETS` + `FacetBody` | `src/components/ai-edition/v4/FloatingInspector.tsx:102`; i18n keys in `editor.json` across 15 locales (`npm run i18n:check`) |
| A CLI command that only touches files | `projectCommands.ts` pattern (no `electron` import) | `SUBCOMMANDS`, `CLI_USAGE`, `parseX`, `CliCommand` in `args.ts`; branch in `runCli` |
| A CLI command that needs rendering or capture | `CliRequest` variant + hidden runner | `cliContracts.ts`, `RUNNER_WINDOW_TYPES`, `App.tsx` switch, `src/cli/Cli*Runner.tsx` |
| An MCP-only tool | `PROJECT_TOOLS` / `createMediaTools().register` / standalone registration | `project-tools.ts`, `media-tools.ts`, `openscreen-mcp-server.ts`; update `DESTRUCTIVE_TOOLS` and `isReadOnly` in `app-channel.ts` |
| Talk to the configured LLM with a schema | `createOpenScreenChatModel` + `withStructuredOutput` / Zod | `deep-agent/chat-model.ts`, `llm-config-store.ts` for credentials |
| Click / pause analysis | `zoom-suggestions.ts` planner, `cursor-track.ts`, `[silence]` transcript segments, `cut-breath.ts` | pure modules under `src/lib/ai-edition/timeline/` |
| Caption text in programme time | `deriveCaptionCues` | `src/lib/ai-edition/captions/cues.ts` |
| A style theme | `StylePresetAppearance` + `stylePresetPatch` | `stylePresets.ts`, `stylePresetsEditor.ts`, `StylePresetsMenu.tsx` |
| Frame sampling from a file | FFmpeg already shipped and resolved by `electron/stt/extractAudio.ts`'s locator; `renderFrames` in the addon for composed frames | `electron/media/`, `compositorViewService.ts` |
| Design tokens, light/dark | `design/tokens/*.css`, `var(--accent)` etc. | consume, never hard-code colours |

## 7. Feasibility assessment

Every feature the brief proposes, with the route and the risk. "Here" means
this headless Linux environment; "device" means a Windows or macOS machine with
the native binaries, which the brief's own §15 requires for end-to-end claims.

| Brief feature | Feasible | Route | Risk / verification |
|---|---|---|---|
| Configurable branding | yes | `BRAND` module, i18next `defaultVariables`, builder config from one source | mechanical; verified by unit test + `i18n:check` here |
| Recording shortcuts (start/stop/pause) | yes | `globalShortcut` + existing HUD actions over IPC | logic testable here; real hotkey on device |
| Mic meter while recording, system-audio meter | partial | mic: renderer `AnalyserNode` on the live stream; system audio: helpers emit no level events today | system meter needs helper change (device) |
| Orphan-take recovery | yes | scan recordings dir for `.session.json` without a finished marker at startup; offer salvage/import | testable here with fixtures |
| Store start/pause/resume/stop markers | yes | add `events[]` to `.session.json` manifest | here |
| Selectable fps/resolution | partial | contract fields exist; HUD/CLI flag → helper request | needs device to verify output |
| Scroll / right-click telemetry | native change | WGC `WH_MOUSE_LL`, CGEvent, evdev `REL_WHEEL` | device only; backlog |
| Keyboard events | not by default | privacy stance; would need explicit opt-in + allow-list | deferred |
| Split clip | yes | pure document op (duplicate + two source ranges, modifiers re-anchored) | here |
| Frame-accurate step | yes | step = 1/asset fps | here |
| Mute ranges | yes | read `muteRanges` in `buildSceneDescription` → compositor gain envelope… | compositor side needed for export; **preview parity requires compositor change** → implement as document op + CLI/agent tool, flag render support as device-verified |
| Freeze frame, transitions, animated arrows | compositor | new shader modes / timeline walk changes in Rust | device only; backlog with design notes |
| Spotlight / focus highlight | yes | bundled WGSL effect through `shaderEffects` (data) | compile check needs addon; WGSL is validated by naga in tests upstream; device to confirm look |
| Intro / outro title cards | yes | frame-space full-frame text annotations + opaque plate | here (document), device (look) |
| Five bundled themes | yes | `StylePresetAppearance` data, read-only rows | here |
| Subtitle export (SRT/VTT) | yes | from `deriveCaptionCues` | here |
| One-click silence removal | yes | deterministic pass over `[silence]` segments → `addTrims` with `breatheCut` | here |
| Tutorial Director | yes | deterministic analyser + optional LLM enrichment with strict schema + apply via tools + approval UI | here (logic, schema, apply); LLM path with a key on device or mocked |
| Approve-before-apply for chat | yes | hold the turn's document, show diff summary, apply on accept | here |
| Agent cancellation / timeouts / usage | yes | `AbortSignal` through LangChain, `usage_metadata` | here (unit), live on device |
| Model per task | yes | `LlmConfig.models?: { chat, director, translate }` | here |
| Privacy Guardian | yes | FFmpeg frame sampling + tesseract.js OCR + patterns + blur annotations + export gate + post-export re-scan | pattern + OCR pipeline testable here on synthetic frames; post-export re-scan needs an export (device) |
| Mask tracking | approximated | consecutive blur regions per sample window | here |
| Compositions per ratio | yes | optional `compositions[]`, pure overlay transform, existing export | here (transform parity test); device (render) |
| Export presets, safe areas | yes | data table + preview guides + caption clamp | here |
| CLI editing / validate / storyboard / privacy / presets | yes | file-only commands + agent tools under Xvfb | here, end to end |
| MCP hardening | yes | `.strict()`, `.max()`, allowed-dir policy on `exportVideo`/`getFrames`/`importMedia`, confirm flag | here, unit tests |
| Windows build + e2e | no, here | CI workflows exist (`build.yml`) | device / CI only |
| Benchmarks | no, here | `rendering-performance.md` has the bench | device only |

## 8. Prioritised implementation plan

Order follows the brief's milestones, with each milestone sized to what can be
verified here and what must be handed to a device. The "core path" (record →
edit → export) is already reliable upstream, so the plan spends its effort on
the product layer and on hardening.

| # | Milestone | Scope | Verification |
|---|---|---|---|
| 2 | Recording and persistence | branding module + i18n interpolation + telemetry/update-feed neutralised; recording shortcuts; session event markers; orphan-take recovery scan; mid-take disk watch; permission guidance for Windows/Linux; countdown length setting | unit tests, `i18n:check`, typecheck |
| 3 | Timeline and export | split at playhead; fps-aware frame step; mute ranges (document + tools); SRT/WebVTT export in dialog, CLI, MCP; rolling project backups | unit tests; CLI under Xvfb |
| 4 | Creative presets | five bundled themes; intro/outro title cards; bundled spotlight WGSL effect; shape callouts (rect/rounded highlight as annotation style); preset apply over CLI/MCP | unit tests, snapshot of `SceneDescription` |
| 5 | Director | storyboard schema; deterministic analyser; LLM enrichment with strict schema; approval UI (facet); apply through tools; chat approve-before-apply; cancellation, usage, model per task; silence-removal pass | unit tests with fixture transcripts + telemetry; workbench cassette for the LLM step |
| 6 | Privacy Guardian | pattern table; OCR pipeline (tesseract.js); finding merge/tracking; privacy facet; export gate; post-export re-scan | unit tests on synthetic PNG frames generated with FFmpeg here |
| 7 | Compositions | schema; overlay transform; composition picker in preview and export; presets; safe-area guides | parity tests: same document + composition → same scene for preview and export |
| 8 | CLI and MCP | `validate`, `storyboard`, `privacy scan`, `preset apply`, `zoom list/add/remove`, `compositions list/export`, `captions --srt`; strict schemas, bounded arrays, allowed directories, confirmation flag; JSON + exit codes | CLI under Xvfb, MCP unit tests |
| 9 | Review and docs | security review of new surfaces, full suite, lint, `docs:check`; SECURITY.md, TESTING.md, README; backlog | all checks here; device checklist written for what cannot run here |

Backlog (needs a device or compositor work, recorded in `PROJECT_STATUS.md`):
scroll and right-click telemetry, selectable capture fps, system-audio meter,
freeze frame, true scene transitions, animated arrows, second video lane,
Linux fragmented MP4, Windows/macOS e2e and benchmarks.

## 9. Verification limits of this environment

What was run here and passed: `npx tsc --noEmit`, `npx tsc -p
tsconfig.test.json --noEmit`, `npm run lint` (26 pre-existing warnings),
`npm run test` (349 files, 4894 tests, 2 skipped), `npx vite build`, and the
Electron CLI `info --json` on a v8 project under Xvfb. What cannot run here:
anything that captures a screen, renders a frame, encodes video or transcribes
audio, because the native binaries are built on each platform's CI and are not
in the repository. Every later claim of "verified" in `PROJECT_STATUS.md`
names which of these two categories it belongs to.

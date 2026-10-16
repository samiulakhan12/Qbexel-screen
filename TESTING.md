# Testing

How Qbexel Capture Studio is verified, what each check proves, and what cannot be proved
on a machine without the native capture, compositor and speech binaries. A claim appears
in `PROJECT_STATUS.md` only when the check named here ran.

## The checks

| Check | Command | What it proves |
|---|---|---|
| Unit and component tests | `npx vitest run` | Every `*.test.ts(x)` under `src/` and `electron/`: pure logic, stores, panes (jsdom), the bridge, the MCP server over real HTTP, the CLI parser and commands in plain Node. 377 files / 5,100+ tests at the end of milestone 8. |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.test.json` | The renderer, the main process and the tests compile under `strict`. |
| Lint and format | `npx biome check .` | Biome's rules and import order; the pre-commit hook runs it on staged files. |
| Locale parity | `npm run i18n:check` | Every literal key the code asks for exists in `en`; the 14 other locales carry the same keys; the supported-locale lists agree. |
| Renderer and main bundles | `npx vite build` | The app bundles; `dist-electron/main.js` is what the headless CLI below runs. |
| Headless CLI | `xvfb-run -a npx electron . --no-sandbox <command>` | The packaged main process starts and the file-only commands run end to end: `info`, `subtitles`, `validate`, `storyboard`, `privacy scan`. |
| Privacy end to end (opt-in) | `QBEXEL_PRIVACY_E2E=1 QBEXEL_OCR_CACHE=<dir> npx vitest run electron/privacy/privacy.e2e.test.ts` | ffmpeg samples a synthetic recording, tesseract.js reads it, the detectors find the drawn email and API key, the blurs land through the agent tools. Needs ffmpeg and the English OCR model (downloaded once into `<dir>`). |
| Benchmarks | `npx vitest bench --run src/lib/ai-edition/director/analyze.bench.ts src/lib/ai-edition/privacy/patterns.bench.ts` | Timing of the Director's analysis and the privacy detectors (numbers below). |
| Rust compositor | `cargo check` in `crates/` | Needs the vendored FFmpeg 8 headers (`FFMPEG_DIR`); with the distro's FFmpeg 6 it fails on an API difference, which is a version mismatch, not a defect. Not run in CI here. |

## What was verified for the Qbexel work (milestones 1–9)

Everything listed in `PROJECT_STATUS.md` under "what was built and how it was verified"
passed the unit suite, the two typechecks, Biome and the locale check, and the Vite build.
In addition:

- **Headless CLI runs** on fixture projects under Xvfb: `subtitles` (SRT and WebVTT written,
  bad extension exits 2), `validate` (exit 0 on a healthy project, 3 with a dangling zoom
  anchor and missing media), `storyboard --dry-run`, `privacy scan --no-ocr` (spoken card
  number masked, exit 3 with `--fail-on-findings`), `privacy scan` with real OCR (6 frames
  read; email, `sk-live…` key and the spoken card number found, all masked).
- **Privacy end to end** with real ffmpeg and tesseract.js on a synthetic 1280×720
  recording: 2 tests passed.
- **MCP over HTTP**: the roster, each Qbexel tool's refusal with edits off, the path
  policy of `exportSubtitles` (outside an allowed directory, `..` escape, no `confirm`,
  existing file without `overwrite` — all refused).

### Benchmarks (this container, Node 22, no GPU)

| What | Result |
|---|---|
| Director analysis, 5-minute recording, clicks every second, ~750 words | 2.0 ms mean (491 ops/s) |
| Director analysis, 30-minute recording, ~4,500 words | 37 ms mean (27 ops/s) |
| Privacy detectors, one OCR'd line | 4 µs mean |
| Privacy detectors, 120 frames × 12 lines (a full scan's text) | 3.5 ms mean |
| OCR of one 1280×720 frame (tesseract.js, WebAssembly, measured once in the spike) | ~0.3 s after a ~0.5 s engine start |

A full privacy scan is therefore bounded by OCR: at most 120 sampled frames, so under a
minute on this machine; the sampler's own timeout is 120 s.

## What cannot be verified here, and how to verify it elsewhere

This container has no display, GPU, capture helpers, compositor addon, Whisper helper or
model. The following were **not** exercised and are documented as such in
`PROJECT_STATUS.md`:

- Recording (WGC, ScreenCaptureKit, PipeWire), pause/resume, the countdown overlay,
  the disk-space stop. Follow `technical-documentation/testing/manual-e2e-checklist.md`
  on Windows and macOS; the take journal's marker file (`<take>.inprogress.json`) can be
  checked by killing the app mid-take and relaunching.
- Preview and export rendering (compositor), including the two bundled WGSL effects,
  title cards on the frame, blur annotations placed by the Guardian, and compositions'
  9:16 / 1:1 / 4:5 output. Export one project per composition and inspect the frames
  (`exportVideo` + `getFrames` over MCP does this from an agent).
- Transcription (whisper.cpp) and the Director's model pass (needs a configured
  provider). The model pass is exercised through an injected stand-in in
  `electron/ai-edition/director/enrich.test.ts`.
- Packaging: the installer's inclusion of `tesseract.js` outside the asar
  (`electron-builder.json5`) and the optional `resources/ocr/eng.traineddata`. Build with
  `npm run build:<platform>` and run `privacy scan` from the installed executable.

## Writing tests for this codebase

See `technical-documentation/testing/writing-tests.md` for the conventions
(`// @vitest-environment jsdom` opt-in, mocking `@/native/client`, the project store's
`setState`). Two rules the Qbexel work added:

- Every new document write in the renderer is a row in
  `src/lib/ai-edition/store/documentWriteAudit.test.ts`, naming who triggers it.
- Every new agent tool is pinned by `electron/ai-edition/agent-tools.test.ts`
  (mutating set), `deep-agent/service.test.ts` (arguments) and the MCP roster test.

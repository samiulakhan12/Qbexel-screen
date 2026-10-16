# Security review of the Qbexel additions (milestone 9)

An adversarial pass over every input path added in milestones 2–8: what it accepts,
what it refuses, and what was changed as a result. Read with `SECURITY.md`, which states
the rules these paths implement.

## Rules every path obeys

1. **Machine edits are structured operations, never code.** The Director, the Guardian,
   the chat and the MCP all end in `executeAgentTool` with Zod-validated arguments. No
   path evaluates text as code; the only "code" an agent writes is a shader effect, under
   the compositor's own WGSL check, unchanged from upstream.
2. **The same validation as a manual edit.** `anchorForAgent`, clip resolution, clamping
   and refusals are the executor's; the panes call the same pure functions as the
   bridge; a refused tool call leaves the document untouched.
3. **Credentials stay in the main process.** The model pass reads the provider key from
   `LlmConfigStore` (OS keychain) and passes it to LangChain in memory; the storyboard
   records the provider and model names only. No bridge result, log, project file or
   MCP response carries a key (`enrich.test.ts` asserts the prompt does not either).
4. **Nothing leaves the machine without a choice.** OCR, detectors, the analyser and
   frame sampling are local. The only outbound calls are the Director's model pass
   (behind a per-run consent toggle; narration text and click counts, never frames) and
   the one-time download of the public OCR model (announced in the pane before the first
   scan; shippable offline via `resources/ocr/`).
5. **Secrets are never stored.** A privacy finding keeps a masked preview (`maskValue`),
   a kind, a confidence and boxes; the value is dropped at detection time.
6. **Keyboard input is never recorded.** The capture helpers record pointer position and
   clicks; there is no key telemetry anywhere in the code base, and the Guardian scans
   what is *shown*, not typed.

## Input paths

| Path | Validation | Review notes |
|---|---|---|
| Bridge `director.analyze` `{document, enrich?, outroText?}` | document re-parsed with `documentSchema`; `enrich` must be boolean; `outroText` string sliced to 200 | Telemetry read only for assets on the timeline, through the existing sidecar reader. The model pass has a 60 s timeout and an AbortSignal; its reply is parsed by a strict Zod schema (titles ≤ 80, summaries ≤ 300, unknown scene ids dropped). A hostile narration can at worst produce a wrong title. |
| Bridge `director.apply` `{document, suggestionIds}` | ids: 1–1000 non-empty strings ≤ 128 | Unknown ids are reported as skipped; each suggestion becomes one tool call; a refusal is recorded on the suggestion in the tool's words. |
| Bridge `privacy.scan` `{document, sampleEveryMs?}` | `sampleEveryMs` 500–60000; one scan at a time (a new one aborts the running one); frames ≤ 120; sampler timeout 120 s | ffmpeg is spawned with an argument array (no shell) on the asset's own path. OCR runs in a worker thread per scan and is terminated in `finally`. |
| Bridge `privacy.scanFile` `{path, durationSec?}` | absolute path; extension in `.mp4 .gif .mov .webm .mkv`; must exist and be a file; `durationSec` finite ≥ 0 | Read-only; result carries masked previews only. Reads any file the user can read, by design (the user picked it as the export path). |
| Bridge `privacy.apply` `{document, findingIds}` | ids: 1–1000 strings ≤ 128 | Blurs through `addAnnotation`; spoken findings skipped. |
| Bridge `chat.cancel` `{projectId, sessionId}` | both must be non-empty strings (added in this review) | Aborts only the caller's own session's turn; answers `cancelled: false` otherwise. |
| Bridge `director.*`/`privacy.*` results in the renderer | re-parsed with `storyboardSchema` / `privacyScanSchema` / `documentSchema` before `saveDocument` | A malformed main-process reply never reaches the store. |
| MCP `analyzeStoryboard`, `applyStoryboard`, `scanPrivacy`, `applyPrivacyFindings`, `addComposition` | Zod schemas with `.max()` on every list; mutating → refused with `consent_required` while "MCP edits" is off; checkpoint required on file-backed projects; revision guard on the editor's | Same executors as the bridge. |
| MCP `exportSubtitles` `{format, path, overwrite?, confirm: true}` | absolute path; extension must match the format; parent directory's realpath inside an allowed directory (user media folders, projects folder, `QBEXEL_ALLOWED_DIRS`); refuses an existing file unless `overwrite`; `confirm` must be literally `true`; write-then-rename | The only tool that writes outside the project. A symlinked final component is replaced by the rename, not followed. |
| MCP `validateProject`, `getStoryboard`, `getPrivacyFindings`, `listCompositions` | no arguments | Read-only; `validateProject` stats the asset paths the project names. |
| CLI `storyboard` `--apply --outro --dry-run` | `--apply` from a fixed list; `--outro` sliced to 200 | Writes the project file write-then-rename, never with `--dry-run`. |
| CLI `privacy scan` `--sample-ms --no-ocr --fail-on-findings --dry-run` | `--sample-ms` integer 500–60000 | Output is masked; exit 3 is the only "finding" signal a script needs. |
| CLI `validate`, `subtitles --out` | `--out` extension must match the format | File-only; no Electron import. |
| CLI `export --composition` | id or unique name; ambiguity refused with the list of names | The composition is laid over the document before sizing. |
| Agent tool `addTitleCard` `{kind, text?, durationSec?}` | text 1–200; duration 1–15 | Through `titleCards.ts` and `anchorRegionsWithDerivedMs` like the pane. |
| Agent tool `splitClip` `{clipId?, atSec}` | clip under `atSec` must match `clipId` when both given; 40 ms minimum piece | Unchanged from milestone 3. |
| Interrupted-take recovery `recover-interrupted-take` `{markerPath}` | marker must be inside the recordings folder (`isPathWithinDir`), re-scanned before use, empty video refused | Milestone 2. |
| `write-export-sidecar` `{exportPath, extension, contents}` | absolute export path; `srt`/`vtt` only; ≤ 16 MB; written beside the `.mp4`/`.gif` | Milestone 3. |
| Global shortcuts `update-global-shortcuts` | bindings validated; duplicate accelerators refused; a refused binding keeps the previous one | Milestone 2. |

## Findings and changes made

1. `chat.cancel` accepted any payload and relied on a thrown `TypeError` for a missing
   session id. **Changed**: the bridge now refuses a non-string `projectId`/`sessionId`
   with `INVALID_REQUEST`.
2. The Privacy Guardian's OCR engine could not start from the packaged main bundle
   (tesseract.js inlined into ESM, `__dirname` undefined). **Changed**: the package is
   external to the main bundle and shipped unpacked (`vite.config.ts`,
   `electron-builder.json5`). Without this the Guardian silently degraded to transcript-only
   while saying so in its warning — honest, but not what the user asked for.
3. The privacy code imported the Electron-bound ffmpeg resolver, which would have made the
   CLI commands untestable in plain Node and pulled Electron into the scan module.
   **Changed**: the ffmpeg path is an argument.
4. The Director's model pass has no Stop button in the pane (the chat has one). It is
   bounded by a 60 s timeout. **Not changed**; backlog.
5. `scanPrivacy` over MCP can take up to a minute and sends no progress notification.
   **Not changed**; backlog.

## Residual risks

- A malicious project file is parsed by Zod before use everywhere, but a very large one
  is still read whole; the bridge inherits upstream's behaviour here.
- The OCR model download trusts the tesseract.js default CDN over HTTPS; a build that
  ships `resources/ocr/eng.traineddata` avoids the download entirely.
- Detectors are heuristics: a scan that finds nothing does not prove a recording is
  clean (the pane says so), and a long alphanumeric id may be flagged as a key (shown at
  low confidence for the user to dismiss).

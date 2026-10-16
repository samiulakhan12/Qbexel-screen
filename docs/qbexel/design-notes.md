# Qbexel Capture Studio — design notes for the extensions (working draft)

These notes record the design decisions behind every subsystem added on top of
OpenScreen. They are the input to ARCHITECTURE.md; each becomes a section there
once the code lands and is tested.

## Non-negotiable constraints inherited from OpenScreen

- One document (`AxcutDocument`, schema v8) is the single source of truth.
  Every new feature stores its state in the document as an OPTIONAL top-level
  field, so no `schemaVersion` bump is needed and older builds simply drop the
  key on save (the same rule `vocabulary`, `shaderEffects` and `audioTracks`
  followed).
- Every mutation, human or machine, goes through the validated operations in
  `electron/ai-edition/agent-tools.ts` (`executeAgentTool`) or the pure document
  ops in `src/lib/ai-edition/document/*.ts`. New subsystems never write regions
  by hand; they call `addZooms`, `addTrims`, `addAnnotation`, `setEditorSettings`
  and the rest, so the Tutorial Director and the Privacy Guardian are held to the
  same rules as a drag on the timeline.
- Preview and export both consume `buildSceneDescription(document)`. A feature
  that must look identical in both (compositions, redactions) is expressed as a
  pure document transform, never as a renderer-side special case.
- Credentials stay in `safeStorage` (`llm-config-store.ts`); nothing new reads
  them in the renderer or serialises them.

## Branding

`src/lib/branding.ts` exports `BRAND` (product name, short name, vendor, app id,
protocol, env prefix, project file extension). The i18n catalogues interpolate
`{{product}}` through i18next `defaultVariables` instead of hard-coding the name,
and `electron-builder.json5` / `package.json` read the same values at build time
via `scripts/apply-branding.mjs`. The `.openscreen` project extension, the
`OPENSCREEN_*` env variables and the `openscreen` MCP server name are kept as
compatibility aliases: changing them would strand existing user projects and
every documented agent setup.

## Tutorial Director (M5) — as built

Document field: `storyboard?: AxcutStoryboard` (optional, additive; schema in
`src/lib/ai-edition/schema/index.ts`, no version bump).

```
AxcutStoryboard {
  version: 1
  generatedAt: iso
  clipSignature: string                // clipExtentSignature() of the timeline analysed; differs → stale
  enrichment: { provider, model, at } | null   // which model named the scenes; never a credential
  scenes: AxcutStoryboardScene[]
  suggestions: AxcutStoryboardSuggestion[]     // flat, each pointing at its sceneId
}
AxcutStoryboardScene {
  id; order; title                     // title = the LLM's when enriched, else the heuristic one
  startMs; endMs; clipId               // RAW ruler ms; a scene never crosses a clip
  narration: string                    // transcribed words in the span — observed, not written
  observed: { kind: click|double-click|right-click|silence, atMs, endMs?, cx?, cy? }[]
  inferred: { kind: title|summary|step|retake, text, confidence, source: heuristic|llm, model? }[]
}
AxcutStoryboardSuggestion = (base & kind-specific):
  base: { id; sceneId; status: proposed|approved|rejected|applied; source; rationale; appliedIds; error? }
  cut       { reason: silence|lead-in|tail|retake; assetId; clipId; sourceStartSec; sourceEndSec }
  zoom      { startMs; endMs; focus {cx,cy}; depth 1..6 }
  callout   { startMs; endMs; text; x; y (percent of frame) }
  titleCard { cardKind: intro|outro; text }
```

Observed events and inferences are separate lists with separate tags in the UI,
so a guess can never read as a fact. A suggestion is data, never code: applying
one builds the arguments of an agent tool and runs `executeAgentTool`.

Pipeline:

1. `src/lib/ai-edition/director/analyze.ts` (pure, deterministic). Per clip:
   spoken words and speech segments inside the clip's source window, clicks from
   the cursor telemetry. Scene boundaries at speech pauses ≥ 1.5 s (never before
   4 s of scene, never leaving < 4 s), or at click gaps ≥ 6 s when there is no
   speech; scenes longer than 45 s are split at their widest pause. Suggestions:
   silence cuts (pause ≥ 1.5 s, 0.3 s breath kept, no click inside, no existing
   trim), lead-in/tail cuts (≥ 2 s of silence at the clip's edges, the stop
   click ignored), retake cuts (two consecutive segments sharing ≥ 4 opening
   words within 8 s), zooms (the timeline's own `buildAutoZoomSuggestionsForClips`
   planner, clear of existing zooms), callouts (the step title beside a scene's
   first click, when the narration names a step), intro/outro title cards
   (programme ≥ 10 s, nothing already on the frame there). Review decisions are
   carried over between analyses by content fingerprint
   (`director/storyboard.ts`).
2. `electron/ai-edition/director/enrich.ts` (optional, main process). Sends each
   scene's id, times, narration (≤ 600 chars) and click/silence counts to the
   configured chat model; strict Zod reply `[{id, title, summary}]`; unknown ids
   dropped; writes `llm` inferences beside the heuristic ones and sets the scene
   title. 60 s timeout, AbortSignal, token usage returned. Runs only when the
   user ticks the consent toggle for that run (never remembered).
3. `electron/ai-edition/director/apply.ts` (main process). Approved suggestions →
   `addTrim` / `addZoom` / `addAnnotation` / `addTitleCard` through
   `executeAgentTool`; created ids recorded in `appliedIds`; a refusal is stored
   on the suggestion in the tool's words. `addTitleCard` was added as an agent
   tool for this (chat and MCP get it too).

Bridge: `aiEdition` actions `director.analyze` (reads telemetry via the cursor
sidecar, optional enrich) and `director.apply`; the renderer saves the returned
storyboard / document through `saveDocument` with history
(`src/lib/ai-edition/store/useStoryboard.ts`, rows in
`documentWriteAudit.test.ts`).

Surface: the **Director** facet of the floating inspector
(`StoryboardPane.tsx`): analyse (+ consent toggle), stale banner, approve /
reject per suggestion, approve all, apply approved, one-click **Remove
silences** (the deterministic silence pass), clear with confirmation; scene and
event rows seek the playhead.

Chat: a **Stop** button while a turn runs (`chat.cancel` → `cancelChat`, an
AbortSignal through `invokeOpenScreenAgent` into LangGraph's `streamEvents`),
and a stall watchdog that stops a turn after 120 s without any text, thinking
or tool event. Both resolve the turn as `cancelled`, reported as information.

Not built yet (M8): CLI `qbexel storyboard` and MCP `director.*` tools; the
analyser is pure and ready for both.

## Privacy Guardian (M6) — as built

Document field: `privacy?: AxcutPrivacyReview` (optional, additive).

```
AxcutPrivacyReview { version: 1; scan: AxcutPrivacyScan | null; reviewedAt; reviewedClipSignature }
AxcutPrivacyScan {
  id; at; strategies: ("ocr"|"transcript")[]; ocrAvailable; sampleEveryMs; framesScanned
  assetIds: string[]                    // the recordings on the timeline the scan read
  findings: AxcutPrivacyFinding[]; warnings: string[]
}
AxcutPrivacyFinding {
  id; kind: api-key|token|private-key|secret-assignment|url-credential|email|phone|card|iban|ip
  preview: string                       // MASKED at detection time; the value is never stored
  confidence: 0..1; source: "frame" | "transcript"; assetId
  boxes: { timeMs (SOURCE), x, y, w, h (0..1 of the picture) }[]   // empty for spoken findings
  spokenStartSec?; spokenEndSec?
  status: suggested | accepted | dismissed; annotationIds: string[]; error?
}
```

Pipeline:

1. `src/lib/ai-edition/privacy/patterns.ts` (pure): detectors with masked previews —
   known key prefixes (OpenAI, Anthropic, AWS, GitHub, Slack, Google, Stripe), JWTs,
   bearer tokens, `password = …` assignments, credential URLs, private-key headers,
   emails, Luhn-checked card numbers, checksum-checked IBANs, phones with a plausible
   shape (account-number shapes refused), IP addresses (low confidence, private ranges
   lower, loopback skipped), and a generic high-entropy run (lowest confidence).
   Overlapping detectors keep the stronger one.
2. `findings.ts` (pure): OCR words with pixel boxes → line text → matches → the box of the
   words carrying the match, in fractions of the frame with a 1 % margin; confidence
   tempered by the OCR's; unsure words (< 40) only count for detectors sure of their
   shape (≥ 0.9), since a real key IS low-confidence text to an OCR engine. One finding
   per distinct value per asset with every box; transcript words → spoken findings with
   times and no box. Decisions carry over between scans by identity (kind + preview).
3. `electron/privacy/frames.ts`: one ffmpeg run per recording (`fps=1/N`, scaled to 1280),
   at most 120 frames (the interval widens for long recordings), 120 s timeout, abort.
   ffmpeg is resolved as the app does (`resolveFfmpeg`), never from PATH.
4. `electron/privacy/ocr.ts`: tesseract.js (WebAssembly, Node worker), one worker per
   scan; `eng.traineddata` from `resources/ocr/` when shipped, else downloaded once into
   the user-data cache (a public model download, said in the pane before the first scan).
5. `electron/privacy/scan.ts`: transcript first, then frames; partial results carry
   warnings (missing ffmpeg, engine failure, frame failures, cancellation).
   `scanVideoFileForSensitiveContent` runs the same over a finished export.
6. `electron/privacy/apply.ts`: accepted findings → `addAnnotation` (type blur, mosaic)
   through `executeAgentTool`, one call per run of sightings per clip (`blur.ts`),
   padded 0.5 s each side; ids recorded on the finding.
7. `review.ts` (pure): counts and the export gate — `unscanned`, `stale` (a recording the
   scan never saw), `unreviewed`, `reviewed` (every finding decided, or marked reviewed
   for this timeline), `clear`.

Bridge: domain `privacy` — `status`, `scan` (progress on `privacy-scan-progress`),
`cancelScan`, `apply`, `scanFile` (absolute path, video extensions only, read-only).

Surfaces: the **Privacy** facet (`PrivacyPane.tsx`): scan with progress and Stop,
machine status (ffmpeg, OCR, model), findings masked with kind, confidence, where seen
or spoken, Blur / Dismiss / jump-to, Blur all open, Mark as reviewed. The export dialog
shows the gate state; undecided findings or a stale scan stop the first click with
"Review findings" (opens the facet) and "Export anyway" (this export only); a toggle
checks the finished file and reports what still shows.

Verified end to end here (`electron/privacy/privacy.e2e.test.ts`, opt-in): a synthetic
1280×720 recording with an email and an `sk-live-…` key drawn into it → both found with
masked previews and boxes where the text was drawn → both blurred through the tools.

Not built: OCR languages other than English (the model is per language); bundling the
model in the installer (a 5 MB binary; documented, not committed); detection inside
images of text at small sizes (frames are read at 1280 px wide).

## Multi-format compositions (M7)

Document field: `compositions?: AxcutComposition[]` (optional, additive).

```
AxcutComposition {
  id; name; aspectRatio                 // "16:9" | "9:16" | "1:1" | "4:3" | "W:H"
  resolution?: { width, height }        // custom; otherwise the quality tier
  formatFollowCursor?: boolean
  padding?: number; borderRadius?: number
  captions?: Partial<CaptionSettings>  // independent caption placement
  safeArea?: { top, bottom, left, right } // % of frame kept clear
  preset?: "tutorial" | "announcement" | "short" | "custom"
}
```

`documentForComposition(document, id)` is a pure transform that overlays the
composition on `legacyEditor` and the caption settings and returns a document
the existing `buildSceneDescription` / `exportMultiNative` consume unchanged.
The preview switches composition through the same function, so what the user
sees for "9:16 short" is what the file holds. Export presets live in
`src/lib/exporter/exportPresets.ts`.

## Subtitle export (M3)

`src/lib/ai-edition/captions/subtitles.ts` turns `deriveCaptionCues` output
(programme time, trims and speed applied) into SRT and WebVTT. Offered in the
Export dialog, the CLI (`captions --srt/--vtt`) and MCP (`exportSubtitles`).

## Themes (M4)

Five bundled style presets as data in `src/lib/ai-edition/bundledStylePresets.ts`
(clean documentation, modern SaaS, cinematic dark, editorial, playful), listed
read-only beside the user's `.openscreenpreset` files and applied through the
existing `applyStylePreset` path. Intro/outro title cards are full-frame text
annotations in frame space over the first/last seconds, so they need no new
region kind and render identically in preview and export.

## CLI and MCP (M8)

File-only commands follow `electron/cli/projectCommands.ts` (no `electron`
import, unit-testable): `validate`, `storyboard`, `privacy scan`, `preset
apply`, `zoom list/add/remove`, `compositions list`. Exit codes: 0 success,
1 failure, 2 usage error, 3 validation failed. MCP tools are added to
`OPENSCREEN_TOOL_NAMES` so both transports and the in-app agent get them, with
`readOnlyHint`/`destructiveHint` set, and every path argument goes through the
existing absolute-path checks plus an allowed-directories list
(`QBEXEL_ALLOWED_DIRS`, defaulting to the projects and recordings folders).

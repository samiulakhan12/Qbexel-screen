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

## Privacy Guardian (M6)

Document field: `privacy?: AxcutPrivacyReview` (optional, additive).

```
AxcutPrivacyReview {
  version: 1
  scans: PrivacyScan[]                 // one per run, newest last
  reviewedAt?: iso                     // user confirmed the findings before export
  reviewedRevision?: number            // document revision at review time
}
PrivacyScan { id; at; strategy: ("pattern"|"ocr"|"vision"|"manual")[]; assetId; sampleEveryMs; findings: PrivacyFinding[] }
PrivacyFinding {
  id; kind: "api-key"|"token"|"email"|"phone"|"card"|"password-field"|"customer-id"|"ip"|"custom"
  preview: string                      // masked excerpt, never the full secret
  confidence: 0..1
  boxes: { timeMs, x, y, w, h }[]      // footage space, 0..1
  status: "suggested" | "accepted" | "dismissed"
  annotationIds: string[]              // the blur regions created on accept
}
```

Detection runs in the main process: frames are sampled with ffmpeg, OCR'd with
tesseract.js (Apache-2.0, WASM, offline), words are matched against the pattern
table in `patterns.ts`, and adjacent samples with overlapping boxes are merged
into one finding with a box track. Accepting a finding writes blur annotations
(existing `type: "blur"`, footage space) through `addAnnotation`; a moving box
becomes consecutive annotations, which is how the schema expresses keyframes.
The Export dialog refuses to proceed while `suggested` findings exist unless
the user reviews them; after export, the finding times are re-sampled from the
output file and OCR'd again, and any finding whose text is still readable is
reported as a warning. The secret itself is never stored: `preview` keeps the
first and last two characters.

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

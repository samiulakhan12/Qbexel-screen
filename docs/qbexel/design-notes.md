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

## Tutorial Director (M5)

Document field: `storyboard?: AxcutStoryboard` (optional, additive).

```
AxcutStoryboard {
  version: 1
  brief: string                       // the user's request
  generatedAt: iso
  source: "deterministic" | "llm"     // what produced the scene list
  title?: string; opening?: string; conclusion?: string
  scenes: AxcutStoryboardScene[]
}
AxcutStoryboardScene {
  id; title; order
  startMs; endMs                       // RAW ruler ms (the clock every tool takes)
  narration: string                    // transcript words inside the span, verbatim
  observed: ObservedEvent[]            // clicks / scrolls / pauses that happened
  inferred: string[]                   // sentences the model inferred, labelled as such
  suggestedAction: string
  zoom?: { depth, focus, startMs, endMs }
  overlays: StoryboardOverlay[]        // text callouts / arrows, frame space
  cuts: { startMs, endMs, reason }[]   // dead air / retakes to remove
  status: "pending" | "approved" | "rejected" | "applied"
  appliedIds: string[]                 // region ids written when applied
}
```

Pipeline, in `src/lib/ai-edition/director/`:

1. `analyze.ts` (pure): transcript (speech/silence segments, words) + cursor
   telemetry (clicks, scroll) → candidate scenes. Clicks within
   `SHOT_MERGE_GAP_MS` of each other and of the speech around them form one
   scene; a silence ≥ 1.5 s or a repeated phrase (retake) becomes a cut
   candidate. Deterministic, no LLM needed.
2. `enrich.ts` (optional LLM): the candidate list, the brief and the transcript
   are sent to the configured provider with a strict Zod output schema
   (`storyboardEnrichmentSchema`); the model may only rename scenes, write
   headings/opening/conclusion and propose overlays that reference observed
   event ids. Anything else is rejected by the parser.
3. `apply.ts`: approved scenes → `executeAgentTool` calls (`addTrims`,
   `addZooms`, `addAnnotation`), recorded in `appliedIds` so a scene can be
   un-applied by `removeModifier`.

Surfaces: a **Storyboard** facet in the floating inspector; CLI
`qbexel storyboard <project> [--brief …] [--apply] [--json]`; MCP
`generateStoryboard` / `applyStoryboard`.

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

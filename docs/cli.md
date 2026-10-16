# OpenScreen CLI

The CLI reference moved to the documentation site: **https://getopenscreen.com/docs/cli/**

Its source is [`website/docs/cli.md`](../website/docs/cli.md) in this repository. Edit that file, not this one.

## Qbexel commands

The commands below work on a project file alone (no window, no GPU); `--json` prints one
NDJSON `done` event. Exit codes: 0 ok, 1 error, 2 usage, 3 "problems found".

```bash
# Tutorial Director: scenes, observed events and suggestions, stored on the project.
qbexel storyboard demo.openscreen --json
# …and apply the silence-removal pass (or all | approved | zoom | callout | titleCard).
qbexel storyboard demo.openscreen --apply cut --outro "Thanks for watching"
# Analyse without writing anything back.
qbexel storyboard demo.openscreen --dry-run

# Privacy Guardian: sensitive text on screen (ffmpeg + local OCR) and in the transcript,
# stored masked. Exit 3 when findings await a decision and --fail-on-findings is set.
qbexel privacy scan demo.openscreen --json --fail-on-findings
qbexel privacy scan demo.openscreen --no-ocr --sample-ms 4000

# References and media.
qbexel validate demo.openscreen --json

# Render one of the project's compositions (by id or unique name).
qbexel export demo.openscreen --composition "Shorts / Reels" -o demo-shorts.mp4
```

The MCP server (`qbexel mcp`, and the in-app HTTP server) serves the same features as
tools: `getStoryboard`, `analyzeStoryboard`, `applyStoryboard`, `getPrivacyFindings`,
`scanPrivacy`, `applyPrivacyFindings`, `listCompositions`, `addComposition`,
`exportSubtitles`, `validateProject`.

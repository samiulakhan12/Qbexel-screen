# Security Policy

## Supported versions

Security fixes land on the latest stable release only. Pre-releases (`-rc.N`) are superseded by the
next stable version and are not patched on their own.

| Version                                  | Supported |
| ---------------------------------------- | --------- |
| Latest stable release                    | Yes       |
| Any earlier release, patches included    | No        |
| Release candidates                       | No        |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub instead:
[Report a vulnerability](https://github.com/getopenscreen/openscreen/security/advisories/new).
This opens a private advisory that only you and the maintainers can see.

A useful report includes:

- the OpenScreen version and how it was installed (Microsoft Store, installer or package
  from the Releases page, Nix…)
- the operating system and version
- the steps to reproduce, or a proof of concept
- the impact you expect: what an attacker gains, and under which conditions

## What happens next

OpenScreen is maintained by volunteers, so these timelines are best-effort:

- an acknowledgement within 7 days
- a first assessment, confirmed or not, within 14 days
- for a confirmed issue, a fix in the next release, then a published advisory crediting you,
  unless you prefer to stay anonymous

Please keep the details private until the fix is released and the advisory is published.

## Scope

In scope: the OpenScreen desktop app and everything this repository builds and ships with it,
including the native capture helpers, the Rust compositor and the auto-update mechanism.

Out of scope: vulnerabilities in third-party dependencies that are already public upstream (a
heads-up is still welcome), and issues that require an attacker who already controls the user's
machine or account.

## Security model of the AI features (Qbexel Capture Studio)

The rules below hold for every AI-driven path — the chat agent, the Tutorial Director,
the Privacy Guardian, the MCP server and the CLI. `docs/qbexel/security-review.md` lists
each input path with its validation.

- **Machine edits are structured operations, never code.** Every edit an agent, the
  Director or the Guardian makes is a validated tool call (`executeAgentTool`) with the
  same anchoring, clamping and refusals a manual edit gets. Nothing evaluates model output
  as code.
- **Credentials never leave the main process.** Provider keys live in the OS keychain
  (`safeStorage`) and are passed to the model client in memory. They appear in no bridge
  reply, log line, project file or MCP response.
- **Nothing is uploaded without a choice.** Transcription and OCR run on this computer. The
  only outbound calls are the chat and the Director's optional model pass, each with the
  provider the user configured; the Director's pass runs only when its consent toggle is
  on for that run and sends narration text and click counts, never frames or screenshots.
  The OCR language model is downloaded once from a public source, announced beforehand,
  and can be shipped offline in `resources/ocr/`.
- **Secrets found on screen are stored masked.** A privacy finding keeps a masked preview,
  not the value; keyboard input is never recorded by any capture helper.
- **A recording is "saved" only once its media and metadata are on disk.** The take journal
  marks an in-progress take and the recovery flow re-scans before it offers anything.
- **MCP**: strict schemas with bounded lists; writes refused while "MCP edits" is off;
  checkpoints required on file-backed projects; file output only inside allowed
  directories (`exportSubtitles`) and never over an existing file unless asked; no shell,
  no arbitrary filesystem access; the privacy scan is bounded in frames and time.
- **The user's voice is never replaced.** There is no speech synthesis path; the
  transcript marks words the user typed (`source: "synth"`) so a future one can tell.

The vulnerability-reporting address above is the upstream OpenScreen project's. A vendor
shipping Qbexel Capture Studio should point it at their own advisory channel.

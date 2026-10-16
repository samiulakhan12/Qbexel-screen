// Qbexel's MCP tools: the Tutorial Director, the Privacy Guardian, compositions, subtitle
// files and a project check, served beside the in-app agent's document tools.
//
// They run in the runner's `execute` like the project tools do — on the document the
// runner read, returning the new document for the runner to apply through the editor or
// save with its revision guard — so they inherit the edit switch, the checkpoint rule and
// the conflict detection. The writes they make are the same pure functions the editor's
// panes call (`analyzeStoryboard`, `applyStoryboardSuggestions`, `applyPrivacyFindings`…),
// and the only file one of them writes (`exportSubtitles`) goes to an allowed directory,
// never over an existing file unless asked, and only when the user confirmed.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CursorTelemetryPoint } from "../../src/components/video-editor/types";
import {
	renderSubtitles,
	subtitleCuesForDocument,
} from "../../src/lib/ai-edition/captions/subtitles";
import { compositionFromPreset } from "../../src/lib/ai-edition/compositions/presets";
import { analyzeStoryboard } from "../../src/lib/ai-edition/director/analyze";
import { storyboardCounts } from "../../src/lib/ai-edition/director/storyboard";
import { resolveAspectRatioValue } from "../../src/lib/ai-edition/document/outputFormat";
import { validateProjectDocument } from "../../src/lib/ai-edition/document/validate";
import { privacyCounts } from "../../src/lib/ai-edition/privacy/review";
import type {
	AxcutDocument,
	AxcutPrivacyScan,
	AxcutStoryboardSuggestion,
} from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import type { AgentToolExecution } from "../ai-edition/agent-tools";
import type { CursorTelemetryReader } from "../ai-edition/deep-agent/service";
import { applyStoryboardSuggestions } from "../ai-edition/director/apply";
import { applyPrivacyFindings } from "../privacy/apply";
import { scanDocumentForSensitiveContent } from "../privacy/scan";

export interface McpPrivacyScanner {
	/** The main process's scan, with OCR set up; absent → transcript only. */
	scan(document: AxcutDocument, options: { sampleEveryMs?: number }): Promise<AxcutPrivacyScan>;
}

export interface QbexelToolContext {
	cursor?: CursorTelemetryReader;
	privacy?: McpPrivacyScanner;
	/** Directories a file may be written into. Absent → no file may be written. */
	allowedExportDirs?: () => string[];
	/** Test seam for validateProject's media check. */
	fileExists?: (filePath: string) => Promise<boolean>;
}

const analyzeStoryboardArgs = z.object({
	outroText: z
		.string()
		.max(200)
		.optional()
		.describe("Text of an outro card to propose; none proposed when omitted."),
});

const suggestionKinds = z.enum(["cut", "zoom", "callout", "titleCard"]);

const applyStoryboardArgs = z.object({
	suggestionIds: z
		.array(z.string().min(1).max(128))
		.max(1000)
		.optional()
		.describe("The suggestions to apply, from getStoryboard. Default: every approved one."),
	kinds: z
		.array(suggestionKinds)
		.max(4)
		.optional()
		.describe(
			"Apply every open suggestion of these kinds instead (proposed or approved). cut with no ids is the silence-removal pass.",
		),
});

const scanPrivacyArgs = z.object({
	sampleEveryMs: z
		.number()
		.int()
		.min(500)
		.max(60_000)
		.optional()
		.describe("Interval between sampled frames; widened to stay within 120 frames. Default 2000."),
});

const applyPrivacyArgs = z.object({
	findingIds: z
		.array(z.string().min(1).max(128))
		.max(1000)
		.optional()
		.describe("The findings to blur, from getPrivacyFindings. Default: every open on-screen one."),
});

const addCompositionArgs = z.object({
	preset: z
		.enum(["youtube", "shorts", "square", "docs-gif", "linkedin"])
		.describe("The publishing preset the composition starts from."),
});

const exportSubtitlesArgs = z.object({
	format: z.enum(["srt", "vtt"]),
	path: z
		.string()
		.min(1)
		.max(4096)
		.describe(
			"Absolute path of the file to write, ending in .srt or .vtt, inside an allowed directory.",
		),
	overwrite: z.boolean().optional().describe("Replace a file already there. Default false."),
	confirm: z
		.literal(true)
		.describe("Must be true: writing a file outside the project is confirmed explicitly."),
});

export const QBEXEL_TOOLS = [
	{
		name: "getStoryboard",
		description:
			"Read the Tutorial Director's storyboard of the project: scenes with their times, the narration said in each (observed), recorded clicks and silences (observed), titles and summaries (inferred, with source and confidence), and the suggestions (cuts, zooms, callouts, title cards) with their review status. Empty until analyzeStoryboard ran.",
		inputSchema: z.object({}),
		mutating: false,
		destructive: false,
	},
	{
		name: "analyzeStoryboard",
		description:
			"Run the Tutorial Director's deterministic analysis and store the storyboard on the project: scenes from the transcript's pauses and the recorded clicks, silence/lead-in/tail/retake cuts, zooms planned on click clusters, callouts and title cards — all as proposals with status proposed. Earlier approvals and rejections of the same proposals carry over. No model is called; nothing changes the film until applyStoryboard.",
		inputSchema: analyzeStoryboardArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "applyStoryboard",
		description:
			"Apply storyboard suggestions through the same tools the agent uses (addTrim, addZoom, addAnnotation, addTitleCard): the named ids, every approved one, or every open one of the given kinds. Returns what was applied, refused (with the tool's reason) and skipped.",
		inputSchema: applyStoryboardArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "getPrivacyFindings",
		description:
			"Read the Privacy Guardian's last scan: sensitive-looking text found on screen (OCR of sampled frames) or spoken (transcript) — keys, tokens, emails, card numbers, phones, IPs — each MASKED, with where it was seen, its confidence and its status. Empty until scanPrivacy ran.",
		inputSchema: z.object({}),
		mutating: false,
		destructive: false,
	},
	{
		name: "scanPrivacy",
		description:
			"Scan every recording on the timeline for sensitive text and store the findings on the project, masked. Frames are sampled with ffmpeg and read by a local OCR engine (nothing leaves the computer); the transcript is read too. Decisions on earlier findings carry over. Can take a minute on a long recording. Nothing is blurred until applyPrivacyFindings.",
		inputSchema: scanPrivacyArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "applyPrivacyFindings",
		description:
			"Blur findings on the video through addAnnotation (a mosaic over each place and time the value was seen): the named ids, or every open on-screen finding. Spoken findings cannot be blurred; cut them with removeWords.",
		inputSchema: applyPrivacyArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "listCompositions",
		description:
			"List the project's compositions (output variants): id, name, preset, frame, caption placement and export settings. exportVideo takes a composition's id or name to render that variant.",
		inputSchema: z.object({}),
		mutating: false,
		destructive: false,
	},
	{
		name: "addComposition",
		description:
			"Add a composition from a publishing preset (YouTube 16:9, Shorts/Reels 9:16, Square, Docs GIF, LinkedIn 4:5). Returns its id.",
		inputSchema: addCompositionArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "exportSubtitles",
		description:
			"Write the project's captions as an .srt or .vtt file on the exported programme's clock (cuts removed, speed applied), so it lines up with exportVideo's output. The project needs a transcript (transcribe). Writes only inside the allowed directories (the user's Videos, Downloads, Desktop, Documents and the projects folder), never over an existing file unless overwrite is true, and only with confirm: true.",
		inputSchema: exportSubtitlesArgs,
		mutating: true,
		destructive: false,
	},
	{
		name: "validateProject",
		description:
			"Check the project: every clip points at an asset, every zoom, annotation, trim and effect range is anchored to a clip that exists, transcripts and storyboard scenes refer to assets and scenes that exist, and the media files are still on disk. Returns ok and a list of problems; changes nothing.",
		inputSchema: z.object({}),
		mutating: false,
		destructive: false,
	},
] as const;

export const QBEXEL_TOOL_NAMES: readonly string[] = QBEXEL_TOOLS.map((tool) => tool.name);
export const QBEXEL_EDIT_TOOLS: ReadonlySet<string> = new Set(
	QBEXEL_TOOLS.filter((tool) => tool.mutating).map((tool) => tool.name),
);

export function isQbexelTool(name: string): boolean {
	return QBEXEL_TOOL_NAMES.includes(name);
}

function failure(message: string): AgentToolExecution {
	return { ok: false, resultJson: JSON.stringify({ error: message }) };
}

function ok(payload: unknown, document?: AxcutDocument): AgentToolExecution {
	return { ok: true, resultJson: JSON.stringify(payload), ...(document ? { document } : {}) };
}

/** Each recording's samples in its own source time, through the runner's telemetry reader. */
async function telemetryFor(
	document: AxcutDocument,
	cursor: CursorTelemetryReader | undefined,
): Promise<Map<string, CursorTelemetryPoint[]>> {
	const out = new Map<string, CursorTelemetryPoint[]>();
	if (!cursor) return out;
	const assets = document.assets.filter(
		(asset) =>
			asset.kind === "video" && document.timeline.clips.some((c) => c.assetId === asset.id),
	);
	await Promise.all(
		assets.map(async (asset) => {
			try {
				const load = await cursor.read({ assetId: asset.id, originalPath: asset.originalPath });
				if (load.status === "ok" && load.samples.length > 0) {
					out.set(asset.id, load.samples as CursorTelemetryPoint[]);
				}
			} catch {
				// No telemetry for this asset.
			}
		}),
	);
	return out;
}

function storyboardSummary(document: AxcutDocument) {
	const storyboard = document.storyboard;
	if (!storyboard) return { storyboard: null };
	return {
		generatedAt: storyboard.generatedAt,
		enrichment: storyboard.enrichment,
		counts: storyboardCounts(storyboard),
		scenes: storyboard.scenes.map((scene) => ({
			id: scene.id,
			order: scene.order,
			title: scene.title,
			startSec: scene.startMs / 1000,
			endSec: scene.endMs / 1000,
			narration: scene.narration,
			observed: scene.observed,
			inferred: scene.inferred,
		})),
		suggestions: storyboard.suggestions,
	};
}

function privacySummary(document: AxcutDocument) {
	const review = document.privacy;
	if (!review?.scan) return { scan: null };
	return {
		at: review.scan.at,
		strategies: review.scan.strategies,
		ocrAvailable: review.scan.ocrAvailable,
		framesScanned: review.scan.framesScanned,
		warnings: review.scan.warnings,
		reviewedAt: review.reviewedAt,
		counts: privacyCounts(review),
		findings: review.scan.findings.map((finding) => ({
			id: finding.id,
			kind: finding.kind,
			preview: finding.preview,
			confidence: finding.confidence,
			source: finding.source,
			status: finding.status,
			seenAtSec: finding.boxes.map((box) => box.timeMs / 1000),
			spokenStartSec: finding.spokenStartSec,
			annotationIds: finding.annotationIds,
			error: finding.error,
		})),
	};
}

/** True when `target` is inside one of `dirs` (resolved, no `..` escape). */
export async function isInsideAllowedDirs(
	target: string,
	dirs: readonly string[],
): Promise<boolean> {
	const parent = path.dirname(target);
	let realParent: string;
	try {
		realParent = await fs.realpath(parent);
	} catch {
		return false;
	}
	for (const dir of dirs) {
		let realDir: string;
		try {
			realDir = await fs.realpath(dir);
		} catch {
			continue;
		}
		const relative = path.relative(realDir, realParent);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
	}
	return false;
}

export async function runQbexelTool(
	document: AxcutDocument,
	name: string,
	args: unknown,
	ctx: QbexelToolContext,
): Promise<AgentToolExecution> {
	switch (name) {
		case "getStoryboard":
			return ok(storyboardSummary(document));

		case "analyzeStoryboard": {
			const parsed = analyzeStoryboardArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			if (document.timeline.clips.length === 0) {
				return failure("The timeline has no footage to analyse.");
			}
			const storyboard = analyzeStoryboard(document, {
				telemetryByAssetId: await telemetryFor(document, ctx.cursor),
				previous: document.storyboard,
				outroText: parsed.data.outroText,
			});
			const next = { ...document, storyboard };
			return ok(storyboardSummary(next), next);
		}

		case "applyStoryboard": {
			const parsed = applyStoryboardArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			const storyboard = document.storyboard;
			if (!storyboard)
				return failure("The project has no storyboard. Call analyzeStoryboard first.");
			let ids: string[];
			if (parsed.data.suggestionIds?.length) {
				ids = parsed.data.suggestionIds;
			} else if (parsed.data.kinds?.length) {
				const kinds = new Set<AxcutStoryboardSuggestion["kind"]>(parsed.data.kinds);
				ids = storyboard.suggestions
					.filter((s) => kinds.has(s.kind) && (s.status === "proposed" || s.status === "approved"))
					.map((s) => s.id);
			} else {
				ids = storyboard.suggestions.filter((s) => s.status === "approved").map((s) => s.id);
			}
			if (ids.length === 0) {
				return failure(
					"Nothing to apply: pass suggestionIds, or kinds, or approve suggestions first (no suggestion is approved).",
				);
			}
			const result = applyStoryboardSuggestions(document, ids);
			return ok(
				{ applied: result.applied, failed: result.failed, skipped: result.skipped },
				result.applied.length > 0 ? result.document : undefined,
			);
		}

		case "getPrivacyFindings":
			return ok(privacySummary(document));

		case "scanPrivacy": {
			const parsed = scanPrivacyArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			if (document.timeline.clips.length === 0) {
				return failure("The timeline has no footage to scan.");
			}
			const scan = ctx.privacy
				? await ctx.privacy.scan(document, { sampleEveryMs: parsed.data.sampleEveryMs })
				: await scanDocumentForSensitiveContent(document, {
						sampleEveryMs: parsed.data.sampleEveryMs,
						ocr: null,
					});
			const previous = document.privacy ?? {
				version: 1 as const,
				scan: null,
				reviewedAt: null,
				reviewedClipSignature: null,
			};
			const next: AxcutDocument = {
				...document,
				privacy: { ...previous, scan, reviewedAt: null, reviewedClipSignature: null },
			};
			return ok(privacySummary(next), next);
		}

		case "applyPrivacyFindings": {
			const parsed = applyPrivacyArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			const scan = document.privacy?.scan;
			if (!scan) return failure("The project has no privacy scan. Call scanPrivacy first.");
			const ids = parsed.data.findingIds?.length
				? parsed.data.findingIds
				: scan.findings
						.filter((f) => f.status === "suggested" && f.source === "frame")
						.map((f) => f.id);
			if (ids.length === 0) return failure("Nothing to blur: no open on-screen finding.");
			const result = applyPrivacyFindings(document, ids);
			return ok(
				{ applied: result.applied, failed: result.failed, skipped: result.skipped },
				result.applied.length > 0 ? result.document : undefined,
			);
		}

		case "listCompositions":
			return ok({ compositions: document.compositions ?? [] });

		case "addComposition": {
			const parsed = addCompositionArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			const composition = compositionFromPreset(parsed.data.preset);
			const next: AxcutDocument = {
				...document,
				compositions: [...(document.compositions ?? []), composition],
			};
			return ok({ id: composition.id, name: composition.name }, next);
		}

		case "exportSubtitles": {
			const parsed = exportSubtitlesArgs.safeParse(args ?? {});
			if (!parsed.success) return failure(parsed.error.message);
			if (document.transcripts.length === 0) {
				return failure("The project has no transcript. Call transcribe first.");
			}
			const target = parsed.data.path;
			if (!path.isAbsolute(target)) return failure(`The path must be absolute, got "${target}".`);
			if (path.extname(target).toLowerCase() !== `.${parsed.data.format}`) {
				return failure(`The path must end in .${parsed.data.format}.`);
			}
			const allowed = ctx.allowedExportDirs?.() ?? [];
			if (allowed.length === 0 || !(await isInsideAllowedDirs(target, allowed))) {
				return failure(
					`The file was NOT written: "${target}" is outside the allowed directories (${allowed.join(", ") || "none configured"}).`,
				);
			}
			const exists = await fs
				.access(target)
				.then(() => true)
				.catch(() => false);
			if (exists && !parsed.data.overwrite) {
				return failure(
					`The file was NOT written: "${target}" exists. Pass overwrite: true to replace it.`,
				);
			}
			const aspect = resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio);
			const cues = subtitleCuesForDocument(document, aspect);
			const text = renderSubtitles(cues, parsed.data.format);
			const tmp = `${target}.${process.pid}.tmp`;
			try {
				await fs.writeFile(tmp, text, "utf8");
				await fs.rename(tmp, target);
			} catch (error) {
				await fs.rm(tmp, { force: true }).catch(() => undefined);
				return failure(
					`The file could not be written: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return ok({ ok: true, path: target, format: parsed.data.format, cues: cues.length });
		}

		case "validateProject": {
			const exists =
				ctx.fileExists ??
				((filePath: string) =>
					fs
						.access(filePath)
						.then(() => true)
						.catch(() => false));
			const problems = await validateProjectDocument(document, exists);
			return ok({ ok: problems.length === 0, problems });
		}

		default:
			return failure(`Unknown tool: ${name}`);
	}
}

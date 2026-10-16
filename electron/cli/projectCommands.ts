// The two CLI commands that only touch the project file and its media:
// `openscreen pack` and `openscreen info`. They live outside cliMain.ts so they
// carry no `electron` import and stay unit-testable — the caller passes the
// writer, so nothing here knows about process.stdout either.

import fs from "node:fs/promises";
import path from "node:path";
import {
	renderSubtitles,
	type SubtitleFormat,
	subtitleCuesForDocument,
	subtitleExtension,
} from "../../src/lib/ai-edition/captions/subtitles";
import { analyzeStoryboard } from "../../src/lib/ai-edition/director/analyze";
import { storyboardCounts } from "../../src/lib/ai-edition/director/storyboard";
import { resolveAspectRatioValue } from "../../src/lib/ai-edition/document/outputFormat";
import { validateProjectDocument } from "../../src/lib/ai-edition/document/validate";
import { privacyCounts } from "../../src/lib/ai-edition/privacy/review";
import {
	type AxcutDocument,
	isAxcutDocumentFile,
	parseDocumentFile,
} from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { applyStoryboardSuggestions } from "../ai-edition/director/apply";
import type { OcrEngineOptions } from "../privacy/ocr";
import { scanDocumentForSensitiveContent } from "../privacy/scan";
import type { CliPrivacyScanCommand, CliStoryboardCommand, CliValidateCommand } from "./args";

/** Writes one already-newline-terminated chunk of CLI output. */
export type CliWriter = (text: string) => void;

export interface PackedProjectData {
	version?: number;
	media?: { screenVideoPath?: string; webcamVideoPath?: string; cursorCaptureMode?: string };
	videoPath?: string;
	editor?: Record<string, unknown>;
}

const isFile = (candidate: string): Promise<boolean> =>
	fs
		.stat(candidate)
		.then((stats) => stats.isFile())
		.catch(() => false);

/** Copies a project and everything it references into one portable folder. */
export async function runPackCommand(
	projectPath: string,
	outDir: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const emit = (message: string) => {
		if (!json) out(`${message}\n`);
	};

	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	// A document can hold several assets, a camera track and imported audio, each with its own
	// path, and the loader's sibling fallback only covers the v2 shape. Say so rather than
	// report that it has no video.
	if (isAxcutDocumentFile(parsed)) {
		throw new Error(
			"pack does not support projects saved by the editor yet, only legacy v2 project files",
		);
	}
	const data = parsed as PackedProjectData;
	const media = data.media ?? (data.videoPath ? { screenVideoPath: data.videoPath } : undefined);
	const screenVideoPath = media?.screenVideoPath;
	if (!screenVideoPath) {
		throw new Error("Project file does not reference a screen video");
	}

	const projectDir = path.dirname(path.resolve(projectPath));
	const resolveSource = async (mediaPath: string): Promise<string> => {
		if (await isFile(mediaPath)) return mediaPath;
		// Moved project: the stored absolute path is stale but the media travelled
		// with the .openscreen file. Same rule as the loader's sibling fallback.
		const sibling = path.join(projectDir, path.basename(mediaPath));
		if (await isFile(sibling)) return sibling;
		throw new Error(`Referenced media not found: ${mediaPath}`);
	};

	await fs.mkdir(outDir, { recursive: true });

	const copied: string[] = [];
	const copyIn = async (sourcePath: string): Promise<string> => {
		const ext = path.extname(sourcePath);
		const stem = path.basename(sourcePath, ext);
		let destination = path.join(outDir, stem + ext);
		// Screen and webcam can share a basename across directories; don't overwrite.
		for (let n = 1; copied.includes(destination); n++) {
			destination = path.join(outDir, `${stem}-${n}${ext}`);
		}
		if (path.resolve(sourcePath) !== path.resolve(destination)) {
			await fs.copyFile(sourcePath, destination);
		}
		copied.push(destination);
		return destination;
	};

	const screenSource = await resolveSource(screenVideoPath);
	const newScreenPath = await copyIn(screenSource);

	let newWebcamPath: string | undefined;
	if (media.webcamVideoPath) {
		newWebcamPath = await copyIn(await resolveSource(media.webcamVideoPath));
	}

	// Cursor telemetry sidecar sits at "<video path>.cursor.json".
	const cursorSidecar = `${screenSource}.cursor.json`;
	const hasCursorData = await isFile(cursorSidecar);
	if (hasCursorData) {
		await copyIn(cursorSidecar);
	}

	const packedProject: PackedProjectData = {
		...data,
		media: {
			...media,
			screenVideoPath: newScreenPath,
			...(newWebcamPath ? { webcamVideoPath: newWebcamPath } : {}),
		},
	};
	delete packedProject.videoPath;
	const packedProjectPath = path.join(outDir, path.basename(projectPath));
	await fs.writeFile(packedProjectPath, JSON.stringify(packedProject, null, 2), "utf8");

	if (json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				projectPath: packedProjectPath,
				files: [packedProjectPath, ...copied],
				cursorData: hasCursorData,
			})}\n`,
		);
	} else {
		emit(`Packed project → ${packedProjectPath}`);
		for (const file of copied) {
			emit(`  + ${path.basename(file)}`);
		}
		if (!hasCursorData) {
			emit("  (no cursor telemetry sidecar found)");
		}
		emit(
			"The folder is self-contained: if the stored paths go stale after moving it, the loader falls back to files next to the project.",
		);
	}
	return 0;
}

/**
 * Writes the project's captions as a subtitle file on the exported programme's clock (trims
 * removed, speed applied), so it lines up with `openscreen export`'s output. The project
 * needs a transcript; `openscreen captions` makes one.
 */
export async function runSubtitlesCommand(
	projectPath: string,
	format: SubtitleFormat,
	outPath: string | null,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!isAxcutDocumentFile(parsed)) {
		throw new Error("subtitles needs a project saved by the editor (schemaVersion 3 or later)");
	}
	const document = parseDocumentFile(parsed);
	if (document.transcripts.length === 0) {
		throw new Error(
			"The project has no transcript yet. Run `captions` on it first, or transcribe it in the editor.",
		);
	}
	const aspect = resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio);
	const cues = subtitleCuesForDocument(document, aspect);
	const target =
		outPath ??
		path.join(
			path.dirname(path.resolve(projectPath)),
			`${path.parse(projectPath).name}${subtitleExtension(format)}`,
		);
	const text = renderSubtitles(cues, format);
	// Write-then-rename, like every other file this CLI produces: a failure leaves no half file.
	const tmp = `${target}.${process.pid}.tmp`;
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(tmp, text, "utf8");
	await fs.rename(tmp, target);
	if (json) {
		out(
			`${JSON.stringify({ event: "done", success: true, outputPath: target, format, cues: cues.length })}\n`,
		);
	} else {
		out(`Wrote ${cues.length} cue${cues.length === 1 ? "" : "s"} → ${target}\n`);
	}
	return 0;
}

/** Prints what a project references and whether its media is still reachable. */
export async function runInfoCommand(
	projectPath: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	const fields = isAxcutDocumentFile(parsed)
		? documentInfoFields(parseDocumentFile(parsed))
		: legacyInfoFields(parsed as PackedProjectData);
	const screenVideoPath = fields.screenVideoPath;
	const mediaExists = screenVideoPath
		? await fs
				.access(screenVideoPath)
				.then(() => true)
				.catch(() => false)
		: false;

	const summary = {
		projectPath,
		version: fields.version,
		screenVideoPath,
		screenVideoExists: mediaExists,
		webcamVideoPath: fields.webcamVideoPath,
		cursorCaptureMode: fields.cursorCaptureMode,
		exportFormat: fields.exportFormat,
		exportQuality: fields.exportQuality,
		aspectRatio: fields.aspectRatio,
		zoomRegions: fields.zoomRegions,
		trimRegions: fields.trimRegions,
		speedRegions: fields.speedRegions,
		annotationRegions: fields.annotationRegions,
		shaderEffectRegions: fields.shaderEffectRegions,
	};

	if (json) {
		out(`${JSON.stringify(summary)}\n`);
	} else {
		out(
			[
				`Project:  ${summary.projectPath} (version ${summary.version ?? "?"})`,
				`Video:    ${summary.screenVideoPath ?? "(none)"}${mediaExists ? "" : "  [MISSING]"}`,
				`Webcam:   ${summary.webcamVideoPath ?? "(none)"}`,
				`Cursor:   ${summary.cursorCaptureMode ?? "(unknown)"}`,
				`Export:   ${summary.exportFormat ?? "?"} / ${summary.exportQuality ?? "?"} / ${summary.aspectRatio ?? "?"}`,
				`Timeline: ${summary.zoomRegions} zooms, ${summary.trimRegions} trims, ${summary.speedRegions} speed regions, ${summary.annotationRegions} annotations, ${summary.shaderEffectRegions} effects`,
			].join("\n") + "\n",
		);
	}
	return summary.screenVideoPath && !mediaExists ? 1 : 0;
}

/** What `openscreen info` reports, read off either shape of project file. */
interface ProjectInfoFields {
	/** The v2 `version`, or a document's `schemaVersion`. */
	version: number | null;
	screenVideoPath: string | null;
	webcamVideoPath: string | null;
	cursorCaptureMode: string | null;
	exportFormat: string | null;
	exportQuality: string | null;
	aspectRatio: string | null;
	zoomRegions: number;
	trimRegions: number;
	speedRegions: number;
	annotationRegions: number;
	/** Shader effect regions (stored fragments, like the other counts). A v2 project has none. */
	shaderEffectRegions: number;
}

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

function legacyInfoFields(data: PackedProjectData): ProjectInfoFields {
	const editor = data.editor ?? {};
	const count = (key: string) =>
		Array.isArray(editor[key]) ? (editor[key] as unknown[]).length : 0;
	return {
		version: data.version ?? null,
		screenVideoPath: data.media?.screenVideoPath ?? data.videoPath ?? null,
		webcamVideoPath: data.media?.webcamVideoPath ?? null,
		cursorCaptureMode: data.media?.cursorCaptureMode ?? null,
		exportFormat: stringOrNull(editor.exportFormat),
		exportQuality: stringOrNull(editor.exportQuality),
		aspectRatio: stringOrNull(editor.aspectRatio),
		zoomRegions: count("zoomRegions"),
		trimRegions: count("trimRegions"),
		speedRegions: count("speedRegions"),
		annotationRegions: count("annotationRegions"),
		shaderEffectRegions: 0,
	};
}

/**
 * A project the editor saved. Its media is the primary asset; the export settings are only
 * there when a migrated v2 project left them in `legacyEditor` (the ExportDialog keeps its own).
 * Speed regions live in `legacyEditor.speedRegions`, not `timeline.speedRanges`: that is where
 * the editor writes them and where the scene reads them (`sceneDescription.ts`).
 */
function documentInfoFields(doc: ReturnType<typeof parseDocumentFile>): ProjectInfoFields {
	const primary =
		doc.assets.find((asset) => asset.id === doc.project.primaryAssetId) ?? doc.assets[0];
	const editor = doc.legacyEditor ?? {};
	return {
		version: doc.schemaVersion,
		screenVideoPath: primary?.originalPath ?? null,
		webcamVideoPath: primary?.cameraTrack?.sourcePath ?? null,
		cursorCaptureMode: null,
		exportFormat: stringOrNull(editor.exportFormat),
		exportQuality: stringOrNull(editor.exportQuality),
		aspectRatio: stringOrNull(editor.aspectRatio),
		zoomRegions: doc.zoomRanges.length,
		trimRegions: doc.timeline.trimRanges.length,
		speedRegions: Array.isArray(editor.speedRegions) ? editor.speedRegions.length : 0,
		annotationRegions: doc.annotations.length,
		shaderEffectRegions: doc.shaderEffectRanges?.length ?? 0,
	};
}

async function readDocumentFile(projectPath: string, command: string): Promise<AxcutDocument> {
	const raw = await fs.readFile(projectPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!isAxcutDocumentFile(parsed)) {
		throw new Error(`${command} needs a project saved by the editor (schemaVersion 3 or later)`);
	}
	return parseDocumentFile(parsed);
}

/** Write-then-rename, like every other file this CLI produces. */
async function writeDocumentFile(projectPath: string, document: AxcutDocument): Promise<void> {
	const tmp = `${projectPath}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(document, null, 2), "utf8");
	await fs.rename(tmp, projectPath);
}

/**
 * The Tutorial Director from the command line: the deterministic analysis stored on the
 * project (no model is called), and optionally the application of suggestions through the
 * same tools the editor uses. Exit 0; 3 when `--apply` asked for something that was refused.
 */
export async function runStoryboardCommand(
	command: CliStoryboardCommand,
	out: CliWriter,
): Promise<number> {
	let document = await readDocumentFile(command.projectPath, "storyboard");
	if (document.timeline.clips.length === 0) {
		throw new Error("The project's timeline has no footage to analyse.");
	}
	const storyboard = analyzeStoryboard(document, {
		previous: document.storyboard,
		outroText: command.outroText ?? undefined,
	});
	document = { ...document, storyboard };
	let applied: string[] = [];
	let failed: Array<{ id: string; error: string }> = [];
	if (command.apply) {
		const wanted = command.apply;
		const ids = storyboard.suggestions
			.filter((s) => {
				if (s.status === "applied" || s.status === "rejected") return false;
				if (wanted === "all") return true;
				if (wanted === "approved") return s.status === "approved";
				return s.kind === wanted;
			})
			.map((s) => s.id);
		if (ids.length > 0) {
			const result = applyStoryboardSuggestions(document, ids);
			document = result.document;
			applied = result.applied;
			failed = result.failed;
		}
	}
	if (!command.dryRun) await writeDocumentFile(command.projectPath, document);
	const counts = storyboardCounts(document.storyboard);
	if (command.json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: failed.length === 0,
				written: !command.dryRun,
				scenes: document.storyboard?.scenes.map((scene) => ({
					id: scene.id,
					title: scene.title,
					startSec: scene.startMs / 1000,
					endSec: scene.endMs / 1000,
					observed: scene.observed.length,
					inferred: scene.inferred,
				})),
				suggestions: document.storyboard?.suggestions,
				counts,
				applied,
				failed,
			})}\n`,
		);
	} else {
		out(
			`${counts.scenes} scene${counts.scenes === 1 ? "" : "s"}, ${counts.proposed + counts.approved} open suggestion${counts.proposed + counts.approved === 1 ? "" : "s"}, ${counts.applied} applied${command.dryRun ? " (dry run, nothing written)" : ""}\n`,
		);
		for (const scene of document.storyboard?.scenes ?? []) {
			out(
				`  ${scene.order + 1}. ${scene.title} (${(scene.startMs / 1000).toFixed(1)}–${(scene.endMs / 1000).toFixed(1)} s)\n`,
			);
		}
		for (const suggestion of document.storyboard?.suggestions ?? []) {
			out(`  - [${suggestion.status}] ${suggestion.kind}: ${suggestion.rationale}\n`);
		}
		for (const { id, error } of failed) out(`  ! ${id}: ${error}\n`);
	}
	return failed.length > 0 ? 3 : 0;
}

/**
 * The Privacy Guardian from the command line. Frames are read with ffmpeg and a local OCR
 * engine unless `--no-ocr`; the transcript is always read. The scan is stored on the project
 * (masked findings), and printed masked. Exit 0; 3 with `--fail-on-findings` when findings
 * await a decision.
 */
export async function runPrivacyScanCommand(
	command: CliPrivacyScanCommand,
	ocr: OcrEngineOptions | null,
	ffmpegPath: string | null,
	out: CliWriter,
): Promise<number> {
	const document = await readDocumentFile(command.projectPath, "privacy scan");
	if (document.timeline.clips.length === 0) {
		throw new Error("The project's timeline has no footage to scan.");
	}
	const scan = await scanDocumentForSensitiveContent(document, {
		sampleEveryMs: command.sampleEveryMs ?? undefined,
		ocr: command.noOcr ? null : ocr,
		ffmpegPath,
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
	if (!command.dryRun) await writeDocumentFile(command.projectPath, next);
	const counts = privacyCounts(next.privacy);
	if (command.json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				written: !command.dryRun,
				ocrAvailable: scan.ocrAvailable,
				framesScanned: scan.framesScanned,
				warnings: scan.warnings,
				counts,
				findings: scan.findings.map((f) => ({
					id: f.id,
					kind: f.kind,
					preview: f.preview,
					confidence: f.confidence,
					source: f.source,
					status: f.status,
					seenAtSec: f.boxes.map((b) => b.timeMs / 1000),
					spokenStartSec: f.spokenStartSec,
				})),
			})}\n`,
		);
	} else {
		out(
			`${scan.framesScanned} frame${scan.framesScanned === 1 ? "" : "s"} read${scan.ocrAvailable ? "" : " (no OCR)"}, ${counts.total} finding${counts.total === 1 ? "" : "s"}, ${counts.suggested} to decide${command.dryRun ? " (dry run, nothing written)" : ""}\n`,
		);
		for (const warning of scan.warnings) out(`  ! ${warning}\n`);
		for (const f of scan.findings) {
			const where =
				f.source === "frame"
					? `on screen at ${f.boxes.map((b) => (b.timeMs / 1000).toFixed(1)).join(", ")} s`
					: `spoken at ${(f.spokenStartSec ?? 0).toFixed(1)} s`;
			out(
				`  - [${f.status}] ${f.kind} ${f.preview} (${Math.round(f.confidence * 100)}%) ${where}\n`,
			);
		}
	}
	return command.failOnFindings && counts.suggested > 0 ? 3 : 0;
}

/** Checks a project's references and media; exit 3 when anything is wrong. */
export async function runValidateCommand(
	command: CliValidateCommand,
	out: CliWriter,
): Promise<number> {
	const document = await readDocumentFile(command.projectPath, "validate");
	const problems = await validateProjectDocument(document, isFile);
	if (command.json) {
		out(`${JSON.stringify({ event: "done", success: problems.length === 0, problems })}\n`);
	} else if (problems.length === 0) {
		out("OK: every reference resolves and every media file is present.\n");
	} else {
		out(`${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
		for (const problem of problems) out(`  - ${problem.kind}: ${problem.message}\n`);
	}
	return problems.length === 0 ? 0 : 3;
}

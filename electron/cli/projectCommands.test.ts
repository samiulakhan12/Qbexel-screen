import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	normalizeProjectEditor,
	PROJECT_VERSION,
} from "../../src/components/video-editor/projectPersistence";
import { migrateProjectDataToAxcutDocument } from "../../src/lib/ai-edition/document/migrate";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import {
	type PackedProjectData,
	runInfoCommand,
	runPackCommand,
	runPrivacyScanCommand,
	runStoryboardCommand,
	runSubtitlesCommand,
	runValidateCommand,
} from "./projectCommands";

let root = "";

/** Absolute path inside the throwaway root, parents created. */
async function make(relative: string, contents = "video-bytes"): Promise<string> {
	const target = path.join(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, contents, "utf8");
	return target;
}

async function writeProject(relative: string, data: PackedProjectData): Promise<string> {
	return make(relative, JSON.stringify(data));
}

/**
 * A project file as the editor saves it: the AxcutDocument itself, one zoom on the timeline, an
 * export format a migrated v2 project left in `legacyEditor`, a speed region where the editor
 * keeps them (`legacyEditor.speedRegions`), and one shader effect.
 */
async function writeDocument(relative: string, screenVideoPath: string): Promise<string> {
	const doc = migrateProjectDataToAxcutDocument({
		version: PROJECT_VERSION,
		media: { screenVideoPath },
		editor: normalizeProjectEditor({
			exportFormat: "gif",
			zoomRegions: [{ id: "z1", startMs: 0, endMs: 1000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
		}),
	});
	const speedRegions = [{ id: "s1", startMs: 0, endMs: 500, speed: 2 }];
	return make(
		relative,
		JSON.stringify({
			...doc,
			legacyEditor: { ...doc.legacyEditor, speedRegions },
			shaderEffects: [
				{
					id: "fx1",
					name: "Pass-through",
					contract: 1,
					code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }",
				},
			],
			shaderEffectRanges: [{ id: "fxr1", startMs: 0, endMs: 500, effectId: "fx1" }],
		}),
	);
}

const readProject = async (file: string): Promise<PackedProjectData> =>
	JSON.parse(await fs.readFile(file, "utf8"));

/** Collects CLI output instead of writing to stdout. */
function recorder() {
	const chunks: string[] = [];
	const write = (text: string) => {
		chunks.push(text);
	};
	return { write, text: () => chunks.join("") };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "os-cli-pack-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("runPackCommand", () => {
	it("keeps screen and webcam apart when they share a basename", async () => {
		const screen = await make("rec/a/clip.mp4", "screen");
		const webcam = await make("rec/b/clip.mp4", "webcam");
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: screen, webcamVideoPath: webcam },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.media?.screenVideoPath).not.toBe(packed.media?.webcamVideoPath);
		await expect(fs.readFile(packed.media?.screenVideoPath ?? "", "utf8")).resolves.toBe("screen");
		await expect(fs.readFile(packed.media?.webcamVideoPath ?? "", "utf8")).resolves.toBe("webcam");
	});

	it("copies the cursor sidecar and drops the legacy videoPath", async () => {
		const screen = await make("rec/clip.mp4", "screen");
		await make("rec/clip.mp4.cursor.json", "[]");
		const project = await writeProject("demo.openscreen", { version: 1, videoPath: screen });
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, true, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.videoPath).toBeUndefined();
		expect(packed.media?.screenVideoPath).toBe(path.join(outDir, "clip.mp4"));
		await expect(fs.readFile(path.join(outDir, "clip.mp4.cursor.json"), "utf8")).resolves.toBe(
			"[]",
		);
		expect(JSON.parse(out.text())).toMatchObject({ event: "done", cursorData: true });
	});

	it("falls back to media sitting next to the project when the stored path is stale", async () => {
		await make("moved/clip.mp4", "screen");
		const project = await writeProject("moved/demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);
		await expect(fs.readFile(path.join(outDir, "clip.mp4"), "utf8")).resolves.toBe("screen");
	});

	it("fails when the referenced media is nowhere to be found", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});

		const out = recorder();
		await expect(
			runPackCommand(project, path.join(root, "packed"), false, out.write),
		).rejects.toThrow(/Referenced media not found/);
	});
});

describe("runInfoCommand", () => {
	it("exits 1 when the project's video is missing, 0 when it is there", async () => {
		const missing = await writeProject("missing.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const present = await writeProject("present.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
		});

		const out = recorder();
		expect(await runInfoCommand(missing, false, out.write)).toBe(1);
		expect(out.text()).toContain("[MISSING]");
		expect(await runInfoCommand(present, false, out.write)).toBe(0);
	});

	it("counts timeline regions in --json mode", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
			editor: { zoomRegions: [{}, {}], trimRegions: [{}], exportFormat: "mp4" },
		});

		const out = recorder();
		expect(await runInfoCommand(project, true, out.write)).toBe(0);
		expect(JSON.parse(out.text())).toMatchObject({
			zoomRegions: 2,
			trimRegions: 1,
			speedRegions: 0,
			annotationRegions: 0,
			shaderEffectRegions: 0,
			exportFormat: "mp4",
			screenVideoExists: true,
		});
	});
});

describe("a project the editor saved", () => {
	it("is described by info from its primary asset", async () => {
		const screen = await make("rec/clip.mp4");
		const project = await writeDocument("saved.openscreen", screen);

		const out = recorder();
		expect(await runInfoCommand(project, true, out.write)).toBe(0);
		expect(JSON.parse(out.text())).toMatchObject({
			version: 8,
			screenVideoPath: screen,
			screenVideoExists: true,
			exportFormat: "gif",
			zoomRegions: 1,
			trimRegions: 0,
			speedRegions: 1,
			shaderEffectRegions: 1,
		});
	});

	it("is reported MISSING by info when its media is gone", async () => {
		const project = await writeDocument("saved.openscreen", path.join(root, "gone", "clip.mp4"));

		const out = recorder();
		expect(await runInfoCommand(project, false, out.write)).toBe(1);
		expect(out.text()).toContain("[MISSING]");
	});

	it("is refused by pack with a reason, not as a project without video", async () => {
		const project = await writeDocument("saved.openscreen", await make("rec/clip.mp4"));

		await expect(
			runPackCommand(project, path.join(root, "packed"), false, recorder().write),
		).rejects.toThrow("pack does not support projects saved by the editor yet");
	});
});

describe("runSubtitlesCommand", () => {
	function transcribed(mediaPath: string) {
		const doc = createEmptyDocument({ projectId: "proj_sub", title: "Subtitles" });
		return {
			...doc,
			project: { ...doc.project, primaryAssetId: "asset_1" },
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "take",
					originalPath: mediaPath,
					durationSec: 20,
					cameraTrack: null,
				},
			],
			timeline: {
				...doc.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 20,
						timelineStartSec: 0,
						timelineEndSec: 20,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 4,
						endSec: 6,
						reason: "",
						origin: "user",
					},
				],
			},
			transcripts: [
				{
					assetId: "asset_1",
					language: "en",
					segments: [
						{
							id: "s1",
							kind: "speech",
							startSec: 1,
							endSec: 3,
							text: "Hello there",
							wordIds: ["w1", "w2"],
						},
						{
							id: "s2",
							kind: "speech",
							startSec: 8,
							endSec: 9,
							text: "Click save",
							wordIds: ["w3", "w4"],
						},
					],
					words: [
						{ id: "w1", segmentId: "s1", startSec: 1, endSec: 1.8, text: "Hello" },
						{ id: "w2", segmentId: "s1", startSec: 2, endSec: 3, text: "there" },
						{ id: "w3", segmentId: "s2", startSec: 8, endSec: 8.4, text: "Click" },
						{ id: "w4", segmentId: "s2", startSec: 8.5, endSec: 9, text: "save" },
					],
				},
			],
		};
	}

	it("writes an SRT beside the project on the programme clock", async () => {
		const media = await make("take.mp4");
		const project = await make("sub/demo.openscreen", JSON.stringify(transcribed(media)));
		const out = recorder();
		expect(await runSubtitlesCommand(project, "srt", null, true, out.write)).toBe(0);
		const written = path.join(root, "sub", "demo.srt");
		const srt = await fs.readFile(written, "utf8");
		// The cut at 4–6 s pulls the second line two seconds earlier.
		expect(srt).toContain("00:00:01,000 --> 00:00:03,000");
		expect(srt).toContain("00:00:06,000 --> 00:00:07,000");
		expect(JSON.parse(out.text().trim())).toMatchObject({ event: "done", success: true, cues: 2 });
	});

	it("writes WebVTT to the path asked for", async () => {
		const media = await make("take.mp4");
		const project = await make("demo.openscreen", JSON.stringify(transcribed(media)));
		const target = path.join(root, "out", "captions.vtt");
		const out = recorder();
		expect(await runSubtitlesCommand(project, "vtt", target, false, out.write)).toBe(0);
		expect(await fs.readFile(target, "utf8")).toMatch(/^WEBVTT\n\n00:00:01\.000 --> /);
		expect(out.text()).toContain("Wrote 2 cues");
	});

	it("refuses a project without a transcript and a legacy v2 file", async () => {
		const media = await make("take.mp4");
		const bare = transcribed(media);
		const project = await make("bare.openscreen", JSON.stringify({ ...bare, transcripts: [] }));
		await expect(
			runSubtitlesCommand(project, "srt", null, false, recorder().write),
		).rejects.toThrow(/no transcript/);
		const legacy = await writeProject("legacy.openscreen", { version: 2, videoPath: media });
		await expect(runSubtitlesCommand(legacy, "srt", null, false, recorder().write)).rejects.toThrow(
			/saved by the editor/,
		);
	});
});

/** An editor-saved project with one clip and a transcript saying a card number. */
async function spokenProject(relative: string, mediaPath: string): Promise<string> {
	const base = createEmptyDocument({ projectId: "proj_q", title: "Qbexel" });
	const words = [
		"my",
		"card",
		"is",
		"4111",
		"1111",
		"1111",
		"1111",
		"and",
		"then",
		"we",
		"wait",
		"for",
		"the",
		"page",
	].map((text, i) => ({
		id: `w${i}`,
		segmentId: "s1",
		startSec: 1 + i * 0.5,
		endSec: 1.4 + i * 0.5,
		text,
	}));
	const document = {
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: mediaPath,
				durationSec: 30,
				cameraTrack: null,
			},
		],
		transcripts: [{ assetId: "asset_1", language: "en", segments: [], words }],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	};
	return make(relative, JSON.stringify(document));
}

describe("runStoryboardCommand", () => {
	it("stores the analysis on the project and applies the silence cuts when asked", async () => {
		const media = await make("take.mp4");
		const project = await spokenProject("sb.openscreen", media);
		const lines: string[] = [];
		const code = await runStoryboardCommand(
			{
				kind: "storyboard",
				projectPath: project,
				apply: null,
				outroText: null,
				dryRun: false,
				json: true,
			},
			(text) => lines.push(text),
		);
		expect(code).toBe(0);
		const report = JSON.parse(lines.join(""));
		expect(report.event).toBe("done");
		expect(report.scenes.length).toBeGreaterThanOrEqual(1);
		const saved = JSON.parse(await fs.readFile(project, "utf8"));
		expect(saved.storyboard.scenes.length).toBe(report.scenes.length);
		// The 20 s tail after the last word is a cut; applying "cut" writes the trim.
		expect(saved.storyboard.suggestions.some((s: { kind: string }) => s.kind === "cut")).toBe(true);
		const applied = await runStoryboardCommand(
			{
				kind: "storyboard",
				projectPath: project,
				apply: "cut",
				outroText: null,
				dryRun: false,
				json: true,
			},
			(text) => lines.push(text),
		);
		expect(applied).toBe(0);
		const after = JSON.parse(await fs.readFile(project, "utf8"));
		expect(after.timeline.trimRanges.length).toBeGreaterThanOrEqual(1);
		expect(after.timeline.trimRanges[0].origin).toBe("agent");
	});

	it("writes nothing on a dry run", async () => {
		const media = await make("take.mp4");
		const project = await spokenProject("dry.openscreen", media);
		const before = await fs.readFile(project, "utf8");
		const code = await runStoryboardCommand(
			{
				kind: "storyboard",
				projectPath: project,
				apply: null,
				outroText: "Bye",
				dryRun: true,
				json: false,
			},
			() => undefined,
		);
		expect(code).toBe(0);
		expect(await fs.readFile(project, "utf8")).toBe(before);
	});
});

describe("runPrivacyScanCommand", () => {
	it("reads the transcript without OCR, stores masked findings and exits 3 on --fail-on-findings", async () => {
		const media = await make("take.mp4");
		const project = await spokenProject("pv.openscreen", media);
		const lines: string[] = [];
		const code = await runPrivacyScanCommand(
			{
				kind: "privacy-scan",
				projectPath: project,
				sampleEveryMs: null,
				noOcr: true,
				failOnFindings: true,
				dryRun: false,
				json: true,
			},
			null,
			null,
			(text) => lines.push(text),
		);
		expect(code).toBe(3);
		const report = JSON.parse(lines.join(""));
		expect(report.ocrAvailable).toBe(false);
		expect(
			report.findings.map((f: { kind: string; preview: string }) => [f.kind, f.preview]),
		).toEqual([["card", "•••• 1111"]]);
		expect(lines.join("")).not.toContain("4111 1111 1111 1111");
		const saved = JSON.parse(await fs.readFile(project, "utf8"));
		expect(saved.privacy.scan.findings[0].source).toBe("transcript");
	});
});

describe("runValidateCommand", () => {
	it("passes a healthy project and reports missing media and dangling anchors", async () => {
		const media = await make("take.mp4");
		const project = await spokenProject("ok.openscreen", media);
		expect(
			await runValidateCommand(
				{ kind: "validate", projectPath: project, json: false },
				() => undefined,
			),
		).toBe(0);
		const broken = JSON.parse(await fs.readFile(project, "utf8"));
		broken.assets[0].originalPath = path.join(root, "gone.mp4");
		broken.zoomRanges = [
			{
				id: "zoom_1",
				startMs: 1000,
				endMs: 2000,
				clipId: "clip_missing",
				sourceStartSec: 1,
				sourceEndSec: 2,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
			},
		];
		const brokenPath = await make("broken.openscreen", JSON.stringify(broken));
		const lines: string[] = [];
		const code = await runValidateCommand(
			{ kind: "validate", projectPath: brokenPath, json: true },
			(text) => lines.push(text),
		);
		expect(code).toBe(3);
		const report = JSON.parse(lines.join(""));
		expect(report.problems.map((p: { kind: string }) => p.kind).sort()).toEqual([
			"media-missing",
			"zoom-anchor",
		]);
	});
});

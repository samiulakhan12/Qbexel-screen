// The Qbexel MCP tools run directly against a document: the Director and Guardian flows,
// compositions, the subtitle file's path policy, and the project check.

import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import {
	isInsideAllowedDirs,
	QBEXEL_EDIT_TOOLS,
	QBEXEL_TOOL_NAMES,
	runQbexelTool,
} from "./qbexel-tools";

function fixture(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "proj_1", title: "Billing tour" });
	const words = ["my", "card", "is", "4111", "1111", "1111", "1111", "then", "we", "wait"].map(
		(text, i) => ({
			id: `w${i}`,
			segmentId: "s1",
			startSec: 1 + i * 0.5,
			endSec: 1.4 + i * 0.5,
			text,
		}),
	);
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: "/tmp/take.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
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
	});
}

const parse = (resultJson: string) => JSON.parse(resultJson);

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "qbexel-tools-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the roster", () => {
	it("names every tool once and marks the writers", () => {
		expect(new Set(QBEXEL_TOOL_NAMES).size).toBe(QBEXEL_TOOL_NAMES.length);
		expect([...QBEXEL_EDIT_TOOLS].sort()).toEqual(
			[
				"addComposition",
				"analyzeStoryboard",
				"applyPrivacyFindings",
				"applyStoryboard",
				"exportSubtitles",
				"scanPrivacy",
			].sort(),
		);
		expect(QBEXEL_EDIT_TOOLS.has("getStoryboard")).toBe(false);
		expect(QBEXEL_EDIT_TOOLS.has("validateProject")).toBe(false);
	});
});

describe("the Director over MCP", () => {
	it("analyses, reads back, and applies by kind through the agent tools", async () => {
		const document = fixture();
		const empty = await runQbexelTool(document, "getStoryboard", {}, {});
		expect(parse(empty.resultJson)).toEqual({ storyboard: null });

		const analysed = await runQbexelTool(document, "analyzeStoryboard", { outroText: "Bye" }, {});
		expect(analysed.ok).toBe(true);
		expect(analysed.document?.storyboard?.scenes.length).toBeGreaterThanOrEqual(1);
		const summary = parse(analysed.resultJson);
		expect(summary.counts.proposed).toBeGreaterThan(0);
		expect(summary.suggestions.some((s: { kind: string }) => s.kind === "cut")).toBe(true);
		expect(
			summary.suggestions.some((s: { kind: string; cardKind?: string }) => s.cardKind === "outro"),
		).toBe(true);

		const withStoryboard = analysed.document as AxcutDocument;
		const nothing = await runQbexelTool(withStoryboard, "applyStoryboard", {}, {});
		expect(nothing.ok).toBe(false);
		expect(parse(nothing.resultJson).error).toMatch(/no suggestion is approved/);

		const cuts = await runQbexelTool(withStoryboard, "applyStoryboard", { kinds: ["cut"] }, {});
		expect(cuts.ok).toBe(true);
		expect(parse(cuts.resultJson).applied.length).toBeGreaterThan(0);
		expect(cuts.document?.timeline.trimRanges.length).toBeGreaterThan(0);
		expect(cuts.document?.storyboard?.suggestions.some((s) => s.status === "applied")).toBe(true);
	});

	it("refuses to analyse an empty timeline and rejects bad arguments", async () => {
		const empty = createEmptyDocument({ projectId: "p", title: "t" });
		expect((await runQbexelTool(empty, "analyzeStoryboard", {}, {})).ok).toBe(false);
		const bad = await runQbexelTool(fixture(), "applyStoryboard", { kinds: ["nope"] }, {});
		expect(bad.ok).toBe(false);
	});
});

describe("the Guardian over MCP", () => {
	it("scans the transcript when no OCR is wired, stores masked findings, and blurs only on-screen ones", async () => {
		const scanned = await runQbexelTool(fixture(), "scanPrivacy", {}, {});
		expect(scanned.ok).toBe(true);
		const summary = parse(scanned.resultJson);
		expect(summary.ocrAvailable).toBe(false);
		expect(summary.findings).toHaveLength(1);
		expect(summary.findings[0]).toMatchObject({
			kind: "card",
			preview: "•••• 1111",
			source: "transcript",
		});
		expect(scanned.resultJson).not.toContain("4111 1111 1111 1111");

		const withScan = scanned.document as AxcutDocument;
		const read = await runQbexelTool(withScan, "getPrivacyFindings", {}, {});
		expect(parse(read.resultJson).counts.suggested).toBe(1);
		const blur = await runQbexelTool(withScan, "applyPrivacyFindings", {}, {});
		expect(blur.ok).toBe(false);
		expect(parse(blur.resultJson).error).toMatch(/no open on-screen finding/);
	});

	it("uses the injected scanner when there is one", async () => {
		const document = fixture();
		const result = await runQbexelTool(
			document,
			"scanPrivacy",
			{ sampleEveryMs: 3000 },
			{
				privacy: {
					scan: async (_doc, options) => ({
						id: "scan_x",
						at: "2026-10-16T00:00:00.000Z",
						strategies: ["transcript", "ocr"],
						ocrAvailable: true,
						sampleEveryMs: options.sampleEveryMs ?? 2000,
						framesScanned: 10,
						assetIds: ["asset_1"],
						findings: [],
						warnings: [],
					}),
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(parse(result.resultJson)).toMatchObject({ ocrAvailable: true, framesScanned: 10 });
		expect(result.document?.privacy?.scan?.sampleEveryMs).toBe(3000);
	});
});

describe("compositions and subtitles over MCP", () => {
	it("adds a preset and lists it", async () => {
		const added = await runQbexelTool(fixture(), "addComposition", { preset: "shorts" }, {});
		expect(added.ok).toBe(true);
		const listed = await runQbexelTool(added.document as AxcutDocument, "listCompositions", {}, {});
		expect(parse(listed.resultJson).compositions).toHaveLength(1);
		expect(parse(listed.resultJson).compositions[0]).toMatchObject({
			preset: "shorts",
			aspectRatio: "9:16",
		});
	});

	it("writes a subtitle file only inside an allowed directory, confirmed, and never over a file", async () => {
		const allowed = path.join(dir, "allowed");
		const elsewhere = path.join(dir, "elsewhere");
		await fs.mkdir(allowed);
		await fs.mkdir(elsewhere);
		const ctx = { allowedExportDirs: () => [allowed] };
		const outside = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: path.join(elsewhere, "a.srt"), confirm: true },
			ctx,
		);
		expect(outside.ok).toBe(false);
		expect(parse(outside.resultJson).error).toMatch(/outside the allowed directories/);
		const unconfirmed = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: path.join(allowed, "a.srt") },
			ctx,
		);
		expect(unconfirmed.ok).toBe(false);
		const escaping = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: path.join(allowed, "..", "elsewhere", "b.srt"), confirm: true },
			ctx,
		);
		expect(escaping.ok).toBe(false);

		const target = path.join(allowed, "a.srt");
		const written = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: target, confirm: true },
			ctx,
		);
		expect(written.ok).toBe(true);
		expect(written.document).toBeUndefined();
		expect(await fs.readFile(target, "utf8")).toContain("-->");
		const again = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: target, confirm: true },
			ctx,
		);
		expect(again.ok).toBe(false);
		expect(parse(again.resultJson).error).toMatch(/exists/);
		const replaced = await runQbexelTool(
			fixture(),
			"exportSubtitles",
			{ format: "srt", path: target, confirm: true, overwrite: true },
			ctx,
		);
		expect(replaced.ok).toBe(true);
		expect(await isInsideAllowedDirs(target, [allowed])).toBe(true);
		expect(await isInsideAllowedDirs(path.join(elsewhere, "x.srt"), [allowed])).toBe(false);
	});
});

describe("validateProject over MCP", () => {
	it("reports problems and changes nothing", async () => {
		const document = fixture();
		const result = await runQbexelTool(
			document,
			"validateProject",
			{},
			{
				fileExists: async () => false,
			},
		);
		expect(result.ok).toBe(true);
		expect(result.document).toBeUndefined();
		const report = parse(result.resultJson);
		expect(report.ok).toBe(false);
		expect(report.problems.map((p: { kind: string }) => p.kind)).toEqual(["media-missing"]);
		const healthy = await runQbexelTool(
			document,
			"validateProject",
			{},
			{ fileExists: async () => true },
		);
		expect(parse(healthy.resultJson)).toEqual({ ok: true, problems: [] });
	});
});

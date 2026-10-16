// The scan's orchestration, with the sampler and the OCR engine stood in for: which
// recordings are read, how partial results are reported, and that the transcript is
// scanned even when frames cannot be.

import { describe, expect, it, vi } from "vitest";
import type { OcrFrame } from "../../src/lib/ai-edition/privacy/findings";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
	privacyScanSchema,
} from "../../src/lib/ai-edition/schema";
import type { OcrEngine } from "./ocr";
import { scanDocumentForSensitiveContent, scanVideoFileForSensitiveContent } from "./scan";

function fixture(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	const words = ["my", "card", "is", "4111", "1111", "1111", "1111"].map((text, i) => ({
		id: `w${i}`,
		segmentId: "s1",
		startSec: 1 + i * 0.5,
		endSec: 1.4 + i * 0.5,
		text,
	}));
	return documentSchema.parse({
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: "/recordings/take.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
			{
				id: "asset_unplaced",
				kind: "video",
				label: "spare",
				originalPath: "/recordings/spare.mp4",
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

/** Three frames per file; the OCR "reads" an email on the second and third. */
function seams(options: { failFrame?: string; dirs?: string[] } = {}) {
	const removed: string[] = [];
	const sampler = vi.fn(async (filePath: string, opts: { everyMs: number }) => ({
		frames: [0, 1, 2].map((i) => ({ timeMs: i * opts.everyMs, path: `${filePath}#${i}` })),
		dir: `/tmp/frames-${filePath.replace(/\W/g, "_")}`,
		warnings: [] as string[],
	}));
	const recognize = vi.fn(async (imagePath: string, timeMs: number): Promise<OcrFrame> => {
		if (imagePath === options.failFrame) throw new Error("boom");
		const words = timeMs === 0 ? ["Welcome", "back"] : ["Contact", "jane.doe@example.com"];
		let x = 80;
		return {
			timeMs,
			width: 1280,
			height: 720,
			lines: [
				{
					words: words.map((text) => {
						const word = {
							text,
							confidence: 92,
							bbox: { x0: x, y0: 300, x1: x + text.length * 14, y1: 330 },
						};
						x += text.length * 14 + 16;
						return word;
					}),
				},
			],
		};
	});
	const terminate = vi.fn(async () => undefined);
	const engine: OcrEngine = { recognize, terminate };
	const engineFactory = vi.fn(async () => engine);
	return { sampler, recognize, terminate, engineFactory, removed };
}

const ocr = { cachePath: "/tmp/ocr" };
let n = 0;
const ids = (prefix: string) => `${prefix}_${++n}`;

describe("scanDocumentForSensitiveContent", () => {
	it("reads only recordings on the timeline, merges frame findings, and keeps the transcript ones", async () => {
		const { sampler, recognize, terminate, engineFactory } = seams();
		const progress: number[] = [];
		const scan = await scanDocumentForSensitiveContent(fixture(), {
			ocr,
			sampler,
			engineFactory,
			createId: ids,
			now: () => new Date("2026-10-16T00:00:00Z"),
			onProgress: (p) => progress.push(p.done),
		});
		expect(() => privacyScanSchema.parse(scan)).not.toThrow();
		expect(sampler).toHaveBeenCalledTimes(1);
		expect(sampler.mock.calls[0][0]).toBe("/recordings/take.mp4");
		expect(recognize).toHaveBeenCalledTimes(3);
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(progress).toEqual([1, 2, 3]);
		expect(scan.assetIds).toEqual(["asset_1"]);
		expect(scan.ocrAvailable).toBe(true);
		expect(scan.strategies).toEqual(["transcript", "ocr"]);
		expect(scan.framesScanned).toBe(3);
		const kinds = scan.findings.map((f) => [f.kind, f.source]).sort();
		expect(kinds).toEqual([
			["card", "transcript"],
			["email", "frame"],
		]);
		const email = scan.findings.find((f) => f.kind === "email");
		expect(email?.boxes.map((b) => b.timeMs)).toEqual([2000, 4000]);
		expect(email?.preview).toBe("j••••••e@example.com");
	});

	it("widens the interval so a long recording stays within the frame cap", async () => {
		const { sampler, engineFactory } = seams();
		const document = fixture();
		document.assets[0].durationSec = 3600;
		const scan = await scanDocumentForSensitiveContent(document, {
			ocr,
			sampler,
			engineFactory,
			sampleEveryMs: 1000,
		});
		expect(sampler.mock.calls[0][1].everyMs).toBe(30000);
		expect(scan.sampleEveryMs).toBe(30000);
	});

	it("scans the transcript alone when OCR is not set up, and says so", async () => {
		const { sampler, engineFactory } = seams();
		const scan = await scanDocumentForSensitiveContent(fixture(), {
			ocr: null,
			sampler,
			engineFactory,
		});
		expect(sampler).not.toHaveBeenCalled();
		expect(scan.ocrAvailable).toBe(false);
		expect(scan.strategies).toEqual(["transcript"]);
		expect(scan.findings.map((f) => f.kind)).toEqual(["card"]);
		expect(scan.warnings.join(" ")).toMatch(/OCR is not set up/);
	});

	it("survives an engine that will not start and a frame that fails", async () => {
		const broken = await scanDocumentForSensitiveContent(fixture(), {
			ocr,
			sampler: seams().sampler,
			engineFactory: async () => {
				throw new Error("no worker");
			},
		});
		expect(broken.ocrAvailable).toBe(false);
		expect(broken.warnings.join(" ")).toMatch(/could not start \(no worker\)/);
		expect(broken.findings.map((f) => f.kind)).toEqual(["card"]);

		const { sampler, engineFactory } = seams({ failFrame: "/recordings/take.mp4#1" });
		const partial = await scanDocumentForSensitiveContent(fixture(), {
			ocr,
			sampler,
			engineFactory,
		});
		expect(partial.warnings.join(" ")).toMatch(/1 frame\(s\) could not be read/);
		const email = partial.findings.find((f) => f.kind === "email");
		expect(email?.boxes.map((b) => b.timeMs)).toEqual([4000]);
	});

	it("carries the previous review's decisions over", async () => {
		const { sampler, engineFactory } = seams();
		const first = await scanDocumentForSensitiveContent(fixture(), { ocr, sampler, engineFactory });
		const dismissedEmail = first.findings.find((f) => f.kind === "email");
		if (!dismissedEmail) throw new Error("fixture");
		const reviewed: AxcutDocument = {
			...fixture(),
			privacy: {
				version: 1,
				scan: {
					...first,
					findings: first.findings.map((f) =>
						f.id === dismissedEmail.id ? { ...f, status: "dismissed" } : f,
					),
				},
				reviewedAt: null,
				reviewedClipSignature: null,
			},
		};
		const second = await scanDocumentForSensitiveContent(reviewed, { ocr, sampler, engineFactory });
		const emailAgain = second.findings.find((f) => f.kind === "email");
		expect(emailAgain?.status).toBe("dismissed");
		expect(emailAgain?.id).toBe(dismissedEmail.id);
	});

	it("stops reading frames when cancelled, keeping what it had", async () => {
		const controller = new AbortController();
		const { sampler, engineFactory, recognize } = seams();
		recognize.mockImplementationOnce(async (_path: string, timeMs: number) => {
			controller.abort();
			return { timeMs, width: 1280, height: 720, lines: [] };
		});
		const scan = await scanDocumentForSensitiveContent(fixture(), {
			ocr,
			sampler,
			engineFactory,
			signal: controller.signal,
		});
		expect(recognize).toHaveBeenCalledTimes(1);
		expect(scan.warnings.join(" ")).toMatch(/cancelled/);
		expect(scan.findings.map((f) => f.kind)).toEqual(["card"]);
	});
});

describe("scanVideoFileForSensitiveContent", () => {
	it("reports what an exported file still shows, without touching any document", async () => {
		const { sampler, engineFactory, terminate } = seams();
		const result = await scanVideoFileForSensitiveContent("/exports/out.mp4", {
			ocr,
			sampler,
			engineFactory,
			durationSec: 6,
		});
		expect(result.framesScanned).toBe(3);
		expect(result.findings.map((f) => f.kind)).toEqual(["email"]);
		expect(result.findings[0].assetId).toBe("/exports/out.mp4");
		expect(terminate).toHaveBeenCalledTimes(1);
		const none = await scanVideoFileForSensitiveContent("/exports/out.mp4", { ocr: null });
		expect(none.findings).toEqual([]);
		expect(none.warnings).toEqual(["OCR is not set up."]);
	});
});

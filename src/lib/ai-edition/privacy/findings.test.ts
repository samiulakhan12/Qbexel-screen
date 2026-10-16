import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutPrivacyFinding,
	type AxcutPrivacyScan,
	createEmptyDocument,
	privacyFindingSchema,
} from "../schema";
import {
	carryOverDecisions,
	findingIdentity,
	frameFindings,
	mergeFrameFindings,
	type OcrFrame,
	transcriptFindings,
} from "./findings";

/** Words laid out left to right on one line, 100 px apart, 30 px tall at `y`. */
function line(y: number, words: Array<string | [string, number]>) {
	let x = 80;
	return {
		words: words.map((entry) => {
			const [text, confidence] = Array.isArray(entry) ? entry : [entry, 92];
			const width = text.length * 14;
			const word = { text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + 30 } };
			x += width + 16;
			return word;
		}),
	};
}

const frame = (timeMs: number, lines: OcrFrame["lines"]): OcrFrame => ({
	timeMs,
	width: 1280,
	height: 720,
	lines,
});

let n = 0;
const ids = (prefix: string) => `${prefix}_${++n}`;

describe("frameFindings", () => {
	it("boxes the words carrying a match, in fractions of the frame, with a margin", () => {
		const found = frameFindings(
			frame(3000, [
				line(120, ["Welcome", "to", "the", "billing", "settings"]),
				line(300, ["Contact", "jane.doe@example.com", "for", "help"]),
			]),
		);
		expect(found).toHaveLength(1);
		const [email] = found;
		expect(email.kind).toBe("email");
		expect(email.preview).toBe("j••••••e@example.com");
		// "Contact" is 7 chars → 98 px wide, so the email starts at 80 + 98 + 16 = 194 px.
		expect(email.box.timeMs).toBe(3000);
		expect(email.box.x).toBeCloseTo(194 / 1280 - 0.01, 3);
		expect(email.box.y).toBeCloseTo(300 / 720 - 0.01, 3);
		expect(email.box.w).toBeCloseTo((20 * 14) / 1280 + 0.02, 3);
		expect(email.box.h).toBeCloseTo(30 / 720 + 0.02, 3);
		expect(email.confidence).toBeLessThanOrEqual(0.9);
		expect(email.confidence).toBeGreaterThan(0.8);
	});

	it("spans several words when the value was split by the OCR", () => {
		const found = frameFindings(frame(0, [line(400, ["card", "4111", "1111", "1111", "1111"])]));
		expect(found).toHaveLength(1);
		expect(found[0].kind).toBe("card");
		// From the first digit group to the last: 4 words of 4 chars plus 3 gaps.
		expect(found[0].box.w).toBeCloseTo((4 * 56 + 3 * 16) / 1280 + 0.02, 3);
	});

	it("keeps unsure words only for detectors sure of their shape, and tempers confidence", () => {
		// A key is gibberish to an OCR engine, so it comes back unsure; its prefix is specific
		// enough to keep it, at a lower confidence.
		const key = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
		const unsureKey = frameFindings(frame(0, [line(0, [[key, 20]])]));
		expect(unsureKey.map((f) => f.kind)).toEqual(["api-key"]);
		expect(unsureKey[0].confidence).toBeLessThan(0.7);
		const sureKey = frameFindings(frame(0, [line(0, [[key, 95]])]));
		expect(sureKey[0].confidence).toBeGreaterThan(unsureKey[0].confidence);
		// A generic high-entropy run read unsurely is OCR noise, not a finding.
		const noise = frameFindings(frame(0, [line(0, [["Zq9xK2mP8vL4nR7tY1wE3uI6oA5sD0fG", 20]])]));
		expect(noise).toEqual([]);
		expect(
			frameFindings(frame(0, [line(0, [["Zq9xK2mP8vL4nR7tY1wE3uI6oA5sD0fG", 80]])])),
		).toHaveLength(1);
		// Below readable, nothing is read at all.
		expect(frameFindings(frame(0, [line(0, [[key, 5]])]))).toEqual([]);
	});

	it("finds nothing in a frame with no sensitive text", () => {
		expect(frameFindings(frame(0, [line(0, ["Click", "Save", "to", "continue"])]))).toEqual([]);
	});
});

describe("mergeFrameFindings", () => {
	it("keeps one finding per value with every box, sorted by time, at the best confidence", () => {
		const a = frameFindings(frame(2000, [line(300, ["Contact", "jane.doe@example.com"])]))[0];
		const b = frameFindings(frame(4000, [line(300, ["Contact", ["jane.doe@example.com", 60]])]))[0];
		const c = frameFindings(
			frame(4000, [line(500, ["key", "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"])]),
		)[0];
		const merged = mergeFrameFindings([b, c, a], "asset_1", ids);
		expect(merged).toHaveLength(2);
		const email = merged.find((f) => f.kind === "email");
		expect(email?.boxes.map((box) => box.timeMs)).toEqual([2000, 4000]);
		expect(email?.confidence).toBe(a.confidence);
		expect(email?.source).toBe("frame");
		expect(email?.status).toBe("suggested");
		for (const finding of merged) expect(() => privacyFindingSchema.parse(finding)).not.toThrow();
	});
});

describe("transcriptFindings", () => {
	it("flags a spoken value with the time of its words and no box", () => {
		// A card number read aloud: the transcriber writes the digit groups as words.
		const words = ["my", "card", "is", "4111", "1111", "1111", "1111", "okay"].map((text, i) => ({
			id: `w${i}`,
			segmentId: "s1",
			startSec: 1 + i * 0.5,
			endSec: 1.4 + i * 0.5,
			text,
		}));
		const found = transcriptFindings(
			{ assetId: "asset_1", language: "en", segments: [], words },
			ids,
		);
		expect(found).toHaveLength(1);
		expect(found[0].source).toBe("transcript");
		expect(found[0].kind).toBe("card");
		expect(found[0].preview).toBe("•••• 1111");
		expect(found[0].boxes).toEqual([]);
		expect(found[0].spokenStartSec).toBe(2.5);
		expect(found[0].spokenEndSec).toBeCloseTo(4.4, 6);
	});
});

describe("carryOverDecisions", () => {
	const doc = (): AxcutDocument => createEmptyDocument({ projectId: "p", title: "t" });
	const finding = (over: Partial<AxcutPrivacyFinding>): AxcutPrivacyFinding => ({
		id: "new",
		kind: "email",
		preview: "j•e@example.com",
		confidence: 0.9,
		source: "frame",
		assetId: "asset_1",
		boxes: [],
		status: "suggested",
		annotationIds: [],
		...over,
	});
	const scan = (findings: AxcutPrivacyFinding[]): AxcutPrivacyScan => ({
		id: "scan_1",
		at: "2026-10-16T00:00:00.000Z",
		strategies: ["ocr"],
		ocrAvailable: true,
		sampleEveryMs: 2000,
		framesScanned: 3,
		assetIds: ["asset_1"],
		findings,
		warnings: [],
	});

	it("keeps dismissals and accepted blurs that still exist, reopens accepted ones that are gone", () => {
		const document: AxcutDocument = {
			...doc(),
			annotations: [{ id: "ann_kept" } as AxcutDocument["annotations"][number]],
		};
		const previous = scan([
			finding({ id: "old_dismissed", status: "dismissed" }),
			finding({
				id: "old_kept",
				kind: "card",
				preview: "•••• 1111",
				status: "accepted",
				annotationIds: ["ann_kept"],
			}),
			finding({
				id: "old_gone",
				kind: "ip",
				preview: "203.0.•.•",
				status: "accepted",
				annotationIds: ["ann_gone"],
			}),
		]);
		const merged = carryOverDecisions(
			previous,
			[
				finding({ id: "n1" }),
				finding({ id: "n2", kind: "card", preview: "•••• 1111" }),
				finding({ id: "n3", kind: "ip", preview: "203.0.•.•" }),
				finding({ id: "n4", kind: "phone", preview: "+1 •••• 33" }),
			],
			document,
		);
		expect(merged.map((f) => [f.id, f.status, f.annotationIds])).toEqual([
			["old_dismissed", "dismissed", []],
			["old_kept", "accepted", ["ann_kept"]],
			["old_gone", "suggested", []],
			["n4", "suggested", []],
		]);
	});

	it("identity is kind, preview and asset", () => {
		expect(findingIdentity(finding({ id: "a" }))).toBe(findingIdentity(finding({ id: "b" })));
		expect(findingIdentity(finding({ assetId: "asset_2" }))).not.toBe(findingIdentity(finding({})));
	});
});

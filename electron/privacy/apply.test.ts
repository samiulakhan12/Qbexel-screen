import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutPrivacyFinding,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { applyPrivacyFindings } from "./apply";

const finding = (over: Partial<AxcutPrivacyFinding> = {}): AxcutPrivacyFinding => ({
	id: "f_email",
	kind: "email",
	preview: "j••••••e@example.com",
	confidence: 0.85,
	source: "frame",
	assetId: "asset_1",
	boxes: [
		{ timeMs: 4000, x: 0.15, y: 0.4, w: 0.3, h: 0.05 },
		{ timeMs: 6000, x: 0.15, y: 0.4, w: 0.3, h: 0.05 },
	],
	status: "suggested",
	annotationIds: [],
	...over,
});

function fixture(findings: AxcutPrivacyFinding[]): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
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
		],
		project: { ...base.project, primaryAssetId: "asset_1" },
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
		privacy: {
			version: 1,
			scan: {
				id: "scan_1",
				at: "2026-10-16T00:00:00.000Z",
				strategies: ["ocr"],
				ocrAvailable: true,
				sampleEveryMs: 2000,
				framesScanned: 15,
				assetIds: ["asset_1"],
				findings,
				warnings: [],
			},
			reviewedAt: "2026-10-16T00:00:00.000Z",
			reviewedClipSignature: "sig",
		},
	});
}

describe("applyPrivacyFindings", () => {
	it("writes a mosaic blur over the run through addAnnotation and records it on the finding", () => {
		const result = applyPrivacyFindings(fixture([finding()]), ["f_email"]);
		expect(result.applied).toEqual(["f_email"]);
		expect(result.failed).toEqual([]);
		const next = result.document;
		expect(() => documentSchema.parse(next)).not.toThrow();
		expect(next.annotations).toHaveLength(1);
		const blur = next.annotations[0];
		expect(blur.type).toBe("blur");
		expect(blur.startMs).toBe(3500);
		expect(blur.endMs).toBe(8500);
		expect(blur.blurData?.type).toBe("mosaic");
		const applied = next.privacy?.scan?.findings[0];
		expect(applied?.status).toBe("accepted");
		expect(applied?.annotationIds).toEqual([blur.id]);
		// New blurs reopen the "reviewed" mark.
		expect(next.privacy?.reviewedAt).toBeNull();
	});

	it("skips spoken, dismissed, accepted and unknown findings", () => {
		const document = fixture([
			finding({ id: "spoken", source: "transcript", boxes: [] }),
			finding({ id: "dismissed", status: "dismissed" }),
			finding({ id: "done", status: "accepted", annotationIds: ["ann_x"] }),
		]);
		const result = applyPrivacyFindings(document, ["spoken", "dismissed", "done", "nope"]);
		expect(result.applied).toEqual([]);
		expect(result.skipped.sort()).toEqual(["dismissed", "done", "nope", "spoken"]);
		expect(result.document.annotations).toHaveLength(0);
		expect(result.document.privacy?.reviewedAt).toBe("2026-10-16T00:00:00.000Z");
	});

	it("skips a finding seen outside every clip, and still applies the rest", () => {
		// Seen at 90 s of a recording of which only 0–30 s is on the timeline: nothing to cover.
		const offTimeline = finding({
			id: "off",
			boxes: [{ timeMs: 90_000, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }],
		});
		const result = applyPrivacyFindings(fixture([offTimeline, finding()]), ["off", "f_email"]);
		expect(result.applied).toEqual(["f_email"]);
		expect(result.failed).toEqual([]);
		expect(result.skipped).toEqual(["off"]);
		const untouched = result.document.privacy?.scan?.findings.find((f) => f.id === "off");
		expect(untouched?.status).toBe("suggested");
		expect(result.document.annotations).toHaveLength(1);
	});

	it("refuses a document without a scan", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		expect(() => applyPrivacyFindings(base, ["x"])).toThrow(/privacy scan/);
	});
});

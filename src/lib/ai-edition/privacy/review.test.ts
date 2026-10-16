import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutPrivacyFinding,
	type AxcutPrivacyReview,
	createEmptyDocument,
	documentSchema,
} from "../schema";
import { clipExtentSignature } from "../timeline/apply-auto-zooms";
import { blurCallsForFinding, blurToolArgs, boxRuns } from "./blur";
import {
	emptyPrivacyReview,
	exportGateState,
	exportNeedsAcknowledgement,
	markReviewed,
	privacyCounts,
	setFindingStatuses,
} from "./review";

function doc(
	clips: Array<[string, number, number, number]> = [["clip_1", 0, 30, 0]],
): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	return documentSchema.parse({
		...base,
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
		timeline: {
			...base.timeline,
			clips: clips.map(([id, sourceStartSec, sourceEndSec, timelineStartSec]) => ({
				id,
				assetId: "asset_1",
				sourceStartSec,
				sourceEndSec,
				timelineStartSec,
				timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
				wordRefs: [],
				origin: "user",
				reason: "",
			})),
		},
	});
}

const finding = (over: Partial<AxcutPrivacyFinding> = {}): AxcutPrivacyFinding => ({
	id: "f1",
	kind: "email",
	preview: "j•e@example.com",
	confidence: 0.9,
	source: "frame",
	assetId: "asset_1",
	boxes: [
		{ timeMs: 4000, x: 0.1, y: 0.4, w: 0.3, h: 0.05 },
		{ timeMs: 6000, x: 0.12, y: 0.4, w: 0.3, h: 0.05 },
		{ timeMs: 20000, x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
	],
	status: "suggested",
	annotationIds: [],
	...over,
});

const review = (findings: AxcutPrivacyFinding[], assetIds = ["asset_1"]): AxcutPrivacyReview => ({
	version: 1,
	scan: {
		id: "scan_1",
		at: "2026-10-16T00:00:00.000Z",
		strategies: ["ocr", "transcript"],
		ocrAvailable: true,
		sampleEveryMs: 2000,
		framesScanned: 15,
		assetIds,
		findings,
		warnings: [],
	},
	reviewedAt: null,
	reviewedClipSignature: null,
});

describe("exportGateState", () => {
	it("is unscanned without a scan, clear when nothing was found", () => {
		expect(exportGateState(doc()).state).toBe("unscanned");
		expect(exportGateState({ ...doc(), privacy: review([]) }).state).toBe("clear");
	});

	it("is unreviewed while findings wait, reviewed once all are decided", () => {
		const open = { ...doc(), privacy: review([finding()]) };
		expect(exportGateState(open)).toEqual({ state: "unreviewed", suggested: 1 });
		expect(exportNeedsAcknowledgement("unreviewed")).toBe(true);
		const decided = { ...doc(), privacy: review([finding({ status: "dismissed" })]) };
		expect(exportGateState(decided).state).toBe("reviewed");
		expect(exportNeedsAcknowledgement("reviewed")).toBe(false);
	});

	it("is reviewed when the user marked it so for this timeline, and unreviewed again after a change", () => {
		const document = doc();
		const marked = {
			...document,
			privacy: markReviewed(review([finding()]), document, () => new Date("2026-10-16T00:00:00Z")),
		};
		expect(exportGateState(marked).state).toBe("reviewed");
		expect(marked.privacy.reviewedClipSignature).toBe(clipExtentSignature(document));
		const moved = { ...marked, ...doc([["clip_1", 2, 30, 0]]), privacy: marked.privacy };
		expect(exportGateState(moved).state).toBe("unreviewed");
	});

	it("is stale when a recording on the timeline was not scanned", () => {
		const document = { ...doc(), privacy: review([finding()], ["asset_other"]) };
		expect(exportGateState(document).state).toBe("stale");
		expect(exportNeedsAcknowledgement("stale")).toBe(true);
	});
});

describe("statuses and counts", () => {
	it("counts by status and source", () => {
		expect(
			privacyCounts(
				review([
					finding({ id: "a" }),
					finding({ id: "b", status: "accepted" }),
					finding({ id: "c", status: "dismissed", source: "transcript", boxes: [] }),
				]),
			),
		).toEqual({ total: 3, suggested: 1, accepted: 1, dismissed: 1, onScreen: 2, spoken: 1 });
		expect(privacyCounts(null).total).toBe(0);
	});

	it("setFindingStatuses changes only the named findings and clears the reviewed mark", () => {
		const document = doc();
		const marked = markReviewed(review([finding({ id: "a" }), finding({ id: "b" })]), document);
		const next = setFindingStatuses(marked, new Set(["a"]), "dismissed");
		expect(next.scan?.findings.map((f) => f.status)).toEqual(["dismissed", "suggested"]);
		expect(next.reviewedAt).toBeNull();
		expect(setFindingStatuses(emptyPrivacyReview(), new Set(["a"]), "dismissed").scan).toBeNull();
	});
});

describe("blur calls", () => {
	it("groups boxes seen within two sampling intervals and unions their rectangles", () => {
		const runs = boxRuns(finding().boxes, 2000);
		expect(runs).toHaveLength(2);
		expect(runs[0]).toMatchObject({ startMs: 4000, endMs: 6000, x: 0.1, y: 0.4 });
		expect(runs[0].w).toBeCloseTo(0.32, 6);
		expect(runs[1]).toMatchObject({ startMs: 20000, endMs: 20000 });
	});

	it("maps each run onto the ruler per clip, padded, in percent of the picture", () => {
		const calls = blurCallsForFinding(finding(), doc(), 2000);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({
			startSec: 3.5,
			endSec: 8.5,
			x: 26,
			y: 42.5,
			width: 32,
			height: 5,
			clipId: "clip_1",
		});
		expect(blurToolArgs(calls[0])).toMatchObject({
			type: "blur",
			startSec: 3.5,
			endSec: 8.5,
			blurData: { type: "mosaic", shape: "rectangle" },
		});
	});

	it("splits a run across the clips it lies in and shifts it onto each clip's ruler span", () => {
		// Two clips over the same recording: 0–5 s on the ruler at 0, 5–30 s on the ruler at 10.
		const document = doc([
			["clip_a", 0, 5, 0],
			["clip_b", 5, 30, 10],
		]);
		const calls = blurCallsForFinding(finding(), document, 2000);
		// The first run (3.5–8.5 s of source) lands in both clips; the second only in clip_b.
		expect(calls.map((c) => [c.clipId, c.startSec, c.endSec])).toEqual([
			["clip_a", 3.5, 5],
			["clip_b", 10, 13.5],
			["clip_b", 24.5, 27.5],
		]);
	});

	it("produces nothing for a spoken finding", () => {
		expect(blurCallsForFinding(finding({ boxes: [], source: "transcript" }), doc(), 2000)).toEqual(
			[],
		);
	});
});

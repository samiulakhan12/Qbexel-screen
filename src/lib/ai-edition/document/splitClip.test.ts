import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import { clipAtRawSec, moveClip, splitClipAt, splitClipAtRawSec } from "./timeline";

function doc() {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video" as const,
				label: "take",
				originalPath: "/tmp/take.mp4",
				durationSec: 10,
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
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
			trimRanges: [
				{
					id: "trim_1",
					assetId: "asset_1",
					clipId: "clip_1",
					startSec: 3,
					endSec: 5,
					reason: "",
					origin: "user" as const,
				},
			],
		},
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 2000,
				endMs: 6000,
				clipId: "clip_1",
				sourceStartSec: 2,
				sourceEndSec: 6,
				depth: 3 as const,
				focus: { cx: 0.5, cy: 0.5 },
			},
		],
	};
}

describe("clipAtRawSec", () => {
	it("maps a ruler second to the clip and its source second", () => {
		const d = doc();
		expect(clipAtRawSec(d.timeline.clips, 4)).toEqual({ clip: d.timeline.clips[0], sourceSec: 4 });
		expect(clipAtRawSec(d.timeline.clips, 10)?.sourceSec).toBe(10);
		expect(clipAtRawSec(d.timeline.clips, 11)).toBeNull();
	});
});

describe("splitClipAt", () => {
	it("makes two clips that meet in media time and stay apart", () => {
		const next = splitClipAt(doc(), "clip_1", 4);
		const clips = next.timeline.clips;
		expect(clips).toHaveLength(2);
		expect(clips[0]).toMatchObject({
			id: "clip_1",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		expect(clips[1]).toMatchObject({
			sourceStartSec: 4,
			sourceEndSec: 10,
			timelineStartSec: 4,
			timelineEndSec: 10,
			cut: true,
		});
		expect(clips[1].id).not.toBe("clip_1");
	});

	it("splits a zoom across the cut into one fragment per piece", () => {
		const next = splitClipAt(doc(), "clip_1", 4);
		const [left, right] = next.timeline.clips;
		const onLeft = next.zoomRanges.filter((z) => z.clipId === left.id);
		const onRight = next.zoomRanges.filter((z) => z.clipId === right.id);
		expect(onLeft).toHaveLength(1);
		expect(onRight).toHaveLength(1);
		expect(onLeft[0]).toMatchObject({
			sourceStartSec: 2,
			sourceEndSec: 4,
			startMs: 2000,
			endMs: 4000,
		});
		expect(onRight[0]).toMatchObject({
			sourceStartSec: 4,
			sourceEndSec: 6,
			startMs: 4000,
			endMs: 6000,
		});
	});

	it("keeps a trim on the piece that holds it, clamped to that piece", () => {
		const next = splitClipAt(doc(), "clip_1", 4);
		const [left, right] = next.timeline.clips;
		const trims = next.timeline.trimRanges;
		expect(trims.filter((t) => t.clipId === left.id)).toEqual([
			expect.objectContaining({ startSec: 3, endSec: 4 }),
		]);
		expect(trims.filter((t) => t.clipId === right.id)).toEqual([
			expect.objectContaining({ startSec: 4, endSec: 5 }),
		]);
	});

	it("refuses a cut at or too near an edge", () => {
		expect(() => splitClipAt(doc(), "clip_1", 0)).toThrow(/too close/);
		expect(() => splitClipAt(doc(), "clip_1", 9.99)).toThrow(/too close/);
		expect(() => splitClipAt(doc(), "clip_x", 4)).toThrow(/Unknown clip/);
	});

	it("splits at the playhead's ruler second", () => {
		const next = splitClipAtRawSec(doc(), 7);
		expect(next.timeline.clips.map((c) => c.sourceEndSec)).toEqual([7, 10]);
		expect(() => splitClipAtRawSec(doc(), 42)).toThrow(/No clip/);
	});

	it("a moved piece drops the cut marker and may fold back when it meets its neighbour", () => {
		const split = splitClipAt(doc(), "clip_1", 4);
		const right = split.timeline.clips[1];
		// Moving the right piece to the front and back again puts it beside its neighbour
		// without the marker: the two are media-contiguous again and fold into one clip.
		const moved = moveClip(split, right.id, 0);
		expect(moved.timeline.clips.map((c) => c.id)).toEqual([right.id, "clip_1"]);
		const back = moveClip(moved, right.id, 1);
		expect(back.timeline.clips).toHaveLength(1);
		expect(back.timeline.clips[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 10 });
	});
});

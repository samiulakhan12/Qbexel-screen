import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./schema";
import { addTitleCard, titleCardBox, titleCardRegion, titleCardSpanMs } from "./titleCards";

function doc(durationSec = 20) {
	const base = createEmptyDocument({ projectId: "p", title: "Demo" });
	return {
		...base,
		assets: [
			{
				id: "a",
				kind: "video" as const,
				label: "t",
				originalPath: "/x.mp4",
				durationSec,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "user" as const,
					reason: "",
				},
			],
		},
	};
}

describe("titleCardSpanMs", () => {
	it("puts an intro at the head and an outro at the tail, clamped to the programme", () => {
		expect(titleCardSpanMs("intro", 20)).toEqual({ startMs: 0, endMs: 3000 });
		expect(titleCardSpanMs("outro", 20, 4)).toEqual({ startMs: 16000, endMs: 20000 });
		expect(titleCardSpanMs("intro", 2, 10)).toEqual({ startMs: 0, endMs: 2000 });
		expect(titleCardSpanMs("outro", 20, 99).startMs).toBe(5000);
	});
});

describe("titleCardBox", () => {
	it("centres a box sized to the longest line and never exceeds the frame", () => {
		const box = titleCardBox("Create an order", 72, 16 / 9);
		expect(box.position.x + box.size.width / 2).toBeCloseTo(50, 5);
		expect(box.position.y + box.size.height / 2).toBeCloseTo(50, 5);
		const huge = titleCardBox("x".repeat(400), 72, 9 / 16);
		expect(huge.size.width).toBeLessThanOrEqual(96);
	});
});

describe("addTitleCard", () => {
	it("adds an anchored intro text annotation on the first clip", () => {
		const next = addTitleCard(doc(), {
			kind: "intro",
			text: "Create an order",
			frameAspect: 16 / 9,
		});
		expect(next.annotations).toHaveLength(1);
		const card = next.annotations[0];
		expect(card).toMatchObject({
			type: "text",
			content: "Create an order",
			space: "frame",
			startMs: 0,
			endMs: 3000,
			clipId: "c1",
			sourceStartSec: 0,
			sourceEndSec: 3,
		});
		expect(card.style.textAnimation).toBe("rise");
	});

	it("an outro fades and sits on the tail", () => {
		const next = addTitleCard(doc(), {
			kind: "outro",
			text: "",
			frameAspect: 16 / 9,
			durationSec: 5,
		});
		expect(next.annotations[0]).toMatchObject({
			content: "Thanks for watching",
			startMs: 15000,
			endMs: 20000,
		});
		expect(next.annotations[0].style.textAnimation).toBe("fade");
	});

	it("refuses an empty timeline", () => {
		expect(() => addTitleCard(doc(0), { kind: "intro", text: "x", frameAspect: 1 })).toThrow(
			/no footage/,
		);
	});

	it("titleCardRegion is pure and validates against the annotation shape", () => {
		const region = titleCardRegion({ kind: "intro", text: "Hi", frameAspect: 1 }, 10, 1);
		expect(region.position.x).toBeGreaterThanOrEqual(0);
		expect(region.size.width).toBeGreaterThan(0);
	});
});

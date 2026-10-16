import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import {
	cuesToSrt,
	cuesToWebVtt,
	formatSubtitleTime,
	projectCuesToProgramme,
	subtitleCuesForDocument,
} from "./subtitles";

function docWithClip(
	trims: Array<[number, number]> = [],
	speed?: { startMs: number; endMs: number; speed: number },
) {
	const doc = createEmptyDocument({ projectId: "p", title: "t" });
	const asset = {
		id: "asset_1",
		kind: "video" as const,
		label: "take",
		originalPath: "/tmp/take.mp4",
		durationSec: 20,
		cameraTrack: null,
	};
	return {
		...doc,
		assets: [asset],
		project: { ...doc.project, primaryAssetId: "asset_1" },
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
					origin: "user" as const,
					reason: "",
				},
			],
			trimRanges: trims.map(([startSec, endSec], i) => ({
				id: `trim_${i}`,
				assetId: "asset_1",
				clipId: "clip_1",
				startSec,
				endSec,
				reason: "",
				origin: "user" as const,
			})),
		},
		legacyEditor: speed ? { speedRegions: [{ id: "sp", ...speed }] } : null,
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: [
					{
						id: "s1",
						kind: "speech" as const,
						startSec: 1,
						endSec: 3,
						text: "Hello there friend",
						wordIds: ["w1", "w2", "w3"],
					},
				],
				words: [
					{ id: "w1", segmentId: "s1", startSec: 1, endSec: 1.6, text: "Hello" },
					{ id: "w2", segmentId: "s1", startSec: 1.7, endSec: 2.3, text: "there" },
					{ id: "w3", segmentId: "s1", startSec: 2.4, endSec: 3, text: "friend" },
				],
			},
		],
	};
}

describe("formatSubtitleTime", () => {
	it("writes hours, minutes, seconds and millis with the format's separator", () => {
		expect(formatSubtitleTime(3_723_456, ",")).toBe("01:02:03,456");
		expect(formatSubtitleTime(5, ".")).toBe("00:00:00.005");
		expect(formatSubtitleTime(-10, ",")).toBe("00:00:00,000");
	});
});

describe("projectCuesToProgramme", () => {
	it("is the identity without trims or speed", () => {
		const doc = docWithClip();
		const cues = [{ id: "c", startMs: 1000, endMs: 3000, text: "x" }];
		expect(projectCuesToProgramme(cues, doc)).toEqual([{ startMs: 1000, endMs: 3000, text: "x" }]);
	});

	it("shifts a cue after a cut by the cut's length and drops one inside the cut", () => {
		const doc = docWithClip([[4, 6]]);
		const cues = [
			{ id: "a", startMs: 1000, endMs: 2000, text: "before" },
			{ id: "b", startMs: 4200, endMs: 5800, text: "inside" },
			{ id: "c", startMs: 8000, endMs: 9000, text: "after" },
		];
		expect(projectCuesToProgramme(cues, doc)).toEqual([
			{ startMs: 1000, endMs: 2000, text: "before" },
			{ startMs: 6000, endMs: 7000, text: "after" },
		]);
	});

	it("keeps the surviving part of a cue a cut interrupts", () => {
		const doc = docWithClip([[1500, 1500 + 1000].map((v) => v / 1000) as [number, number]]);
		const cues = [{ id: "a", startMs: 1000, endMs: 3000, text: "cut through" }];
		expect(projectCuesToProgramme(cues, doc)).toEqual([
			{ startMs: 1000, endMs: 2000, text: "cut through" },
		]);
	});

	it("compresses a cue under a 2x speed region", () => {
		const doc = docWithClip([], { startMs: 0, endMs: 10_000, speed: 2 });
		const cues = [{ id: "a", startMs: 2000, endMs: 4000, text: "fast" }];
		expect(projectCuesToProgramme(cues, doc)).toEqual([
			{ startMs: 1000, endMs: 2000, text: "fast" },
		]);
	});
});

describe("renderers", () => {
	const cues = [
		{ startMs: 1000, endMs: 2500, text: "Hello there" },
		{ startMs: 3000, endMs: 4000, text: "a --> b & <c>" },
	];

	it("writes SRT with numbered blocks and comma millis", () => {
		expect(cuesToSrt(cues)).toBe(
			"1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\na → b & <c>\n",
		);
		expect(cuesToSrt([])).toBe("");
	});

	it("writes WebVTT with the header, dot millis and escaped markup", () => {
		expect(cuesToWebVtt(cues)).toBe(
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there\n\n00:00:03.000 --> 00:00:04.000\na → b &amp; &lt;c&gt;\n",
		);
		expect(cuesToWebVtt([])).toBe("WEBVTT\n\n");
	});
});

describe("subtitleCuesForDocument", () => {
	it("derives cues from the transcript even when burn-in captions are off", () => {
		const cues = subtitleCuesForDocument(docWithClip(), 16 / 9);
		expect(cues.length).toBeGreaterThan(0);
		expect(cues.map((c) => c.text).join(" ")).toContain("Hello");
		expect(cues[0].startMs).toBe(1000);
	});
});

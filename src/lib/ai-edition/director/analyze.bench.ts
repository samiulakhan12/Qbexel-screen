// How long the Director's deterministic pass takes on a long recording — a synthetic
// 30-minute transcript (about 4,500 words, a pause every few sentences) with one click a
// second. Run with `npx vitest bench --run src/lib/ai-edition/director/analyze.bench.ts`;
// the numbers in TESTING.md come from here.

import { bench, describe } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, type AxcutWord, createEmptyDocument, documentSchema } from "../schema";
import { analyzeStoryboard } from "./analyze";

function longRecording(minutes: number): {
	document: AxcutDocument;
	telemetry: Map<string, CursorTelemetryPoint[]>;
} {
	const durationSec = minutes * 60;
	const words: AxcutWord[] = [];
	const vocabulary = "open the settings page and click save then choose the yearly plan".split(" ");
	let t = 1;
	let i = 0;
	while (t < durationSec - 2) {
		words.push({
			id: `w${i}`,
			segmentId: `s${Math.floor(i / 12)}`,
			startSec: t,
			endSec: t + 0.3,
			text: vocabulary[i % vocabulary.length],
		});
		i += 1;
		// A pause of 2 s every twelve words, a breath otherwise.
		t += i % 12 === 0 ? 2.4 : 0.4;
	}
	const telemetry: CursorTelemetryPoint[] = [];
	for (let s = 0; s < durationSec; s += 0.2) {
		telemetry.push({
			timeMs: Math.round(s * 1000),
			cx: (s % 7) / 7,
			cy: (s % 5) / 5,
			visible: true,
			interactionType: Math.round(s * 5) % 5 === 0 ? "click" : "move",
		});
	}
	const base = createEmptyDocument({ projectId: "bench", title: "Bench" });
	const document = documentSchema.parse({
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: "/tmp/take.mp4",
				durationSec,
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
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
	return { document, telemetry: new Map([["asset_1", telemetry]]) };
}

const thirty = longRecording(30);
const five = longRecording(5);

describe("analyzeStoryboard", () => {
	bench("5-minute recording with clicks", () => {
		analyzeStoryboard(five.document, { telemetryByAssetId: five.telemetry });
	});
	bench("30-minute recording with clicks", () => {
		analyzeStoryboard(thirty.document, { telemetryByAssetId: thirty.telemetry });
	});
});

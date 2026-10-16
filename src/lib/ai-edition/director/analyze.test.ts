import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import {
	type AxcutDocument,
	type AxcutStoryboard,
	type AxcutWord,
	createEmptyDocument,
	documentSchema,
} from "../schema";
import {
	analyzeStoryboard,
	findRetakes,
	heuristicTitle,
	MAX_SCENE_SEC,
	SCENE_PAUSE_SEC,
	SILENCE_CUT_SEC,
} from "./analyze";

/** A phrase as words, one every 0.4 s from `startSec`, each 0.3 s long. */
function phrase(startSec: number, text: string, segmentId: string, offset: number): AxcutWord[] {
	return text.split(" ").map((word, index) => ({
		id: `word_${offset + index}`,
		segmentId,
		startSec: round(startSec + index * 0.4),
		endSec: round(startSec + index * 0.4 + 0.3),
		text: word,
	}));
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

interface Speech {
	startSec: number;
	text: string;
}

/** One asset, one clip over `durationSec`, said phrases, recorded clicks. */
function doc(options: {
	durationSec?: number;
	speech?: Speech[];
	title?: string;
	clipRange?: [number, number];
}): AxcutDocument {
	const durationSec = options.durationSec ?? 30;
	const base = createEmptyDocument({ projectId: "p", title: options.title ?? "Onboarding tour" });
	const words: AxcutWord[] = [];
	const segments = [];
	let offset = 0;
	for (const [index, speech] of (options.speech ?? []).entries()) {
		const segmentId = `seg_${index}`;
		const spoken = phrase(speech.startSec, speech.text, segmentId, offset);
		offset += spoken.length;
		words.push(...spoken);
		segments.push({
			id: segmentId,
			kind: "speech" as const,
			startSec: spoken[0].startSec,
			endSec: spoken[spoken.length - 1].endSec,
			text: speech.text,
			wordIds: spoken.map((word) => word.id),
		});
	}
	const [sourceStartSec, sourceEndSec] = options.clipRange ?? [0, durationSec];
	return documentSchema.parse({
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
		project: { ...base.project, primaryAssetId: "asset_1" },
		transcripts: words.length ? [{ assetId: "asset_1", language: "en", segments, words }] : [],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec,
					sourceEndSec,
					timelineStartSec: 0,
					timelineEndSec: sourceEndSec - sourceStartSec,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

function clicksAt(...secs: number[]): Map<string, CursorTelemetryPoint[]> {
	const samples: CursorTelemetryPoint[] = [];
	for (let t = 0; t <= 60; t += 0.5) {
		samples.push({ timeMs: t * 1000, cx: 0.5, cy: 0.5, visible: true, interactionType: "move" });
	}
	for (const sec of secs) {
		samples.push({
			timeMs: sec * 1000,
			cx: 0.25,
			cy: 0.75,
			visible: true,
			interactionType: "click",
		});
	}
	samples.sort((a, b) => a.timeMs - b.timeMs);
	return new Map([["asset_1", samples]]);
}

let counter = 0;
const stableIds = (prefix: string) => `${prefix}_${++counter}`;
const analyze = (document: AxcutDocument, extra: Parameters<typeof analyzeStoryboard>[1] = {}) =>
	analyzeStoryboard(document, {
		createId: stableIds,
		now: () => new Date("2026-10-16T00:00:00.000Z"),
		...extra,
	});

describe("analyzeStoryboard", () => {
	it("returns an empty storyboard for a timeline without clips", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		const storyboard = analyze(base);
		expect(storyboard.scenes).toEqual([]);
		expect(storyboard.suggestions).toEqual([]);
		expect(storyboard.version).toBe(1);
	});

	it("validates against the document schema", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar" },
				{ startSec: 8, text: "Click the billing tab to see your plan" },
			],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(2, 9) });
		expect(() => documentSchema.parse({ ...document, storyboard })).not.toThrow();
	});

	it("starts a new scene at a long pause in speech, never crossing a clip", () => {
		const document = doc({
			durationSec: 30,
			speech: [
				{ startSec: 1, text: "First we open the dashboard and look around" },
				// Ends 1 + 7 × 0.4 + 0.3 = 4.1 s, so the first scene is long enough; a pause of
				// nearly 4 s follows.
				{ startSec: 8, text: "Then we create a new project from the menu" },
			],
		});
		const storyboard = analyze(document);
		expect(storyboard.scenes).toHaveLength(2);
		const [first, second] = storyboard.scenes;
		expect(first.startMs).toBe(0);
		expect(second.startMs).toBeGreaterThan(4100);
		expect(second.startMs).toBeLessThanOrEqual(8000);
		expect(second.endMs).toBe(30000);
		expect(first.clipId).toBe("clip_1");
		expect(first.narration).toBe("First we open the dashboard and look around");
		expect(second.narration).toBe("Then we create a new project from the menu");
	});

	it("does not split on a pause shorter than SCENE_PAUSE_SEC, nor before MIN_SCENE_SEC", () => {
		const short = doc({
			speech: [
				{ startSec: 1, text: "First we open the dashboard and look around" },
				{ startSec: 4.1 + SCENE_PAUSE_SEC - 0.2, text: "and then keep talking for a while longer" },
			],
		});
		expect(analyze(short).scenes).toHaveLength(1);
		const early = doc({
			speech: [
				{ startSec: 0.5, text: "First we open the dashboard" },
				{ startSec: 8, text: "Then we create a new project from the menu" },
			],
		});
		expect(analyze(early).scenes).toHaveLength(1);
	});

	it("splits a long scene without pauses at MAX_SCENE_SEC pieces", () => {
		const document = doc({ durationSec: 100 });
		const storyboard = analyze(document);
		expect(storyboard.scenes.length).toBe(Math.ceil(100 / MAX_SCENE_SEC));
		for (const scene of storyboard.scenes) {
			expect(scene.endMs - scene.startMs).toBeLessThanOrEqual(MAX_SCENE_SEC * 1000 + 1);
		}
	});

	it("keeps observed clicks apart from inferred titles", () => {
		const document = doc({
			speech: [{ startSec: 1, text: "Open the settings page from the sidebar" }],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(2.2) });
		const scene = storyboard.scenes[0];
		expect(scene.observed).toEqual([{ kind: "click", atMs: 2200, cx: 0.25, cy: 0.75 }]);
		expect(scene.inferred.every((inference) => inference.source === "heuristic")).toBe(true);
		expect(scene.title).toBe("Open the settings page from the sidebar");
		expect(scene.inferred.find((inference) => inference.kind === "step")).toBeTruthy();
	});

	it("places the scene on the ruler when the clip starts inside its source", () => {
		const document = doc({
			durationSec: 30,
			clipRange: [10, 30],
			speech: [{ startSec: 12, text: "Choose a template to begin" }],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(15) });
		expect(storyboard.scenes[0].startMs).toBe(0);
		expect(storyboard.scenes[0].endMs).toBe(20000);
		expect(storyboard.scenes[0].observed[0].atMs).toBe(5000);
		expect(storyboard.scenes[0].narration).toBe("Choose a template to begin");
	});

	it("proposes cutting a silent pause, keeping a breath on each side", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar" },
				// Ends 1 + 6*0.4 + 0.3 = 3.7 s. Pause of 4.3 s.
				{ startSec: 8, text: "Click the billing tab to see your plan" },
			],
		});
		const storyboard = analyze(document);
		const cuts = storyboard.suggestions.filter((s) => s.kind === "cut");
		const silence = cuts.find((s) => s.kind === "cut" && s.reason === "silence");
		expect(silence).toBeTruthy();
		if (silence?.kind !== "cut") throw new Error("unreachable");
		expect(silence.sourceStartSec).toBeCloseTo(3.7 + 0.3, 3);
		expect(silence.sourceEndSec).toBeCloseTo(8 - 0.3, 3);
		expect(silence.clipId).toBe("clip_1");
		expect(silence.assetId).toBe("asset_1");
		expect(silence.status).toBe("proposed");
		expect(silence.source).toBe("heuristic");
	});

	it("does not cut a pause the user clicked through", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar" },
				{ startSec: 8, text: "Click the billing tab to see your plan" },
			],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(5.5) });
		expect(storyboard.suggestions.some((s) => s.kind === "cut" && s.reason === "silence")).toBe(
			false,
		);
		// The pause is still an observed fact of the scene.
		expect(
			storyboard.scenes.flatMap((scene) => scene.observed).some((e) => e.kind === "silence"),
		).toBe(true);
	});

	it("proposes lead-in and tail cuts, ignoring the stop click", () => {
		const document = doc({
			durationSec: 20,
			speech: [{ startSec: 4, text: "Open the settings page from the sidebar" }],
		});
		// Last word ends 4 + 6*0.4 + 0.3 = 6.7 s; the stop click sits at 19.8 s.
		const telemetry = clicksAt(19.8);
		const samples = telemetry.get("asset_1") ?? [];
		telemetry.set(
			"asset_1",
			samples.filter((sample) => sample.timeMs <= 20000),
		);
		const storyboard = analyze(document, { telemetryByAssetId: telemetry });
		const reasons = storyboard.suggestions
			.filter((s) => s.kind === "cut")
			.map((s) => (s.kind === "cut" ? s.reason : ""));
		expect(reasons).toContain("lead-in");
		expect(reasons).toContain("tail");
		const tail = storyboard.suggestions.find((s) => s.kind === "cut" && s.reason === "tail");
		if (tail?.kind !== "cut") throw new Error("unreachable");
		expect(tail.sourceStartSec).toBeCloseTo(6.7 + 0.5, 3);
		expect(tail.sourceEndSec).toBe(20);
	});

	it("skips a cut that overlaps a trim already on the clip", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar" },
				{ startSec: 8, text: "Click the billing tab to see your plan" },
			],
		});
		const trimmed: AxcutDocument = {
			...document,
			timeline: {
				...document.timeline,
				trimRanges: [
					{
						id: "trim_1",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 5,
						endSec: 6,
						reason: "",
						origin: "user",
					},
				],
			},
		};
		const storyboard = analyze(trimmed);
		expect(storyboard.suggestions.some((s) => s.kind === "cut" && s.reason === "silence")).toBe(
			false,
		);
	});

	it("detects a retake and proposes cutting the first attempt", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Now we open the billing tab and" },
				{ startSec: 5, text: "Now we open the billing tab and pick the yearly plan" },
			],
		});
		const storyboard = analyze(document);
		const retake = storyboard.suggestions.find((s) => s.kind === "cut" && s.reason === "retake");
		if (retake?.kind !== "cut") throw new Error("no retake cut");
		expect(retake.sourceStartSec).toBe(1);
		expect(retake.sourceEndSec).toBeCloseTo(5 - 0.3, 3);
		expect(storyboard.scenes[0].inferred.some((inference) => inference.kind === "retake")).toBe(
			true,
		);
	});

	it("turns click clusters into zoom suggestions filed under their scene", () => {
		const document = doc({
			durationSec: 30,
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar first" },
				{ startSec: 12, text: "Click the billing tab to see your plan" },
			],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(13, 13.6, 14.2) });
		expect(storyboard.scenes).toHaveLength(2);
		const zooms = storyboard.suggestions.filter((s) => s.kind === "zoom");
		expect(zooms.length).toBeGreaterThan(0);
		const zoom = zooms[0];
		if (zoom.kind !== "zoom") throw new Error("unreachable");
		expect(zoom.sceneId).toBe(storyboard.scenes[1].id);
		expect(zoom.startMs).toBeLessThanOrEqual(13000);
		expect(zoom.focus.cx).toBeCloseTo(0.25, 2);
		expect(zoom.depth).toBeGreaterThanOrEqual(1);
	});

	it("proposes a callout naming the step beside its first click", () => {
		const document = doc({
			speech: [{ startSec: 1, text: "Open the settings page from the sidebar" }],
		});
		const storyboard = analyze(document, { telemetryByAssetId: clicksAt(2) });
		const callout = storyboard.suggestions.find((s) => s.kind === "callout");
		if (callout?.kind !== "callout") throw new Error("no callout");
		expect(callout.startMs).toBe(2000);
		expect(callout.endMs).toBe(4500);
		expect(callout.text).toBe("Open the settings page from the sidebar");
		expect(callout.x).toBe(25);
		expect(callout.y).toBe(63);
	});

	it("proposes an intro card from the title and an outro from the caller's text", () => {
		const document = doc({ durationSec: 30, title: "  Billing walkthrough " });
		const storyboard = analyze(document, { outroText: "Thanks for watching" });
		const cards = storyboard.suggestions.filter((s) => s.kind === "titleCard");
		expect(cards.map((card) => (card.kind === "titleCard" ? card.cardKind : ""))).toEqual([
			"intro",
			"outro",
		]);
		expect(cards[0].kind === "titleCard" && cards[0].text).toBe("Billing walkthrough");
		// No outro text, no outro card; a short programme gets no cards at all.
		expect(analyze(document).suggestions.filter((s) => s.kind === "titleCard")).toHaveLength(1);
		expect(
			analyze(doc({ durationSec: 8 }), { outroText: "x" }).suggestions.filter(
				(s) => s.kind === "titleCard",
			),
		).toHaveLength(0);
	});

	it("carries approved and rejected decisions over to the next analysis", () => {
		const document = doc({
			speech: [
				{ startSec: 1, text: "Open the settings page from the sidebar" },
				{ startSec: 8, text: "Click the billing tab to see your plan" },
			],
		});
		const first = analyze(document);
		const silence = first.suggestions.find((s) => s.kind === "cut");
		const intro = first.suggestions.find((s) => s.kind === "titleCard");
		if (!silence || !intro) throw new Error("fixture");
		const reviewed: AxcutStoryboard = {
			...first,
			suggestions: first.suggestions.map((s) =>
				s.id === silence.id
					? { ...s, status: "approved" }
					: s.id === intro.id
						? { ...s, status: "rejected" }
						: s,
			),
		};
		const second = analyze(document, { previous: reviewed });
		const silenceAgain = second.suggestions.find((s) => s.kind === "cut");
		const introAgain = second.suggestions.find((s) => s.kind === "titleCard");
		expect(silenceAgain?.status).toBe("approved");
		expect(silenceAgain?.id).toBe(silence.id);
		expect(introAgain?.status).toBe("rejected");
		expect(second.clipSignature).toBe(first.clipSignature);
	});
});

describe("heuristicTitle", () => {
	it("takes the first sentence, eight words at most, capitalised and unpunctuated", () => {
		expect(heuristicTitle("open the settings page. Then more.")).toBe("Open the settings page");
		expect(heuristicTitle("one two three four five six seven eight nine ten")).toBe(
			"One two three four five six seven eight",
		);
		expect(heuristicTitle("   ")).toBe("");
	});
});

describe("findRetakes", () => {
	it("needs four shared opening words and a second attempt at least as long", () => {
		const seg = (id: string, startSec: number, text: string) => ({
			id,
			kind: "speech" as const,
			startSec,
			endSec: startSec + 2,
			text,
			wordIds: [],
		});
		expect(
			findRetakes([
				seg("a", 0, "So now we click the"),
				seg("b", 3, "So now we click the save button"),
			]),
		).toHaveLength(1);
		expect(
			findRetakes([seg("a", 0, "So now we"), seg("b", 3, "So now we click the save button")]),
		).toHaveLength(0);
		expect(
			findRetakes([
				seg("a", 0, "So now we click the save button and wait"),
				seg("b", 3, "So now we click"),
			]),
		).toHaveLength(0);
		expect(
			findRetakes([
				seg("a", 0, "So now we click the"),
				seg("b", 20, "So now we click the save button"),
			]),
		).toHaveLength(0);
	});
});

describe("constants", () => {
	it("cuts only pauses the scene splitter would also notice", () => {
		expect(SILENCE_CUT_SEC).toBeGreaterThanOrEqual(SCENE_PAUSE_SEC);
	});
});

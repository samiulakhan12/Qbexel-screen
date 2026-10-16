import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutStoryboard,
	type AxcutStoryboardSuggestion,
	createEmptyDocument,
	documentSchema,
} from "../../../src/lib/ai-edition/schema";
import { applyStoryboardSuggestions } from "./apply";

function fixture(suggestions: AxcutStoryboardSuggestion[]): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "Billing tour" });
	const storyboard: AxcutStoryboard = {
		version: 1,
		generatedAt: "2026-10-16T00:00:00.000Z",
		clipSignature: "sig",
		enrichment: null,
		scenes: [
			{
				id: "scene_1",
				order: 0,
				title: "Open billing",
				startMs: 0,
				endMs: 30000,
				clipId: "clip_1",
				narration: "",
				observed: [],
				inferred: [],
			},
		],
		suggestions,
	};
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
		storyboard,
	});
}

const common = {
	sceneId: "scene_1",
	source: "heuristic" as const,
	rationale: "",
	appliedIds: [] as string[],
};
type ZoomSuggestion = Extract<AxcutStoryboardSuggestion, { kind: "zoom" }>;

const cut: AxcutStoryboardSuggestion = {
	...common,
	id: "s_cut",
	kind: "cut",
	status: "approved",
	reason: "silence",
	assetId: "asset_1",
	clipId: "clip_1",
	sourceStartSec: 4,
	sourceEndSec: 6,
};
const zoom: ZoomSuggestion = {
	...common,
	id: "s_zoom",
	kind: "zoom",
	status: "approved",
	startMs: 10000,
	endMs: 14000,
	focus: { cx: 0.25, cy: 0.75 },
	depth: 3,
};
const callout: AxcutStoryboardSuggestion = {
	...common,
	id: "s_callout",
	kind: "callout",
	status: "proposed",
	startMs: 10000,
	endMs: 12500,
	text: "Open billing",
	x: 25,
	y: 63,
};
const intro: AxcutStoryboardSuggestion = {
	...common,
	id: "s_intro",
	kind: "titleCard",
	status: "approved",
	cardKind: "intro",
	text: "Billing tour",
};
const rejected: AxcutStoryboardSuggestion = {
	...common,
	id: "s_rejected",
	kind: "zoom",
	status: "rejected",
	startMs: 20000,
	endMs: 22000,
	focus: { cx: 0.5, cy: 0.5 },
	depth: 2,
};

describe("applyStoryboardSuggestions", () => {
	it("writes each approved suggestion through its agent tool and records what it created", () => {
		const document = fixture([cut, zoom, callout, intro, rejected]);
		const result = applyStoryboardSuggestions(document, [
			"s_cut",
			"s_zoom",
			"s_callout",
			"s_intro",
			"s_rejected",
			"s_unknown",
		]);
		expect(result.applied).toEqual(["s_cut", "s_zoom", "s_callout", "s_intro"]);
		expect(result.failed).toEqual([]);
		expect(result.skipped.sort()).toEqual(["s_rejected", "s_unknown"]);

		const next = result.document;
		expect(() => documentSchema.parse(next)).not.toThrow();
		expect(next.timeline.trimRanges).toHaveLength(1);
		expect(next.timeline.trimRanges[0]).toMatchObject({
			assetId: "asset_1",
			clipId: "clip_1",
			startSec: 4,
			endSec: 6,
			origin: "agent",
		});
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({ startMs: 10000, endMs: 14000, depth: 3 });
		// The callout and the intro card are both text annotations.
		expect(next.annotations).toHaveLength(2);
		// The callout stores its words as the editor's text annotation does; the title card is
		// placed by `titleCards.ts`, which keeps them in `content`.
		expect(
			next.annotations.map((annotation) => annotation.textContent || annotation.content),
		).toEqual(["Open billing", "Billing tour"]);

		const statuses = Object.fromEntries(
			(next.storyboard?.suggestions ?? []).map((s) => [s.id, s.status]),
		);
		expect(statuses).toEqual({
			s_cut: "applied",
			s_zoom: "applied",
			s_callout: "applied",
			s_intro: "applied",
			s_rejected: "rejected",
		});
		const appliedCut = next.storyboard?.suggestions.find((s) => s.id === "s_cut");
		expect(appliedCut?.appliedIds).toEqual([next.timeline.trimRanges[0].id]);
		const appliedZoom = next.storyboard?.suggestions.find((s) => s.id === "s_zoom");
		expect(appliedZoom?.appliedIds).toEqual([next.zoomRanges[0].id]);
		const appliedIntro = next.storyboard?.suggestions.find((s) => s.id === "s_intro");
		expect(appliedIntro?.appliedIds).toContain(next.annotations[1].id);
	});

	it("applies only the ids asked for", () => {
		const document = fixture([cut, zoom]);
		const result = applyStoryboardSuggestions(document, ["s_zoom"]);
		expect(result.applied).toEqual(["s_zoom"]);
		expect(result.document.timeline.trimRanges).toHaveLength(0);
		expect(result.document.storyboard?.suggestions.find((s) => s.id === "s_cut")?.status).toBe(
			"approved",
		);
	});

	it("records a tool refusal on the suggestion and keeps applying the rest", () => {
		const offTimeline: AxcutStoryboardSuggestion = {
			...zoom,
			id: "s_off",
			startMs: 50000,
			endMs: 52000,
		};
		const document = fixture([offTimeline, cut]);
		const result = applyStoryboardSuggestions(document, ["s_off", "s_cut"]);
		expect(result.applied).toEqual(["s_cut"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].id).toBe("s_off");
		expect(result.failed[0].error.length).toBeGreaterThan(0);
		const refused = result.document.storyboard?.suggestions.find((s) => s.id === "s_off");
		expect(refused?.status).toBe("approved");
		expect(refused?.error).toBe(result.failed[0].error);
		expect(result.document.zoomRanges).toHaveLength(0);
	});

	it("refuses a document without a storyboard", () => {
		const document = fixture([]);
		const { storyboard: _dropped, ...bare } = document;
		expect(() => applyStoryboardSuggestions(bare as AxcutDocument, ["x"])).toThrow(/storyboard/);
	});
});

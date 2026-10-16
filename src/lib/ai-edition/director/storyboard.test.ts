import { describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	type AxcutStoryboard,
	type AxcutStoryboardSuggestion,
	createEmptyDocument,
} from "../schema";
import {
	canSetStatus,
	isStoryboardStale,
	mergeSuggestionStatuses,
	setSuggestionStatuses,
	storyboardCounts,
	suggestionFingerprint,
} from "./storyboard";
import { createdIdsFromToolResult, toolCallForSuggestion } from "./toolCalls";

const base = (over: Partial<AxcutStoryboardSuggestion> = {}) =>
	({
		id: "sb_1",
		sceneId: "scene_1",
		status: "proposed",
		source: "heuristic",
		rationale: "",
		appliedIds: [],
		...over,
	}) as AxcutStoryboardSuggestion;

const cut = (over: Record<string, unknown> = {}) =>
	base({
		kind: "cut",
		reason: "silence",
		assetId: "asset_1",
		clipId: "clip_1",
		sourceStartSec: 1.234,
		sourceEndSec: 2.5,
		...over,
	} as Partial<AxcutStoryboardSuggestion>);

const zoom = (over: Record<string, unknown> = {}) =>
	base({
		id: "sb_2",
		kind: "zoom",
		startMs: 1000,
		endMs: 3000,
		focus: { cx: 0.2, cy: 0.3 },
		depth: 3,
		...over,
	} as Partial<AxcutStoryboardSuggestion>);

const storyboard = (suggestions: AxcutStoryboardSuggestion[]): AxcutStoryboard => ({
	version: 1,
	generatedAt: "2026-10-16T00:00:00.000Z",
	clipSignature: "sig",
	enrichment: null,
	scenes: [],
	suggestions,
});

const document = (): AxcutDocument => createEmptyDocument({ projectId: "p", title: "t" });

describe("suggestionFingerprint", () => {
	it("is the content, rounded, not the id", () => {
		expect(suggestionFingerprint(cut({ id: "a" }))).toBe(suggestionFingerprint(cut({ id: "b" })));
		expect(suggestionFingerprint(cut({ sourceStartSec: 1.2341 }))).toBe(
			suggestionFingerprint(cut({ sourceStartSec: 1.2339 })),
		);
		expect(suggestionFingerprint(cut({ sourceEndSec: 3 }))).not.toBe(suggestionFingerprint(cut()));
		expect(suggestionFingerprint(zoom())).toBe("zoom:1000:3000");
	});
});

describe("mergeSuggestionStatuses", () => {
	it("keeps approvals and rejections, with their ids, and leaves new proposals alone", () => {
		const previous = storyboard([
			cut({ id: "old_cut", status: "approved" }),
			zoom({ id: "old_zoom", status: "rejected" }),
		]);
		const merged = mergeSuggestionStatuses(
			previous,
			[cut({ id: "new_cut" }), zoom({ id: "new_zoom" }), zoom({ id: "fresh", startMs: 9000 })],
			document(),
		);
		expect(merged.map((s) => [s.id, s.status])).toEqual([
			["old_cut", "approved"],
			["old_zoom", "rejected"],
			["fresh", "proposed"],
		]);
	});

	it("reverts an applied suggestion whose regions are gone", () => {
		const previous = storyboard([zoom({ id: "z", status: "applied", appliedIds: ["zoom_gone"] })]);
		const merged = mergeSuggestionStatuses(previous, [zoom({ id: "n" })], document());
		expect(merged[0].status).toBe("proposed");
		expect(merged[0].id).toBe("z");
	});

	it("keeps an applied suggestion whose region is still there", () => {
		const doc = document();
		const withZoom: AxcutDocument = {
			...doc,
			zoomRanges: [
				{
					id: "zoom_kept",
					startMs: 1000,
					endMs: 3000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				} as AxcutDocument["zoomRanges"][number],
			],
		};
		const previous = storyboard([zoom({ id: "z", status: "applied", appliedIds: ["zoom_kept"] })]);
		const merged = mergeSuggestionStatuses(previous, [zoom({ id: "n" })], withZoom);
		expect(merged[0].status).toBe("applied");
		expect(merged[0].appliedIds).toEqual(["zoom_kept"]);
	});
});

describe("statuses", () => {
	it("moves between proposed, approved and rejected, never into or out of applied", () => {
		expect(canSetStatus("proposed", "approved")).toBe(true);
		expect(canSetStatus("approved", "rejected")).toBe(true);
		expect(canSetStatus("rejected", "proposed")).toBe(true);
		expect(canSetStatus("proposed", "applied")).toBe(false);
		expect(canSetStatus("applied", "proposed")).toBe(false);
		expect(canSetStatus("approved", "approved")).toBe(false);
	});

	it("setSuggestionStatuses touches only the named ids and clears their last error", () => {
		const sb = storyboard([
			cut({ id: "a", error: "refused" }),
			zoom({ id: "b" }),
			zoom({ id: "c", status: "applied", appliedIds: ["zoom_1"] }),
		]);
		const next = setSuggestionStatuses(sb, new Set(["a", "c"]), "approved");
		expect(next.suggestions.map((s) => s.status)).toEqual(["approved", "proposed", "applied"]);
		expect(next.suggestions[0].error).toBeUndefined();
	});

	it("counts by status and the open silence cuts", () => {
		const counts = storyboardCounts(
			storyboard([
				cut({ id: "a" }),
				cut({ id: "b", status: "approved", reason: "tail" }),
				cut({ id: "c", status: "rejected" }),
				cut({ id: "d", status: "applied", reason: "retake" }),
				zoom({ id: "e" }),
			]),
		);
		expect(counts).toEqual({
			scenes: 0,
			proposed: 2,
			approved: 1,
			rejected: 1,
			applied: 1,
			silenceCuts: 2,
		});
		expect(storyboardCounts(null).proposed).toBe(0);
	});

	it("is stale once the clips moved", () => {
		const doc = document();
		const sb = storyboard([]);
		expect(isStoryboardStale(sb, doc)).toBe(true);
	});
});

describe("toolCallForSuggestion", () => {
	it("maps each kind to one agent tool and nothing else", () => {
		expect(toolCallForSuggestion(cut())).toEqual({
			name: "addTrim",
			args: {
				startSec: 1.234,
				endSec: 2.5,
				assetId: "asset_1",
				clipId: "clip_1",
				reason: "Director: silence",
			},
		});
		expect(toolCallForSuggestion(zoom())).toEqual({
			name: "addZoom",
			args: { startSec: 1, endSec: 3, depth: 3, focus: { cx: 0.2, cy: 0.3 } },
		});
		expect(
			toolCallForSuggestion(
				base({
					kind: "callout",
					startMs: 2000,
					endMs: 4500,
					text: "Open settings",
					x: 25,
					y: 63,
				} as Partial<AxcutStoryboardSuggestion>),
			),
		).toMatchObject({
			name: "addAnnotation",
			args: { startSec: 2, endSec: 4.5, type: "text", text: "Open settings", x: 25, y: 63 },
		});
		expect(
			toolCallForSuggestion(
				base({
					kind: "titleCard",
					cardKind: "outro",
					text: "Bye",
				} as Partial<AxcutStoryboardSuggestion>),
			),
		).toEqual({ name: "addTitleCard", args: { kind: "outro", text: "Bye" } });
	});

	it("reads created ids off a tool result, tolerating anything else", () => {
		expect(createdIdsFromToolResult(JSON.stringify({ trimRangeId: "trim_1", depth: 3 }))).toEqual([
			"trim_1",
		]);
		expect(
			createdIdsFromToolResult(
				JSON.stringify({ annotationId: "ann_1", annotationIds: ["ann_1", "ann_2"] }),
			),
		).toEqual(["ann_1", "ann_1", "ann_2"]);
		expect(createdIdsFromToolResult("not json")).toEqual([]);
		expect(createdIdsFromToolResult("[]")).toEqual([]);
	});
});

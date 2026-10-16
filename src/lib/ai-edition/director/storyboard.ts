// Pure helpers over a storyboard: identity of a suggestion across re-analyses, the
// carry-over of review decisions, status transitions and the counts the pane shows.
//
// No IO, no document writes. The analyser (`analyze.ts`) builds a storyboard, the
// main process applies it (`electron/ai-edition/director/apply.ts`) and the pane
// reads it; this file is what all three agree on.

import type {
	AxcutDocument,
	AxcutStoryboard,
	AxcutStoryboardSuggestion,
	AxcutStoryboardSuggestionStatus,
} from "../schema";
import { clipExtentSignature } from "../timeline/apply-auto-zooms";

/**
 * The content of a suggestion, as a string: two analyses of the same footage produce the
 * same fingerprint for the same proposal, however the ids were minted. Times are rounded
 * to the hundredth so a float wobble does not make a reviewed suggestion look new.
 */
export function suggestionFingerprint(suggestion: AxcutStoryboardSuggestion): string {
	const r = (value: number) => Math.round(value * 100) / 100;
	switch (suggestion.kind) {
		case "cut":
			return `cut:${suggestion.assetId}:${suggestion.clipId}:${r(suggestion.sourceStartSec)}:${r(suggestion.sourceEndSec)}`;
		case "zoom":
			return `zoom:${Math.round(suggestion.startMs)}:${Math.round(suggestion.endMs)}`;
		case "callout":
			return `callout:${Math.round(suggestion.startMs)}:${Math.round(suggestion.endMs)}`;
		case "titleCard":
			return `titleCard:${suggestion.cardKind}`;
	}
}

/** True when a region an applied suggestion created is still on the document. */
export function appliedRegionsPresent(
	suggestion: AxcutStoryboardSuggestion,
	document: AxcutDocument,
): boolean {
	if (suggestion.appliedIds.length === 0) return false;
	const ids = new Set<string>([
		...document.timeline.trimRanges.map((trim) => trim.id),
		...document.zoomRanges.map((zoom) => zoom.id),
		...document.annotations.map((annotation) => annotation.id),
	]);
	return suggestion.appliedIds.some((id) => ids.has(id));
}

/**
 * Carry the review over: a suggestion the user already approved, rejected or applied keeps
 * that decision (and its id, so a selection in the pane survives) when the new analysis
 * proposes the same thing. An `applied` whose regions were since deleted goes back to
 * `proposed`: the edit is gone, so the proposal stands again.
 */
export function mergeSuggestionStatuses(
	previous: AxcutStoryboard | null | undefined,
	next: readonly AxcutStoryboardSuggestion[],
	document: AxcutDocument,
): AxcutStoryboardSuggestion[] {
	if (!previous) return [...next];
	const byFingerprint = new Map<string, AxcutStoryboardSuggestion>();
	for (const suggestion of previous.suggestions) {
		byFingerprint.set(suggestionFingerprint(suggestion), suggestion);
	}
	return next.map((suggestion) => {
		const earlier = byFingerprint.get(suggestionFingerprint(suggestion));
		if (!earlier || earlier.status === "proposed") return suggestion;
		if (earlier.status === "applied" && !appliedRegionsPresent(earlier, document)) {
			return { ...suggestion, id: earlier.id };
		}
		return {
			...suggestion,
			id: earlier.id,
			status: earlier.status,
			appliedIds: earlier.status === "applied" ? earlier.appliedIds : [],
		};
	});
}

/** The review moves a suggestion between these; `applied` is only ever set by the apply step. */
export function canSetStatus(
	current: AxcutStoryboardSuggestionStatus,
	next: AxcutStoryboardSuggestionStatus,
): boolean {
	if (next === "applied") return false;
	if (current === "applied") return false;
	return current !== next;
}

export function setSuggestionStatuses(
	storyboard: AxcutStoryboard,
	ids: ReadonlySet<string>,
	status: AxcutStoryboardSuggestionStatus,
): AxcutStoryboard {
	return {
		...storyboard,
		suggestions: storyboard.suggestions.map((suggestion) =>
			ids.has(suggestion.id) && canSetStatus(suggestion.status, status)
				? { ...suggestion, status, error: undefined }
				: suggestion,
		),
	};
}

export interface StoryboardCounts {
	scenes: number;
	proposed: number;
	approved: number;
	rejected: number;
	applied: number;
	/** The cuts that remove silence (silence, lead-in, tail), still open. */
	silenceCuts: number;
}

export function storyboardCounts(storyboard: AxcutStoryboard | null | undefined): StoryboardCounts {
	const counts: StoryboardCounts = {
		scenes: storyboard?.scenes.length ?? 0,
		proposed: 0,
		approved: 0,
		rejected: 0,
		applied: 0,
		silenceCuts: 0,
	};
	for (const suggestion of storyboard?.suggestions ?? []) {
		counts[suggestion.status] += 1;
		if (
			isSilenceCut(suggestion) &&
			suggestion.status !== "applied" &&
			suggestion.status !== "rejected"
		) {
			counts.silenceCuts += 1;
		}
	}
	return counts;
}

export function isSilenceCut(suggestion: AxcutStoryboardSuggestion): boolean {
	return suggestion.kind === "cut" && suggestion.reason !== "retake";
}

/** The timeline moved under the analysis: clips were trimmed, moved, added or removed since. */
export function isStoryboardStale(storyboard: AxcutStoryboard, document: AxcutDocument): boolean {
	return storyboard.clipSignature !== clipExtentSignature(document);
}

/** The suggestions of one scene, in the storyboard's order. */
export function suggestionsForScene(
	storyboard: AxcutStoryboard,
	sceneId: string,
): AxcutStoryboardSuggestion[] {
	return storyboard.suggestions.filter((suggestion) => suggestion.sceneId === sceneId);
}

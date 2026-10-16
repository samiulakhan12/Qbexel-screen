// A storyboard suggestion is data; applying it is a tool call. This file is the whole of
// that translation, so the pane, the main process and the tests read one mapping.
//
// Every call goes through `executeAgentTool` (electron/ai-edition/agent-tools.ts): the
// same validation, anchoring and refusals a chat or MCP edit gets. Nothing here builds
// a region by hand.

import type { AxcutStoryboardSuggestion } from "../schema";

export type DirectorToolName = "addTrim" | "addZoom" | "addAnnotation" | "addTitleCard";

export interface DirectorToolCall {
	name: DirectorToolName;
	args: Record<string, unknown>;
}

/** The text size of a callout: readable beside a click without covering the screen. */
export const CALLOUT_FONT_SIZE = 28;

export function toolCallForSuggestion(suggestion: AxcutStoryboardSuggestion): DirectorToolCall {
	switch (suggestion.kind) {
		case "cut":
			return {
				name: "addTrim",
				args: {
					startSec: suggestion.sourceStartSec,
					endSec: suggestion.sourceEndSec,
					assetId: suggestion.assetId,
					clipId: suggestion.clipId,
					reason: `Director: ${suggestion.reason}`,
				},
			};
		case "zoom":
			return {
				name: "addZoom",
				args: {
					startSec: suggestion.startMs / 1000,
					endSec: suggestion.endMs / 1000,
					depth: suggestion.depth,
					focus: suggestion.focus,
				},
			};
		case "callout":
			return {
				name: "addAnnotation",
				args: {
					startSec: suggestion.startMs / 1000,
					endSec: suggestion.endMs / 1000,
					type: "text",
					text: suggestion.text,
					x: suggestion.x,
					y: suggestion.y,
					fontSize: CALLOUT_FONT_SIZE,
					animation: "rise",
				},
			};
		case "titleCard":
			return {
				name: "addTitleCard",
				args: { kind: suggestion.cardKind, text: suggestion.text },
			};
	}
}

/** The ids of the regions a successful tool call created, read off its result JSON. */
export function createdIdsFromToolResult(resultJson: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultJson);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const record = parsed as Record<string, unknown>;
	const ids: string[] = [];
	for (const key of ["trimRangeId", "zoomId", "annotationId"]) {
		const value = record[key];
		if (typeof value === "string" && value) ids.push(value);
	}
	for (const key of ["trimRangeIds", "zoomIds", "annotationIds"]) {
		const value = record[key];
		if (Array.isArray(value)) {
			for (const entry of value) if (typeof entry === "string" && entry) ids.push(entry);
		}
	}
	return ids;
}

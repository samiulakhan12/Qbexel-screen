// Applying a storyboard: each approved suggestion becomes one agent tool call, run through
// `executeAgentTool` — the single gate every machine edit passes (chat, MCP, and now the
// Director). Nothing here writes a region itself, so a suggestion cannot land where a
// manual or chat edit would be refused, and a refusal is recorded on the suggestion in
// the tool's own words.
//
// Pure: takes a document, returns a document. The caller (the bridge, then the renderer)
// decides whether to save it, with history, like any other edit the user confirmed.

import {
	createdIdsFromToolResult,
	toolCallForSuggestion,
} from "../../../src/lib/ai-edition/director/toolCalls";
import type { AxcutDocument, AxcutStoryboardSuggestion } from "../../../src/lib/ai-edition/schema";
import { executeAgentTool } from "../agent-tools";

export interface ApplyStoryboardResult {
	document: AxcutDocument;
	/** Suggestion ids whose edit was written, in the order they were applied. */
	applied: string[];
	/** Suggestion ids the tool refused, with the refusal. */
	failed: Array<{ id: string; error: string }>;
	/** Ids asked for that were not open: already applied, rejected, or unknown. */
	skipped: string[];
}

function errorFromResult(resultJson: string): string {
	try {
		const parsed = JSON.parse(resultJson) as { error?: unknown };
		if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
	} catch {
		// Fall through to the generic wording.
	}
	return "The tool refused the edit.";
}

export function applyStoryboardSuggestions(
	document: AxcutDocument,
	suggestionIds: readonly string[],
): ApplyStoryboardResult {
	const storyboard = document.storyboard;
	if (!storyboard) {
		throw new Error("The project has no storyboard to apply. Run the Director first.");
	}
	const wanted = new Set(suggestionIds);
	const known = new Set(storyboard.suggestions.map((suggestion) => suggestion.id));
	const applied: string[] = [];
	const failed: Array<{ id: string; error: string }> = [];
	const skipped: string[] = [...wanted].filter((id) => !known.has(id));
	const updated = new Map<string, AxcutStoryboardSuggestion>();
	let working = document;

	for (const suggestion of storyboard.suggestions) {
		if (!wanted.has(suggestion.id)) continue;
		if (suggestion.status === "applied" || suggestion.status === "rejected") {
			skipped.push(suggestion.id);
			continue;
		}
		const call = toolCallForSuggestion(suggestion);
		const result = executeAgentTool(working, call.name, JSON.stringify(call.args));
		if (!result.ok || !result.document) {
			const error = errorFromResult(result.resultJson);
			failed.push({ id: suggestion.id, error });
			updated.set(suggestion.id, { ...suggestion, error });
			continue;
		}
		working = result.document;
		applied.push(suggestion.id);
		updated.set(suggestion.id, {
			...suggestion,
			status: "applied",
			appliedIds: createdIdsFromToolResult(result.resultJson),
			error: undefined,
		});
	}

	return {
		document: {
			...working,
			storyboard: {
				...storyboard,
				suggestions: storyboard.suggestions.map(
					(suggestion) => updated.get(suggestion.id) ?? suggestion,
				),
			},
		},
		applied,
		failed,
		skipped,
	};
}

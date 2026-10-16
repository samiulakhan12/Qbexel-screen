// The Storyboard pane's store: the Director's analysis, the review of its suggestions,
// and their application — every write through `saveDocument`, with history, like any
// other thing the user does in the editor.
//
// Analysis and application both run in the main process (`director.analyze`,
// `director.apply`): the first reads cursor telemetry and may call the model, the second
// goes through `executeAgentTool`. This hook only moves documents: it sends the store's
// current one and saves what comes back, after validating it, guarded against a project
// switch during the round trip the way `addZoomsBulk` is.

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
import { isSilenceCut, setSuggestionStatuses } from "../director/storyboard";
import {
	type AxcutDocument,
	type AxcutStoryboard,
	type AxcutStoryboardSuggestionStatus,
	documentSchema,
	storyboardSchema,
} from "../schema";
import { useProjectStore } from "./projectStore";

export type StoryboardBusy = "idle" | "analyzing" | "applying";

export interface StoryboardApplyOutcome {
	applied: number;
	failed: number;
}

export function useStoryboard() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const setCurrentTime = useProjectStore((s) => s.setCurrentTime);
	const te = useScopedT("editor");
	const ts = useScopedT("settings");
	const [busy, setBusy] = useState<StoryboardBusy>("idle");
	/** The model pass's failure, when the deterministic analysis still succeeded. */
	const [warning, setWarning] = useState<string | null>(null);

	const storyboard: AxcutStoryboard | null = document?.storyboard ?? null;

	// The document as the store holds it NOW, not as the render closure saw it: a round
	// trip to main takes long enough for the user to edit, and writing the closure's copy
	// back would drop that edit. Null once the project changed underneath.
	const current = useCallback((): AxcutDocument | null => {
		const state = useProjectStore.getState();
		if (!state.document || state.projectId !== projectId) return null;
		return state.document;
	}, [projectId]);

	const analyze = useCallback(
		async ({ enrich }: { enrich: boolean }): Promise<boolean> => {
			const doc = current();
			if (!doc) return false;
			setBusy("analyzing");
			setWarning(null);
			try {
				const result = await nativeBridgeClient.aiEdition.directorAnalyze(doc, {
					enrich,
					outroText: ts("effects.outroDefault"),
				});
				if (!result.success) {
					toast.error(te("director.analyzeFailed", { error: result.error ?? "" }));
					return false;
				}
				const parsed = storyboardSchema.safeParse(result.storyboard);
				if (!parsed.success) {
					toast.error(te("director.analyzeFailed", { error: parsed.error.message }));
					return false;
				}
				if (result.warning) setWarning(result.warning);
				const fresh = current();
				if (!fresh) return false;
				return await saveDocument({ ...fresh, storyboard: parsed.data }, { history: true });
			} catch (error) {
				toast.error(
					te("director.analyzeFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return false;
			} finally {
				setBusy("idle");
			}
		},
		[current, saveDocument, te, ts],
	);

	const setStatus = useCallback(
		async (ids: readonly string[], status: AxcutStoryboardSuggestionStatus): Promise<boolean> => {
			const doc = current();
			if (!doc?.storyboard) return false;
			return saveDocument(
				{ ...doc, storyboard: setSuggestionStatuses(doc.storyboard, new Set(ids), status) },
				{ history: true },
			);
		},
		[current, saveDocument],
	);

	const approveAll = useCallback(async (): Promise<boolean> => {
		const doc = current();
		if (!doc?.storyboard) return false;
		const ids = doc.storyboard.suggestions
			.filter((suggestion) => suggestion.status === "proposed")
			.map((suggestion) => suggestion.id);
		if (ids.length === 0) return false;
		return setStatus(ids, "approved");
	}, [current, setStatus]);

	const apply = useCallback(
		async (ids: readonly string[]): Promise<StoryboardApplyOutcome | null> => {
			const doc = current();
			if (!doc?.storyboard || ids.length === 0) return null;
			setBusy("applying");
			try {
				const result = await nativeBridgeClient.aiEdition.directorApply(doc, [...ids]);
				if (!result.success || result.document === undefined) {
					toast.error(te("director.applyError", { error: result.error ?? "" }));
					return null;
				}
				const parsed = documentSchema.safeParse(result.document);
				if (!parsed.success) {
					toast.error(te("director.applyError", { error: parsed.error.message }));
					return null;
				}
				// The project may have changed during the round trip; then the edited document
				// belongs to a project no longer open and must not be written over this one.
				if (!current()) return null;
				const saved = await saveDocument(parsed.data, { history: true });
				if (!saved) return null;
				const outcome = { applied: result.applied.length, failed: result.failed.length };
				if (outcome.applied > 0) {
					toast.success(te("director.applied", { count: outcome.applied }));
				}
				if (outcome.failed > 0) {
					toast.warning(te("director.applyFailed", { count: outcome.failed }));
				}
				return outcome;
			} catch (error) {
				toast.error(
					te("director.applyError", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				return null;
			} finally {
				setBusy("idle");
			}
		},
		[current, saveDocument, te],
	);

	const applyApproved = useCallback(async (): Promise<StoryboardApplyOutcome | null> => {
		const doc = current();
		if (!doc?.storyboard) return null;
		const ids = doc.storyboard.suggestions
			.filter((suggestion) => suggestion.status === "approved")
			.map((suggestion) => suggestion.id);
		if (ids.length === 0) {
			toast.info(te("director.nothingApproved"));
			return null;
		}
		return apply(ids);
	}, [apply, current, te]);

	/** The deterministic silence pass: every open silence, lead-in and tail cut, applied at once. */
	const removeSilences = useCallback(async (): Promise<StoryboardApplyOutcome | null> => {
		const doc = current();
		if (!doc?.storyboard) return null;
		const ids = doc.storyboard.suggestions
			.filter(
				(suggestion) =>
					isSilenceCut(suggestion) &&
					(suggestion.status === "proposed" || suggestion.status === "approved"),
			)
			.map((suggestion) => suggestion.id);
		if (ids.length === 0) return null;
		return apply(ids);
	}, [apply, current]);

	const clearStoryboard = useCallback(async (): Promise<boolean> => {
		const doc = current();
		if (!doc?.storyboard) return false;
		const { storyboard: _dropped, ...rest } = doc;
		return saveDocument(rest, { history: true });
	}, [current, saveDocument]);

	const seek = useCallback(
		(ms: number) => {
			setCurrentTime(Math.max(0, ms) / 1000);
		},
		[setCurrentTime],
	);

	return {
		document,
		storyboard,
		busy,
		warning,
		analyze,
		setStatus,
		approveAll,
		apply,
		applyApproved,
		removeSilences,
		clearStoryboard,
		seek,
	};
}

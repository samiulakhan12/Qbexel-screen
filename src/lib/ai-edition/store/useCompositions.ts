// The Compositions pane's store: the project's output variants, kept on the document.
// Adding, editing and removing a composition are writes to the document, with history.
// Previewing one applies its settings to the project through `documentForComposition` —
// the same transform the export runs — so the preview is the deliverable.

import { useCallback } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { documentForComposition } from "../compositions/apply";
import { compositionFromPreset, customComposition } from "../compositions/presets";
import type { AxcutComposition, AxcutCompositionPreset, AxcutDocument } from "../schema";
import { getEditorSettings } from "./editorSettings";
import { useProjectStore } from "./projectStore";
import { useSafeAreaGuide } from "./safeAreaGuide";

export type CompositionPatch = Partial<Omit<AxcutComposition, "id" | "preset">>;

export function useCompositions() {
	const document = useProjectStore((s) => s.document);
	const projectId = useProjectStore((s) => s.projectId);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const guideId = useSafeAreaGuide((s) => s.compositionId);
	const showGuide = useSafeAreaGuide((s) => s.show);
	const ts = useScopedT("settings");

	const compositions: AxcutComposition[] = document?.compositions ?? [];

	const current = useCallback((): AxcutDocument | null => {
		const state = useProjectStore.getState();
		if (!state.document || state.projectId !== projectId) return null;
		return state.document;
	}, [projectId]);

	const write = useCallback(
		async (next: AxcutComposition[]): Promise<boolean> => {
			const doc = current();
			if (!doc) return false;
			return saveDocument({ ...doc, compositions: next }, { history: true });
		},
		[current, saveDocument],
	);

	const add = useCallback(
		async (preset: AxcutCompositionPreset): Promise<AxcutComposition | null> => {
			const doc = current();
			if (!doc) return null;
			const composition =
				preset === "custom"
					? {
							...customComposition(getEditorSettings(doc).aspectRatio),
							name: ts("compositions.customName"),
						}
					: compositionFromPreset(preset);
			const ok = await write([...(doc.compositions ?? []), composition]);
			return ok ? composition : null;
		},
		[current, ts, write],
	);

	const update = useCallback(
		async (id: string, patch: CompositionPatch): Promise<boolean> => {
			const doc = current();
			if (!doc?.compositions?.some((composition) => composition.id === id)) return false;
			return write(
				doc.compositions.map((composition) =>
					composition.id === id
						? // Edited by hand, the composition is no longer the preset it started from.
							{ ...composition, ...patch, preset: "custom" as const }
						: composition,
				),
			);
		},
		[current, write],
	);

	const remove = useCallback(
		async (id: string): Promise<boolean> => {
			const doc = current();
			if (!doc?.compositions) return false;
			if (guideId === id) showGuide(null);
			return write(doc.compositions.filter((composition) => composition.id !== id));
		},
		[current, guideId, showGuide, write],
	);

	/** Apply the composition's look to the project, so the preview shows the deliverable. */
	const applyToProject = useCallback(
		async (id: string): Promise<boolean> => {
			const doc = current();
			const composition = doc?.compositions?.find((candidate) => candidate.id === id);
			if (!doc || !composition) return false;
			showGuide(id);
			return saveDocument(documentForComposition(doc, composition), { history: true });
		},
		[current, saveDocument, showGuide],
	);

	const toggleGuide = useCallback(
		(id: string) => showGuide(guideId === id ? null : id),
		[guideId, showGuide],
	);

	return {
		document,
		compositions,
		guideId,
		add,
		update,
		remove,
		applyToProject,
		toggleGuide,
	};
}

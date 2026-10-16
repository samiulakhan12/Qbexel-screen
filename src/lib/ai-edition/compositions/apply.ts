// A composition laid over the document: the one transform the preview, the export dialog,
// the batch export and the CLI all run, so what the user previews for "Shorts" is what the
// file holds. Pure. The timeline, cuts, zooms and annotations come through untouched; only
// the editor settings a composition names, and the caption placement, change.

import type { AspectRatio } from "@/utils/aspectRatioUtils";
import { type CaptionSettingsPatch, patchCaptionSettings } from "../captions/settings";
import { resolveAspectRatioValue } from "../document/outputFormat";
import type { AxcutComposition, AxcutDocument } from "../schema";
import { type EditorSettingsPatch, patchEditorSettings } from "../store/editorSettings";

export function documentForComposition(
	document: AxcutDocument,
	composition: AxcutComposition,
): AxcutDocument {
	const settings: EditorSettingsPatch = { aspectRatio: composition.aspectRatio as AspectRatio };
	if (composition.formatFollowCursor !== undefined) {
		settings.formatFollowCursor = composition.formatFollowCursor;
	}
	if (composition.padding !== undefined) settings.padding = composition.padding;
	if (composition.borderRadius !== undefined) settings.borderRadius = composition.borderRadius;
	let next = patchEditorSettings(document, settings);
	if (composition.captions) {
		const patch: CaptionSettingsPatch = {};
		if (composition.captions.anchorV) patch.anchorV = composition.captions.anchorV;
		if (composition.captions.insetY !== undefined) patch.insetY = composition.captions.insetY;
		if (composition.captions.fontSize !== undefined) patch.fontSize = composition.captions.fontSize;
		const aspectValue = resolveAspectRatioValue(next, composition.aspectRatio as AspectRatio);
		next = patchCaptionSettings(next, patch, aspectValue);
	}
	return next;
}

/** The composition by id, or null. */
export function findComposition(
	document: AxcutDocument | null | undefined,
	id: string | null | undefined,
): AxcutComposition | null {
	if (!document?.compositions || !id) return null;
	return document.compositions.find((composition) => composition.id === id) ?? null;
}

/** A composition by id, or by name (case-insensitive), for the CLI's `--composition`. */
export function resolveCompositionRef(
	document: AxcutDocument,
	ref: string,
): AxcutComposition | null {
	const compositions = document.compositions ?? [];
	const byId = compositions.find((composition) => composition.id === ref);
	if (byId) return byId;
	const wanted = ref.trim().toLowerCase();
	const byName = compositions.filter(
		(composition) => composition.name.trim().toLowerCase() === wanted,
	);
	return byName.length === 1 ? byName[0] : null;
}

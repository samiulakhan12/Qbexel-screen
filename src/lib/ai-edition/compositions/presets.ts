// The publishing presets a composition starts from.
//
// Each is the handful of settings that make a deliverable for one place: the frame's
// shape, how a recording of another shape fills it, where captions sit (a vertical cut
// keeps them above the platform's own UI), the margins the preview marks as "keep clear",
// and the container and tier the export writes. Everything else — the edit itself — is
// the project's and shared by every composition.

import { createId as defaultCreateId } from "../document/ids";
import type { AxcutComposition, AxcutCompositionPreset } from "../schema";

export type CompositionTemplate = Omit<AxcutComposition, "id" | "preset">;

export const COMPOSITION_PRESETS: Record<
	Exclude<AxcutCompositionPreset, "custom">,
	CompositionTemplate
> = {
	youtube: {
		name: "YouTube",
		aspectRatio: "16:9",
		// Just above the player's control strip, which the bottom margin stands for.
		captions: { anchorV: "bottom", insetY: 10 },
		safeArea: { top: 5, bottom: 8, left: 4, right: 4 },
		export: { format: "mp4", quality: "good", fps: 60 },
	},
	shorts: {
		name: "Shorts / Reels",
		aspectRatio: "9:16",
		formatFollowCursor: true,
		padding: 0,
		// Above the platform's caption bar and handles, below the top chrome.
		captions: { anchorV: "bottom", insetY: 26, fontSize: 60 },
		safeArea: { top: 12, bottom: 24, left: 6, right: 10 },
		export: { format: "mp4", quality: "good", fps: 30 },
	},
	square: {
		name: "Square",
		aspectRatio: "1:1",
		formatFollowCursor: true,
		captions: { anchorV: "bottom", insetY: 14 },
		safeArea: { top: 6, bottom: 12, left: 6, right: 6 },
		export: { format: "mp4", quality: "good", fps: 30 },
	},
	"docs-gif": {
		name: "Docs GIF",
		aspectRatio: "16:9",
		padding: 0,
		safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
		export: {
			format: "gif",
			quality: "medium",
			fps: 30,
			gifFrameRate: 15,
			gifSize: "small",
			gifLoop: true,
		},
	},
	linkedin: {
		name: "LinkedIn",
		aspectRatio: "4:5",
		formatFollowCursor: true,
		captions: { anchorV: "bottom", insetY: 16, fontSize: 54 },
		safeArea: { top: 6, bottom: 14, left: 5, right: 5 },
		export: { format: "mp4", quality: "good", fps: 30 },
	},
};

export const COMPOSITION_PRESET_ORDER: Array<Exclude<AxcutCompositionPreset, "custom">> = [
	"youtube",
	"shorts",
	"square",
	"docs-gif",
	"linkedin",
];

export function compositionFromPreset(
	preset: Exclude<AxcutCompositionPreset, "custom">,
	createId: (prefix: string) => string = defaultCreateId,
): AxcutComposition {
	const template = COMPOSITION_PRESETS[preset];
	return {
		id: createId("comp"),
		preset,
		...structuredClone(template),
	};
}

/** A blank composition: the project's current frame, exported as it is set today. */
export function customComposition(
	aspectRatio: string,
	createId: (prefix: string) => string = defaultCreateId,
): AxcutComposition {
	return {
		id: createId("comp"),
		name: "Custom",
		preset: "custom",
		aspectRatio,
		export: { format: "mp4", quality: "good", fps: 60 },
	};
}

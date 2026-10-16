// The looks that ship with the product, as style presets.
//
// Data, not code: each entry is a `StylePresetAppearance` exactly as a saved `.openscreenpreset`
// holds one, validated by the same parser (`parseStylePresetAppearance`) in the tests, so a
// bundled theme can never express a look a user preset could not. They are listed read-only
// beside the user's own presets (`StylePresetService.list`); applying one is the same single
// settings patch, and "use for new projects" works on them too.
//
// Main-process safe: relative imports only, like `stylePresets.ts`.

import { DEFAULT_PROJECT_APPEARANCE } from "../projectDefaults";
import type { StylePreset, StylePresetAppearance } from "./stylePresets";

export const BUNDLED_STYLE_PRESET_PREFIX = "qbexel-";

/** The cursor block every theme starts from; a theme overrides what it cares about. */
const CURSOR = DEFAULT_PROJECT_APPEARANCE.cursor;

/** Fields every theme shares, from the project defaults; the themes below override the look. */
const BASE: StylePresetAppearance = {
	wallpaper: DEFAULT_PROJECT_APPEARANCE.wallpaper,
	wallpaperMotion: "none",
	frame: "none",
	frameTheme: "light",
	aspectRatio: "auto",
	shadowIntensity: DEFAULT_PROJECT_APPEARANCE.shadowIntensity,
	backgroundBlur: 0,
	motionBlurAmount: DEFAULT_PROJECT_APPEARANCE.motionBlurAmount,
	depthOfField: true,
	borderRadius: DEFAULT_PROJECT_APPEARANCE.borderRadius,
	padding: DEFAULT_PROJECT_APPEARANCE.padding,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: DEFAULT_PROJECT_APPEARANCE.webcamMaskShape,
	webcamRoundness: DEFAULT_PROJECT_APPEARANCE.webcamRoundness,
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: DEFAULT_PROJECT_APPEARANCE.webcamSizePreset,
	webcamBackgroundMode: "none",
	webcamWallpaper: DEFAULT_PROJECT_APPEARANCE.webcamWallpaper,
	webcamBlurIntensity: DEFAULT_PROJECT_APPEARANCE.webcamBlurIntensity,
	cursor: {
		size: CURSOR.size,
		smoothing: CURSOR.smoothing,
		motionBlur: CURSOR.motionBlur,
		clickBounce: CURSOR.clickBounce,
		model3d: false,
		asArrow: [...CURSOR.asArrow],
		clickImpact: false,
		clickSound: false,
		clickSoundGainDb: 0,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
};

export interface BundledStylePreset extends StylePreset {
	builtIn: true;
	/** One sentence for the menu's tooltip: who the look is for. */
	description: string;
}

/** A theme's own values: anything of the appearance, with a partial cursor block. */
type Look = Omit<Partial<StylePresetAppearance>, "cursor"> & {
	cursor?: Partial<StylePresetAppearance["cursor"]>;
};

const theme = (id: string, name: string, description: string, look: Look): BundledStylePreset => ({
	id: `${BUNDLED_STYLE_PRESET_PREFIX}${id}`,
	name,
	description,
	// Fixed: a bundled theme has no file and never changes behind the user's back.
	updatedAt: "2026-10-16T00:00:00.000Z",
	builtIn: true,
	appearance: {
		...BASE,
		...look,
		cursor: { ...BASE.cursor, ...(look.cursor ?? {}) },
	},
});

export const BUNDLED_STYLE_PRESETS: readonly BundledStylePreset[] = [
	theme(
		"clean-documentation",
		"Clean documentation",
		"Neutral and quiet, for docs pages and help centres: a light window frame on an off-white page, a modest shadow, the cursor plain.",
		{
			wallpaper: "#f4f6f8",
			frame: "window",
			frameTheme: "light",
			shadowIntensity: 0.3,
			borderRadius: 14,
			padding: 44,
			motionBlurAmount: 0,
			depthOfField: false,
			cursor: { size: 2.8, smoothing: 0.7, motionBlur: 0.1, clickBounce: 0.6 },
			cursorTheme: "studio-ink",
		},
	),
	theme(
		"modern-saas",
		"Modern SaaS",
		"A product-launch look: an indigo-to-cyan gradient that drifts, a dark window frame floating on a deep shadow, a glowing cursor.",
		{
			wallpaper: "linear-gradient(135deg, #4f46e5 0%, #0891b2 100%)",
			wallpaperMotion: "drift",
			frame: "window",
			frameTheme: "dark",
			shadowIntensity: 0.75,
			borderRadius: 24,
			padding: 60,
			motionBlurAmount: 0.25,
			cursor: { size: 3.4, smoothing: 0.65, motionBlur: 0.35, clickBounce: 1.1, clickImpact: true },
			cursorTheme: "prism-glow",
		},
	),
	theme(
		"cinematic-dark",
		"Cinematic dark",
		"For feature films of a feature: near-black backdrop, no frame, heavy shadow, motion blur and depth of field on, a glass cursor that hides when idle.",
		{
			wallpaper: "linear-gradient(180deg, #0b0f14 0%, #161b26 100%)",
			frame: "none",
			shadowIntensity: 0.9,
			borderRadius: 10,
			padding: 72,
			motionBlurAmount: 0.5,
			depthOfField: true,
			cursor: { size: 3.6, smoothing: 0.75, motionBlur: 0.5, clickBounce: 0.9, model3d: true },
			cursorAutoHide: true,
			cursorTheme: "glass-lens",
		},
	),
	theme(
		"editorial",
		"Editorial",
		"Warm paper and generous margins, as in a magazine spread: a light frame, a faint shadow, an ink cursor.",
		{
			wallpaper: "#f3ead8",
			frame: "window",
			frameTheme: "light",
			shadowIntensity: 0.25,
			borderRadius: 6,
			padding: 84,
			motionBlurAmount: 0.1,
			depthOfField: false,
			cursor: { size: 3, smoothing: 0.6, motionBlur: 0.15, clickBounce: 0.7 },
			cursorTheme: "studio-ink",
		},
	),
	theme(
		"playful-creative",
		"Playful creative",
		"Candy gradient in motion, round corners, a bouncy pixel cursor with click sounds: for social clips and communities.",
		{
			wallpaper: "linear-gradient(135deg, #ff9a9e 0%, #fad0c4 45%, #a1c4fd 100%)",
			wallpaperMotion: "waves",
			frame: "window",
			frameTheme: "light",
			shadowIntensity: 0.55,
			borderRadius: 36,
			padding: 56,
			motionBlurAmount: 0.2,
			cursor: {
				size: 3.8,
				smoothing: 0.6,
				motionBlur: 0.3,
				clickBounce: 1.6,
				clickImpact: true,
				clickSound: true,
			},
			cursorTheme: "pixel-candy",
		},
	),
];

export function isBundledStylePresetId(id: string): boolean {
	return BUNDLED_STYLE_PRESETS.some((preset) => preset.id === id);
}

export function findBundledStylePreset(id: string): BundledStylePreset | null {
	return BUNDLED_STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

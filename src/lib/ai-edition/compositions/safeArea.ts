// Safe areas: the margins a platform's own UI covers (a vertical feed's caption bar and
// buttons, a player's control strip), which the preview marks so the user keeps the
// recording's important part — and the captions — out of them. Guides only: nothing in the
// export reads them, and they are stored per composition.

import type { AxcutComposition, AxcutCompositionSafeArea } from "../schema";

export const NO_SAFE_AREA: AxcutCompositionSafeArea = { top: 0, bottom: 0, left: 0, right: 0 };

export function safeAreaOf(
	composition: AxcutComposition | null | undefined,
): AxcutCompositionSafeArea {
	return composition?.safeArea ?? NO_SAFE_AREA;
}

export function hasSafeArea(area: AxcutCompositionSafeArea): boolean {
	return area.top > 0 || area.bottom > 0 || area.left > 0 || area.right > 0;
}

/** The clear region as CSS insets of the frame, for the overlay. */
export function safeAreaInsetStyle(area: AxcutCompositionSafeArea): {
	top: string;
	bottom: string;
	left: string;
	right: string;
} {
	return {
		top: `${area.top}%`,
		bottom: `${area.bottom}%`,
		left: `${area.left}%`,
		right: `${area.right}%`,
	};
}

/** True when a caption anchored at `anchorV` with `insetY` percent sits inside the clear region. */
export function captionInsideSafeArea(
	area: AxcutCompositionSafeArea,
	caption: { anchorV: "bottom" | "top"; insetY: number },
): boolean {
	return caption.anchorV === "bottom" ? caption.insetY >= area.bottom : caption.insetY >= area.top;
}

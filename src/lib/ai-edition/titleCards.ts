// Intro and outro title cards.
//
// A title card is a text annotation in frame space: large, centred, on a plate, animated in,
// over the first or last seconds of the programme. It needs no new region kind and no new
// renderer path, so it looks the same in the preview and in the export by construction, and the
// user edits it like any other text (the inspector, the agent's setAnnotation, drag on canvas).
// What it does NOT do is cover the picture with an opaque background: that would be a scene
// kind the compositor does not have (see PROJECT_STATUS.md, backlog).

import { createId } from "./document/ids";
import type { AxcutAnnotationRegion, AxcutDocument } from "./schema";
import { anchorRegionsWithDerivedMs } from "./timeline/timelineMap";

export type TitleCardKind = "intro" | "outro";

export const TITLE_CARD_DEFAULT_SEC = 3;
export const TITLE_CARD_MIN_SEC = 1;
export const TITLE_CARD_MAX_SEC = 15;

export interface TitleCardOptions {
	kind: TitleCardKind;
	text: string;
	/** Seconds the card stays on screen, clamped to [1, 15] and to the programme's length. */
	durationSec?: number;
	/** The frame's width over height, for the text box. */
	frameAspect: number;
	/** Text and plate colours; the defaults read on any wallpaper. */
	color?: string;
	backgroundColor?: string;
	fontFamily?: string;
	fontSize?: number;
	origin?: "user" | "agent";
}

/** The RAW ruler span the card covers: the head of the timeline for an intro, its tail for an outro. */
export function titleCardSpanMs(
	kind: TitleCardKind,
	timelineDurationSec: number,
	durationSec = TITLE_CARD_DEFAULT_SEC,
): { startMs: number; endMs: number } {
	const total = Math.max(0, timelineDurationSec);
	const wanted = Math.min(TITLE_CARD_MAX_SEC, Math.max(TITLE_CARD_MIN_SEC, durationSec));
	const length = Math.min(wanted, total);
	if (kind === "intro") return { startMs: 0, endMs: Math.round(length * 1000) };
	return { startMs: Math.round((total - length) * 1000), endMs: Math.round(total * 1000) };
}

/** A text box for `text` at `fontSize`, centred in the frame; wide enough for the longest line. */
export function titleCardBox(
	text: string,
	fontSize: number,
	frameAspect: number,
): { position: { x: number; y: number }; size: { width: number; height: number } } {
	const lines = text.split("\n");
	const longest = Math.max(1, ...lines.map((line) => line.length));
	// Average advance of a proportional bold face, plus plate padding, in px at a 1080-high frame.
	const widthPx = longest * fontSize * 0.58 + fontSize * 1.6;
	const heightPx = lines.length * fontSize * 1.3 + fontSize * 0.9;
	const aspect = frameAspect > 0 ? frameAspect : 16 / 9;
	const width = Math.min(96, (widthPx / (1080 * aspect)) * 100);
	const height = Math.min(90, (heightPx / 1080) * 100);
	return { position: { x: (100 - width) / 2, y: (100 - height) / 2 }, size: { width, height } };
}

/** The region as the timeline stores it, before anchoring. Pure. */
export function titleCardRegion(
	options: TitleCardOptions,
	timelineDurationSec: number,
	zIndex: number,
): AxcutAnnotationRegion {
	const text = options.text.trim() || (options.kind === "intro" ? "Title" : "Thanks for watching");
	const fontSize = options.fontSize ?? (options.kind === "intro" ? 72 : 56);
	const span = titleCardSpanMs(options.kind, timelineDurationSec, options.durationSec);
	return {
		id: createId("ann"),
		startMs: span.startMs,
		endMs: span.endMs,
		type: "text",
		content: text,
		textContent: "",
		space: "frame",
		...titleCardBox(text, fontSize, options.frameAspect),
		style: {
			color: options.color ?? "#ffffff",
			backgroundColor: options.backgroundColor ?? "#0b1220",
			fontSize,
			fontFamily: options.fontFamily ?? "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			// Rise in for a title, fade for a sign-off: the two text animations that read as cards.
			textAnimation: options.kind === "intro" ? "rise" : "fade",
		},
		zIndex,
	};
}

/** The programme's RAW length: the end of the last clip. */
export function timelineDurationSec(document: Pick<AxcutDocument, "timeline">): number {
	return document.timeline.clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0);
}

/** Adds a title card to the document, anchored to the clip(s) under its span. Pure. */
export function addTitleCard(document: AxcutDocument, options: TitleCardOptions): AxcutDocument {
	const total = timelineDurationSec(document);
	if (total <= 0) throw new Error("The timeline has no footage to put a title card on.");
	const region = titleCardRegion(options, total, document.annotations.length + 1);
	const created = anchorRegionsWithDerivedMs([region], document.timeline.clips, () =>
		createId("ann"),
	) as unknown as AxcutDocument["annotations"];
	if (created.length === 0) throw new Error("The title card covers no clip.");
	return { ...document, annotations: [...document.annotations, ...created] };
}

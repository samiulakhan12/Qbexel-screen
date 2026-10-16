// Subtitle files from the caption layer: SRT and WebVTT.
//
// The cues come from `deriveCaptionCues`, on the RAW ruler (trims still occupy their time).
// A subtitle file accompanies the EXPORTED programme, whose clock has the trims removed and
// the speed regions applied, so every cue is projected through the same function the audio
// mix uses (`projectRawTimelineSecToPlayback`) before it is written. A cue that a cut swallows
// whole collapses to nothing and is dropped; one a cut interrupts keeps what survives.

import {
	type PlaybackSpeedRegion,
	projectRawTimelineSecToPlayback,
	readSpeedRegions,
} from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { type CaptionCue, deriveCaptionCues } from "./cues";
import { type CaptionSettings, getCaptionSettings } from "./settings";
import { getCaptionTranslations } from "./translations";

export type SubtitleFormat = "srt" | "vtt";
export const SUBTITLE_FORMATS: readonly SubtitleFormat[] = ["srt", "vtt"];

export function subtitleExtension(format: SubtitleFormat): string {
	return format === "srt" ? ".srt" : ".vtt";
}

/** A cue on the programme clock, ready to write. */
export interface SubtitleCue {
	startMs: number;
	endMs: number;
	text: string;
}

/** Cues too short to read are noise in a player: below this they are dropped. */
const MIN_CUE_MS = 40;

export function projectCuesToProgramme(
	cues: CaptionCue[],
	document: Pick<AxcutDocument, "timeline" | "legacyEditor">,
	speedRegions: PlaybackSpeedRegion[] = readSpeedRegions(document),
): SubtitleCue[] {
	const { clips, trimRanges } = document.timeline;
	const project = (rawMs: number) =>
		Math.round(
			projectRawTimelineSecToPlayback(clips, trimRanges, rawMs / 1000, speedRegions) * 1000,
		);
	const out: SubtitleCue[] = [];
	for (const cue of cues) {
		const startMs = project(cue.startMs);
		const endMs = project(cue.endMs);
		if (endMs - startMs < MIN_CUE_MS) continue;
		out.push({ startMs, endMs, text: cue.text });
	}
	// Projection is monotonic, but two cues can now meet or touch; keep the file well-formed.
	out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	for (let i = 1; i < out.length; i++) {
		if (out[i - 1].endMs > out[i].startMs)
			out[i - 1].endMs = Math.max(out[i - 1].startMs + 1, out[i].startMs);
	}
	return out;
}

/**
 * The document's caption cues as subtitles. Captions are always derived here, whatever the
 * burn-in switch says: a subtitle file is the alternative to burning them in.
 */
export function subtitleCuesForDocument(
	document: AxcutDocument,
	aspectValue: number,
	settingsOverride?: Partial<CaptionSettings>,
): SubtitleCue[] {
	const settings: CaptionSettings = {
		...getCaptionSettings(document, aspectValue),
		...settingsOverride,
		enabled: true,
	};
	const cues = deriveCaptionCues(document, settings, getCaptionTranslations(document));
	return projectCuesToProgramme(cues, document);
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

/** `HH:MM:SS,mmm` for SRT, `HH:MM:SS.mmm` for WebVTT. */
export function formatSubtitleTime(ms: number, separator: "," | "."): string {
	const total = Math.max(0, Math.round(ms));
	const hours = Math.floor(total / 3_600_000);
	const minutes = Math.floor((total % 3_600_000) / 60_000);
	const seconds = Math.floor((total % 60_000) / 1000);
	const millis = total % 1000;
	return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`;
}

/** SRT forbids blank lines inside a cue (they end it) and WebVTT forbids `-->` in text. */
function cleanCueText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n")
		.replace(/-->/g, "→");
}

export function cuesToSrt(cues: SubtitleCue[]): string {
	const blocks = cues.map((cue, index) =>
		[
			String(index + 1),
			`${formatSubtitleTime(cue.startMs, ",")} --> ${formatSubtitleTime(cue.endMs, ",")}`,
			cleanCueText(cue.text),
		].join("\n"),
	);
	return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

export function cuesToWebVtt(cues: SubtitleCue[]): string {
	// WebVTT's own text escapes: `&`, `<` and `>` are markup in cue text (not in the timing line).
	const escapeText = (text: string) =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const blocks = cues.map(
		(cue) =>
			`${formatSubtitleTime(cue.startMs, ".")} --> ${formatSubtitleTime(cue.endMs, ".")}\n${escapeText(cleanCueText(cue.text))}`,
	);
	return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
}

export function renderSubtitles(cues: SubtitleCue[], format: SubtitleFormat): string {
	return format === "srt" ? cuesToSrt(cues) : cuesToWebVtt(cues);
}

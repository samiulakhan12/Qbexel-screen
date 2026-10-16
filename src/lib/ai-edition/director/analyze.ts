// The Tutorial Director's deterministic pass.
//
// Reads what the recording holds — transcribed words, recorded clicks, the clips on the
// timeline — and writes a storyboard: scenes with their observed events, heuristic
// inferences, and typed suggestions (cuts, zooms, callouts, title cards). No model is
// involved here; `electron/ai-edition/director/enrich.ts` may add `llm` inferences on
// top, and it only ever adds titles and summaries. Times, events and suggestions come
// from this file alone, so nothing a model says can invent an action that did not occur.
//
// Axes. Words and clicks are in the asset's SOURCE time; scenes, zooms and callouts are
// placed in RAW ruler ms (the editor's ruler, where clips sit end to end); cuts are
// stored in source time like trims. A raw clip is identity between its source window and
// its ruler span (timeline/timelineMap.ts), so the translation is one addition per clip,
// and a scene never crosses a clip boundary.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { createId as defaultCreateId } from "../document/ids";
import {
	type AxcutClip,
	type AxcutDocument,
	type AxcutStoryboard,
	type AxcutStoryboardInference,
	type AxcutStoryboardObservedEvent,
	type AxcutStoryboardScene,
	type AxcutStoryboardSuggestion,
	type AxcutTranscript,
	type AxcutTranscriptSegment,
	type AxcutWord,
	STORYBOARD_VERSION,
} from "../schema";
import { isInsertedWord, isSilenceWord } from "../timeline/aggregated-transcript";
import { clipExtentSignature } from "../timeline/apply-auto-zooms";
import { effectiveZoomScale } from "../timeline/zoom-scale";
import { buildAutoZoomSuggestionsForClips } from "../timeline/zoom-suggestions";
import { mergeSuggestionStatuses } from "./storyboard";

/** A pause in speech at least this long may start a new scene. */
export const SCENE_PAUSE_SEC = 1.5;
/** A scene is never shorter than this, so a breath does not become a scene. */
export const MIN_SCENE_SEC = 4;
/** A scene longer than this is split at its widest pause. */
export const MAX_SCENE_SEC = 45;
/** Without speech, clicks this far apart start a new scene. */
export const CLICK_SCENE_GAP_SEC = 6;
/** A pause at least this long with nothing happening is proposed as a cut… */
export const SILENCE_CUT_SEC = 1.5;
/** …keeping this much breath on each side… */
export const CUT_PAD_SEC = 0.3;
/** …and only when what is left to cut is at least this long. */
export const MIN_CUT_SEC = 0.5;
/** Silence before the first word or after the last one this long is proposed as a cut. */
export const EDGE_SILENCE_SEC = 2;
export const EDGE_PAD_SEC = 0.5;
/** The recording's last second holds the stop click; a tail cut ignores clicks there. */
export const STOP_CLICK_GUARD_SEC = 1;
/** A pause at least this long is listed among a scene's observed events. */
export const OBSERVED_SILENCE_SEC = 1;
/** How long a callout stays beside its click. */
export const CALLOUT_SEC = 2.5;
/** Two speech segments sharing this many opening words, one right after the other, are a retake. */
export const RETAKE_PREFIX_WORDS = 4;
export const RETAKE_MAX_GAP_SEC = 8;
/** An intro card is not proposed over a programme shorter than this, nor an outro. */
export const MIN_TITLE_CARD_PROGRAMME_SEC = 10;

const CLICK_KINDS = new Set(["click", "double-click", "right-click"]);

export interface DirectorAnalysisOptions {
	/** Each recording's cursor samples in its own SOURCE time, by asset id. */
	telemetryByAssetId?: ReadonlyMap<string, readonly CursorTelemetryPoint[]>;
	/** The storyboard this one replaces: approved and rejected decisions carry over. */
	previous?: AxcutStoryboard | null;
	/** The outro card's text, translated by the caller. No outro is proposed when omitted. */
	outroText?: string;
	now?: () => Date;
	/** Injectable so tests get stable ids. */
	createId?: (prefix: string) => string;
}

interface Click {
	sourceSec: number;
	cx: number;
	cy: number;
	kind: "click" | "double-click" | "right-click";
}

interface ClipContext {
	clip: AxcutClip;
	srcStart: number;
	srcEnd: number;
	/** Spoken words inside the clip's source window, by start. */
	words: AxcutWord[];
	/** Speech segments inside the window, by start. */
	segments: AxcutTranscriptSegment[];
	clicks: Click[];
	/** The last sample's time, for the stop-click guard; the window's end without telemetry. */
	telemetryEndSec: number;
}

function toRawMs(ctx: ClipContext, sourceSec: number): number {
	return Math.round((ctx.clip.timelineStartSec + (sourceSec - ctx.srcStart)) * 1000);
}

function transcriptFor(document: AxcutDocument, assetId: string): AxcutTranscript | null {
	return (
		document.transcripts.find((transcript) => transcript.assetId === assetId) ??
		(document.transcript?.assetId === assetId ? document.transcript : null)
	);
}

function clipContext(
	document: AxcutDocument,
	clip: AxcutClip,
	telemetry: readonly CursorTelemetryPoint[] | undefined,
): ClipContext {
	const srcStart = clip.sourceStartSec;
	const srcEnd = clip.sourceEndSec ?? srcStart + (clip.timelineEndSec - clip.timelineStartSec);
	const transcript = transcriptFor(document, clip.assetId);
	const words = (transcript?.words ?? [])
		.filter(
			(word) =>
				!isSilenceWord(word) &&
				!isInsertedWord(word) &&
				word.text.trim().length > 0 &&
				word.startSec >= srcStart &&
				word.endSec <= srcEnd,
		)
		.sort((a, b) => a.startSec - b.startSec);
	const segments = (transcript?.segments ?? [])
		.filter(
			(segment) =>
				segment.kind === "speech" &&
				segment.text.trim().length > 0 &&
				segment.startSec >= srcStart &&
				segment.endSec <= srcEnd,
		)
		.sort((a, b) => a.startSec - b.startSec);
	const clicks: Click[] = [];
	let telemetryEndSec = srcEnd;
	if (telemetry?.length) {
		telemetryEndSec = Math.max(...telemetry.map((sample) => sample.timeMs)) / 1000;
		for (const sample of telemetry) {
			const kind = sample.interactionType;
			if (!kind || !CLICK_KINDS.has(kind) || sample.visible === false) continue;
			const sourceSec = sample.timeMs / 1000;
			if (sourceSec < srcStart || sourceSec > srcEnd) continue;
			clicks.push({
				sourceSec,
				cx: clamp01(sample.cx),
				cy: clamp01(sample.cy),
				kind: kind as Click["kind"],
			});
		}
		clicks.sort((a, b) => a.sourceSec - b.sourceSec);
	}
	return { clip, srcStart, srcEnd, words, segments, clicks, telemetryEndSec };
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Where the clip's scenes start and end, in source seconds, first and last included. */
export function sceneBoundaries(ctx: ClipContext): number[] {
	const { srcStart, srcEnd, words, clicks } = ctx;
	const bounds = [srcStart];
	let sceneStart = srcStart;
	if (words.length > 0) {
		for (let i = 1; i < words.length; i++) {
			const previous = words[i - 1];
			const next = words[i];
			const gap = next.startSec - previous.endSec;
			if (gap < SCENE_PAUSE_SEC) continue;
			if (previous.endSec - sceneStart < MIN_SCENE_SEC) continue;
			if (srcEnd - next.startSec < MIN_SCENE_SEC) continue;
			const boundary = next.startSec - Math.min(0.15, gap / 2);
			bounds.push(boundary);
			sceneStart = boundary;
		}
	} else if (clicks.length > 0) {
		for (let i = 1; i < clicks.length; i++) {
			const previous = clicks[i - 1];
			const next = clicks[i];
			if (next.sourceSec - previous.sourceSec < CLICK_SCENE_GAP_SEC) continue;
			if (previous.sourceSec - sceneStart < MIN_SCENE_SEC) continue;
			if (srcEnd - next.sourceSec < MIN_SCENE_SEC) continue;
			const boundary = next.sourceSec - 0.5;
			bounds.push(boundary);
			sceneStart = boundary;
		}
	}
	bounds.push(srcEnd);
	return splitLongScenes(ctx, bounds);
}

/** Any interval longer than MAX_SCENE_SEC is cut at its widest pause, else at its widest click gap, else evenly. */
function splitLongScenes(ctx: ClipContext, bounds: number[]): number[] {
	const out: number[] = [bounds[0]];
	for (let i = 1; i < bounds.length; i++) {
		const start = bounds[i - 1];
		const end = bounds[i];
		for (const inner of innerSplits(ctx, start, end)) out.push(inner);
		out.push(end);
	}
	return out;
}

function innerSplits(ctx: ClipContext, start: number, end: number): number[] {
	if (end - start <= MAX_SCENE_SEC) return [];
	const margin = MIN_SCENE_SEC;
	let best: { at: number; gap: number } | null = null;
	const words = ctx.words.filter((word) => word.startSec >= start && word.endSec <= end);
	for (let i = 1; i < words.length; i++) {
		const gap = words[i].startSec - words[i - 1].endSec;
		const at = words[i].startSec - Math.min(0.15, gap / 2);
		if (at - start < margin || end - at < margin) continue;
		if (!best || gap > best.gap) best = { at, gap };
	}
	if (!best) {
		const clicks = ctx.clicks.filter((click) => click.sourceSec >= start && click.sourceSec <= end);
		for (let i = 1; i < clicks.length; i++) {
			const gap = clicks[i].sourceSec - clicks[i - 1].sourceSec;
			const at = clicks[i].sourceSec - 0.5;
			if (at - start < margin || end - at < margin) continue;
			if (!best || gap > best.gap) best = { at, gap };
		}
	}
	if (!best) {
		const pieces = Math.ceil((end - start) / MAX_SCENE_SEC);
		const length = (end - start) / pieces;
		const splits: number[] = [];
		for (let i = 1; i < pieces; i++) splits.push(start + length * i);
		return splits;
	}
	return [...innerSplits(ctx, start, best.at), best.at, ...innerSplits(ctx, best.at, end)];
}

const STEP_VERBS =
	/^(click|open|select|go to|choose|type|press|enter|drag|scroll|navigate|create|add|remove|delete|save|set|pick|tap|switch|turn|check|uncheck|close|start|stop|run|install|upload|download|paste|copy|sign|log)\b/i;

/** The first few words of what was said, as a title: up to the first sentence end, eight words at most. */
export function heuristicTitle(narration: string): string {
	const sentence = narration.split(/(?<=[.!?])\s+/)[0] ?? narration;
	const words = sentence.trim().split(/\s+/).filter(Boolean).slice(0, 8);
	if (words.length === 0) return "";
	const text = words.join(" ").replace(/[.,;:!?]+$/u, "");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function sceneInferences(
	narration: string,
	clicks: readonly Click[],
	order: number,
): AxcutStoryboardInference[] {
	const inferences: AxcutStoryboardInference[] = [];
	if (narration) {
		inferences.push({
			kind: "title",
			text: heuristicTitle(narration),
			confidence: 0.5,
			source: "heuristic",
		});
		if (STEP_VERBS.test(narration)) {
			inferences.push({
				kind: "step",
				text: heuristicTitle(narration),
				confidence: 0.6,
				source: "heuristic",
			});
		}
	} else if (clicks.length > 0) {
		const first = clicks[0];
		const where = `${Math.round(first.cx * 100)}%, ${Math.round(first.cy * 100)}%`;
		inferences.push({
			kind: "title",
			text:
				clicks.length === 1
					? `A click at ${where} of the screen`
					: `${clicks.length} clicks, the first at ${where} of the screen`,
			confidence: 0.3,
			source: "heuristic",
		});
	} else {
		inferences.push({
			kind: "title",
			text: `Scene ${order + 1}`,
			confidence: 0.1,
			source: "heuristic",
		});
	}
	return inferences;
}

function normalizeWords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

/** `[a, b]` of the first consecutive segments that restart the same sentence, if any. */
export function findRetakes(
	segments: readonly AxcutTranscriptSegment[],
): Array<{ first: AxcutTranscriptSegment; second: AxcutTranscriptSegment; opening: string }> {
	const out: Array<{
		first: AxcutTranscriptSegment;
		second: AxcutTranscriptSegment;
		opening: string;
	}> = [];
	for (let i = 1; i < segments.length; i++) {
		const first = segments[i - 1];
		const second = segments[i];
		if (second.startSec - first.endSec > RETAKE_MAX_GAP_SEC) continue;
		const a = normalizeWords(first.text);
		const b = normalizeWords(second.text);
		if (a.length < RETAKE_PREFIX_WORDS || b.length < RETAKE_PREFIX_WORDS) continue;
		let shared = 0;
		while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
		if (shared < RETAKE_PREFIX_WORDS) continue;
		// The second attempt is the one kept, so it must carry at least as much of the sentence.
		if (b.length < a.length * 0.6) continue;
		out.push({ first, second, opening: a.slice(0, shared).join(" ") });
	}
	return out;
}

function overlapsExistingTrim(
	document: AxcutDocument,
	ctx: ClipContext,
	startSec: number,
	endSec: number,
): boolean {
	return document.timeline.trimRanges.some(
		(trim) =>
			trim.assetId === ctx.clip.assetId &&
			(trim.clipId === undefined || trim.clipId === ctx.clip.id) &&
			trim.endSec > startSec &&
			trim.startSec < endSec,
	);
}

function hasClickBetween(ctx: ClipContext, startSec: number, endSec: number): boolean {
	return ctx.clicks.some((click) => click.sourceSec >= startSec && click.sourceSec <= endSec);
}

function sceneIdAtRaw(scenes: readonly AxcutStoryboardScene[], rawMs: number): string {
	const scene =
		scenes.find((candidate) => rawMs >= candidate.startMs && rawMs < candidate.endMs) ??
		scenes[scenes.length - 1];
	return scene.id;
}

export function analyzeStoryboard(
	document: AxcutDocument,
	options: DirectorAnalysisOptions = {},
): AxcutStoryboard {
	const createId = options.createId ?? defaultCreateId;
	const now = options.now ?? (() => new Date());
	const telemetryByAssetId = options.telemetryByAssetId ?? new Map();
	const clips = [...document.timeline.clips].sort(
		(a, b) => a.timelineStartSec - b.timelineStartSec,
	);

	const scenes: AxcutStoryboardScene[] = [];
	const suggestions: AxcutStoryboardSuggestion[] = [];
	const retakeNotes: Array<{ rawMs: number; text: string }> = [];
	type CutSuggestion = Extract<AxcutStoryboardSuggestion, { kind: "cut" }>;
	const cutSuggestions: Array<{ rawMs: number; suggestion: Omit<CutSuggestion, "sceneId"> }> = [];

	for (const clip of clips) {
		const ctx = clipContext(document, clip, telemetryByAssetId.get(clip.assetId));
		if (ctx.srcEnd <= ctx.srcStart) continue;
		const bounds = sceneBoundaries(ctx);
		for (let i = 1; i < bounds.length; i++) {
			const start = bounds[i - 1];
			const end = bounds[i];
			const words = ctx.words.filter((word) => word.startSec >= start && word.startSec < end);
			const clicks = ctx.clicks.filter(
				(click) => click.sourceSec >= start && click.sourceSec < end,
			);
			const narration = words
				.map((word) => word.text.trim())
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			const observed: AxcutStoryboardObservedEvent[] = clicks.map((click) => ({
				kind: click.kind,
				atMs: toRawMs(ctx, click.sourceSec),
				cx: click.cx,
				cy: click.cy,
			}));
			for (let w = 1; w < words.length; w++) {
				const gap = words[w].startSec - words[w - 1].endSec;
				if (gap >= OBSERVED_SILENCE_SEC) {
					observed.push({
						kind: "silence",
						atMs: toRawMs(ctx, words[w - 1].endSec),
						endMs: toRawMs(ctx, words[w].startSec),
					});
				}
			}
			observed.sort((a, b) => a.atMs - b.atMs);
			const order = scenes.length;
			const inferred = sceneInferences(narration, clicks, order);
			scenes.push({
				id: createId("scene"),
				order,
				title: inferred.find((inference) => inference.kind === "title")?.text ?? "",
				startMs: toRawMs(ctx, start),
				endMs: toRawMs(ctx, end),
				clipId: clip.id,
				narration,
				observed,
				inferred,
			});
		}

		// Cuts are found over the whole clip, then filed under the scene they start in.
		const proposeCut = (
			reason: "silence" | "lead-in" | "tail" | "retake",
			startSec: number,
			endSec: number,
			rationale: string,
		) => {
			const clampedStart = Math.max(ctx.srcStart, startSec);
			const clampedEnd = Math.min(ctx.srcEnd, endSec);
			if (clampedEnd - clampedStart < MIN_CUT_SEC) return;
			if (overlapsExistingTrim(document, ctx, clampedStart, clampedEnd)) return;
			cutSuggestions.push({
				rawMs: toRawMs(ctx, clampedStart),
				suggestion: {
					id: createId("sb"),
					kind: "cut",
					reason,
					status: "proposed",
					source: "heuristic",
					rationale,
					appliedIds: [],
					assetId: clip.assetId,
					clipId: clip.id,
					sourceStartSec: round3(clampedStart),
					sourceEndSec: round3(clampedEnd),
				},
			});
		};

		if (ctx.words.length > 0) {
			const first = ctx.words[0];
			const last = ctx.words[ctx.words.length - 1];
			if (
				first.startSec - ctx.srcStart >= EDGE_SILENCE_SEC &&
				!hasClickBetween(ctx, ctx.srcStart, first.startSec)
			) {
				proposeCut(
					"lead-in",
					ctx.srcStart,
					first.startSec - EDGE_PAD_SEC,
					`${(first.startSec - ctx.srcStart).toFixed(1)} s before the first word, with no click`,
				);
			}
			for (let w = 1; w < ctx.words.length; w++) {
				const previous = ctx.words[w - 1];
				const next = ctx.words[w];
				const gap = next.startSec - previous.endSec;
				if (gap < SILENCE_CUT_SEC) continue;
				if (hasClickBetween(ctx, previous.endSec, next.startSec)) continue;
				proposeCut(
					"silence",
					previous.endSec + CUT_PAD_SEC,
					next.startSec - CUT_PAD_SEC,
					`${gap.toFixed(1)} s pause with no speech or click`,
				);
			}
			const tailGuardStart = Math.min(ctx.telemetryEndSec, ctx.srcEnd) - STOP_CLICK_GUARD_SEC;
			if (
				ctx.srcEnd - last.endSec >= EDGE_SILENCE_SEC &&
				!hasClickBetween(ctx, last.endSec, Math.max(last.endSec, tailGuardStart))
			) {
				proposeCut(
					"tail",
					last.endSec + EDGE_PAD_SEC,
					ctx.srcEnd,
					`${(ctx.srcEnd - last.endSec).toFixed(1)} s after the last word`,
				);
			}
		}

		for (const retake of findRetakes(ctx.segments)) {
			const text = `"${retake.opening}…" is started again right after`;
			retakeNotes.push({ rawMs: toRawMs(ctx, retake.first.startSec), text });
			proposeCut("retake", retake.first.startSec, retake.second.startSec - CUT_PAD_SEC, text);
		}
	}

	if (scenes.length === 0) {
		return {
			version: STORYBOARD_VERSION,
			generatedAt: now().toISOString(),
			clipSignature: clipExtentSignature(document),
			enrichment: null,
			scenes: [],
			suggestions: [],
		};
	}

	for (const note of retakeNotes) {
		const scene = scenes.find((candidate) => candidate.id === sceneIdAtRaw(scenes, note.rawMs));
		scene?.inferred.push({ kind: "retake", text: note.text, confidence: 0.5, source: "heuristic" });
	}
	for (const entry of cutSuggestions) {
		suggestions.push({ ...entry.suggestion, sceneId: sceneIdAtRaw(scenes, entry.rawMs) });
	}

	// Zooms: the timeline's own planner, over every recording at once, clear of the zooms
	// already placed. A click cluster becomes one zoom suggestion in the scene it starts in.
	const zooms = buildAutoZoomSuggestionsForClips({
		telemetryByAssetId: new Map(
			[...telemetryByAssetId.entries()].map(([assetId, samples]) => [assetId, [...samples]]),
		),
		clips: document.timeline.clips,
		existingRegions: document.zoomRanges.map((region) => ({
			startMs: region.startMs,
			endMs: region.endMs,
			scale: effectiveZoomScale(region),
		})),
	});
	for (const zoom of zooms) {
		suggestions.push({
			id: createId("sb"),
			sceneId: sceneIdAtRaw(scenes, zoom.span.start),
			kind: "zoom",
			status: "proposed",
			source: "heuristic",
			rationale: "Recorded clicks cluster here",
			appliedIds: [],
			startMs: Math.round(zoom.span.start),
			endMs: Math.round(zoom.span.end),
			focus: { cx: clamp01(zoom.focus.cx), cy: clamp01(zoom.focus.cy) },
			depth: zoom.depth,
		});
	}

	// Callouts: the step's title beside its first click, where the narration names a step.
	for (const scene of scenes) {
		const firstClick = scene.observed.find((event) => event.kind !== "silence");
		const title = scene.inferred.find((inference) => inference.kind === "title");
		if (!firstClick || !title || title.confidence < 0.5 || !scene.narration) continue;
		const startMs = firstClick.atMs;
		const endMs = Math.min(startMs + CALLOUT_SEC * 1000, scene.endMs);
		if (endMs - startMs < 800) continue;
		const covered = document.annotations.some(
			(annotation) => annotation.endMs > startMs && annotation.startMs < endMs,
		);
		if (covered) continue;
		suggestions.push({
			id: createId("sb"),
			sceneId: scene.id,
			kind: "callout",
			status: "proposed",
			source: "heuristic",
			rationale: "Names the step beside the click it starts with",
			appliedIds: [],
			startMs,
			endMs,
			text: title.text,
			x: clamp((firstClick.cx ?? 0.5) * 100, 12, 88),
			y: clamp((firstClick.cy ?? 0.5) * 100 - 12, 8, 92),
		});
	}

	const programmeSec = Math.max(...clips.map((clip) => clip.timelineEndSec));
	if (programmeSec >= MIN_TITLE_CARD_PROGRAMME_SEC) {
		const introCovered = document.annotations.some((annotation) => annotation.startMs < 3000);
		if (!introCovered && document.project.title.trim()) {
			suggestions.push({
				id: createId("sb"),
				sceneId: scenes[0].id,
				kind: "titleCard",
				status: "proposed",
				source: "heuristic",
				rationale: "Opens on the project's title",
				appliedIds: [],
				cardKind: "intro",
				text: document.project.title.trim().slice(0, 200),
			});
		}
		const outroCovered = document.annotations.some(
			(annotation) => annotation.endMs > programmeSec * 1000 - 3000,
		);
		if (!outroCovered && options.outroText?.trim()) {
			suggestions.push({
				id: createId("sb"),
				sceneId: scenes[scenes.length - 1].id,
				kind: "titleCard",
				status: "proposed",
				source: "heuristic",
				rationale: "Closes on a card",
				appliedIds: [],
				cardKind: "outro",
				text: options.outroText.trim().slice(0, 200),
			});
		}
	}

	return {
		version: STORYBOARD_VERSION,
		generatedAt: now().toISOString(),
		clipSignature: clipExtentSignature(document),
		enrichment: null,
		scenes,
		suggestions: mergeSuggestionStatuses(options.previous, suggestions, document),
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

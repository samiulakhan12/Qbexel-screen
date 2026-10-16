// From an accepted finding to the blur annotations that cover it.
//
// Pure. A finding's boxes are in SOURCE time and in fractions of the recording's
// picture; a blur annotation is placed on the editor's RAW ruler, in percent of the
// picture, through `addAnnotation` (type "blur"), which is the same tool the chat uses
// and the inspector's own kind switch mirrors. Boxes seen in consecutive samples are one
// run; a run that lies in several clips becomes one annotation per clip, each clamped to
// its clip, so the blur follows the footage however the timeline is cut.

import type { AxcutClip, AxcutDocument, AxcutPrivacyBox, AxcutPrivacyFinding } from "../schema";

/** Time added before the first and after the last sample a value was seen in. */
export const BLUR_TIME_PAD_SEC = 0.5;
/** Two samples further apart than this many sampling intervals start a new run. */
export const RUN_GAP_INTERVALS = 2;

export interface BlurCall {
	/** RAW ruler seconds. */
	startSec: number;
	endSec: number;
	/** Centre and size, in percent of the recording's picture. */
	x: number;
	y: number;
	width: number;
	height: number;
	clipId: string;
}

interface Run {
	startMs: number;
	endMs: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Group boxes seen close together in time, taking the union of their rectangles. */
export function boxRuns(boxes: readonly AxcutPrivacyBox[], sampleEveryMs: number): Run[] {
	const sorted = [...boxes].sort((a, b) => a.timeMs - b.timeMs);
	const runs: Run[] = [];
	const maxGap = sampleEveryMs * RUN_GAP_INTERVALS;
	for (const box of sorted) {
		const current = runs[runs.length - 1];
		if (current && box.timeMs - current.endMs <= maxGap) {
			const x1 = Math.max(current.x + current.w, box.x + box.w);
			const y1 = Math.max(current.y + current.h, box.y + box.h);
			current.x = Math.min(current.x, box.x);
			current.y = Math.min(current.y, box.y);
			current.w = x1 - current.x;
			current.h = y1 - current.y;
			current.endMs = box.timeMs;
			continue;
		}
		runs.push({ startMs: box.timeMs, endMs: box.timeMs, x: box.x, y: box.y, w: box.w, h: box.h });
	}
	return runs;
}

function clipSourceEnd(clip: AxcutClip): number {
	return clip.sourceEndSec ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
}

/**
 * The `addAnnotation` calls covering a finding: one per (run × clip the run lies in).
 * `sampleEveryMs` is the scan's interval: a value seen in one sample is assumed on screen
 * until the next, so each run ends one interval after its last sample.
 */
export function blurCallsForFinding(
	finding: AxcutPrivacyFinding,
	document: AxcutDocument,
	sampleEveryMs: number,
): BlurCall[] {
	if (finding.boxes.length === 0) return [];
	const clips = document.timeline.clips.filter((clip) => clip.assetId === finding.assetId);
	const calls: BlurCall[] = [];
	for (const run of boxRuns(finding.boxes, sampleEveryMs)) {
		const sourceStart = run.startMs / 1000 - BLUR_TIME_PAD_SEC;
		const sourceEnd = (run.endMs + sampleEveryMs) / 1000 + BLUR_TIME_PAD_SEC;
		for (const clip of clips) {
			const clipStart = clip.sourceStartSec;
			const clipEnd = clipSourceEnd(clip);
			const start = Math.max(sourceStart, clipStart);
			const end = Math.min(sourceEnd, clipEnd);
			if (end - start <= 0.05) continue;
			const toRaw = (sourceSec: number) => clip.timelineStartSec + (sourceSec - clipStart);
			calls.push({
				startSec: round3(toRaw(start)),
				endSec: round3(toRaw(end)),
				x: round2((run.x + run.w / 2) * 100),
				y: round2((run.y + run.h / 2) * 100),
				width: round2(Math.max(1, run.w * 100)),
				height: round2(Math.max(1, run.h * 100)),
				clipId: clip.id,
			});
		}
	}
	return calls;
}

/** The arguments `addAnnotation` takes for one blur call. */
export function blurToolArgs(call: BlurCall): Record<string, unknown> {
	return {
		startSec: call.startSec,
		endSec: call.endSec,
		type: "blur",
		x: call.x,
		y: call.y,
		width: call.width,
		height: call.height,
		blurData: { type: "mosaic", shape: "rectangle", blockSize: 14 },
	};
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

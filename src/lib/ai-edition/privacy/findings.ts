// From what was read off the recording to findings the review can show.
//
// Pure. The main process samples frames and OCRs them (`electron/privacy/`), and reads
// the transcript; this file turns OCR words with pixel boxes, and transcript words with
// times, into `AxcutPrivacyFinding`s: one per distinct sensitive value per asset, with
// every place and time it was seen. Decisions made on an earlier scan carry over by the
// finding's identity (its kind and masked preview), so a re-scan does not reopen what
// the user already dismissed or accepted.

import { createId as defaultCreateId } from "../document/ids";
import type {
	AxcutDocument,
	AxcutPrivacyBox,
	AxcutPrivacyFinding,
	AxcutPrivacyFindingKind,
	AxcutPrivacyScan,
	AxcutTranscript,
} from "../schema";
import { isInsertedWord, isSilenceWord } from "../timeline/aggregated-transcript";
import { findSensitiveText } from "./patterns";

export interface OcrWord {
	text: string;
	/** Tesseract's 0..100. */
	confidence: number;
	/** Pixel box in the frame. */
	bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrLine {
	words: OcrWord[];
}

export interface OcrFrame {
	/** SOURCE ms of the asset. */
	timeMs: number;
	width: number;
	height: number;
	lines: OcrLine[];
}

/**
 * Words Tesseract is less sure of than this only count for the most specific detectors.
 *
 * A real key IS low-confidence text to an OCR engine: it has no dictionary to lean on, so
 * `sk-live-4f9a…` comes back at 25 where "billing" comes back at 95. Dropping such words
 * would drop the very thing the scan is for. So they are kept, and a match on them has to
 * come from a detector sure of its shape (`MIN_SPECIFIC_MATCH_CONFIDENCE`): a known key
 * prefix, an email, a checksummed number — not the generic "long high-entropy run", which
 * is what OCR noise looks like.
 */
export const MIN_WORD_CONFIDENCE = 40;
/** Words below this are not read at all: they are noise, not text. */
export const MIN_READABLE_CONFIDENCE = 10;
export const MIN_SPECIFIC_MATCH_CONFIDENCE = 0.9;
/** Margin added around a box so the blur covers the glyphs' edges and anti-aliasing. */
export const BOX_PAD = 0.01;

export interface FrameFinding {
	kind: AxcutPrivacyFindingKind;
	preview: string;
	confidence: number;
	box: AxcutPrivacyBox;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** The sensitive spans of one OCR'd frame, each with the box of the words carrying it. */
export function frameFindings(frame: OcrFrame): FrameFinding[] {
	const out: FrameFinding[] = [];
	if (frame.width <= 0 || frame.height <= 0) return out;
	for (const line of frame.lines) {
		const words = line.words.filter(
			(word) => word.text.trim().length > 0 && word.confidence >= MIN_READABLE_CONFIDENCE,
		);
		if (words.length === 0) continue;
		// The line as one string, remembering where each word landed in it.
		let text = "";
		const spans: Array<{ start: number; end: number; word: OcrWord }> = [];
		for (const word of words) {
			if (text) text += " ";
			const start = text.length;
			text += word.text.trim();
			spans.push({ start, end: text.length, word });
		}
		for (const match of findSensitiveText(text)) {
			const carriers = spans.filter((span) => span.start < match.end && match.start < span.end);
			if (carriers.length === 0) continue;
			const x0 = Math.min(...carriers.map((c) => c.word.bbox.x0));
			const y0 = Math.min(...carriers.map((c) => c.word.bbox.y0));
			const x1 = Math.max(...carriers.map((c) => c.word.bbox.x1));
			const y1 = Math.max(...carriers.map((c) => c.word.bbox.y1));
			const ocrConfidence =
				carriers.reduce((sum, c) => sum + c.word.confidence, 0) / carriers.length / 100;
			// Unsure glyphs only count for a detector that is sure of the shape it matched.
			if (
				ocrConfidence * 100 < MIN_WORD_CONFIDENCE &&
				match.confidence < MIN_SPECIFIC_MATCH_CONFIDENCE
			) {
				continue;
			}
			const x = clamp01(x0 / frame.width - BOX_PAD);
			const y = clamp01(y0 / frame.height - BOX_PAD);
			out.push({
				kind: match.kind,
				preview: match.preview,
				// The pattern's confidence, tempered by how sure the OCR was of the glyphs.
				confidence: round2(match.confidence * (0.5 + 0.5 * ocrConfidence)),
				box: {
					timeMs: frame.timeMs,
					x,
					y,
					w: clamp01(x1 / frame.width + BOX_PAD) - x,
					h: clamp01(y1 / frame.height + BOX_PAD) - y,
				},
			});
		}
	}
	return out;
}

/** What makes two findings the same thing: the same kind of value, masked the same way. */
export function findingIdentity(finding: {
	kind: AxcutPrivacyFindingKind;
	preview: string;
	assetId: string;
}): string {
	return `${finding.assetId}:${finding.kind}:${finding.preview}`;
}

/** One finding per distinct value, carrying every frame it was seen in. */
export function mergeFrameFindings(
	findings: readonly FrameFinding[],
	assetId: string,
	createId: (prefix: string) => string = defaultCreateId,
): AxcutPrivacyFinding[] {
	const byIdentity = new Map<string, AxcutPrivacyFinding>();
	for (const finding of findings) {
		const key = findingIdentity({ ...finding, assetId });
		const existing = byIdentity.get(key);
		if (existing) {
			existing.boxes.push(finding.box);
			existing.confidence = Math.max(existing.confidence, finding.confidence);
			continue;
		}
		byIdentity.set(key, {
			id: createId("pf"),
			kind: finding.kind,
			preview: finding.preview,
			confidence: finding.confidence,
			source: "frame",
			assetId,
			boxes: [finding.box],
			status: "suggested",
			annotationIds: [],
		});
	}
	return [...byIdentity.values()].map((finding) => ({
		...finding,
		boxes: [...finding.boxes].sort((a, b) => a.timeMs - b.timeMs),
	}));
}

/** Sensitive values the narrator SAID: flagged with their time, nothing on the picture to cover. */
export function transcriptFindings(
	transcript: AxcutTranscript,
	createId: (prefix: string) => string = defaultCreateId,
): AxcutPrivacyFinding[] {
	const words = transcript.words
		.filter((word) => !isSilenceWord(word) && !isInsertedWord(word) && word.text.trim())
		.sort((a, b) => a.startSec - b.startSec);
	let text = "";
	const spans: Array<{ start: number; end: number; startSec: number; endSec: number }> = [];
	for (const word of words) {
		if (text) text += " ";
		const start = text.length;
		text += word.text.trim();
		spans.push({ start, end: text.length, startSec: word.startSec, endSec: word.endSec });
	}
	const out: AxcutPrivacyFinding[] = [];
	for (const match of findSensitiveText(text)) {
		const carriers = spans.filter((span) => span.start < match.end && match.start < span.end);
		if (carriers.length === 0) continue;
		out.push({
			id: createId("pf"),
			kind: match.kind,
			preview: match.preview,
			confidence: round2(match.confidence * 0.8),
			source: "transcript",
			assetId: transcript.assetId,
			boxes: [],
			spokenStartSec: Math.min(...carriers.map((c) => c.startSec)),
			spokenEndSec: Math.max(...carriers.map((c) => c.endSec)),
			status: "suggested",
			annotationIds: [],
		});
	}
	return out;
}

/** True when a blur an accepted finding created is still on the document. */
export function acceptedBlursPresent(
	finding: AxcutPrivacyFinding,
	document: AxcutDocument,
): boolean {
	if (finding.annotationIds.length === 0) return false;
	const ids = new Set(document.annotations.map((annotation) => annotation.id));
	return finding.annotationIds.some((id) => ids.has(id));
}

/**
 * Carry the earlier review over: a finding the user accepted or dismissed keeps that
 * decision (and its id) when the new scan finds the same value again. An accepted one
 * whose blurs were since deleted is open again.
 */
export function carryOverDecisions(
	previous: AxcutPrivacyScan | null | undefined,
	next: readonly AxcutPrivacyFinding[],
	document: AxcutDocument,
): AxcutPrivacyFinding[] {
	if (!previous) return [...next];
	const earlierByIdentity = new Map(
		previous.findings.map((finding) => [findingIdentity(finding), finding] as const),
	);
	return next.map((finding) => {
		const earlier = earlierByIdentity.get(findingIdentity(finding));
		if (!earlier || earlier.status === "suggested") return finding;
		if (earlier.status === "accepted" && !acceptedBlursPresent(earlier, document)) {
			return { ...finding, id: earlier.id };
		}
		return {
			...finding,
			id: earlier.id,
			status: earlier.status,
			annotationIds: earlier.status === "accepted" ? earlier.annotationIds : [],
		};
	});
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

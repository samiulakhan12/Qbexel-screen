// The state of a privacy review, for the pane and for the export gate.
//
// Pure. The gate's question is not "is the video clean" — no scan can promise that — but
// "did the user look": a scan ran over every recording on the timeline, and every finding
// has a decision or the user marked the review done.

import type {
	AxcutDocument,
	AxcutPrivacyFinding,
	AxcutPrivacyReview,
	AxcutPrivacyScan,
} from "../schema";
import { clipExtentSignature } from "../timeline/apply-auto-zooms";

export interface PrivacyCounts {
	total: number;
	suggested: number;
	accepted: number;
	dismissed: number;
	onScreen: number;
	spoken: number;
}

export function privacyCounts(review: AxcutPrivacyReview | null | undefined): PrivacyCounts {
	const counts: PrivacyCounts = {
		total: 0,
		suggested: 0,
		accepted: 0,
		dismissed: 0,
		onScreen: 0,
		spoken: 0,
	};
	for (const finding of review?.scan?.findings ?? []) {
		counts.total += 1;
		counts[finding.status] += 1;
		if (finding.source === "frame") counts.onScreen += 1;
		else counts.spoken += 1;
	}
	return counts;
}

/** The video assets on the timeline, which is what a scan has to have covered. */
export function scannableAssetIds(document: AxcutDocument): string[] {
	return document.assets
		.filter(
			(asset) =>
				asset.kind === "video" && document.timeline.clips.some((clip) => clip.assetId === asset.id),
		)
		.map((asset) => asset.id);
}

/** True when a recording on the timeline was not part of the scan. */
export function scanMissesAssets(scan: AxcutPrivacyScan, document: AxcutDocument): boolean {
	const scanned = new Set(scan.assetIds);
	return scannableAssetIds(document).some((id) => !scanned.has(id));
}

export type ExportGateState =
	/** No scan was ever run on this project. */
	| "unscanned"
	/** The scan predates a recording now on the timeline. */
	| "stale"
	/** Findings are waiting for a decision. */
	| "unreviewed"
	/** Every finding decided, or the review marked done. */
	| "reviewed"
	/** Scanned, nothing found. */
	| "clear";

export function exportGateState(document: AxcutDocument): {
	state: ExportGateState;
	suggested: number;
} {
	const review = document.privacy;
	const scan = review?.scan ?? null;
	if (!scan) return { state: "unscanned", suggested: 0 };
	if (scanMissesAssets(scan, document)) return { state: "stale", suggested: 0 };
	const counts = privacyCounts(review);
	if (counts.total === 0) return { state: "clear", suggested: 0 };
	if (counts.suggested === 0) return { state: "reviewed", suggested: 0 };
	if (review?.reviewedAt && review.reviewedClipSignature === clipExtentSignature(document)) {
		return { state: "reviewed", suggested: counts.suggested };
	}
	return { state: "unreviewed", suggested: counts.suggested };
}

/** Whether the export should ask before going on. */
export function exportNeedsAcknowledgement(state: ExportGateState): boolean {
	return state === "unreviewed" || state === "stale";
}

export function setFindingStatuses(
	review: AxcutPrivacyReview,
	ids: ReadonlySet<string>,
	status: AxcutPrivacyFinding["status"],
): AxcutPrivacyReview {
	if (!review.scan) return review;
	return {
		...review,
		// A new decision reopens the question of whether the review is complete.
		reviewedAt: null,
		reviewedClipSignature: null,
		scan: {
			...review.scan,
			findings: review.scan.findings.map((finding) =>
				ids.has(finding.id) && finding.status !== status
					? { ...finding, status, error: undefined }
					: finding,
			),
		},
	};
}

export function markReviewed(
	review: AxcutPrivacyReview,
	document: AxcutDocument,
	now: () => Date = () => new Date(),
): AxcutPrivacyReview {
	return {
		...review,
		reviewedAt: now().toISOString(),
		reviewedClipSignature: clipExtentSignature(document),
	};
}

export function emptyPrivacyReview(): AxcutPrivacyReview {
	return { version: 1, scan: null, reviewedAt: null, reviewedClipSignature: null };
}

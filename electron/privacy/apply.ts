// Accepting findings: each one becomes blur annotations written through `addAnnotation`
// — the agent tool the chat and MCP use — so a Guardian blur is anchored, clamped and
// refused exactly as a hand-placed one would be. Pure over the document; the bridge
// returns it and the renderer saves it with history, like any edit the user confirmed.

import { blurCallsForFinding, blurToolArgs } from "../../src/lib/ai-edition/privacy/blur";
import type { AxcutDocument, AxcutPrivacyFinding } from "../../src/lib/ai-edition/schema";
import { executeAgentTool } from "../ai-edition/agent-tools";

export interface ApplyPrivacyResult {
	document: AxcutDocument;
	/** Findings that now have at least one blur. */
	applied: string[];
	failed: Array<{ id: string; error: string }>;
	/** Ids not open: unknown, dismissed, already accepted, or spoken (nothing to cover). */
	skipped: string[];
}

function errorFromResult(resultJson: string): string {
	try {
		const parsed = JSON.parse(resultJson) as { error?: unknown };
		if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
	} catch {
		// Generic wording below.
	}
	return "The blur was refused.";
}

function createdAnnotationId(resultJson: string): string | null {
	try {
		const parsed = JSON.parse(resultJson) as { annotationId?: unknown };
		return typeof parsed?.annotationId === "string" ? parsed.annotationId : null;
	} catch {
		return null;
	}
}

export function applyPrivacyFindings(
	document: AxcutDocument,
	findingIds: readonly string[],
): ApplyPrivacyResult {
	const review = document.privacy;
	const scan = review?.scan;
	if (!review || !scan) {
		throw new Error("The project has no privacy scan to apply. Run a scan first.");
	}
	const wanted = new Set(findingIds);
	const known = new Set(scan.findings.map((finding) => finding.id));
	const applied: string[] = [];
	const failed: Array<{ id: string; error: string }> = [];
	const skipped: string[] = [...wanted].filter((id) => !known.has(id));
	const updated = new Map<string, AxcutPrivacyFinding>();
	let working = document;

	for (const finding of scan.findings) {
		if (!wanted.has(finding.id)) continue;
		if (finding.status !== "suggested" || finding.source !== "frame") {
			skipped.push(finding.id);
			continue;
		}
		const calls = blurCallsForFinding(finding, working, scan.sampleEveryMs);
		if (calls.length === 0) {
			skipped.push(finding.id);
			continue;
		}
		const annotationIds: string[] = [];
		let error: string | null = null;
		for (const call of calls) {
			const result = executeAgentTool(working, "addAnnotation", JSON.stringify(blurToolArgs(call)));
			if (!result.ok || !result.document) {
				error = errorFromResult(result.resultJson);
				break;
			}
			working = result.document;
			const id = createdAnnotationId(result.resultJson);
			if (id) annotationIds.push(id);
		}
		if (annotationIds.length === 0) {
			const message = error ?? "No blur could be placed.";
			failed.push({ id: finding.id, error: message });
			updated.set(finding.id, { ...finding, error: message });
			continue;
		}
		applied.push(finding.id);
		updated.set(finding.id, {
			...finding,
			status: "accepted",
			annotationIds,
			// A partial cover is still recorded on the finding, so the pane can say so.
			error: error ?? undefined,
		});
	}

	return {
		document: {
			...working,
			privacy: {
				...review,
				// New blurs mean new decisions: the review is complete again only when marked.
				reviewedAt: applied.length > 0 ? null : review.reviewedAt,
				reviewedClipSignature: applied.length > 0 ? null : review.reviewedClipSignature,
				scan: {
					...scan,
					findings: scan.findings.map((finding) => updated.get(finding.id) ?? finding),
				},
			},
		},
		applied,
		failed,
		skipped,
	};
}
